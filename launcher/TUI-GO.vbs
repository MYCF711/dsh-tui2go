Option Explicit
' TUI2GO desktop entry: open a terminal in the play root, then type the launcher
' command into it. Portable: every path below is derived at run time.
'   play root : %DSH_GO_PLAY%  ->  %TEMP%\TUI2GO-PLAY
'   launcher  : run-019.cmd next to this .vbs (WScript.ScriptFullName)
'   terminal  : %DSH_ELYTERMINAL%
'               -> <pkg>\..\..\tools\ELYTerminal\app\elyterminal.exe   (packaged)
'               -> <pkg>\..\..\..\tools\ELYTerminal\app\elyterminal.exe (workspace)
'               -> none found: skip the terminal, run the launcher directly
'   window    : the AppActivate title is the play root's basename
'   waits     : %DSH_GO_TUI_WAIT_MS% (default 4000), %DSH_GO_TUI_SETTLE_MS% (600)
' Never fail on a missing terminal or a missing play root: create the root, and
' fall back to a plain console instead of silently doing nothing.
Dim sh, fso, scriptDir, cmdPath, play, ely, cand, title, waitMs, settleMs
Dim t1, t2, i
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
cmdPath = fso.BuildPath(scriptDir, "run-019.cmd")

' ---------------------------------------------------------------- play root
play = sh.ExpandEnvironmentStrings("%DSH_GO_PLAY%")
If play = "%DSH_GO_PLAY%" Then play = ""
If play = "" Then play = sh.ExpandEnvironmentStrings("%TEMP%") & "\TUI2GO-PLAY"
Do While Len(play) > 3 And Right(play, 1) = "\"
  play = Left(play, Len(play) - 1)
Loop
If Not fso.FolderExists(play) Then sh.Run "cmd /d /c mkdir """ & play & """", 0, True

' ------------------------------------------------------------ wait durations
waitMs = 4000
settleMs = 600
t1 = sh.ExpandEnvironmentStrings("%DSH_GO_TUI_WAIT_MS%")
If IsNumeric(t1) Then waitMs = CLng(t1)
t2 = sh.ExpandEnvironmentStrings("%DSH_GO_TUI_SETTLE_MS%")
If IsNumeric(t2) Then settleMs = CLng(t2)

' ------------------------------------------------------------------ terminal
ely = sh.ExpandEnvironmentStrings("%DSH_ELYTERMINAL%")
If Not fso.FileExists(ely) Then ely = ""
If ely = "" Then
  cand = fso.GetAbsolutePathName(scriptDir & "\..\..\tools\ELYTerminal\app\elyterminal.exe")
  If fso.FileExists(cand) Then ely = cand
End If
If ely = "" Then
  cand = fso.GetAbsolutePathName(scriptDir & "\..\..\..\tools\ELYTerminal\app\elyterminal.exe")
  If fso.FileExists(cand) Then ely = cand
End If

If fso.FolderExists(play) Then sh.CurrentDirectory = play
If ely = "" Then
  ' No terminal available on this machine: run the launcher in a plain console.
  ' Failing here would make the shortcut useless, so this is a fallback, not an error.
  sh.Run "cmd /d /c """ & cmdPath & """", 1, False
  WScript.Quit 0
End If
sh.Run """" & ely & """ -d """ & play & """", 1, False
WScript.Sleep waitMs

' --------------------------------------------------------------- type it in
title = play
i = InStrRev(title, "\")
If i > 0 Then title = Mid(title, i + 1)
i = 0
Do
  If sh.AppActivate(title) Then Exit Do
  WScript.Sleep 500
  i = i + 1
Loop While i < 10
If sh.AppActivate(title) Then
  WScript.Sleep settleMs
  sh.SendKeys "cmd /c """ & SKEsc(cmdPath) & """" & "{ENTER}"
End If

' SendKeys treats these as key syntax; a plugin installed under a parenthesised
' directory name would otherwise send mangled text (or nothing at all).
Function SKEsc(text)
  Dim out, j, ch
  out = ""
  For j = 1 To Len(text)
    ch = Mid(text, j, 1)
    If InStr("+^%~(){}[]", ch) > 0 Then
      out = out & "{" & ch & "}"
    Else
      out = out & ch
    End If
  Next
  SKEsc = out
End Function
