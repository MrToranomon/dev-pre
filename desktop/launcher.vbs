Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
shell.Run Chr(34) & folder & "\TigerGate.exe" & Chr(34), 1, False
