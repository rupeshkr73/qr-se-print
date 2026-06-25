@echo off
title QR Se Print - Agent Installer
color 0A
cls

echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║       QR Se Print - Windows Installer        ║
echo  ╚══════════════════════════════════════════════╝
echo.
echo  Aapka Shop ID already set hai is package mein.
echo.
pause

:: Python check
echo [1/4] Python check...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Python nahi mila!
    echo https://python.org/downloads pe jao, "Add to PATH" tick karke install karo
    start https://www.python.org/downloads/
    pause
    exit /b 1
)
echo ✅ Python OK!

:: Packages install
echo [2/4] Packages install ho rahe hain...
python -m pip install requests pywin32 Pillow PyPDF2 pycryptodome --quiet
echo ✅ Packages ready!

:: SumatraPDF
echo [3/4] SumatraPDF check...
if exist "%ProgramFiles%\SumatraPDF\SumatraPDF.exe" (
    echo ✅ SumatraPDF ready!
) else (
    echo Installing SumatraPDF...
    winget install SumatraPDF.SumatraPDF --silent >nul 2>&1
    if %errorlevel% equ 0 (echo ✅ SumatraPDF install ho gaya!) else (echo ⚠️  Manually install karo: sumatrapdfreader.org)
)

:: Run files banana
echo [4/4] Final setup...
echo @echo off > RUN_AGENT.bat
echo title QR Se Print Agent >> RUN_AGENT.bat
echo cd /d "%%~dp0" >> RUN_AGENT.bat
echo python print_agent.py >> RUN_AGENT.bat
echo pause >> RUN_AGENT.bat

choice /c YN /m "Startup mein add karo? (PC on hote hi start ho)"
if %errorlevel% equ 1 (
    echo @echo off > "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\QRSePrint.bat"
    echo cd /d "%~dp0" >> "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\QRSePrint.bat"
    echo python print_agent.py >> "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\QRSePrint.bat"
    echo ✅ Startup mein add ho gaya!
)

echo.
echo ╔══════════════════════════════════════════════╗
echo ║           ✅ SETUP COMPLETE!                 ║
echo ║   RUN_AGENT.bat se agent start karo          ║
echo ╚══════════════════════════════════════════════╝
echo.

choice /c YN /m "Abhi agent start karo?"
if %errorlevel% equ 1 python print_agent.py
pause
