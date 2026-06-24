param(
    [string]$ConfigPath = "",
    [string]$Title = "",
    [string]$Render = "true"
)

$ErrorActionPreference = "Stop"

$factoryRoot = if ($env:NIGHTCORE_FACTORY_ROOT) { $env:NIGHTCORE_FACTORY_ROOT } else { "C:\NightcoreFactory" }
$ConfigPath = if ($ConfigPath) { $ConfigPath } else { Join-Path $factoryRoot "mix-inbox\mix-config.json" }
$runner = Join-Path $factoryRoot "scripts\build-mix.ps1"

if (-not (Test-Path -LiteralPath $runner)) {
    throw "Mix runner is missing: $runner"
}

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Mix config is missing: $ConfigPath"
}

$args = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $runner,
    "-ConfigPath", $ConfigPath,
    "-Render", $Render,
    "-JsonOnly", "1"
)

if (-not [string]::IsNullOrWhiteSpace($Title)) {
    $args += @("-Title", $Title)
}

$raw = powershell @args
if ($LASTEXITCODE -ne 0) {
    throw "Mix workflow failed."
}

$json = $raw | ConvertFrom-Json
$json | ConvertTo-Json -Depth 20
