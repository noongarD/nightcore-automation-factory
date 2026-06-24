param(
    [string]$ProjectPath = "",
    [string]$OutputRoot = "",
    [double]$RenderLimitSeconds = 0
)

$ErrorActionPreference = "Stop"

$factoryRoot = if ($env:NIGHTCORE_FACTORY_ROOT) { $env:NIGHTCORE_FACTORY_ROOT } else { "C:\NightcoreFactory" }
$OutputRoot = if ($OutputRoot) { $OutputRoot } else { Join-Path $factoryRoot "mix-outputs" }
$mixQueueRoot = Join-Path $factoryRoot "mix-queue"
$rendererScript = Join-Path $factoryRoot "scripts\render-mix-ffmpeg.cjs"
$ffmpegPath = if ($env:FFMPEG_PATH) { $env:FFMPEG_PATH } else { "ffmpeg" }
$ffprobePath = if ($env:FFPROBE_PATH) { $env:FFPROBE_PATH } else { "ffprobe" }

if (-not (Test-Path -LiteralPath $rendererScript)) {
    throw "Offline mix renderer is missing: $rendererScript"
}

function Copy-ToN8nFiles {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string]$ProjectName
    )

    if (-not (Test-Path -LiteralPath $FilePath)) {
        return $FilePath
    }

    $n8nRoot = if ($env:N8N_FILES_ROOT) { $env:N8N_FILES_ROOT } else { Join-Path $env:USERPROFILE ".n8n-files\NightcoreFactory" }
    $n8nOutputRoot = Join-Path $n8nRoot "mix-outputs"
    $targetDir = Join-Path $n8nOutputRoot $ProjectName
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

    $targetPath = Join-Path $targetDir (Split-Path -Leaf $FilePath)
    Copy-Item -LiteralPath $FilePath -Destination $targetPath -Force
    return $targetPath
}

if ([string]::IsNullOrWhiteSpace($ProjectPath)) {
    $latest = Get-ChildItem -LiteralPath $mixQueueRoot -Directory |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "mix.wav") } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    if (-not $latest) {
        throw "No mix project with mix.wav was found in $mixQueueRoot"
    }

    $ProjectPath = $latest.FullName
}

$summaryPath = Join-Path $ProjectPath "mix-render-summary.json"
if (Test-Path -LiteralPath $summaryPath) {
    $existing = Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json
}

if ($existing -and $existing.files -and (Test-Path -LiteralPath $existing.files.mp4) -and (Test-Path -LiteralPath $existing.files.thumbnail) -and $RenderLimitSeconds -le 0) {
    $json = $existing
} else {
    $args = @(
        $rendererScript,
        "--project", $ProjectPath,
        "--outputRoot", $OutputRoot,
        "--ffmpeg", $ffmpegPath,
        "--ffprobe", $ffprobePath,
        "--summaryPath", $summaryPath
    )

    if ($RenderLimitSeconds -gt 0) {
        $args += @("--limitSeconds", ([string]$RenderLimitSeconds))
    }

    $raw = node @args
    if ($LASTEXITCODE -ne 0) {
        throw "Existing mix render failed."
    }

    $json = $raw | ConvertFrom-Json
}

$n8nMp4Path = Copy-ToN8nFiles -FilePath $json.files.mp4 -ProjectName $json.project
$n8nThumbnailPath = Copy-ToN8nFiles -FilePath $json.files.thumbnail -ProjectName $json.project
$json | Add-Member -NotePropertyName "rendered" -NotePropertyValue $true -Force
$json | Add-Member -NotePropertyName "originalMp4Path" -NotePropertyValue $json.files.mp4 -Force
$json | Add-Member -NotePropertyName "originalThumbnailPath" -NotePropertyValue $json.files.thumbnail -Force
$json | Add-Member -NotePropertyName "mp4Path" -NotePropertyValue $n8nMp4Path -Force
$json | Add-Member -NotePropertyName "thumbnailPath" -NotePropertyValue $n8nThumbnailPath -Force
$json | Add-Member -NotePropertyName "youtubeTitle" -NotePropertyValue $json.youtube.title -Force
$json | Add-Member -NotePropertyName "description" -NotePropertyValue $json.youtube.description -Force
$json | Add-Member -NotePropertyName "tags" -NotePropertyValue $json.youtube.tags -Force
$json | Add-Member -NotePropertyName "privacy" -NotePropertyValue $json.youtube.privacy -Force
$json | ConvertTo-Json -Depth 20
