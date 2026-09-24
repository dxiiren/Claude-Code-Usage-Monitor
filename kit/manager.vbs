' Starts the Account Manager web app (web\start.js -> web\build) with no console window.
' Registered as HKCU Run "ClaudeUsageManager" by setup.ps1; also used by `just manager-start`.
' start.js pins HOST=127.0.0.1 / PORT=47291. Its full path is on node's command line so
' Stop-Manager can find this exact process.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
webDir = fso.BuildPath(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)), "web")
sh.CurrentDirectory = webDir
sh.Run "node """ & fso.BuildPath(webDir, "start.js") & """", 0, False
