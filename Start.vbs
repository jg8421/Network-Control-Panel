Option Explicit
Dim shell, fso, root, script
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
script = fso.BuildPath(root, "scripts\Start-Panel.ps1")
If Not fso.FileExists(script) Then
  MsgBox "Start-Panel.ps1 is missing. Extract the complete ZIP first.", 48, "Network Panel"
  WScript.Quit 1
End If
shell.Run "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """", 0, False
