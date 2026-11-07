/**
 * MAJIN — Windows computer control, lane 1: Win32 messaging (the SURVIVOR).
 *
 * Real-world audit (win-control-poc v2.6, 2026-10-20, reproduced twice on
 * windows-latest): the classic UIA ValuePattern lane exposes Bare Panes on the
 * windows-2025 image (Notepad Edit = Pane, 0 patterns), SendKeys cannot focus
 * in Session-0 — but the Win32 SendMessage lane (WM_SETTEXT → WM_GETTEXT →
 * BM_CLICK) round-trips deterministically against REAL legacy controls.
 *
 * So MAJIN's control surface starts here and is honest about its reach:
 *   control.list_windows — what windows exist on the desktop
 *   control.type         — write VERIFYING text into a named window's text field
 *   control.read         — read it back
 *   control.click_button — BM_CLICK a button by caption (Run-dialog OK etc.)
 *
 * Every op carries a negative control: the verdict claims only what a
 * measured read-back proves. UIA/SendKeys lanes WILL be added once they
 * survive measurement — never before.
 *
 * Transport: PowerShell child process with an inlined script (zero native
 * modules, zero dynamic imports — vm-safe for the packaged exe).
 * Risk: 'exec' — driving another window is guarded like shell.run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { def } from './registry.js';
import { IS_WIN } from './shell.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PS = String.raw`
# MAJIN control bridge — inlined by src/core/tools/wincontrol.js (ps1 template)
param([string]$Action, [string]$Window = '', [string]$Text = '', [string]$Caption = '')
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$src = @'
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public class Ctl {
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string cls, string title);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, string l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, StringBuilder l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  public const int WM_GETTEXT=0x0D, WM_GETTEXTLENGTH=0x0E, WM_SETTEXT=0x0C, BM_CLICK=0x00F5;
  public static string TextOf(IntPtr h){ var sb=new StringBuilder(1024); SendMessage(h, WM_GETTEXT, (IntPtr)sb.Capacity, sb); return sb.ToString(); }
  public static string ClassOf(IntPtr h){ var sb=new StringBuilder(256); GetClassName(h, sb, sb.Capacity); return sb.ToString(); }
  public static List<Dictionary<string,string>> Tops(){
    var tops = new List<Dictionary<string,string>>();
    EnumWindows((h,l)=>{ if(IsWindowVisible(h)){ var sb=new StringBuilder(256); GetWindowText(h,sb,sb.Capacity); var t=sb.ToString();
      tops.Add(new Dictionary<string,string>{{"hwnd",h.ToString()},{"title",t},{"class",ClassOf(h)}}); } return true; }, IntPtr.Zero);
    return tops;
  }
  public static IntPtr FindTop(string titlePart){
    if(titlePart.StartsWith("hwnd:")){ long n; if(long.TryParse(titlePart.Substring(5),out n)){var h=new IntPtr(n); return IsWindowVisible(h)?h:IntPtr.Zero;} return IntPtr.Zero; }
    IntPtr found=IntPtr.Zero; IntPtr exact=IntPtr.Zero; int matches=0; int exactMatches=0; var low=titlePart.ToLower();
    EnumWindows((h,l)=>{ if(IsWindowVisible(h)){ var sb=new StringBuilder(512); GetWindowText(h,sb,sb.Capacity);
      var title=sb.ToString().ToLower();
      if(title==low){exact=h;exactMatches++;}
      if(title.Contains(low)){found=h;matches++;} } return true; }, IntPtr.Zero);
    return exactMatches==1?exact:(matches==1?found:IntPtr.Zero);
  }
  public static IntPtr FindChildEdit(IntPtr parent){ IntPtr edit=IntPtr.Zero;
    EnumChildWindows(parent,(h,l)=>{ var c=ClassOf(h); if(c=="Edit"||c=="RichEdit20W"||c=="RichEdit50W"||c=="RichEditD2DPT"||c.StartsWith("WindowsForms10.EDIT.",StringComparison.OrdinalIgnoreCase)){ if(edit==IntPtr.Zero) edit=h; } else if(edit==IntPtr.Zero && c=="ComboBoxEx32"){ edit=h; } return true; }, IntPtr.Zero);
    return edit;
  }
  public static IntPtr FindButton(IntPtr parent, string caption){ IntPtr btn=IntPtr.Zero; var low=caption.ToLower();
    EnumChildWindows(parent,(h,l)=>{ if(ClassOf(h)=="Button"||ClassOf(h).StartsWith("WindowsForms10.BUTTON.",StringComparison.OrdinalIgnoreCase)){ var sb=new StringBuilder(256); SendMessage(h, WM_GETTEXT, (IntPtr)sb.Capacity, sb);
      var t=sb.ToString().Replace("&","").ToLower(); if(t.Contains(low)){ btn=h; return false; } } return true; }, IntPtr.Zero);
    return btn;
  }
}
'@
Add-Type -TypeDefinition $src -ReferencedAssemblies System.Windows.Forms -Language CSharp
function Out($o){ ($o | ConvertTo-Json -Depth 5 -Compress) }
function Fail($code, $msg, $hint = $null){ Out @{ ok = $false; error = @{ code = $code; message = $msg; hint = $hint } }; exit 0 }
$text = if ($Text -eq '') { '' } else { $Text }
switch ($Action) {
  'list' {
    $tops = [Ctl]::Tops() | Where-Object { $_.title -ne '' } | Select-Object -First 40
    Out @{ ok = $true; count = @($tops).Count; windows = @($tops) }
  }
  'type' {
    $w = [Ctl]::FindTop($Window); if ($w -eq [IntPtr]::Zero) { Fail 'window_not_found' ("no visible top window containing '" + $Window + "' is present") 'open the app first, or pass a shorter unique part of its title' }
    $e = [Ctl]::FindChildEdit($w); if ($e -eq [IntPtr]::Zero) { Fail 'edit_not_found' ("window '" + $Window + "' has no Edit-class text control") 'this is the Win32 lane — the app may need the future UIA lane' }
    [void][Ctl]::SendMessage($e, [Ctl]::WM_SETTEXT, [IntPtr]::Zero, $text)
    $read = [Ctl]::TextOf($e)
    if ($read -ne $text) { Fail 'verify_failed' ("WM_GETTEXT mismatch: expected '" + $text + "' got '" + $read + "'") 'the control refused the write — control surface recorded honestly' }
    Out @{ ok = $true; window = $Window; hwnd = $w.ToInt64(); edit = $e.ToInt64(); written = $text; verified = $true }
  }
  'read' {
    $w = [Ctl]::FindTop($Window); if ($w -eq [IntPtr]::Zero) { Fail 'window_not_found' ("no visible top window containing '" + $Window + "' is present") $null }
    $e = [Ctl]::FindChildEdit($w); if ($e -eq [IntPtr]::Zero) { Fail 'edit_not_found' ("window '" + $Window + "' has no Edit-class text control") $null }
    Out @{ ok = $true; window = $Window; text = [Ctl]::TextOf($e) }
  }
  'inspect' {
    $w = [Ctl]::FindTop($Window); if ($w -eq [IntPtr]::Zero) { Fail 'window_not_found' 'Window not found' $null }
    $script:children = [System.Collections.Generic.List[object]]::new()
    [void][Ctl]::EnumChildWindows($w, { param($h,$l)
      $script:children.Add(@{hwnd=$h.ToInt64(); class=[Ctl]::ClassOf($h); text=[Ctl]::TextOf($h)})
      return $true
    }, [IntPtr]::Zero)
    Out @{ok=$true; window=$Window; children=@($script:children.ToArray())}
  }
  'focus' {
    $w = [Ctl]::FindTop($Window); if ($w -eq [IntPtr]::Zero) { Fail 'window_not_found' 'Window not found' $null }
    [void][Ctl]::ShowWindow($w, 9)
    [void][Ctl]::SetForegroundWindow($w)
    if ([Ctl]::GetForegroundWindow() -ne $w) {
      $from = [Ctl]::GetCurrentThreadId()
      $to = [Ctl]::GetWindowThreadProcessId([Ctl]::GetForegroundWindow(), [IntPtr]::Zero)
      $attached = [Ctl]::AttachThreadInput($from, $to, $true)
      try { [void][Ctl]::SetForegroundWindow($w) }
      finally { if ($attached) { [void][Ctl]::AttachThreadInput($from, $to, $false) } }
    }
    Start-Sleep -Milliseconds 250
    if ([Ctl]::GetForegroundWindow() -ne $w) { Fail 'focus_denied' 'Windows refused foreground focus' $null }
    Out @{ok=$true; hwnd=$w.ToInt64(); foregroundVerified=$true}
  }
  'click' {
    $w = [Ctl]::FindTop($Window); if ($w -eq [IntPtr]::Zero) { Fail 'window_not_found' ("no visible top window containing '" + $Window + "' is present") $null }
    $b = [Ctl]::FindButton($w, $Caption); if ($b -eq [IntPtr]::Zero) { Fail 'button_not_found' ("no Button with caption containing '" + $Caption + "' in '" + $Window + "'") $null }
    [void][Ctl]::SendMessage($b, [Ctl]::BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 250
    Out @{ ok = $true; window = $Window; button = $Caption; clicked = $true }
  }
  default { Fail 'bad_action' ("unknown action '" + $Action + "'") 'list | type | read | click' }
}
`;

let psFile = null;
function bridgePath() {
  if (psFile && fs.existsSync(psFile)) return psFile;
  // Unique private directory: never execute a predictable shared-temp .ps1.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-control-'));
  const f = path.join(dir, 'bridge.ps1');
  // Windows PowerShell 5.1 decodes bare UTF-8 PS1 as ANSI. A BOM prevents
  // non-ASCII diagnostic hints from corrupting the parser/JSON output.
  fs.writeFileSync(f, '\uFEFF' + PS, { flag: 'wx', mode: 0o600 });
  psFile = f;
  return f;
}

// EncodedCommand is constant; untrusted window/text/caption are opaque JSON in
// the child environment, never interpolated into cmd.exe or PowerShell syntax.
const BRIDGE_ENCODED = Buffer.from([
    '$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MAJIN_CONTROL_PAYLOAD)) | ConvertFrom-Json',
    '& $env:MAJIN_CONTROL_SCRIPT -Action $p.action -Window $p.window -Text $p.text -Caption $p.caption',
  ].join('; '), 'utf16le').toString('base64');
const BRIDGE_COMMAND = 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + BRIDGE_ENCODED;

export function encodeControlRequest(action, { window = '', text = '', caption = '' } = {}) {
  const json = JSON.stringify({ action, window, text, caption });
  // Windows environment variable strings have a finite length; fail cleanly.
  if (Buffer.byteLength(json, 'utf8') > 12000) throw new RangeError('control payload exceeds 12 KB');
  return { command: BRIDGE_COMMAND, payload: Buffer.from(json, 'utf8').toString('base64') };
}

let bridgeWarmed = false;
const READONLY_BRIDGE_ACTIONS = new Set(['list', 'inspect', 'read']);

async function runBridge(action, { window = '', text = '', caption = '' } = {}) {
  let req;
  try { req = encodeControlRequest(action, { window, text, caption }); }
  catch (e) { return { ok: false, error: { code: 'payload_too_large', message: e.message } }; }
  // A nested "powershell -Command powershell -EncodedCommand" loses structured
  // bridge output on real interactive desktops (observed as CLIXML on stderr).
  // Execute the constant encoded script DIRECTLY; user inputs remain opaque
  // JSON in environment, never interpolated into PowerShell source.
  //
  // Cold-start reality: the first PowerShell invocation on a loaded machine
  // pays process + script-compile cost and can exceed a 30s budget (observed
  // in CI as a timeout kill with only a CLIXML progress header). The first
  // call per process therefore gets a longer budget. Read-only actions may
  // retry once after a timeout kill (the runtime is warm by then); mutating
  // actions (type/click/focus) never retry, so an action can never execute
  // twice because its first result was slow to print.
  const spawnOnce = async (timeoutMs) => {
    let stdout = '';
    let stderr = '';
    let failure = null;
    try {
      const run = await execFileAsync('powershell.exe',
        ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',BRIDGE_ENCODED],
        { timeout: timeoutMs, maxBuffer: 120000, windowsHide: true,
          env: { ...process.env, MAJIN_CONTROL_SCRIPT: bridgePath(), MAJIN_CONTROL_PAYLOAD: req.payload } });
      stdout = String(run.stdout || '');
      stderr = String(run.stderr || '');
    } catch (e) {
      failure = e;
      stdout = String(e.stdout || '');
      stderr = String(e.stderr || '');
    }
    return { stdout, stderr, failure };
  };
  let { stdout, stderr, failure } = await spawnOnce(bridgeWarmed ? 30000 : 90000);
  const timedOut = Boolean(failure && failure.killed);
  if (!timedOut) bridgeWarmed = true;
  if (timedOut && READONLY_BRIDGE_ACTIONS.has(action)) {
    ({ stdout, stderr, failure } = await spawnOnce(30000));
    if (!(failure && failure.killed)) bridgeWarmed = true;
  }
  // A PowerShell bridge can produce progress/warnings around the contract
  // JSON. Read the most recent actual JSON object rather than assuming the
  // final output line is the payload.
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  let j = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const candidate = JSON.parse(lines[i]);
      if (candidate && typeof candidate === 'object' && typeof candidate.ok === 'boolean') {
        j = candidate; break;
      }
    } catch { /* continue to another output line */ }
  }
  if (!j) {
    // PowerShell 5.1 can serialize process errors as CLIXML. Extract the
    // actual Error stream and provide a bounded diagnostic, not a fake PASS.
    const psErrors = [...stderr.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
      .map(m => m[1].replace(/_x000D_|_x000A_/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>'))
      .join(' ').slice(-480);
    const plain = stderr.replace(/<[^>]*>/g,' ').replace(/_x000D_|_x000A_/g,' ').replace(/\s+/g,' ').trim();
    const exit = failure ? ('exit=' + String(failure.code ?? '?') + ' signal=' + String(failure.signal ?? '-')) : 'exit=0';
    const detail = psErrors || plain.slice(-620) || String(failure?.message || '').slice(0,180) || 'no JSON output';
    return { ok:false, error: { code:failure?'bridge_exit':'bridge_parse',
      message:'Win32 control bridge ' + exit + ', stdout_bytes=' + stdout.length +
        ', stderr_bytes=' + stderr.length + ', stdout_tail=' +
        stdout.slice(-270).replace(/MAJIN_QA_[A-Z0-9]+/g,'QA_TEXT') + ': ' + detail } };
  }
  if (j.ok === false) return { ok: false, error: { code: j.error?.code || 'control_failed', message: j.error?.message || 'control op failed', hint: j.error?.hint || null }, meta: j };
  return { ok: true, report: j, meta: j };
}

function unsupported() {
  return { ok: false, error: { code: 'unsupported_platform', message: 'control tools drive REAL Windows windows — this lane is Windows-only (Win32 SendMessage). On Linux/macOS the honest answer is no, not a pretend click.', hint: 'run MAJIN on Windows for computer control' } };
}


/* Actual OS mouse pointer movement, NOT the pink instructional overlay.
   The command is constant and the coordinates come through environment data.
   There is no mouse.click or global keystroke injection in this tool. */
async function moveWindowsMouse(x,y) {
  if (!IS_WIN) return unsupported();
  const ix=Number(x), iy=Number(y);
  if (!Number.isSafeInteger(ix)||!Number.isSafeInteger(iy)||
      ix < -32768 || iy < -32768 || ix > 32767 || iy > 32767)
    return {ok:false,error:{code:'bad_coordinate',message:'x/y must be integer Windows screen coordinates'}};
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$v = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$x = [int]$env:MAJIN_MOUSE_X; $y = [int]$env:MAJIN_MOUSE_Y',
    'if ($x -lt $v.Left -or $x -ge $v.Right -or $y -lt $v.Top -or $y -ge $v.Bottom) { throw "coordinates outside virtual screen" }',
    '[System.Windows.Forms.Cursor]::Position = [System.Drawing.Point]::new($x,$y)',
    'Start-Sleep -Milliseconds 100',
    '$p = [System.Windows.Forms.Cursor]::Position',
    'if ($p.X -ne $x -or $p.Y -ne $y) { throw "cursor movement not confirmed" }',
    'Write-Output ("MAJIN_POINTER_VERIFIED:"+$p.X+","+$p.Y)'
  ].join('; ');
  const cmd=Buffer.from(ps,'utf16le').toString('base64');
  try {
    const run=await execFileAsync('powershell.exe', ['-NoProfile','-NonInteractive','-STA','-EncodedCommand',cmd],
      {timeout:12000,windowsHide:true,env:{...process.env,MAJIN_MOUSE_X:String(ix),MAJIN_MOUSE_Y:String(iy)}});
    if(!String(run.stdout).includes('MAJIN_POINTER_VERIFIED:'+ix+','+iy))
      throw new Error('no verified pointer position; a disconnected desktop cannot claim success');
    return {ok:true,result:'Real Windows mouse pointer moved and independently read back at '+ix+','+iy,
      meta:{x:ix,y:iy,verified:true,kind:'real_system_cursor'},summary:'mouse position verified'};
  } catch(e) {
    return {ok:false,error:{code:'mouse_move_failed',message:String(e.stderr||e.message||e).slice(0,300)}};
  }
}

export const winControlTools = [
  def({
    name: 'control.focus', group: 'control', risk: 'exec',
    desc: 'Focus a specific observed hwnd:<number> or unique window title; verify foreground handle.',
    params: { window: 'string: observed window title or hwnd:<number>' },
    async run({ window }) {
      if (!IS_WIN) return unsupported();
      const b = await runBridge('focus', { window: String(window) });
      return b.ok ? { ok: true, result: b.report, meta: b.meta } : b;
    },
  }),
  def({
    name: 'control.inspect', group: 'control', risk: 'read',
    desc: 'Inspect actual Win32 child classes and text in an observed window.',
    params: { window: 'string: unique observed window title' },
    async run({ window }) {
      if (!IS_WIN) return unsupported();
      const b = await runBridge('inspect', { window: String(window) });
      return b.ok ? { ok: true, result: b.report, meta: b.meta } : b;
    },
  }),
  def({
    name: 'mouse.move',
    group: 'control',
    risk: 'exec',
    desc: 'Move the ACTUAL Windows system mouse pointer to specified screen coordinates and verify its position. Requires a real interactive desktop. Does not click, and is separate from cursor.overlay.',
    params: {x:'number: absolute virtual screen X coordinate', y:'number: absolute virtual screen Y coordinate'},
    required: ['x','y'],
    async run({x,y}) { return moveWindowsMouse(x,y); },
  }),

  def({
    name: 'control.list_windows',
    group: 'control',
    risk: 'read',
    desc: 'List the REAL top-level windows on this machine (title + class). Negative-control-verified lane; Windows-only.',
    params: {},
    async run() {
      if (!IS_WIN) return unsupported();
      const b = await runBridge('list');
      if (!b.ok) return b;
      const rows = (b.report.windows || []).map((w) => `  [${w.class}] ${String(w.title).slice(0, 90)}`);
      return { ok: true, result: `${b.report.count} top-level window(s):\n${rows.join('\n') || '(none visible in this session — service sessions see their own desktop only)'}`, meta: b.meta, summary: `${b.report.count} window(s)` };
    },
  }),
  def({
    name: 'control.type',
    group: 'control',
    risk: 'exec',
    desc: 'Write text into the Edit field of a REAL window (title substring) and VERIFY by reading it back. Claim = measured round-trip, never optimism. Windows-only.',
    params: {
      window: 'string: part of the window title, e.g. "Untitled - Notepad"',
      text: 'string: the exact text to write (optional, empty = clear the field)',
    },
    examples: ['control.type({window:"Notepad", text:"hello"})'],
    async run({ window, text = '' }) {
      if (!IS_WIN) return unsupported();
      const b = await runBridge('type', { window: String(window), text: String(text) });
      if (!b.ok) return b;
      return { ok: true, result: `verified write into "${b.report.window}": "${b.report.written}" (WM_SETTEXT→WM_GETTEXT round-trip)`, meta: b.meta, summary: `typed→verified in ${b.report.window}` };
    },
  }),
  def({
    name: 'control.read',
    group: 'control',
    risk: 'read',
    desc: 'Read the current text of a REAL window\'s Edit field (title substring). Windows-only.',
    params: { window: 'string: part of the window title' },
    async run({ window }) {
      if (!IS_WIN) return unsupported();
      const b = await runBridge('read', { window: String(window) });
      if (!b.ok) return b;
      return { ok: true, result: `text of "${b.report.window}": ${JSON.stringify(b.report.text)}`, meta: b.meta, summary: `read ${b.report.text.length} chars` };
    },
  }),
  def({
    name: 'control.click_button',
    group: 'control',
    risk: 'exec',
    desc: 'Click a button by caption in a REAL window via BM_CLICK (e.g. "OK" in the Run dialog). Windows-only.',
    params: {
      window: 'string: part of the window title',
      caption: 'string: part of the button caption, e.g. "OK"',
    },
    async run({ window, caption }) {
      if (!IS_WIN) return unsupported();
      const b = await runBridge('click', { window: String(window), caption: String(caption) });
      if (!b.ok) return b;
      return { ok: true, result: `clicked "${b.report.button}" in "${b.report.window}" (BM_CLICK)`, meta: b.meta, summary: `clicked ${b.report.button}` };
    },
  }),
];
