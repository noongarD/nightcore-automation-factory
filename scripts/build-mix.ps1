param(
    [string]$ConfigPath = "",
    [string]$Title = "",
    [double]$MinimumMinutes = 60,
    [double]$TargetMinutes = 62,
    [double]$CrossfadeSeconds = 5,
    [double]$MinTrackSeconds = 60,
    [int]$TrackCount = 0,
    [string]$TransitionMode = "fade",
    [string]$Mode = "",
    [string]$Seed = "",
    [string]$BackgroundPath = "",
    [string]$Render = "false",
    [double]$RenderLimitSeconds = 0,
    [string]$JsonOnly = "false"
)

$ErrorActionPreference = "Stop"
$renderEnabled = $Render -match '^(1|true|yes)$'
$jsonOnlyEnabled = $JsonOnly -match '^(1|true|yes)$'

$factoryRoot = if ($env:NIGHTCORE_FACTORY_ROOT) { $env:NIGHTCORE_FACTORY_ROOT } else { "C:\NightcoreFactory" }
$scriptDir = Join-Path $factoryRoot "scripts"
$templatePath = Join-Path $factoryRoot "templates\VISUALIZER MIX.html"
$outputRoot = Join-Path $factoryRoot "outputs"
$mixOutputRoot = Join-Path $factoryRoot "mix-outputs"
$queueRoot = Join-Path $factoryRoot "mix-queue"
$builderScript = Join-Path $scriptDir "build-mix.cjs"
$rendererScript = Join-Path $scriptDir "render-mix-ffmpeg.cjs"

$ffmpegPath = if ($env:FFMPEG_PATH) { $env:FFMPEG_PATH } else { "ffmpeg" }
$ffprobePath = if ($env:FFPROBE_PATH) { $env:FFPROBE_PATH } else { "ffprobe" }

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

if (-not (Test-Path -LiteralPath $builderScript)) {
    throw "Mix builder is missing: $builderScript"
}

if (-not (Test-Path -LiteralPath $templatePath)) {
    throw "Mix visualizer template is missing: $templatePath"
}

if (-not (Test-Path -LiteralPath $ffmpegPath)) {
    $ffmpegCommand = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if (-not $ffmpegCommand) {
        throw "ffmpeg was not found."
    }
    $ffmpegPath = $ffmpegCommand.Source
}

if (-not (Test-Path -LiteralPath $ffprobePath)) {
    $ffprobeCommand = Get-Command ffprobe -ErrorAction SilentlyContinue
    if (-not $ffprobeCommand) {
        throw "ffprobe was not found."
    }
    $ffprobePath = $ffprobeCommand.Source
}

New-Item -ItemType Directory -Force -Path $mixOutputRoot, $queueRoot | Out-Null
$env:NODE_PATH = npm root -g

$builderArgs = @(
    $builderScript,
    "--factoryRoot", $factoryRoot,
    "--outputRoot", $outputRoot,
    "--queueRoot", $queueRoot,
    "--ffmpeg", $ffmpegPath,
    "--ffprobe", $ffprobePath,
    "--minimumMinutes", ([string]$MinimumMinutes),
    "--targetMinutes", ([string]$TargetMinutes),
    "--crossfadeSeconds", ([string]$CrossfadeSeconds),
    "--minTrackSeconds", ([string]$MinTrackSeconds),
    "--transitionMode", $TransitionMode
)

$effectiveMode = $Mode
if ([string]::IsNullOrWhiteSpace($effectiveMode) -and [string]::IsNullOrWhiteSpace($ConfigPath)) {
    $effectiveMode = "random"
}

if (-not [string]::IsNullOrWhiteSpace($effectiveMode)) {
    $builderArgs += @("--mode", $effectiveMode)
}

if (-not [string]::IsNullOrWhiteSpace($ConfigPath)) {
    $builderArgs += @("--config", $ConfigPath)
}

if (-not [string]::IsNullOrWhiteSpace($Title)) {
    $builderArgs += @("--title", $Title)
}

if ($TrackCount -gt 0) {
    $builderArgs += @("--trackCount", ([string]$TrackCount))
}

if (-not [string]::IsNullOrWhiteSpace($Seed)) {
    $builderArgs += @("--seed", $Seed)
}

if (-not [string]::IsNullOrWhiteSpace($BackgroundPath)) {
    $builderArgs += @("--backgroundPath", $BackgroundPath)
}

$summaryRaw = & node @builderArgs
if ($LASTEXITCODE -ne 0) {
    throw "Mix preparation failed."
}

$summary = $summaryRaw | ConvertFrom-Json
if (-not $jsonOnlyEnabled) {
    Write-Host "Mix prepared: $($summary.projectPath)"
    Write-Host "Duration: $($summary.duration)"
    Write-Host "Tracks: $($summary.trackCount)"
}

if ($renderEnabled) {
    if (-not (Test-Path -LiteralPath $rendererScript)) {
        throw "Renderer is missing: $rendererScript"
    }

    $summaryPath = Join-Path $summary.projectPath "mix-render-summary.json"
    $rendererArgs = @(
        $rendererScript,
        "--project", $summary.projectPath,
        "--outputRoot", $mixOutputRoot,
        "--ffmpeg", $ffmpegPath,
        "--ffprobe", $ffprobePath,
        "--audioPath", $summary.mixAudioPath,
        "--backgroundPath", $summary.backgroundPath,
        "--summaryPath", $summaryPath
    )

    if ($RenderLimitSeconds -gt 0) {
        $rendererArgs += @("--limitSeconds", ([string]$RenderLimitSeconds))
    }

    $renderOutput = node @rendererArgs

    if ($LASTEXITCODE -ne 0) {
        throw "Mix renderer failed with exit code $LASTEXITCODE"
    }

    if (Test-Path -LiteralPath $summaryPath) {
        $renderSummary = Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json
        $n8nMp4Path = Copy-ToN8nFiles -FilePath $renderSummary.files.mp4 -ProjectName $renderSummary.project
        $n8nThumbnailPath = Copy-ToN8nFiles -FilePath $renderSummary.files.thumbnail -ProjectName $renderSummary.project
        $summary | Add-Member -NotePropertyName "rendered" -NotePropertyValue $true -Force
        $summary | Add-Member -NotePropertyName "renderSummaryPath" -NotePropertyValue $summaryPath -Force
        $summary | Add-Member -NotePropertyName "originalMp4Path" -NotePropertyValue $renderSummary.files.mp4 -Force
        $summary | Add-Member -NotePropertyName "originalThumbnailPath" -NotePropertyValue $renderSummary.files.thumbnail -Force
        $summary | Add-Member -NotePropertyName "mp4Path" -NotePropertyValue $n8nMp4Path -Force
        $summary | Add-Member -NotePropertyName "thumbnailPath" -NotePropertyValue $n8nThumbnailPath -Force
        $summary | Add-Member -NotePropertyName "youtubeTitle" -NotePropertyValue $renderSummary.youtube.title -Force
        $summary | Add-Member -NotePropertyName "description" -NotePropertyValue $renderSummary.youtube.description -Force
        $summary | Add-Member -NotePropertyName "tags" -NotePropertyValue $renderSummary.youtube.tags -Force
        $summary | Add-Member -NotePropertyName "privacy" -NotePropertyValue $renderSummary.youtube.privacy -Force
        $summary | Add-Member -NotePropertyName "renderLog" -NotePropertyValue (($renderOutput | Out-String).Trim()) -Force
    } else {
        $summary | Add-Member -NotePropertyName "rendered" -NotePropertyValue $true -Force
        $summary | Add-Member -NotePropertyName "renderLog" -NotePropertyValue (($renderOutput | Out-String).Trim()) -Force
    }
}

$summary | ConvertTo-Json -Depth 20
