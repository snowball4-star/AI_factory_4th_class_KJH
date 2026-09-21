@echo off
REM ============================================================
REM  PubMed weekly collector - wrapper for Windows Task Scheduler
REM
REM  Runs every Friday and saves the last 7 days of new papers
REM  into the data\ folder. The Korean summary report is written
REM  separately in Claude Code via /pubmed-weekly.
REM
REM  Manual run:  scripts\run-weekly.cmd
REM  Log file:    logs\run-weekly.log
REM
REM  NOTE: keep this file ASCII-only. cmd.exe parses batch files
REM  in the legacy ANSI codepage, so UTF-8 Korean text here breaks
REM  command parsing even with `chcp 65001`.
REM ============================================================

chcp 65001 >nul

REM Work from the quest folder (parent of this scripts\ folder)
cd /d "%~dp0.."

set "KEYWORD=glaucoma"
set "DAYS=7"

if not exist "logs" mkdir "logs"

echo. >> "logs\run-weekly.log"
echo ==================== %DATE% %TIME% ==================== >> "logs\run-weekly.log"

node "scripts\fetch-pubmed.js" --keyword "%KEYWORD%" --days %DAYS% --out "data" >> "logs\run-weekly.log" 2>&1

if errorlevel 1 (
  echo [FAILED] exit code %errorlevel% >> "logs\run-weekly.log"
  exit /b %errorlevel%
)

echo [OK] >> "logs\run-weekly.log"
exit /b 0
