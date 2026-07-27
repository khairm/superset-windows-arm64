# Verify the installed bun is native Windows ARM64; fall back to the official
# aarch64 zip when setup-bun handed us an emulated binary. Extracted from
# build-arm64.yml so the CI repair AI can fix it mid-run (workflow YAML is
# frozen once a run starts; repo files are not).
#
# FAILURE PROPAGATION: a nested .ps1's `exit 1` does NOT fail the parent pwsh
# by itself. This script only fails the step because the Actions runner wraps
# pwsh steps with $ErrorActionPreference='stop' (Write-Error becomes
# terminating) and appends `exit $LASTEXITCODE` (runner ADR 0277). If this is
# ever invoked outside a runner step, check $LASTEXITCODE at the call site.
function Get-PEMachine($p){ $fs=[IO.File]::OpenRead($p); $br=New-Object IO.BinaryReader($fs); $fs.Position=0x3C; $pe=$br.ReadInt32(); $fs.Position=$pe+4; $m=$br.ReadUInt16(); $br.Close(); return $m }
$bun = (Get-Command bun).Source
$m = Get-PEMachine $bun
$ver = (& bun --version).Trim()
Write-Host "bun: $bun  version=$ver  PEmachine=0x$('{0:X}' -f $m)"
if ($m -ne 0xAA64) {
  Write-Host "::warning::setup-bun did not provide native ARM64 bun (machine 0x$('{0:X}' -f $m)); downloading official bun-windows-aarch64"
  $zip = Join-Path $env:RUNNER_TEMP 'bun-arm64.zip'
  Invoke-WebRequest -Uri 'https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-windows-aarch64.zip' -OutFile $zip
  $dest = Join-Path $env:RUNNER_TEMP 'bun-arm64'
  Expand-Archive -Path $zip -DestinationPath $dest -Force
  $found = Get-ChildItem -Recurse -Filter bun.exe $dest | Select-Object -First 1
  if (-not $found) { Write-Error 'bun.exe not found in official ARM64 zip'; exit 1 }
  $m2 = Get-PEMachine $found.FullName
  if ($m2 -ne 0xAA64) { Write-Error "Official zip bun.exe is not ARM64 (0x$('{0:X}' -f $m2))"; exit 1 }
  Add-Content -Path $env:GITHUB_PATH -Value $found.DirectoryName
  Write-Host "Prepended native ARM64 bun ($($found.DirectoryName)) to PATH"
}
