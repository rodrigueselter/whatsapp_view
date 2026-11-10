@echo off
rem Inicia o visualizador: abre a janela para escolher o export (.zip);
rem cancelar sobe a interface de upload. Argumentos extras vão para o .ps1
rem (ex.: iniciar.cmd -Port 8080).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0iniciar.ps1" %*
if errorlevel 1 pause
