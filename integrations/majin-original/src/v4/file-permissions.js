import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

/** Read permissions without reading file contents or changing the ACL. */
export function privateFilePermissions(file) {
  if (process.platform !== 'win32') return (fs.statSync(file).mode & 0o077) === 0;
  // NTFS ACLs, not POSIX mode bits, control access on Windows. Permit the
  // current owner, SYSTEM and Administrators; reject other read/write grants.
  const command = `
    $ErrorActionPreference = 'Stop'
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $trusted = @($me, 'S-1-5-18', 'S-1-5-32-544')
    $acl = [System.IO.File]::GetAccessControl($env:MAJIN_ACL_PROBE)
    foreach ($ace in $acl.Access) {
      $sid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
      if ($ace.AccessControlType -eq 'Allow' -and $sid -notin $trusted -and ([int]$ace.FileSystemRights -band 7)) { exit 1 }
    }
    exit 0
  `;
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, MAJIN_ACL_PROBE: file }, windowsHide: true, timeout: 10_000, stdio: 'ignore',
  });
  return out.status === 0;
}
