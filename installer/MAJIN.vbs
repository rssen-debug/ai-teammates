' MAJIN — the hidden launcher: starts the agent with NO console window.
' The app opens in your browser window; that window is what MAJIN looks like.
Dim shell, fso, dir
Set shell = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = dir
shell.Run Chr(34) & dir & "\majin-win-x64.exe" & Chr(34) & " start --no-window", 0, False
Set shell = Nothing
Set fso = Nothing
