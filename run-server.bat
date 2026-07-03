@echo off
rem Keeps Channel Gateway running: restarts node if it ever exits.
rem If another instance already holds port 8090, just wait (no fighting).
cd /d "D:\Claud\FIFA"
:loop
netstat -ano | findstr ":8090" | findstr "LISTENING" >nul
if not errorlevel 1 (
  timeout /t 15 /nobreak >nul
  goto loop
)
echo [%date% %time%] starting server >> "D:\Claud\FIFA\server.log"
"C:\Program Files\nodejs\node.exe" server.js >> "D:\Claud\FIFA\server.log" 2>&1
echo [%date% %time%] server exited, restarting in 3s >> "D:\Claud\FIFA\server.log"
timeout /t 3 /nobreak >nul
goto loop
