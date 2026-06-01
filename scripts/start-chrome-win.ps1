$ErrorActionPreference = "Stop"

$defaultUrl = "https://ads.tiktok.com/"
$configPath = Join-Path (Get-Location) "config.json"
$dashboardUrl = $env:GMVMAX_URL

if (-not $dashboardUrl -and (Test-Path $configPath)) {
  try {
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    if ($config.url -and $config.url -notmatch "^PASTE_") {
      $dashboardUrl = $config.url
    }
  } catch {
    Write-Warning "Could not read config.json URL: $($_.Exception.Message)"
  }
}

if (-not $dashboardUrl) {
  $dashboardUrl = $defaultUrl
  Write-Host "No GMVMAX_URL or config.json url found. Opening TikTok Ads home page instead."
}

$cdpVersionUrl = "http://127.0.0.1:9222/json/version"

try {
  Invoke-RestMethod -Uri $cdpVersionUrl -TimeoutSec 1 | Out-Null
  Write-Host "Dedicated Chrome is already running on port 9222."
  exit 0
} catch {
  # Start a dedicated Chrome below.
}

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
  "--no-default-browser-check",
  $dashboardUrl
)

for ($i = 0; $i -lt 45; $i++) {
  try {
    Invoke-RestMethod -Uri $cdpVersionUrl -TimeoutSec 1 | Out-Null
    Write-Host "Dedicated Chrome is ready on port 9222."
    exit 0
  } catch {
    Start-Sleep -Seconds 1
  }
}

throw "Dedicated Chrome did not open port 9222. Please start scripts\start-chrome-win.bat manually."
