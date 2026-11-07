import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

/** Enforce private audit material using the platform's actual access model. */
export function protectAuditFile(file) {
  const directory = fs.statSync(file).isDirectory();
  if (process.platform !== 'win32') return fs.chmodSync(file, directory ? 0o700 : 0o600);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    $directory = $env:MAJIN_AUDIT_PRIVATE_DIRECTORY -eq '1'
    $acl = if ($directory) { New-Object System.Security.AccessControl.DirectorySecurity } else { New-Object System.Security.AccessControl.FileSecurity }
    $acl.SetAccessRuleProtection($true, $false)
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    foreach ($sid in @($me, [System.Security.Principal.SecurityIdentifier]'S-1-5-18', [System.Security.Principal.SecurityIdentifier]'S-1-5-32-544')) {
      $rule = if ($directory) { New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow') } else { New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow') }
      $acl.AddAccessRule($rule)
    }
    if ($directory) { [System.IO.Directory]::SetAccessControl($env:MAJIN_AUDIT_PRIVATE_FILE, $acl) } else { [System.IO.File]::SetAccessControl($env:MAJIN_AUDIT_PRIVATE_FILE, $acl) }
  `], { env: { ...process.env, MAJIN_AUDIT_PRIVATE_FILE: file, MAJIN_AUDIT_PRIVATE_DIRECTORY: directory ? '1' : '0' }, windowsHide: true, encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) throw new Error(`Unable to protect audit file: ${result.error?.message || result.stderr || 'ACL operation failed'}`);
}
