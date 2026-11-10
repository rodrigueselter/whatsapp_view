@echo off
rem Sobe o visualizador sem export: o .zip é enviado pela interface no navegador.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0iniciar.ps1" -Interface %*
if errorlevel 1 pause
