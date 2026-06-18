# stop_aep.ps1
# ----------------------------------------------------------------------------
# 8767 포트에서 LISTENING 중인 aep-review 서버 프로세스 종료.
#
# 사용:
#   바탕화면 ■ 아이콘 더블클릭
#   또는: pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\stop_aep.ps1
# ----------------------------------------------------------------------------

$ErrorActionPreference = "Continue"

try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
chcp 65001 > $null 2>&1

$Port = 8767

Write-Host ""
Write-Host "  AEP Review - Stop" -ForegroundColor Blue
Write-Host "  -----------------" -ForegroundColor DarkGray
Write-Host ""

$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $conns) {
    Write-Host "  [i] 서버가 실행 중이 아닙니다." -ForegroundColor Yellow
    Write-Host ""
    Read-Host "  Enter"
    exit 0
}

# NOTE: $pid 는 PowerShell 자동변수 (read-only). loop 변수로 사용 금지.
$targetPids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($targetPid in $targetPids) {
    try {
        $proc = Get-Process -Id $targetPid -ErrorAction Stop
        Write-Host "  [.] 종료: PID $targetPid ($($proc.ProcessName))" -ForegroundColor Yellow
        Stop-Process -Id $targetPid -Force -ErrorAction Stop
        Write-Host "  [OK] 종료 완료" -ForegroundColor Green
    } catch {
        Write-Host "  [X] PID $targetPid 종료 실패: $_" -ForegroundColor Red
    }
}

Write-Host ""
Read-Host "  Enter"
