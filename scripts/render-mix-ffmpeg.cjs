const fs = require("node:fs");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");

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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function safeName(value) {
  return String(value || "Nightcore Mix")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "Nightcore Mix";
}

function assTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const wholeSeconds = Math.floor(safe % 60);
  const centiseconds = Math.floor((safe - Math.floor(safe)) * 100);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function escapeAssText(value) {
  return String(value || "")
    .replace(/[{}]/g, "")
    .replace(/\r?\n/g, " ")
    .trim()
    .toUpperCase();
}

function writeAss(projectPath, titleEvents, durationSeconds) {
  const assPath = path.join(projectPath, "mix-titles.ass");
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1920",
    "PlayResY: 1080",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Glow,Arial Black,104,&H00FFFFFF,&H000000FF,&H00FF8CB9,&H00000000,-1,0,0,0,100,100,0,0,1,12,0,2,60,60,66,1",
    "Style: Title,Arial Black,104,&H00FFFFFF,&H000000FF,&H00000000,&HAA000000,-1,0,0,0,100,100,0,0,1,5,3,2,60,60,66,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events = titleEvents.flatMap((track, index) => {
    const next = titleEvents[index + 1];
    const start = Number(track.start) || 0;
    const end = Math.max(start + 0.1, Number(next?.start ?? track.end ?? durationSeconds) || durationSeconds);
    const text = escapeAssText(track.title);
    return [
      `Dialogue: 0,${assTime(start)},${assTime(end)},Glow,,0,0,0,,${text}`,
      `Dialogue: 1,${assTime(start)},${assTime(end)},Title,,0,0,0,,${text}`,
    ];
  });

  fs.writeFileSync(assPath, `${header.concat(events).join("\n")}\n`, "utf8");
  return assPath;
}

function getDurationSeconds(ffprobePath, filePath) {
  const output = execFileSync(ffprobePath, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ], { encoding: "utf8" }).trim();
  return Number(output);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.status !== 0) {
    const message = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(message || `${path.basename(command)} failed with exit code ${result.status}`);
  }
  return result;
}

function renderThumbnail(ffmpegPath, backgroundPath, thumbnailPath) {
  run(ffmpegPath, [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", backgroundPath,
    "-vf", "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,format=yuvj420p",
    "-frames:v", "1",
    "-q:v", "2",
    thumbnailPath,
  ]);
}

function renderVideo(ffmpegPath, projectPath, backgroundPath, audioPath, assPath, mp4Path, limitSeconds) {
  const filter = [
    "[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,format=rgba[bg]",
    "[1:a]showfreqs=s=1920x230:mode=bar:ascale=sqrt:fscale=log:colors=0xB88CFF|0xFFFFFF:win_size=2048:overlap=0.75,format=rgba,colorkey=black:0.18:0.08,colorchannelmixer=aa=0.86[spec]",
    "[bg][spec]overlay=0:H-h:format=auto,ass=mix-titles.ass[v]",
  ].join(";");

  const baseArgs = [
    "-hide_banner",
    "-y",
    "-loop", "1",
    "-framerate", "60",
    "-i", backgroundPath,
    "-i", audioPath,
    "-filter_complex", filter,
    "-map", "[v]",
    "-map", "1:a",
  ];

  if (limitSeconds > 0) baseArgs.push("-t", String(limitSeconds));

  const outputArgs = [
    "-r", "60",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    "-shortest",
    mp4Path,
  ];

  const nvencArgs = baseArgs.concat([
    "-c:v", "h264_nvenc",
    "-preset", "p5",
    "-rc", "vbr",
    "-cq", "19",
    "-b:v", "12M",
    "-maxrate", "18M",
    "-bufsize", "24M",
  ], outputArgs);

  const nvenc = spawnSync(ffmpegPath, nvencArgs, {
    cwd: projectPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (nvenc.status === 0) return { encoder: "h264_nvenc", stderr: nvenc.stderr || "" };

  const cpuArgs = baseArgs.concat([
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
  ], outputArgs);
  run(ffmpegPath, cpuArgs, { cwd: projectPath });
  return { encoder: "libx264", nvencError: nvenc.stderr || "" };
}

function main() {
  const args = parseArgs(process.argv);
  const projectPath = path.resolve(args.project || "");
  const factoryRoot = path.resolve(process.env.NIGHTCORE_FACTORY_ROOT || "C:\\NightcoreFactory");
  const outputRoot = path.resolve(args.outputRoot || path.join(factoryRoot, "mix-outputs"));
  const ffmpegPath = args.ffmpeg || process.env.FFMPEG_PATH || "ffmpeg";
  const ffprobePath = args.ffprobe || process.env.FFPROBE_PATH || "ffprobe";
  const limitSeconds = Number(args.limitSeconds || 0);

  if (!projectPath || !fs.existsSync(projectPath)) throw new Error(`Project folder not found: ${projectPath}`);

  const metadataPath = path.join(projectPath, "metadata.json");
  const mixSummaryPath = path.join(projectPath, "mix-summary.json");
  const metadata = fs.existsSync(metadataPath) ? readJson(metadataPath) : {};
  const mixSummary = fs.existsSync(mixSummaryPath) ? readJson(mixSummaryPath) : {};

  const projectName = safeName(path.basename(projectPath));
  const audioPath = path.resolve(args.audioPath || mixSummary.mixAudioPath || path.join(projectPath, "mix.wav"));
  const backgroundPath = path.resolve(args.backgroundPath || mixSummary.backgroundPath || path.join(projectPath, "background.jpg"));
  if (!fs.existsSync(audioPath)) throw new Error(`Audio not found: ${audioPath}`);
  if (!fs.existsSync(backgroundPath)) throw new Error(`Background not found: ${backgroundPath}`);

  const outputDir = path.join(outputRoot, projectName);
  fs.mkdirSync(outputDir, { recursive: true });

  const mp4Path = path.join(outputDir, `${projectName}.mp4`);
  const thumbnailPath = path.join(outputDir, `${projectName}-thumbnail.jpg`);
  const summaryPath = args.summaryPath ? path.resolve(args.summaryPath) : path.join(projectPath, "mix-render-summary.json");
  const durationSeconds = getDurationSeconds(ffprobePath, audioPath);
  const timeline = Array.isArray(metadata.mixTimeline) ? metadata.mixTimeline : (mixSummary.tracks || []);
  const assPath = writeAss(projectPath, timeline, durationSeconds);

  renderThumbnail(ffmpegPath, backgroundPath, thumbnailPath);
  const encoder = renderVideo(ffmpegPath, projectPath, backgroundPath, audioPath, assPath, mp4Path, limitSeconds);

  const summary = {
    variant: "mix-offline",
    project: projectName,
    projectPath,
    durationSeconds,
    renderedSeconds: limitSeconds > 0 ? limitSeconds : durationSeconds,
    encoder,
    files: {
      mp4: mp4Path,
      thumbnail: thumbnailPath,
      metadata: fs.existsSync(metadataPath) ? metadataPath : null,
      audio: audioPath,
      background: backgroundPath,
      ass: assPath,
    },
    youtube: {
      title: metadata.youtubeTitle || metadata.title || projectName,
      description: metadata.description || "",
      tags: metadata.tags || [],
      privacy: metadata.privacy || "private",
    },
    mix: {
      enabled: true,
      title: metadata.mixTitle || metadata.title || projectName,
      trackCount: timeline.length,
      timeline,
    },
  };

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  process.stdout.write(JSON.stringify(summary, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
}
