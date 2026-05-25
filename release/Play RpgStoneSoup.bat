@echo off
REM One-click launcher -- runs RpgStoneSoup.exe from the folder this
REM .bat lives in, so you can keep the release on a flash drive or
REM elsewhere and not worry about working directory.
cd /d "%~dp0"
start "" "RpgStoneSoup.exe"
