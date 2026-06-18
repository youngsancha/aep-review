$bfPid = 22384
$logPath = "C:\Users\dorzz\projects\aep-review\logs\shutdown_watcher.log"
"$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') watcher started, waiting on PID $bfPid" | Out-File -Append $logPath
try {
    Wait-Process -Id $bfPid -ErrorAction Stop
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') backfill PID $bfPid exited; scheduling shutdown in 60s" | Out-File -Append $logPath
    Start-Process -FilePath shutdown.exe -ArgumentList '/s','/t','60','/c','AEP backfill complete - shutdown in 60s. Cancel: shutdown /a' -NoNewWindow
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') shutdown scheduled" | Out-File -Append $logPath
} catch {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ERROR: $_" | Out-File -Append $logPath
}
