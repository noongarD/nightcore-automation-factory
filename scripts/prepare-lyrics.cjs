const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const LYRIC_EXTENSIONS = new Set([".json", ".srt", ".lrc", ".txt"]);

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

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
}

function cleanLine(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\{[^}]+\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldSkipPlainLine(line) {
  const normalized = line.trim();
  return !normalized || /^\[[^\]]+\]$/.test(normalized);
}

function toSeconds(hours, minutes, seconds, millis = 0) {
  return Number(hours || 0) * 3600 + Number(minutes || 0) * 60 + Number(seconds || 0) + Number(millis || 0) / 1000;
}

function parseSrtTime(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!match) return null;
  return toSeconds(match[1], match[2], match[3], match[4].padEnd(3, "0"));
}

function normalizeEntries(entries, durationSeconds) {
  const normalized = entries
    .map((entry) => ({
      start: Number(entry.start),
      end: Number(entry.end),
      text: cleanLine(entry.text),
    }))
    .filter((entry) => Number.isFinite(entry.start) && entry.start >= 0 && entry.text)
    .sort((a, b) => a.start - b.start);

  for (let i = 0; i < normalized.length; i += 1) {
    const current = normalized[i];
    const next = normalized[i + 1];
    if (!Number.isFinite(current.end) || current.end <= current.start) {
      const fallbackEnd = next ? next.start - 0.08 : current.start + 3.2;
      current.end = Math.max(current.start + 0.75, fallbackEnd);
    }
    if (next && current.end > next.start - 0.08) {
      current.end = Math.max(current.start + 0.75, next.start - 0.08);
    }
    if (Number.isFinite(durationSeconds)) {
      current.end = Math.min(current.end, durationSeconds);
    }
  }

  return normalized.filter((entry) => entry.end > entry.start);
}

function parseSrt(filePath, durationSeconds) {
  const raw = readText(filePath).replace(/\r/g, "");
  const entries = raw.split(/\n\s*\n/g).flatMap((block) => {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timeLineIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeLineIndex === -1) return [];
    const [startRaw, endRaw] = lines[timeLineIndex].split("-->").map((part) => part.trim().split(/\s+/)[0]);
    const start = parseSrtTime(startRaw);
    const end = parseSrtTime(endRaw);
    const text = lines.slice(timeLineIndex + 1).join(" ");
    return start === null || end === null ? [] : [{ start, end, text }];
  });
  return normalizeEntries(entries, durationSeconds);
}

function parseLrcTime(value) {
  const match = String(value || "").match(/^(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?$/);
  if (!match) return null;
  const fraction = match[3] ? match[3].padEnd(3, "0").slice(0, 3) : "0";
  return Number(match[1]) * 60 + Number(match[2]) + Number(fraction) / 1000;
}

function parseLrc(filePath, durationSeconds) {
  const entries = [];
  for (const rawLine of readText(filePath).split(/\r?\n/g)) {
    const tags = [...rawLine.matchAll(/\[([^\]]+)\]/g)];
    if (tags.length === 0) continue;
    const text = cleanLine(rawLine.replace(/\[[^\]]+\]/g, ""));
    if (!text) continue;
    for (const tag of tags) {
      const start = parseLrcTime(tag[1]);
      if (start !== null) entries.push({ start, text });
    }
  }
  return normalizeEntries(entries, durationSeconds);
}

function parseJson(filePath, durationSeconds) {
  const parsed = JSON.parse(readText(filePath));
  const source = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.lyrics)
      ? parsed.lyrics
      : Array.isArray(parsed.lines)
        ? parsed.lines
        : Array.isArray(parsed.segments)
          ? parsed.segments
          : [];

  const entries = source.map((entry) => ({
    start: entry.start,
    end: entry.end,
    text: entry.text || entry.line || entry.lyric,
  }));

  return normalizeEntries(entries, durationSeconds);
}

function parsePlainText(filePath, durationSeconds, metadata) {
  const lines = readText(filePath)
    .split(/\r?\n/g)
    .map(cleanLine)
    .filter((line) => !shouldSkipPlainLine(line));

  if (lines.length === 0) return [];

  const startSeconds = Number(metadata.lyricsStartSeconds ?? 11);
  const endPaddingSeconds = Number(metadata.lyricsEndPaddingSeconds ?? 8);
  const usableDuration = Math.max(lines.length * 1.4, Number(durationSeconds || 0) - startSeconds - endPaddingSeconds);
  const weights = lines.map((line) => Math.max(1.2, line.split(/\s+/).length * 0.55));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  let cursor = Math.max(0, startSeconds);
  const entries = lines.map((line, index) => {
    const seconds = Math.max(1.25, (usableDuration * weights[index]) / totalWeight);
    const entry = { start: cursor, end: cursor + seconds, text: line };
    cursor = entry.end;
    return entry;
  });

  return normalizeEntries(entries, durationSeconds);
}

function getDurationSeconds(ffprobePath, audioPath) {
  if (!ffprobePath || !audioPath || !fs.existsSync(ffprobePath) || !fs.existsSync(audioPath)) return null;
  const output = execFileSync(ffprobePath, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    audioPath,
  ], { encoding: "utf8" }).trim();
  const duration = Number(output);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function findLyricsSource(projectPath, explicitPath) {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    return fs.existsSync(resolved) ? resolved : null;
  }

  const preferred = ["lyrics.json", "lyrics.srt", "lyrics.lrc", "lyrics.txt"];
  for (const name of preferred) {
    const candidate = path.join(projectPath, name);
    if (fs.existsSync(candidate)) return candidate;
  }

  const candidates = fs.readdirSync(projectPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(projectPath, entry.name))
    .filter((filePath) => LYRIC_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
    .filter((filePath) => path.basename(filePath).toLowerCase() !== "metadata.json")
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

  return candidates[0] || null;
}

function loadMetadata(projectPath) {
  const metadataPath = path.join(projectPath, "metadata.json");
  if (!fs.existsSync(metadataPath)) return {};
  try {
    return JSON.parse(readText(metadataPath));
  } catch {
    return {};
  }
}

function isTruthy(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    return !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());
  }
  return false;
}

function runAutoTranscription(args, metadata, outputPath, lyricsSourcePath = "") {
  if (!args.audio || !fs.existsSync(args.audio)) {
    throw new Error("lyricsAutoTranscribe is enabled, but no audio path was provided.");
  }

  const scriptPath = path.join(__dirname, "transcribe-lyrics.py");
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Transcription script was not found: ${scriptPath}`);
  }

  const pythonCommand = metadata.lyricsPython || "python";
  const model = String(metadata.lyricsWhisperModel || "base");
  const language = String(metadata.lyricsLanguage || "");
  const maxWords = String(metadata.lyricsMaxWordsPerLine || 7);
  const maxSeconds = String(metadata.lyricsMaxLineSeconds || 4.2);
  const commandArgs = [
    scriptPath,
    "--audio", path.resolve(args.audio),
    "--output", outputPath,
    "--model", model,
    "--max-words", maxWords,
    "--max-seconds", maxSeconds,
  ];

  if (language) {
    commandArgs.push("--language", language);
  }
  if (lyricsSourcePath) {
    commandArgs.push("--lyrics", path.resolve(lyricsSourcePath));
  }

  const result = spawnSync(pythonCommand, commandArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new Error(`Auto transcription failed.\n${result.stdout}\n${result.stderr}`);
  }

  return result.stdout.trim();
}

function main() {
  const args = parseArgs(process.argv);
  const projectPath = path.resolve(args.project || ".");
  const outputPath = path.resolve(args.output || path.join(projectPath, "lyrics.json"));
  const sourcePath = findLyricsSource(projectPath, args.source);
  const metadata = loadMetadata(projectPath);

  if (!sourcePath) {
    if (isTruthy(metadata.lyricsAutoTranscribe)) {
      const transcriptionOutput = runAutoTranscription(args, metadata, outputPath);
      console.log(transcriptionOutput || JSON.stringify({ status: "ready", output: outputPath, timingMode: "whisper" }));
      return;
    }

    console.log(JSON.stringify({ status: "missing" }));
    return;
  }

  const durationSeconds = getDurationSeconds(args.ffprobe, args.audio);
  const extension = path.extname(sourcePath).toLowerCase();
  let entries;

  if (extension === ".srt") entries = parseSrt(sourcePath, durationSeconds);
  else if (extension === ".lrc") entries = parseLrc(sourcePath, durationSeconds);
  else if (extension === ".json") entries = parseJson(sourcePath, durationSeconds);
  else if (isTruthy(metadata.lyricsAutoTimestampText ?? metadata.lyricsAutoTranscribe)) {
    try {
      const transcriptionOutput = runAutoTranscription(args, metadata, outputPath, sourcePath);
      console.log(transcriptionOutput || JSON.stringify({ status: "ready", output: outputPath, timingMode: "whisper-align" }));
      return;
    } catch (error) {
      console.error(`Text timestamping failed, falling back to estimated lyrics: ${error.message || error}`);
      entries = parsePlainText(sourcePath, durationSeconds, metadata);
    }
  } else {
    entries = parsePlainText(sourcePath, durationSeconds, metadata);
  }

  const payload = {
    version: 1,
    source: sourcePath,
    generatedAt: new Date().toISOString(),
    timingMode: extension === ".txt" ? "estimated" : "source",
    lines: entries,
  };

  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(JSON.stringify({
    status: entries.length > 0 ? "ready" : "empty",
    source: sourcePath,
    output: outputPath,
    lines: entries.length,
    timingMode: payload.timingMode,
  }));
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
}
