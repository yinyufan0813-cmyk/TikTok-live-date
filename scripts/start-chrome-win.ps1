$ErrorActionPreference = "Stop"

$chromeCandidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles(x86)\Google\Chrome\Application\chrome.exe",
  "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
)

$chrome = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) {
  throw "Cannot find Google Chrome. Please install Chrome first."
}

$profileDir = Join-Path $env:USERPROFILE ".gmvmax-chrome-win"
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

Write-Host "Starting Chrome with remote debugging..."
Write-Host "Chrome: $chrome"
Write-Host "Profile: $profileDir"

Start-Process -FilePath $chrome -ArgumentList @(
  "--remote-debugging-port=9222",
  "--user-data-dir=$profileDir",
  "--no-first-run",
  "--no-default-browser-check"
)

Write-Host "Done. Open TikTok Ads GMV Max page in the new Chrome window and log in."
