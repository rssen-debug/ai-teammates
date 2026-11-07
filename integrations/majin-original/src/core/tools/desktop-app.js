import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { def } from './registry.js';
import fs from 'node:fs';
import path from 'node:path';

// A narrow deterministic app launcher. No shell text or model/provider calls.
export const desktopAppTools = [def({
  name: 'desktop.open_notepad', group: 'control', risk: 'exec',
  desc: 'Open a new Windows Notepad window. Does not type or verify document contents.',
  params: {},
  async run() {
    if (process.platform !== 'win32') return { ok: false, error: { code: 'unsupported_host', message: 'Windows required' } };
    const script = "$p = Start-Process -FilePath notepad.exe -PassThru; @{pid=$p.Id; launched=$true} | ConvertTo-Json -Compress";
    const { stdout } = await promisify(execFile)('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15000 });
    return { ok: true, result: JSON.parse(stdout.trim()), summary: 'Notepad launch requested; inspect windows next' };
  },
}), def({
  name: 'desktop.capture_window', group: 'control', risk: 'read',
  desc: 'Capture an observed HWND using Windows PrintWindow. Returns PNG; caller must inspect pixels, including for blank capture.',
  params: { hwnd: 'string: observed numeric window handle', path: 'string: PNG output file' },
  async run({ hwnd, path: output }) {
    if (process.platform !== 'win32' || !/^\d+$/.test(hwnd)) throw new Error('Windows and numeric HWND required');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const script = String.raw`
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CaptureWindow {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
}
'@
$h=[IntPtr]::new([long]$env:MAJIN_CAPTURE_HWND)
$r=New-Object CaptureWindow+Rect
if(-not [CaptureWindow]::GetWindowRect($h,[ref]$r)){throw 'Window unavailable'}
$b=New-Object Drawing.Bitmap ($r.Right-$r.Left),($r.Bottom-$r.Top)
$g=[Drawing.Graphics]::FromImage($b)
$dc=$g.GetHdc()
try { $ok=[CaptureWindow]::PrintWindow($h,$dc,2) } finally { $g.ReleaseHdc($dc) }
try { if(-not $ok){throw 'PrintWindow failed'}; $b.Save($env:MAJIN_CAPTURE_FILE,[Drawing.Imaging.ImageFormat]::Png) }
finally { $g.Dispose(); $b.Dispose() }
`;
    await promisify(execFile)('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
      { timeout: 15000, windowsHide: true, env: { ...process.env, MAJIN_CAPTURE_HWND: hwnd, MAJIN_CAPTURE_FILE: output } });
    const bytes = fs.readFileSync(output);
    if (bytes.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid PNG');
    return { ok: true, result: 'Window captured; visual content requires separate inspection', meta: { path: output, bytes: bytes.length } };
  },
})];
