param(
    [string]$InboxPath = "",
    [string]$QueuePath = "",
    [string]$RenderScript = "",
    [bool]$Render = $true
)

$ErrorActionPreference = "Stop"

$factoryRoot = if ($env:NIGHTCORE_FACTORY_ROOT) { $env:NIGHTCORE_FACTORY_ROOT } else { "C:\NightcoreFactory" }
$InboxPath = if ($InboxPath) { $InboxPath } else { Join-Path $factoryRoot "inbox" }
$QueuePath = if ($QueuePath) { $QueuePath } else { Join-Path $factoryRoot "queue" }
$RenderScript = if ($RenderScript) { $RenderScript } else { Join-Path $factoryRoot "scripts\render-nightcore.ps1" }

$audioExtensions = @(".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg")
$imageExtensions = @(".jpg", ".jpeg", ".png", ".webp")
$lyricExtensions = @(".txt", ".lrc", ".srt", ".json")
$resultFormatter = Join-Path $factoryRoot "scripts\make-n8n-item.cjs"

function Get-SafeName {
    param([string]$Name)

    $safe = $Name -replace '[<>:"/\\|?*\x00-\x1F]', ''
    $safe = $safe -replace '\s+', ' '
    $safe = $safe.Trim()

    if ([string]::IsNullOrWhiteSpace($safe)) {
        return "nightcore"
    }

    if ($safe.Length -gt 100) {
        return $safe.Substring(0, 100).Trim()
    }

    return $safe
}

function Wait-FileStable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [int]$Checks = 3,
        [int]$DelayMs = 750
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }

    $lastLength = -1
    for ($i = 0; $i -lt $Checks; $i++) {
        $item = Get-Item -LiteralPath $Path -ErrorAction Stop
        if ($item.Length -eq $lastLength) {
            Start-Sleep -Milliseconds $DelayMs
            continue
        }

        $lastLength = $item.Length
        Start-Sleep -Milliseconds $DelayMs
    }

    $finalItem = Get-Item -LiteralPath $Path -ErrorAction Stop
    return $finalItem.Length -eq $lastLength
}

function Get-UniqueProjectPath {
    param(
        [string]$Root,
        [string]$ProjectName
    )

    $candidate = Join-Path $Root $ProjectName
    if (-not (Test-Path -LiteralPath $candidate)) {
        return $candidate
    }

    $suffix = Get-Date -Format "yyyyMMdd-HHmmss"
    return (Join-Path $Root "$ProjectName-$suffix")
}

function Find-ImageForAudio {
    param(
        [System.IO.FileInfo]$Audio,
        [System.IO.FileInfo[]]$AllImages,
        [System.IO.FileInfo[]]$AllAudio
    )

    $audioStem = [System.IO.Path]::GetFileNameWithoutExtension($Audio.Name)

    $matchingByName = @($AllImages | Where-Object {
        [System.IO.Path]::GetFileNameWithoutExtension($_.Name) -ieq $audioStem
    })
    if ($matchingByName.Count -eq 1) {
        return $matchingByName[0]
    }

    $backgroundNames = @("background", "cover", "artwork", "image", "bg")
    $namedBackground = @($AllImages | Where-Object {
        $stem = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
        $backgroundNames -contains $stem.ToLowerInvariant()
    })
    if ($namedBackground.Count -eq 1 -and $AllAudio.Count -eq 1) {
        return $namedBackground[0]
    }

    if ($AllImages.Count -eq 1 -and $AllAudio.Count -eq 1) {
        return $AllImages[0]
    }

    return $null
}

function Find-LyricsForAudio {
    param(
        [System.IO.FileInfo]$Audio,
        [System.IO.FileInfo[]]$AllLyrics,
        [System.IO.FileInfo[]]$AllAudio
    )

    $audioStem = [System.IO.Path]::GetFileNameWithoutExtension($Audio.Name)

    $matchingByName = @($AllLyrics | Where-Object {
        [System.IO.Path]::GetFileNameWithoutExtension($_.Name) -ieq $audioStem
    })
    if ($matchingByName.Count -eq 1) {
        return $matchingByName[0]
    }

    $genericLyrics = @($AllLyrics | Where-Object {
        [System.IO.Path]::GetFileNameWithoutExtension($_.Name).ToLowerInvariant() -eq "lyrics"
    })
    if ($genericLyrics.Count -eq 1 -and $AllAudio.Count -eq 1) {
        return $genericLyrics[0]
    }

    if ($AllLyrics.Count -eq 1 -and $AllAudio.Count -eq 1) {
        return $AllLyrics[0]
    }

    return $null
}

New-Item -ItemType Directory -Force -Path $InboxPath, $QueuePath | Out-Null

if (-not (Test-Path -LiteralPath $RenderScript)) {
    throw "Render script not found: $RenderScript"
}

$allFiles = @(Get-ChildItem -LiteralPath $InboxPath -File -ErrorAction Stop)
$audioFiles = @($allFiles | Where-Object { $audioExtensions -contains $_.Extension.ToLowerInvariant() } | Sort-Object LastWriteTime, Name)
$imageFiles = @($allFiles | Where-Object { $imageExtensions -contains $_.Extension.ToLowerInvariant() } | Sort-Object LastWriteTime, Name)
$lyricFiles = @($allFiles | Where-Object { $lyricExtensions -contains $_.Extension.ToLowerInvariant() -and $_.Name.ToLowerInvariant() -ne "metadata.json" } | Sort-Object LastWriteTime, Name)

if ($audioFiles.Count -eq 0) {
    ConvertTo-Json -InputObject @() -Depth 10 -Compress
    exit 0
}

$results = @()
$resultJsonParts = @()

foreach ($audio in $audioFiles) {
    if (-not (Wait-FileStable -Path $audio.FullName)) {
        $resultJsonParts += (ConvertTo-Json -InputObject ([pscustomobject]@{
            audio = $audio.Name
            status = "skipped"
            reason = "Audio file is still copying"
        }) -Depth 10 -Compress)
        continue
    }

    $image = Find-ImageForAudio -Audio $audio -AllImages $imageFiles -AllAudio $audioFiles
    if ($null -eq $image) {
        $resultJsonParts += (ConvertTo-Json -InputObject ([pscustomobject]@{
            audio = $audio.Name
            status = "skipped"
            reason = "No matching image found. Use one audio + one image, or matching names like Song.wav + Song.jpg"
        }) -Depth 10 -Compress)
        continue
    }

    if (-not (Wait-FileStable -Path $image.FullName)) {
        $resultJsonParts += (ConvertTo-Json -InputObject ([pscustomobject]@{
            audio = $audio.Name
            image = $image.Name
            status = "skipped"
            reason = "Image file is still copying"
        }) -Depth 10 -Compress)
        continue
    }

    $lyrics = Find-LyricsForAudio -Audio $audio -AllLyrics $lyricFiles -AllAudio $audioFiles
    if ($null -ne $lyrics -and -not (Wait-FileStable -Path $lyrics.FullName)) {
        $resultJsonParts += (ConvertTo-Json -InputObject ([pscustomobject]@{
            audio = $audio.Name
            image = $image.Name
            lyrics = $lyrics.Name
            status = "skipped"
            reason = "Lyrics file is still copying"
        }) -Depth 10 -Compress)
        continue
    }

    $title = [System.IO.Path]::GetFileNameWithoutExtension($audio.Name)
    $projectName = Get-SafeName -Name $title
    $projectPath = Get-UniqueProjectPath -Root $QueuePath -ProjectName $projectName
    New-Item -ItemType Directory -Force -Path $projectPath | Out-Null

    $targetAudio = Join-Path $projectPath $audio.Name
    $targetImage = Join-Path $projectPath ("background" + $image.Extension.ToLowerInvariant())
    $metadataTarget = Join-Path $projectPath "metadata.json"
    $metadataTemplate = Join-Path $factoryRoot "metadata.template.json"

    Move-Item -LiteralPath $audio.FullName -Destination $targetAudio
    Move-Item -LiteralPath $image.FullName -Destination $targetImage

    if ($null -ne $lyrics) {
        $targetLyrics = Join-Path $projectPath ("lyrics" + $lyrics.Extension.ToLowerInvariant())
        Move-Item -LiteralPath $lyrics.FullName -Destination $targetLyrics
    }

    if (Test-Path -LiteralPath $metadataTemplate) {
        Copy-Item -LiteralPath $metadataTemplate -Destination $metadataTarget -Force
    } else {
        @{
            visualArtist = "Nightcore"
            title = ""
            youtubeTitle = ""
            description = "AI-generated nightcore visualizer."
            tags = @("nightcore", "suno ai", "ai music")
            privacy = "private"
            accentColor = "auto"
        } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $metadataTarget -Encoding utf8
    }

    $renderStatus = "not-run"
    $renderLog = Join-Path $projectPath "render.log"
    if ($Render) {
        $renderOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $RenderScript -ProjectPath $projectPath 2>&1
        $renderOutput | ForEach-Object { $_.ToString() } | Set-Content -LiteralPath $renderLog -Encoding utf8
        if ($LASTEXITCODE -ne 0) {
            throw "Render failed for project: $projectPath. Log: $renderLog"
        }
        $renderStatus = "rendered"
    }

    $outputPath = Join-Path (Join-Path $factoryRoot "outputs") (Split-Path -Leaf $projectPath)
    $summaryPath = Join-Path $outputPath ("{0}-render-summary.json" -f (Split-Path -Leaf $projectPath))

    if (-not (Test-Path -LiteralPath $resultFormatter)) {
        throw "n8n result formatter not found: $resultFormatter"
    }

    $itemJson = & node $resultFormatter `
        --audio $audio.Name `
        --image $image.Name `
        --status $renderStatus `
        --projectPath $projectPath `
        --renderLog $renderLog `
        --summaryPath $summaryPath

    if ($LASTEXITCODE -ne 0) {
        throw "Failed to format n8n result for project: $projectPath"
    }

    $resultJsonParts += (($itemJson -join "`n").Trim())

    $allFiles = @(Get-ChildItem -LiteralPath $InboxPath -File -ErrorAction Stop)
    $imageFiles = @($allFiles | Where-Object { $imageExtensions -contains $_.Extension.ToLowerInvariant() } | Sort-Object LastWriteTime, Name)
    $lyricFiles = @($allFiles | Where-Object { $lyricExtensions -contains $_.Extension.ToLowerInvariant() -and $_.Name.ToLowerInvariant() -ne "metadata.json" } | Sort-Object LastWriteTime, Name)
}

Write-Output ("[" + ($resultJsonParts -join ",") + "]")
