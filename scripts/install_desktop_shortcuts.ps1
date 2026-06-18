# install_desktop_shortcuts.ps1
# ----------------------------------------------------------------------------
# 바탕화면에 두 개의 아이콘 생성:
#   ▶ AEP Review - Start  → start_aep.ps1
#   ■ AEP Review - Stop   → stop_aep.ps1
#
# 한 번만 실행. 관리자 권한 불필요.
#
# 사용:
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\install_desktop_shortcuts.ps1
# ----------------------------------------------------------------------------

$ErrorActionPreference = "Stop"

try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
chcp 65001 > $null 2>&1

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$Desktop     = [Environment]::GetFolderPath("Desktop")

$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $pwsh) {
    $pwsh = (Get-Command powershell -ErrorAction SilentlyContinue).Source
}
if (-not $pwsh) {
    Write-Host "[!] pwsh / powershell.exe 를 찾을 수 없습니다." -ForegroundColor Red
    exit 1
}

$startScript = Join-Path $ScriptDir "start_aep.ps1"
$stopScript  = Join-Path $ScriptDir "stop_aep.ps1"
$iconPng     = Join-Path $ProjectRoot "ui\icons\icon-192.png"
$iconIco     = Join-Path $ProjectRoot "ui\icons\aep-review.ico"

# --- PNG → ICO ---
if (-not (Test-Path $iconIco) -and (Test-Path $iconPng)) {
    try {
        Add-Type -AssemblyName System.Drawing
        $bmp = [System.Drawing.Bitmap]::FromFile($iconPng)
        $resized = New-Object System.Drawing.Bitmap($bmp, 256, 256)
        $hicon = $resized.GetHicon()
        $icon = [System.Drawing.Icon]::FromHandle($hicon)
        $fs = [System.IO.File]::Create($iconIco)
        $icon.Save($fs)
        $fs.Close()
        $bmp.Dispose(); $resized.Dispose(); $icon.Dispose()
        Write-Host "[+] 아이콘 변환 완료: $iconIco" -ForegroundColor Green
    } catch {
        Write-Host "[!] 아이콘 변환 실패 (기본 아이콘 사용): $_" -ForegroundColor Yellow
        $iconIco = $null
    }
}
if (-not (Test-Path $iconIco)) { $iconIco = $null }

# NOTE: param 이름 $Args 절대 사용 X — PowerShell 자동변수와 충돌
function New-Shortcut {
    param(
        [string]$Path,
        [string]$Target,
        [string]$ArgString,
        [string]$Description,
        [string]$IconPath
    )
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($Path)
    $sc.TargetPath       = $Target
    $sc.Arguments        = $ArgString
    $sc.WorkingDirectory = $ProjectRoot
    $sc.WindowStyle      = 1
    $sc.Description      = $Description
    if ($IconPath -and (Test-Path $IconPath)) {
        $sc.IconLocation = "$IconPath,0"
    }
    $sc.Save()
}

$startLnk = Join-Path $Desktop "AEP Review - Start.lnk"
$stopLnk  = Join-Path $Desktop "AEP Review - Stop.lnk"

New-Shortcut `
    -Path $startLnk `
    -Target $pwsh `
    -ArgString "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`"" `
    -Description "American English Podcast PWA 서버 시작 + QR 표시" `
    -IconPath $iconIco

New-Shortcut `
    -Path $stopLnk `
    -Target $pwsh `
    -ArgString "-NoProfile -ExecutionPolicy Bypass -File `"$stopScript`"" `
    -Description "American English Podcast PWA 서버 종료" `
    -IconPath $iconIco

Write-Host ""
Write-Host "  [OK] 바탕화면 아이콘 설치 완료" -ForegroundColor Green
Write-Host "    - $startLnk" -ForegroundColor White
Write-Host "    - $stopLnk" -ForegroundColor White
Write-Host ""
Write-Host "  사용:" -ForegroundColor Cyan
Write-Host "    1. ▶ AEP Review - Start 더블클릭 -> 서버 시작 + QR" -ForegroundColor White
Write-Host "    2. 폰 카메라로 QR 스캔 -> Chrome/Safari -> 홈화면 추가" -ForegroundColor White
Write-Host "    3. 다 쓰면 ■ AEP Review - Stop 더블클릭 -> 서버 종료" -ForegroundColor White
Write-Host ""
Write-Host "  방화벽 안내:" -ForegroundColor Cyan
Write-Host "    첫 실행 시 Windows 방화벽 팝업 -> '액세스 허용'" -ForegroundColor White
Write-Host "    또는 관리자 PowerShell 에서:" -ForegroundColor DarkGray
Write-Host '    New-NetFirewallRule -DisplayName "aep-review PWA" -Direction Inbound -Protocol TCP -LocalPort 8767 -Action Allow -Profile Private,Public' -ForegroundColor DarkGray
Write-Host ""
