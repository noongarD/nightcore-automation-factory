param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectPath
)

$ErrorActionPreference = "Stop"

$factoryRoot = if ($env:NIGHTCORE_FACTORY_ROOT) { $env:NIGHTCORE_FACTORY_ROOT } else { "C:\NightcoreFactory" }
$scriptDir = Join-Path $factoryRoot "scripts"
$templatePath = Join-Path $factoryRoot "templates\VISUALIZER ZWYKLY.html"
$shortTemplatePath = Join-Path $factoryRoot "templates\VISUALIZER TIKTOK.html"
$outputRoot = Join-Path $factoryRoot "outputs"
$workRoot = Join-Path $factoryRoot "work"
$rendererScript = Join-Path $scriptDir "render-nightcore.cjs"
$mergeScript = Join-Path $scriptDir "merge-short-summary.cjs"
$lyricsScript = Join-Path $scriptDir "prepare-lyrics.cjs"

$ffmpegPath = if ($env:FFMPEG_PATH) { $env:FFMPEG_PATH } else { "ffmpeg" }
$ffprobePath = if ($env:FFPROBE_PATH) { $env:FFPROBE_PATH } else { "ffprobe" }

if (-not (Test-Path -LiteralPath $ProjectPath)) {
    throw "Project folder does not exist: $ProjectPath"
}

if (-not (Test-Path -LiteralPath $templatePath)) {
    throw "Visualizer template is missing: $templatePath"
}

if (-not (Test-Path -LiteralPath $rendererScript)) {
    throw "Renderer script is missing: $rendererScript"
}

if (-not (Test-Path -LiteralPath $ffmpegPath)) {
    $ffmpegCommand = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if (-not $ffmpegCommand) {
        throw "ffmpeg was not found. Install ffmpeg or update the path in render-nightcore.ps1."
    }
    $ffmpegPath = $ffmpegCommand.Source
}

if (-not (Test-Path -LiteralPath $ffprobePath)) {
    $ffprobeCommand = Get-Command ffprobe -ErrorAction SilentlyContinue
    if (-not $ffprobeCommand) {
        throw "ffprobe was not found. Install ffmpeg/ffprobe or update the path in render-nightcore.ps1."
    }
    $ffprobePath = $ffprobeCommand.Source
}

function Get-Metadata {
    param([string]$Path)

    $metadataPath = Join-Path $Path "metadata.json"
    if (-not (Test-Path -LiteralPath $metadataPath)) {
        return $null
    }

    try {
        return (Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Get-MetadataNumber {
    param(
        [object]$Metadata,
        [string]$Name,
        [double]$Default
    )

    if ($null -eq $Metadata) {
        return $Default
    }

    $property = $Metadata.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) {
        return $Default
    }

    try {
        return [double]$property.Value
    } catch {
        return $Default
    }
}

function Get-MetadataBool {
    param(
        [object]$Metadata,
        [string]$Name,
        [bool]$Default
    )

    if ($null -eq $Metadata) {
        return $Default
    }

    $property = $Metadata.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) {
        return $Default
    }

    $value = $property.Value
    if ($value -is [string]) {
        $normalized = $value.Trim().ToLowerInvariant()
        return -not (@("false", "0", "no", "off") -contains $normalized)
    }

    return [bool]$value
}

function Get-MetadataString {
    param(
        [object]$Metadata,
        [string]$Name,
        [string]$Default
    )

    if ($null -eq $Metadata) {
        return $Default
    }

    $property = $Metadata.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) {
        return $Default
    }

    $value = [string]$property.Value
    if ([string]::IsNullOrWhiteSpace($value)) {
        return $Default
    }

    return $value
}

function Get-ProjectAudio {
    param([string]$Path)

    $audioExtensions = @(".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg")
    return Get-ChildItem -LiteralPath $Path -File |
        Where-Object { $audioExtensions -contains $_.Extension.ToLowerInvariant() } |
        Sort-Object Name |
        Select-Object -First 1
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

$globalNodeModules = npm root -g
$env:NODE_PATH = $globalNodeModules

$metadata = Get-Metadata -Path $ProjectPath
$audioFile = Get-ProjectAudio -Path $ProjectPath
if ($null -eq $audioFile) {
    throw "Audio file was not found in: $ProjectPath"
}

$lyricsPath = Join-Path $ProjectPath "lyrics.json"
if (Test-Path -LiteralPath $lyricsScript) {
    node $lyricsScript `
        --project $ProjectPath `
        --audio $audioFile.FullName `
        --ffprobe $ffprobePath `
        --output $lyricsPath *> $null

    if ($LASTEXITCODE -ne 0) {
        throw "Lyrics preparation failed with exit code $LASTEXITCODE"
    }
}

node $rendererScript `
    --project $ProjectPath `
    --template $templatePath `
    --outputRoot $outputRoot `
    --ffmpeg $ffmpegPath `
    --ffprobe $ffprobePath `
    --lyricsPath $lyricsPath

if ($LASTEXITCODE -ne 0) {
    throw "Renderer failed with exit code $LASTEXITCODE"
}

$shortsEnabled = Get-MetadataBool -Metadata $metadata -Name "shortsEnabled" -Default $true

if ($shortsEnabled -and (Test-Path -LiteralPath $shortTemplatePath)) {
    if (-not (Test-Path -LiteralPath $mergeScript)) {
        throw "Short summary merger is missing: $mergeScript"
    }

    $projectName = Split-Path -Leaf (Resolve-Path -LiteralPath $ProjectPath)
    $shortStartSeconds = Get-MetadataNumber -Metadata $metadata -Name "shortStartSeconds" -Default 0
    $shortDurationSeconds = Get-MetadataNumber -Metadata $metadata -Name "shortDurationSeconds" -Default 30
    $shortVisualArtist = Get-MetadataString -Metadata $metadata -Name "shortVisualArtist" -Default "check out now on all streamings!"
    if ($shortDurationSeconds -le 0) {
        $shortDurationSeconds = 30
    }

    $shortWorkDir = Join-Path $workRoot $projectName
    New-Item -ItemType Directory -Force -Path $shortWorkDir | Out-Null
    $shortAudioPath = Join-Path $shortWorkDir "short-audio.wav"

    & $ffmpegPath `
        -hide_banner `
        -loglevel error `
        -y `
        -ss $shortStartSeconds `
        -t $shortDurationSeconds `
        -i $audioFile.FullName `
        -vn `
        -acodec pcm_s16le `
        -ar 48000 `
        -ac 2 `
        $shortAudioPath *> $null

    if ($LASTEXITCODE -ne 0) {
        throw "Could not prepare short audio for: $ProjectPath"
    }

    $outputDir = Join-Path $outputRoot $projectName
    $mainSummaryPath = Join-Path $outputDir ("{0}-render-summary.json" -f $projectName)
    $shortSummaryPath = Join-Path $outputDir ("{0}-short-render-summary.json" -f $projectName)

    node $rendererScript `
        --project $ProjectPath `
        --template $shortTemplatePath `
        --outputRoot $outputRoot `
        --ffmpeg $ffmpegPath `
        --ffprobe $ffprobePath `
        --variant short `
        --outputSuffix "-short" `
        --audioPath $shortAudioPath `
        --titleSourcePath $audioFile.FullName `
        --visualArtist $shortVisualArtist `
        --lyricsPath $lyricsPath `
        --lyricsOffsetSeconds $shortStartSeconds `
        --summaryPath $shortSummaryPath

    if ($LASTEXITCODE -ne 0) {
        throw "Short renderer failed with exit code $LASTEXITCODE"
    }

    node $mergeScript `
        --mainSummary $mainSummaryPath `
        --shortSummary $shortSummaryPath `
        --startSeconds $shortStartSeconds `
        --durationSeconds $shortDurationSeconds

    if ($LASTEXITCODE -ne 0) {
        throw "Short summary merge failed with exit code $LASTEXITCODE"
    }
}
