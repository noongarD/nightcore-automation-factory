$ErrorActionPreference = "Stop"

$factoryRoot = if ($env:NIGHTCORE_FACTORY_ROOT) {
    $env:NIGHTCORE_FACTORY_ROOT
} else {
    Split-Path -Parent $PSScriptRoot
}

$directories = @(
    "inbox",
    "queue",
    "outputs",
    "work",
    "mix-inbox",
    "mix-queue",
    "mix-outputs",
    "mix-work"
)

foreach ($directory in $directories) {
    New-Item -ItemType Directory -Force -Path (Join-Path $factoryRoot $directory) | Out-Null
}

Push-Location $factoryRoot
try {
    npm install
    npx playwright install chromium
} finally {
    Pop-Location
}

Write-Host "Factory directories and Node.js dependencies are ready."
