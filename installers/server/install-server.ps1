<#
.SYNOPSIS
  Vault Finance — interactive server installer (Windows).

.DESCRIPTION
  Asks where to store data, which port to use, and (optionally) sets up local
  AI and your owner account, then writes docker\.env and brings up the Docker
  Compose stack. Safe to re-run: existing docker\.env values become defaults.

  Requires Docker Desktop (with the Compose plugin). Run in PowerShell:
      pwsh -File installers\server\install-server.ps1
      # or, from an elevated/normal PowerShell:
      .\installers\server\install-server.ps1 -DryRun

.PARAMETER DryRun
  Show the .env and planned actions without touching Docker.

.PARAMETER Yes
  Accept all defaults / existing values without prompting (headless).
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"

# ---- locate repo + compose dir ---------------------------------------------
# This script lives at installers\server\ — the repo root is two levels up.
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir    = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$ComposeDir = Join-Path $RepoDir "docker"
$ComposeFile= Join-Path $ComposeDir "docker-compose.yml"
$EnvFile    = Join-Path $ComposeDir ".env"

function Hdr($t)  { Write-Host "`n$t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "OK  $t" -ForegroundColor Green }
function Warn($t) { Write-Host "!   $t" -ForegroundColor Yellow }
function Die($t)  { Write-Host "X   $t" -ForegroundColor Red; exit 1 }

function Ask($prompt, $default) {
  if ($Yes) { return $default }
  $suffix = if ($default) { " [$default]" } else { "" }
  $reply = Read-Host "$prompt$suffix"
  if ([string]::IsNullOrEmpty($reply)) { return $default } else { return $reply }
}
function AskSecret($prompt) {
  if ($Yes) { return "" }
  $sec = Read-Host $prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
function YesNo($prompt, $default) {
  if ($Yes) { return ($default -eq "y") }
  $hint = if ($default -eq "y") { "[Y/n]" } else { "[y/N]" }
  $reply = Read-Host "$prompt $hint"
  if ([string]::IsNullOrEmpty($reply)) { $reply = $default }
  return ($reply -match '^[Yy]')
}
function EnvGet($key) {
  if (-not (Test-Path $EnvFile)) { return "" }
  $line = Select-String -Path $EnvFile -Pattern "^$key=" -SimpleMatch:$false | Select-Object -First 1
  if ($line) { return ($line.Line -replace "^$key=", "") } else { return "" }
}

# ---- preflight --------------------------------------------------------------
Hdr "Vault Finance server installer"
if (-not (Test-Path $ComposeFile)) { Die "Can't find $ComposeFile — run this from a Vault Finance checkout." }

$DC = $null
try { docker compose version *> $null; if ($LASTEXITCODE -eq 0) { $DC = "compose" } } catch {}
if (-not $DC) { try { docker-compose version *> $null; if ($LASTEXITCODE -eq 0) { $DC = "legacy" } } catch {} }

function Compose { param([Parameter(ValueFromRemainingArguments=$true)]$a)
  if ($DC -eq "legacy") { & docker-compose @a } else { & docker compose @a }
}

if (-not $DryRun) {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Die "Docker isn't installed. Install Docker Desktop, then re-run." }
  if (-not $DC) { Die "Docker Compose not found. Install Docker Desktop (includes Compose), then re-run." }
  try { docker info *> $null } catch { Die "Docker isn't running. Start Docker Desktop, then re-run." }
  if ($LASTEXITCODE -ne 0) { Die "Docker isn't running. Start Docker Desktop, then re-run." }
  Ok "Docker and Compose detected"
} else {
  Warn "Dry run — Docker will not be touched."
}

# ---- questions --------------------------------------------------------------
Hdr "1. Where should Vault store its files?"
Write-Host "Holds the database, uploaded receipts, TLS cert, and (if enabled) AI models." -ForegroundColor DarkGray
$defDisk = EnvGet "VAULT_DISK"; if (-not $defDisk) { $defDisk = (Join-Path $ComposeDir "data") }
$VaultDisk = Ask "Data directory:" $defDisk
if (-not [System.IO.Path]::IsPathRooted($VaultDisk)) { $VaultDisk = Join-Path $ComposeDir $VaultDisk }

Hdr "2. Which HTTPS port should the app listen on?"
$defPort = EnvGet "VAULT_PORT"; if (-not $defPort) { $defPort = "8443" }
$VaultPort = Ask "Port:" $defPort
if ($VaultPort -notmatch '^\d+$') { Die "Port must be a number (got '$VaultPort')." }

Hdr "3. Database password"
Write-Host "Internal to the Docker network. Leave blank to generate a strong random one." -ForegroundColor DarkGray
$defPw = EnvGet "POSTGRES_PASSWORD"
if ($defPw) {
  $PostgresPassword = Ask "Postgres password:" $defPw
} else {
  $PostgresPassword = AskSecret "Postgres password (blank = random):"
  if (-not $PostgresPassword) {
    $bytes = New-Object byte[] 16; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $PostgresPassword = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
    Ok "Generated a random database password."
  }
}

Hdr "4. Local AI (optional)"
Write-Host "Runs an Ollama model on this machine so nothing leaves your hardware." -ForegroundColor DarkGray
Write-Host "The app works fully without it; you can turn AI on later in Settings." -ForegroundColor DarkGray
$defModel = EnvGet "OLLAMA_MODEL"; if (-not $defModel) { $defModel = "llama3.1:8b" }
$PullModel = ""
if (YesNo "Enable the bundled local AI now?" "n") {
  $OllamaModel = Ask "Model to use:" $defModel
  $PullModel = $OllamaModel
} else { $OllamaModel = $defModel }

Hdr "5. Owner account (optional)"
Write-Host "Create your login now, or skip and do it from the desktop app's setup wizard." -ForegroundColor DarkGray
$OwnerEmail = ""; $OwnerName = ""; $OwnerPw = ""
if (YesNo "Create the owner account now?" "n") {
  $OwnerEmail = Ask "  Email:" ""
  $OwnerName  = Ask "  Display name:" ""
  while ($true) {
    $OwnerPw  = AskSecret "  Password (min 10 chars):"
    $OwnerPw2 = AskSecret "  Confirm password:"
    if ($OwnerPw.Length -lt 10) { Warn "Too short — at least 10 characters."; continue }
    if ($OwnerPw -ne $OwnerPw2)  { Warn "Passwords don't match."; continue }
    break
  }
}

# ---- compose docker\.env ----------------------------------------------------
$PostgresUser = EnvGet "POSTGRES_USER"; if (-not $PostgresUser) { $PostgresUser = "vault" }
$PostgresDb   = EnvGet "POSTGRES_DB";   if (-not $PostgresDb)   { $PostgresDb   = "vault" }
$stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

$EnvContent = @"
# Generated by installers\server\install-server.ps1 on $stamp. Edit freely.

# All persistent data lives under this directory.
VAULT_DISK=$VaultDisk

# HTTPS port published on the host.
VAULT_PORT=$VaultPort

# Postgres (internal to the compose network).
POSTGRES_USER=$PostgresUser
POSTGRES_PASSWORD=$PostgresPassword
POSTGRES_DB=$PostgresDb

# Local AI (Ollama). OLLAMA_HOST=ollama is the bundled service; point it at
# another machine on your network to use an Ollama running elsewhere.
OLLAMA_HOST=ollama
OLLAMA_PORT=11434
OLLAMA_MODEL=$OllamaModel

LOG_LEVEL=info
"@

Hdr "Review"
Write-Host "Configuration to be written to $EnvFile :"
Write-Host $EnvContent -ForegroundColor DarkGray
Write-Host "Data directory : $VaultDisk"
Write-Host "Server URL     : https://localhost:$VaultPort"
if ($PullModel) { Write-Host "Will pull model: $PullModel (can be several GB)" }
if ($OwnerEmail) { Write-Host "Owner account  : $OwnerEmail" }

if ($DryRun) { Write-Host ""; Ok "Dry run complete — nothing was changed."; exit 0 }

Write-Host ""
if (-not (YesNo "Write this config and start the server?" "y")) { Die "Aborted — nothing changed." }

foreach ($sub in @("postgres","vault","redis","ollama")) { New-Item -ItemType Directory -Force -Path (Join-Path $VaultDisk $sub) | Out-Null }
Set-Content -Path $EnvFile -Value $EnvContent -NoNewline -Encoding utf8
Ok "Wrote $EnvFile"
Ok "Created data directories under $VaultDisk"

# ---- bring up the stack -----------------------------------------------------
Hdr "Building and starting the stack"
Write-Host "First run compiles the server image and pulls the base images — give it a few minutes." -ForegroundColor DarkGray
Push-Location $ComposeDir
try { Compose up -d --build } finally { Pop-Location }
Ok "Containers are up."

# ---- wait for health --------------------------------------------------------
Hdr "Waiting for the API to come up"
$statusUrl = "https://localhost:$VaultPort/api/v1/setup/status"
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  & curl.exe -ksf $statusUrl *> $null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Start-Sleep -Seconds 2
}
if ($ready) { Ok "API is responding at https://localhost:$VaultPort" }
else { Warn "API didn't respond in time. Check: docker compose -f `"$ComposeFile`" logs -f server" }

# ---- optional owner setup ---------------------------------------------------
if ($OwnerEmail -and $ready) {
  Hdr "Creating your owner account"
  $payload = @{ ownerEmail = $OwnerEmail; ownerPassword = $OwnerPw; ownerDisplayName = $OwnerName } | ConvertTo-Json -Compress
  $resp = & curl.exe -ksS -X POST "https://localhost:$VaultPort/api/v1/setup/complete" -H "content-type: application/json" --data-binary $payload
  if ($resp -match "SETUP_ALREADY_COMPLETE") { Warn "An owner account already exists — skipped." }
  elseif ($resp -match '(?i)error') { Warn "Setup responded: $resp" }
  else { Ok "Owner account created for $OwnerEmail" }
}

# ---- pull AI model ----------------------------------------------------------
if ($PullModel) {
  Hdr "Pulling AI model: $PullModel"
  Push-Location $ComposeDir
  try { Compose exec -T ollama ollama pull $PullModel; if ($LASTEXITCODE -eq 0) { Ok "Model ready." } else { Warn "Model pull didn't finish — run it later." } }
  finally { Pop-Location }
}

# ---- summary ----------------------------------------------------------------
Hdr "Done."
Write-Host "Open the desktop app and connect to:"
Write-Host "  Same machine : https://localhost:$VaultPort"
Write-Host "  Other devices: https://<this-machine-ip>:$VaultPort"
if (-not $OwnerEmail) { Write-Host "`nThe app's setup wizard will create your owner account on first connect." }
Write-Host "`nData lives in $VaultDisk — back that up. See docs\self-hosting.md."
