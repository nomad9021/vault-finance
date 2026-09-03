# Vault Finance — one-command server update (Windows / Docker Desktop).
#
# Pulls the newest prebuilt image and restarts the stack. Your data is
# untouched; database migrations run automatically on boot.
#
#   pwsh -File installers\server\update-server.ps1
#
$ErrorActionPreference = "Stop"

$RepoDir     = (Resolve-Path "$PSScriptRoot\..\..").Path
$ComposeFile = Join-Path $RepoDir "docker\docker-compose.yml"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "docker not found" }

if (Test-Path (Join-Path $RepoDir ".git")) {
  Write-Host "Updating repository..." -ForegroundColor Cyan
  git -C $RepoDir pull --ff-only 2>$null
}

Write-Host "Updating the Vault Finance stack..." -ForegroundColor Cyan
docker compose -f $ComposeFile pull
docker compose -f $ComposeFile up -d
docker image prune -f | Out-Null

Write-Host "OK - server updated. Migrations run automatically on boot." -ForegroundColor Green
Write-Host "Check it came back up:  docker compose -f docker\docker-compose.yml ps"
