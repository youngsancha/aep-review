@echo off
rem aep-review 로컬 PWA 서버 런처 (바탕화면 아이콘이 이 파일을 실행).
rem %~dp0 = 이 .cmd 가 있는 폴더(...\aep-review\scripts\).
title aep-review local server
python "%~dp0serve_local.py"
rem Ctrl+C 로 끝났을 때 마지막 메시지를 볼 수 있게 잠깐 멈춤.
pause >nul
