$ErrorActionPreference = 'Continue'

$ProjectRoot = "C:\Users\dorzz\projects\aep-review"
$LogFile     = Join-Path $ProjectRoot "logs\finish_all.log"
$BackfillStdout = Join-Path $ProjectRoot "logs\backfill_full_stdout.log"
$BackfillStderr = Join-Path $ProjectRoot "logs\backfill_full_stderr.log"
$CurrentBfPid = 25396

function Log($msg) {
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -Append $LogFile -Encoding utf8
}

# Prevent system sleep + display sleep while this watcher runs.
# SetThreadExecutionState pins the system awake state for THIS process.
# When the process exits, the lock auto-releases (no permanent change).
Add-Type -Namespace 'NoSleep' -Name 'Win32' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
$ES_CONTINUOUS       = [uint32]'0x80000000'
$ES_SYSTEM_REQUIRED  = [uint32]'0x00000001'
$ES_AWAYMODE_REQUIRED= [uint32]'0x00000040'
$flags = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_AWAYMODE_REQUIRED
[NoSleep.Win32]::SetThreadExecutionState($flags) | Out-Null
Log "watcher started (sleep prevention engaged)"

# Stage 1: wait for the current --episodes 50 backfill to finish (skip if not running).
$existingBf = Get-Process -Id $CurrentBfPid -ErrorAction SilentlyContinue
if ($existingBf) {
  Log "waiting on current backfill PID=${CurrentBfPid}"
  Wait-Process -Id $CurrentBfPid -ErrorAction SilentlyContinue
  Log "current backfill PID=${CurrentBfPid} exited"
} else {
  Log "no current backfill on PID=${CurrentBfPid}, skipping wait"
}

# Stage 2: run unlimited backfill until 0 pending OR max 4 iterations.
# Optimized for speed: small.en + greedy decoding (beam_size=1)
# Combined ~9-10x speedup vs medium.en + beam=5. ~95% accuracy retained.
$env:AEP_WHISPER_DEVICE = "cuda"
$env:AEP_WHISPER_MODEL  = "small.en"
$env:AEP_WHISPER_BEAM   = "1"
Set-Location $ProjectRoot

for ($i = 1; $i -le 4; $i++) {
  Log "iteration ${i}: launching unlimited local_backfill.py"
  $stdout = "${BackfillStdout}.${i}"
  $stderr = "${BackfillStderr}.${i}"
  $proc = Start-Process -FilePath "py" `
    -ArgumentList "scripts/local_backfill.py" `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError  $stderr `
    -PassThru -NoNewWindow -Wait
  Log "iteration ${i} exited code=$($proc.ExitCode)"

  $pendingJson = & py -c "import sqlite3, json; c = sqlite3.connect('data/episodes.db').cursor(); c.execute('SELECT SUM(audio_url IS NOT NULL AND audio_path IS NULL), SUM(audio_path IS NOT NULL AND transcribed_at IS NULL), SUM(transcribed_at IS NOT NULL AND vocab_extracted_at IS NULL) FROM episodes'); a, s, v = c.fetchone(); print(json.dumps({'audio_pending': a or 0, 'stt_pending': s or 0, 'vocab_pending': v or 0}))"
  Log "pending after iter ${i} : $pendingJson"
  $obj = $pendingJson | ConvertFrom-Json
  $totalPending = $obj.audio_pending + $obj.stt_pending + $obj.vocab_pending
  if ($totalPending -eq 0) {
    Log "all pending = 0, stopping iterations"
    break
  }
  if ($i -lt 4) {
    Log "still pending=${totalPending}, retrying after 30s"
    Start-Sleep -Seconds 30
  }
}

# Stage 3: schedule shutdown 60 seconds after completion.
Log "scheduling shutdown /s /t 60"
Start-Process -FilePath shutdown.exe -ArgumentList '/s','/t','60','/c','AEP backfill complete - shutdown in 60s. Cancel: shutdown /a' -NoNewWindow
Log "shutdown scheduled, releasing sleep lock"
[NoSleep.Win32]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
