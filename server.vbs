' Runs the dashboard server hidden (no console window) and restarts it 3 s after
' it exits. A .cmd loop can get stuck on an invisible
' "Terminate batch job (Y/N)?" prompt. Looping here also keeps this process alive
' as long as the server runs, which is what makes the task's IgnoreNew watchdog work.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
Do
  sh.Run "node server.js", 0, True
  WScript.Sleep 3000
Loop
