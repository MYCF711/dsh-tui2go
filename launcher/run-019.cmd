@echo off
rem ---------------------------------------------------------------------------
rem TUI2GO launcher. Portable: no machine-specific path lives in this file.
rem   play root  : %DSH_GO_PLAY%  (unset -> %TEMP%\TUI2GO-PLAY)
rem   plugin cwd : %~dp0..        (launcher/.. is the plugin root)
rem   node       : the system PATH; %ProgramFiles%\nodejs only as a fallback
rem Everything below is derived from those three, so copying the plugin to any
rem directory (or another machine) keeps working.
rem ---------------------------------------------------------------------------
setlocal
rem Play root = runtime state: home/ (DSH_HOME), dsh-go-fresh/ (DSH_GO_HOME),
rem bin/dshd.exe and logs/. It deliberately does NOT default to %~dp0: the
rem launcher ships inside the plugin/repo, while the play root is per-machine
rem state that must stay outside it and survive a copy of the repository.
if not defined DSH_GO_PLAY set "DSH_GO_PLAY=%TEMP%\TUI2GO-PLAY"
set "PLAY=%DSH_GO_PLAY%"
rem Normalize to a full path (strips a trailing separator, resolves relative
rem input) so the same spelling is used by cmd, node and the .vbs title match.
for %%I in ("%PLAY%") do set "PLAY=%%~fI"
if not exist "%PLAY%" mkdir "%PLAY%" >nul 2>nul
rem Isolation invariant: HOME / USERPROFILE / DSH_HOME are ALWAYS rebuilt from
rem PLAY, never inherited, so a launch can never touch the real user profile.
set "HOME=%PLAY%"
set "USERPROFILE=%PLAY%"
set "DSH_HOME=%PLAY%\home"
rem dshd location may be overridden (it is only a binary, never state); the
rem agent home is not, for the same isolation reason as DSH_HOME above.
if not defined DSH_GO_DSHD set "DSH_GO_DSHD=%PLAY%\bin\dshd.exe"
set "DSH_GO_HOME=%PLAY%\dsh-go-fresh"
rem Permission policy is the HOST's decision  -  not this launcher's, not the TUI
rem plugin's. The product default is "allow" (cmd/dshd/serve.go; the user asked
rem on 2026-11-04 for full permissions, see CHANGELOG 0.2.1-go.31). This file
rem used to pin "ask", and src/backend.ts used to fall back to "ask" when unset
rem and always pass --policy, so every shortcut launch silently overrode the
rem product default either way. t12 removed the plugin fallback; do NOT re-pin a
rem value here  -  keep this file free of policy opinions.
rem Clear an inherited value too: "the host decides" must hold even when the
rem parent shell happens to carry DSH_GO_POLICY, exactly like DSH_GO_DEBUG_LOG
rem is cleared below. An explicit override belongs to a controlled caller that
rem does not go through this product entry point.
set "DSH_GO_POLICY="
rem Model id uses the gateway's fully-qualified form (with the group/ prefix):
rem the host's built-in capacity table and model catalog are keyed by it. The
rem unprefixed spelling misses the exact match, falls back to "undeclared custom
rem model" and injects max_tokens=128000 into EVERY request (the host also
rem normalizes a unique alias as a backstop, but the launcher should be correct).
set "DSH_GO_MODEL=group/deepseek-v4.1-flash-1017"
set "DSHD_LLM_BASE=http://127.0.0.1:3425/v1"
rem Debug log is OFF by default: TUI2GO appends synchronously on the render hot
rem path (modes.current / modes.list) and the JSONL carries the full request
rem params/body, so one session can write MiB-scale files. To debug, run
rem "set DSH_GO_DEBUG=1" before launching; the same file is truncated before the
rem TUI starts, so it cannot grow without bound.
rem Single-line ifs on purpose: this batch file is LF-only, and multi-line
rem parenthesized blocks are the fragile shape under cmd.exe.
if defined DSH_GO_DEBUG if not exist "%PLAY%\logs" mkdir "%PLAY%\logs" >nul
if defined DSH_GO_DEBUG set "DSH_GO_DEBUG_LOG=%PLAY%\logs\tui2go-debug.jsonl"
if defined DSH_GO_DEBUG type nul > "%PLAY%\logs\tui2go-debug.jsonl"
rem Clear an inherited path too: "default off" must be truly off, not just unset.
if not defined DSH_GO_DEBUG set "DSH_GO_DEBUG_LOG="
rem --- node: trust the system PATH, fall back to the default install dir only ---
rem The launcher used to prepend the default install dir to PATH unconditionally.
rem Do not reintroduce that: a portable launcher must honour whatever node the
rem host has (nvm, fnm, a portable zip, the installer) and only guess when PATH
rem has none at all.
set "PATH=%PLAY%\npm\node_modules\.bin;%PATH%"
where node >nul 2>nul
if not errorlevel 1 goto :node_ok
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
:node_ok
where node >nul 2>nul
if errorlevel 1 goto :no_node
rem --- plugin cwd: launcher/.. is the plugin root, wherever it was copied to ---
cd /d "%~dp0.."
if errorlevel 1 goto :no_plugin
if not exist "%~dp0..\package.json" goto :no_plugin
node "%~dp0install-play.mjs" --ensure
if errorlevel 1 exit /b %errorlevel%
node "%DSH_HOME%\profiles\dsh-tui\node_modules\@deepseek-harness-tui\dsh-tui\bin\dsh-tui.js" --backend dsh-go %*
exit /b %errorlevel%
goto :eof

:no_node
echo [run-019] ERROR: node.exe not found on PATH and not in "%ProgramFiles%\nodejs".
echo [run-019] Install Node.js 22.19+ or 24+, or put node.exe on PATH.
exit /b 3

:no_plugin
echo [run-019] ERROR: plugin root not found at "%~dp0.." (no package.json there).
echo [run-019] run-019.cmd must stay inside the plugin's launcher/ directory.
exit /b 4
