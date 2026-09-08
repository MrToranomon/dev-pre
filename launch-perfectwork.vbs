Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = folder
exe = folder & "\dist\releases\2.6.0\TigerGate-win32-x64\TigerGate.exe"
If fso.FileExists(exe) Then
  shell.Run Chr(34) & exe & Chr(34), 1, False
Else
  shell.Run Chr(34) & folder & "\node_modules\electron\dist\electron.exe" & Chr(34) & " " & Chr(34) & folder & Chr(34), 1, False
End If
