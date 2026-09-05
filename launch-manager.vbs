Option Explicit

Dim shell, fileSystem, folder, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
folder = fileSystem.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = folder
command = "node """ & folder & "\manage.mjs"""
shell.Run command, 0, False
