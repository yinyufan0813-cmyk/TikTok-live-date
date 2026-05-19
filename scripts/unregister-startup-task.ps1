$taskName = "GMVMAX Monitor Windows"
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Unregistered scheduled task: $taskName"
} else {
  Write-Host "Scheduled task not found: $taskName"
}
