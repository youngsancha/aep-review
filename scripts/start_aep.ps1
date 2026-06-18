# start_aep.ps1
# ----------------------------------------------------------------------------
# 1. aep-review 서버를 백그라운드로 기동 (host=0.0.0.0)
# 2. 8767 LISTENING 까지 대기
# 3. Windows Firewall 인바운드 규칙
# 4. LAN IP + QR 표시
# 5. 호스트 PC 브라우저로 localhost:8767 자동 오픈
#
# 사용:
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\start_aep.ps1
# ----------------------------------------------------------------------------

$ErrorActionPreference = "Stop"

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$Port        = 8767
$FwRuleName  = "aep-review PWA"
$LogDir      = Join-Path $ProjectRoot "logs"
$StdoutLog   = Join-Path $LogDir "server.stdout.log"
$StderrLog   = Join-Path $LogDir "server.stderr.log"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
chcp 65001 > $null 2>&1

Write-Host ""
Write-Host "  AEP Review Launcher" -ForegroundColor Blue
Write-Host "  -------------------" -ForegroundColor DarkGray
Write-Host ""

# --- 1. 서버 기동 ---
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    Write-Host "  [OK] 서버 이미 실행 중 (PID=$($listening[0].OwningProcess))" -ForegroundColor Green
} else {
    Write-Host "  [.] 서버 기동 중..." -ForegroundColor Yellow
    $env:AEP_RELOAD = "0"

    $pythonw = $null
    try {
        $pyExeDir = (& py -c "import sys, os; print(os.path.dirname(sys.executable))").Trim()
        $candidate = Join-Path $pyExeDir "pythonw.exe"
        if (Test-Path $candidate) { $pythonw = $candidate }
    } catch {}

    if ($pythonw) {
        Write-Host "  [.] pythonw: $pythonw" -ForegroundColor DarkGray
        Start-Process -FilePath $pythonw `
            -ArgumentList "-m", "api.run" `
            -WorkingDirectory $ProjectRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $StdoutLog `
            -RedirectStandardError  $StderrLog
    } else {
        Write-Host "  [.] pythonw 없음 -> py.exe (hidden)" -ForegroundColor DarkGray
        Start-Process -FilePath "py" `
            -ArgumentList "-m", "api.run" `
            -WorkingDirectory $ProjectRoot `
            -WindowStyle Hidden
    }

    $deadline = (Get-Date).AddSeconds(15)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        $check = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if ($check) { $ready = $true; break }
        Start-Sleep -Milliseconds 300
    }
    if ($ready) {
        Write-Host "  [OK] 서버 시작 완료" -ForegroundColor Green
    } else {
        Write-Host "  [X] 서버 시작 실패 (15초 timeout)" -ForegroundColor Red
        if (Test-Path $StderrLog) {
            Write-Host ""
            Write-Host "  --- stderr (마지막 20줄) ---" -ForegroundColor DarkGray
            Get-Content $StderrLog -Tail 20 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkYellow }
        }
        Write-Host ""
        Read-Host "  Enter 누르면 닫힘"
        exit 1
    }
}

# --- 2. 방화벽 규칙 ---
$existingRule = Get-NetFirewallRule -DisplayName $FwRuleName -ErrorAction SilentlyContinue
if (-not $existingRule) {
    $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($isAdmin) {
        try {
            New-NetFirewallRule `
                -DisplayName $FwRuleName `
                -Direction   Inbound `
                -Action      Allow `
                -Protocol    TCP `
                -LocalPort   $Port `
                -Profile     Private,Public `
                -Description "aep-review PWA inbound (LAN access from phone)" | Out-Null
            Write-Host "  [OK] 방화벽 규칙 추가: $FwRuleName" -ForegroundColor Green
        } catch {
            Write-Host "  [!] 방화벽 규칙 추가 실패: $_" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  [!] 방화벽 규칙 없음. 폰 접속 안 되면 한 번만 관리자 PowerShell로:" -ForegroundColor Yellow
        Write-Host "      New-NetFirewallRule -DisplayName '$FwRuleName' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private,Public" -ForegroundColor DarkGray
    }
}

Write-Host ""

# --- 3. QR + URL ---
$showQrPath = Join-Path $ScriptDir "show_qr.py"
if (Test-Path $showQrPath) {
    Set-Location $ProjectRoot
    & py $showQrPath --port $Port
} else {
    Write-Host "  [!] show_qr.py 없음 — URL만:" -ForegroundColor Yellow
    Write-Host "      http://localhost:$Port" -ForegroundColor White
}

# --- 4. 호스트 브라우저 ---
Write-Host ""
Write-Host "  [.] 호스트 브라우저 자동 오픈..." -ForegroundColor Yellow
Start-Process "http://localhost:$Port"

Write-Host ""
Write-Host "  -------------------" -ForegroundColor DarkGray
Write-Host "  서버 실행 중. 폰에서 위 QR 스캔하세요." -ForegroundColor White
Write-Host "  종료: 바탕화면 ■ 아이콘 또는 scripts\stop_aep.ps1" -ForegroundColor DarkGray
Write-Host ""
Read-Host "  Enter 누르면 이 창 닫힘 (서버는 계속 실행)"
