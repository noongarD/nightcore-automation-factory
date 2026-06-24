const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync, spawnSync } = require("node:child_process");
const { chromium } = require("playwright");

const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const TITLE_PLACEHOLDERS = new Set([
  "",
  "song",
  "audio",
  "wpisz_tutaj_nazwe_piosenki",
  "wpisz tutaj nazwe piosenki",
  "wpisz tutaj nazwę piosenki",
]);

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    args[key] = value;
  }
  return args;
}

function mustExist(filePath, label) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`${label} was not found: ${filePath}`);
  }
  return filePath;
}

function resolveCommand(value, label) {
  if (!value) throw new Error(`${label} was not configured.`);
  if (!path.isAbsolute(value) && !value.includes(path.sep)) return value;
  return mustExist(path.resolve(value), label);
}

function firstExisting(projectPath, names) {
  for (const name of names) {
    const candidate = path.join(projectPath, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findProjectFile(projectPath, preferredNames, extensions, label) {
  const preferred = firstExisting(projectPath, preferredNames);
  if (preferred) return preferred;

  const candidates = fs.readdirSync(projectPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(projectPath, entry.name))
    .filter((filePath) => extensions.has(path.extname(filePath).toLowerCase()))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    const names = candidates.map((candidate) => path.basename(candidate)).join(", ");
    throw new Error(`Multiple ${label} files found. Keep one file or use a standard name. Found: ${names}`);
  }

  return null;
}

function sanitizeName(value) {
  return String(value || "nightcore")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "nightcore";
}

function isTitlePlaceholder(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  return TITLE_PLACEHOLDERS.has(normalized);
}

function titleFromFileName(filePath) {
  const baseName = path.basename(filePath, path.extname(filePath));
  return baseName
    .replace(/^nightcore\s*[-_:]\s*/i, "")
    .replace(/\s*\(\d+\)\s*$/g, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+-\s+/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTitle(value, fallback) {
  const raw = String(value || fallback || "Nightcore").trim();
  return raw.replace(/^nightcore\s*[-:]\s*/i, "").trim() || raw;
}

function normalizeAccentColor(value) {
  const color = String(value || "").trim();
  if (!color || color.toLowerCase() === "auto") return "";
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  throw new Error(`Invalid accentColor in metadata.json: ${value}. Use empty string, "auto", or a hex color like #ff3300.`);
}

function formatTimestamp(totalSeconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function renderTextTemplate(value, variables) {
  return String(value || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key]) : match;
  });
}

function normalizeLyricLine(entry, offsetSeconds, durationSeconds) {
  const start = Number(entry.start) - offsetSeconds;
  const end = Number(entry.end) - offsetSeconds;
  const text = String(entry.text || entry.line || entry.lyric || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!Number.isFinite(start) || !Number.isFinite(end) || !text) return null;
  if (end <= 0 || start >= durationSeconds + 0.5) return null;

  return {
    start: Math.max(0, start),
    end: Math.min(durationSeconds, Math.max(start + 0.25, end)),
    text,
  };
}

function loadLyrics(lyricsPath, offsetSeconds, durationSeconds) {
  if (!lyricsPath || !fs.existsSync(lyricsPath)) {
    return { path: null, timingMode: "none", lines: [] };
  }

  const parsed = JSON.parse(fs.readFileSync(lyricsPath, "utf8").replace(/^\uFEFF/, ""));
  const sourceLines = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.lines)
      ? parsed.lines
      : Array.isArray(parsed.lyrics)
        ? parsed.lyrics
        : [];

  const lines = sourceLines
    .map((entry) => normalizeLyricLine(entry, offsetSeconds, durationSeconds))
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);

  return {
    path: lyricsPath,
    timingMode: parsed.timingMode || "source",
    lines,
  };
}

function getDurationSeconds(ffprobePath, audioPath) {
  const output = execFileSync(ffprobePath, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    audioPath,
  ], { encoding: "utf8" }).trim();

  const duration = Number(output);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not read audio duration from: ${audioPath}`);
  }
  return duration;
}

function runFfmpeg(ffmpegPath, rawWebmPath, mp4Path, variant) {
  const scaleFilter = variant === "short"
    ? "fps=60,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2"
    : "fps=60";

  const nvencArgs = [
    "-y",
    "-i", rawWebmPath,
    "-vf", scaleFilter,
    "-c:v", "h264_nvenc",
    "-preset", "p5",
    "-cq", "19",
    "-r", "60",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    mp4Path,
  ];

  const nvenc = spawnSync(ffmpegPath, nvencArgs, { encoding: "utf8" });
  if (nvenc.status === 0) return "h264_nvenc";

  const fallbackArgs = [
    "-y",
    "-i", rawWebmPath,
    "-vf", scaleFilter,
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "18",
    "-r", "60",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    mp4Path,
  ];

  const fallback = spawnSync(ffmpegPath, fallbackArgs, { encoding: "utf8" });
  if (fallback.status !== 0) {
    throw new Error(`ffmpeg failed.\nNVENC:\n${nvenc.stderr}\nFallback:\n${fallback.stderr}`);
  }
  return "libx264";
}

async function waitForFileReady(filePath) {
  const previousSize = fs.statSync(filePath).size;
  await new Promise((resolve) => setTimeout(resolve, 750));
  const currentSize = fs.statSync(filePath).size;
  if (previousSize !== currentSize) {
    await waitForFileReady(filePath);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const projectPath = mustExist(path.resolve(args.project), "Project folder");
  const templatePath = mustExist(path.resolve(args.template), "Visualizer template");
  const outputRoot = mustExist(path.resolve(args.outputRoot), "Output root");
  const ffmpegPath = resolveCommand(args.ffmpeg || process.env.FFMPEG_PATH || "ffmpeg", "ffmpeg");
  const ffprobePath = resolveCommand(args.ffprobe || process.env.FFPROBE_PATH || "ffprobe", "ffprobe");
  const variant = String(args.variant || "youtube").trim().toLowerCase();
  const outputSuffix = typeof args.outputSuffix === "string"
    ? args.outputSuffix
    : (variant === "short" ? "-short" : "");

  const metadataPath = path.join(projectPath, "metadata.json");
  const metadata = fs.existsSync(metadataPath)
    ? JSON.parse(fs.readFileSync(metadataPath, "utf8").replace(/^\uFEFF/, ""))
    : {};

  const audioPath = args.audioPath
    ? mustExist(path.resolve(args.audioPath), "audio file")
    : findProjectFile(projectPath, [
      "song.wav", "song.mp3", "song.flac", "audio.wav", "audio.mp3", "audio.flac",
    ], AUDIO_EXTENSIONS, "audio");
  const titleSourcePath = args.titleSourcePath
    ? mustExist(path.resolve(args.titleSourcePath), "title source audio file")
    : audioPath;
  const backgroundPath = args.backgroundPath
    ? mustExist(path.resolve(args.backgroundPath), "background image")
    : findProjectFile(projectPath, [
      "background.jpg", "background.jpeg", "background.png", "background.webp",
    ], IMAGE_EXTENSIONS, "background image");
  const thumbPath = firstExisting(projectPath, [
    "thumbnail.jpg", "thumbnail.jpeg", "thumbnail.png", "thumbnail.webp",
  ]);

  mustExist(audioPath, "audio file");
  mustExist(backgroundPath, "background image");

  await waitForFileReady(audioPath);
  await waitForFileReady(backgroundPath);

  const projectName = sanitizeName(path.basename(projectPath));
  const outputDir = path.join(outputRoot, projectName);
  fs.mkdirSync(outputDir, { recursive: true });

  const rawWebmPath = path.join(outputDir, `${projectName}${outputSuffix}.webm`);
  const mp4Path = path.join(outputDir, `${projectName}${outputSuffix}.mp4`);
  const thumbnailOutputPath = path.join(outputDir, `${projectName}${outputSuffix}-thumbnail.jpg`);
  const summaryPath = args.summaryPath
    ? path.resolve(args.summaryPath)
    : path.join(outputDir, `${projectName}${outputSuffix}-render-summary.json`);
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });

  const duration = getDurationSeconds(ffprobePath, audioPath);
  const renderWaitMs = Math.ceil((duration + Number(metadata.extraTailSeconds || 0.75)) * 1000);
  const timeoutMs = renderWaitMs + 120000;
  const titleFromAudio = titleFromFileName(titleSourcePath);
  const metadataTitle = metadata.visualTitle || metadata.title || metadata.songTitle || metadata.youtubeTitle;
  const visualArtist = String(
    args.visualArtist ||
    (variant === "short" && (
      metadata.shortVisualArtist ||
      metadata.shortDisplayText ||
      metadata.shortArtist
    )) ||
    metadata.visualArtist ||
    metadata.visualizerArtist ||
    metadata.displayArtist ||
    "Nightcore"
  );
  const songTitle = cleanTitle(
    isTitlePlaceholder(metadataTitle) ? titleFromAudio : metadataTitle,
    projectName
  );
  const youtubeTitle = metadata.youtubeTitle || `Nightcore - ${songTitle}`;
  const accentColor = normalizeAccentColor(metadata.accentColor);
  const descriptionSource = metadata.description || metadata.descriptionTemplate || "";
  const description = renderTextTemplate(descriptionSource, {
    title: songTitle,
    youtubeTitle,
    visualArtist,
    outroTimestamp: formatTimestamp(duration),
  });
  const lyricsEnabled = metadata.lyricsEnabled !== false && metadata.lyrics !== false;
  const lyricsPath = args.lyricsPath
    ? path.resolve(args.lyricsPath)
    : path.join(projectPath, "lyrics.json");
  const lyricsOffsetSeconds = Number(args.lyricsOffsetSeconds || 0);
  const lyricsInfo = lyricsEnabled
    ? loadLyrics(lyricsPath, lyricsOffsetSeconds, duration)
    : { path: null, timingMode: "disabled", lines: [] };
  const mixTimeline = Array.isArray(metadata.mixTimeline)
    ? metadata.mixTimeline
      .map((track, index) => ({
        index: Number(track.index || index + 1),
        title: String(track.title || `Track ${index + 1}`).trim(),
        start: Number(track.start),
        end: Number(track.end),
      }))
      .filter((track) => track.title && Number.isFinite(track.start) && Number.isFinite(track.end) && track.end > track.start)
      .sort((a, b) => a.start - b.start)
    : [];

  console.log(`Project: ${projectName}`);
  console.log(`Audio duration: ${duration.toFixed(2)}s`);
  console.log(`Output: ${outputDir}`);
  if (lyricsInfo.lines.length > 0) {
    console.log(`Lyrics: ${lyricsInfo.lines.length} lines (${lyricsInfo.timingMode})`);
  }

  const headless = metadata.headless === true;
  const browser = await chromium.launch({
    headless,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--window-size=1920,1080",
      "--use-angle=d3d11",
      "--enable-gpu-rasterization",
    ],
  });

  try {
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    });
    context.setDefaultTimeout(timeoutMs);

    const page = await context.newPage();
    await page.bringToFront();
    await page.goto(pathToFileURL(templatePath).href, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#image-upload");

    await page.setInputFiles("#image-upload", backgroundPath);
    await page.setInputFiles("#audio-upload", audioPath);
    await page.fill("#artist-input", visualArtist);
    await page.fill("#title-input", songTitle);
    await page.evaluate((payload) => {
      window.__nightcoreLyrics = payload.lines;
      window.__nightcoreLyricsOptions = payload.options;
      window.__nightcoreMix = payload.mix;
    }, {
      lines: lyricsInfo.lines,
      options: {
        enabled: lyricsInfo.lines.length > 0,
        variant,
      },
      mix: {
        title: metadata.mixTitle || metadata.youtubeTitle || youtubeTitle,
        durationSeconds: duration,
        tracks: mixTimeline,
      },
    });

    if (accentColor) {
      await page.evaluate((color) => {
        const picker = document.querySelector("#accent-color-picker");
        picker.value = color;
        picker.dispatchEvent(new Event("input", { bubbles: true }));
      }, accentColor);
    }

    await page.waitForTimeout(2000);

    await page.click("#tab-thumb");
    if (thumbPath) {
      await page.setInputFiles("#thumb-image-upload", thumbPath);
      await page.waitForTimeout(750);
    }

    const thumbnailDownload = page.waitForEvent("download", { timeout: timeoutMs });
    await page.click("#download-thumb-btn");
    const downloadedThumb = await thumbnailDownload;
    await downloadedThumb.saveAs(thumbnailOutputPath);
    console.log(`Thumbnail saved: ${thumbnailOutputPath}`);

    await page.click("#tab-vis");
    await page.waitForTimeout(500);

    const videoDownload = page.waitForEvent("download", { timeout: timeoutMs });
    await page.click("#record-btn");
    await page.waitForTimeout(renderWaitMs);
    await page.evaluate(() => {
      const controls = document.querySelector("#controls");
      if (controls) controls.classList.remove("controls-hidden");
      const recordButton = document.querySelector("#record-btn");
      if (!recordButton) throw new Error("Record button was not found.");
      recordButton.click();
    });
    const downloadedVideo = await videoDownload;
    await downloadedVideo.saveAs(rawWebmPath);
    console.log(`WebM saved: ${rawWebmPath}`);

    await context.close();
  } finally {
    await browser.close();
  }

  const encoder = runFfmpeg(ffmpegPath, rawWebmPath, mp4Path, variant);
  console.log(`MP4 saved: ${mp4Path}`);

  const summary = {
    variant,
    project: projectName,
    projectPath,
    durationSeconds: duration,
    encoder,
    files: {
      mp4: mp4Path,
      webm: rawWebmPath,
      thumbnail: thumbnailOutputPath,
      metadata: fs.existsSync(metadataPath) ? metadataPath : null,
      audio: audioPath,
      titleSourceAudio: titleSourcePath,
      background: backgroundPath,
      lyrics: lyricsInfo.path,
    },
    lyrics: {
      enabled: lyricsInfo.lines.length > 0,
      timingMode: lyricsInfo.timingMode,
      lineCount: lyricsInfo.lines.length,
      offsetSeconds: lyricsOffsetSeconds,
    },
    visualizer: {
      artist: visualArtist,
      title: songTitle,
    },
    mix: {
      enabled: mixTimeline.length > 0,
      title: metadata.mixTitle || "",
      trackCount: mixTimeline.length,
      timeline: mixTimeline,
    },
    youtube: {
      title: youtubeTitle,
      description,
      tags: Array.isArray(metadata.tags) ? metadata.tags : [],
      privacy: metadata.privacy || "private",
    },
    renderedAt: new Date().toISOString(),
  };

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(`Summary saved: ${summaryPath}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
