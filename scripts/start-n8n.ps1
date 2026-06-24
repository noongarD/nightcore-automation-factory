$ErrorActionPreference = "Stop"

$factoryRoot = if ($env:NIGHTCORE_FACTORY_ROOT) {
    $env:NIGHTCORE_FACTORY_ROOT
} else {
    "C:\NightcoreFactory"
}

$n8nFilesRoot = if ($env:N8N_FILES_ROOT) {
    $env:N8N_FILES_ROOT
} else {
    Join-Path $env:USERPROFILE ".n8n-files\NightcoreFactory"
}

$env:N8N_RESTRICT_FILE_ACCESS_TO = "$factoryRoot;$n8nFilesRoot"

Write-Host "Nightcore factory: $factoryRoot"
Write-Host "n8n file access: $env:N8N_RESTRICT_FILE_ACCESS_TO"
n8n start
