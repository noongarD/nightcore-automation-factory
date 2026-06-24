const fs = require("node:fs");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");

const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg", ".webm", ".mp4"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

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

function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

function stripNightcorePrefix(value) {
  return String(value || "")
    .replace(/^nightcore\s*[-:]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function prettifyTitle(value) {
  return stripNightcorePrefix(String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

function ensureUniqueDir(root, name) {
  const base = path.join(root, safeName(name));
  if (!fs.existsSync(base)) return base;
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
  return path.join(root, `${safeName(name)}-${stamp}`);
}

function formatTimestamp(totalSeconds) {
  const safe = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function getDurationSeconds(ffprobePath, filePath) {
  const output = execFileSync(ffprobePath, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ], { encoding: "utf8" }).trim();
  const duration = Number(output);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not read duration from: ${filePath}`);
  }
  return duration;
}

function listFiles(folderPath) {
  if (!fs.existsSync(folderPath)) return [];
  return fs.readdirSync(folderPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      name: entry.name,
      path: path.join(folderPath, entry.name),
      extension: path.extname(entry.name).toLowerCase(),
    }));
}

function chooseAudioFile(folderPath) {
  const rank = new Map([
    [".wav", 0],
    [".flac", 1],
    [".mp3", 2],
    [".m4a", 3],
    [".aac", 4],
    [".ogg", 5],
    [".webm", 6],
    [".mp4", 7],
  ]);

  return listFiles(folderPath)
    .filter((file) => AUDIO_EXTENSIONS.has(file.extension))
    .sort((a, b) => {
      const aPenalty = /tiktok|visualizer|short/i.test(a.name) ? 20 : 0;
      const bPenalty = /tiktok|visualizer|short/i.test(b.name) ? 20 : 0;
      const aVideoPenalty = /video|nightcore/i.test(a.name) && a.extension !== ".wav" ? 10 : 0;
      const bVideoPenalty = /video|nightcore/i.test(b.name) && b.extension !== ".wav" ? 10 : 0;
      return (rank.get(a.extension) ?? 99) + aPenalty + aVideoPenalty
        - ((rank.get(b.extension) ?? 99) + bPenalty + bVideoPenalty);
    })[0]?.path || "";
}

function chooseImageFile(folderPath) {
  const preferred = [
    "nightcore_miniaturka_hd",
    "thumbnail",
    "background",
    "screenshot_1",
  ];

  return listFiles(folderPath)
    .filter((file) => IMAGE_EXTENSIONS.has(file.extension))
    .sort((a, b) => {
      const aName = path.basename(a.name, a.extension).toLowerCase();
      const bName = path.basename(b.name, b.extension).toLowerCase();
      const aIndex = preferred.findIndex((name) => aName.includes(name));
      const bIndex = preferred.findIndex((name) => bName.includes(name));
      return (aIndex === -1 ? 99 : aIndex) - (bIndex === -1 ? 99 : bIndex);
    })[0]?.path || "";
}

function discoverTracks(outputRoot, ffprobePath) {
  if (!fs.existsSync(outputRoot)) {
    throw new Error(`Output root not found: ${outputRoot}`);
  }

  return fs.readdirSync(outputRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const folderPath = path.join(outputRoot, entry.name);
      const summaryPath = path.join(folderPath, `${entry.name}-render-summary.json`);
      if (!fs.existsSync(summaryPath)) return null;
      try {
        const summary = readJson(summaryPath);
        const audioPath = summary.files?.audio && fs.existsSync(summary.files.audio)
          ? summary.files.audio
          : summary.files?.mp4;
        if (!audioPath || !fs.existsSync(audioPath)) return null;
        const title = stripNightcorePrefix(summary.visualizer?.title || summary.youtube?.title || entry.name);
        const duration = Number(summary.durationSeconds) > 0
          ? Number(summary.durationSeconds)
          : getDurationSeconds(ffprobePath, audioPath);
        const stat = fs.statSync(summaryPath);
        return {
          folder: entry.name,
          title: title || entry.name,
          audioPath,
          backgroundPath: summary.files?.background || "",
          thumbnailPath: summary.files?.thumbnail || "",
          summaryPath,
          duration,
          mtimeMs: stat.mtimeMs,
          renderedAt: summary.renderedAt || "",
          source: "outputs",
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function discoverLibraryTracks(sourceRoots, ffprobePath) {
  const roots = Array.isArray(sourceRoots) ? sourceRoots : [sourceRoots].filter(Boolean);
  const tracks = [];

  for (const root of roots) {
    const rootPath = path.resolve(root);
    if (!fs.existsSync(rootPath)) continue;

    for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folderPath = path.join(rootPath, entry.name);
      const audioPath = chooseAudioFile(folderPath);
      if (!audioPath) continue;

      try {
        const backgroundPath = chooseImageFile(folderPath);
        const stat = fs.statSync(audioPath);
        tracks.push({
          folder: entry.name,
          title: prettifyTitle(entry.name),
          audioPath,
          backgroundPath,
          thumbnailPath: backgroundPath,
          summaryPath: "",
          duration: getDurationSeconds(ffprobePath, audioPath),
          mtimeMs: stat.mtimeMs,
          renderedAt: "",
          source: "library",
        });
      } catch {
        // Skip unreadable files and keep the rest of the library usable.
      }
    }
  }

  return tracks;
}

function resolveTrackPath(entry, ffprobePath) {
  const rawPath = entry.path || entry.audioPath || "";
  if (!rawPath) return null;

  const resolved = path.resolve(rawPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Configured track path does not exist: ${resolved}`);
  }

  const isDirectory = fs.statSync(resolved).isDirectory();
  const folderPath = isDirectory ? resolved : path.dirname(resolved);
  const audioPath = isDirectory ? chooseAudioFile(folderPath) : resolved;
  if (!audioPath || !fs.existsSync(audioPath)) {
    throw new Error(`No audio file found for configured track: ${resolved}`);
  }

  const backgroundPath = entry.backgroundPath && fs.existsSync(entry.backgroundPath)
    ? entry.backgroundPath
    : chooseImageFile(folderPath);

  return {
    folder: path.basename(folderPath),
    title: entry.title || entry.displayTitle || prettifyTitle(path.basename(folderPath)),
    audioPath,
    backgroundPath,
    thumbnailPath: backgroundPath,
    summaryPath: "",
    duration: getDurationSeconds(ffprobePath, audioPath),
    mtimeMs: fs.statSync(audioPath).mtimeMs,
    renderedAt: "",
    source: "configured",
  };
}

function findConfiguredTrack(allTracks, requestedValue) {
  const needle = normalizeTitle(requestedValue);
  if (!needle) return null;

  const exact = allTracks.find((track) => normalizeTitle(track.folder) === needle)
    || allTracks.find((track) => normalizeTitle(track.title) === needle);
  if (exact) return exact;

  return allTracks.find((track) => normalizeTitle(track.folder).includes(needle))
    || allTracks.find((track) => normalizeTitle(track.title).includes(needle))
    || allTracks.find((track) => needle.includes(normalizeTitle(track.folder)))
    || allTracks.find((track) => needle.includes(normalizeTitle(track.title)));
}

function chooseConfiguredTracks(allTracks, requestedNames, ffprobePath) {
  return requestedNames.map((entry) => {
    const request = typeof entry === "string" ? { match: entry } : (entry || {});
    const pathTrack = resolveTrackPath(request, ffprobePath);
    if (pathTrack) return pathTrack;

    const requestedValue = request.match || request.name || request.folder || request.title || request.displayTitle || "";
    const match = findConfiguredTrack(allTracks, requestedValue);
    if (!match) throw new Error(`Track was not found in configured sources: ${requestedValue}`);

    return {
      ...match,
      title: request.title || request.displayTitle || match.title,
    };
  });
}

function chooseLatestTracks(allTracks, trackCount) {
  const seen = new Set();
  const unique = [];
  const sorted = [...allTracks].sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const track of sorted) {
    const key = track.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(track);
    if (trackCount > 0 && unique.length >= trackCount) break;
  }
  return unique;
}

function hashString(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createRandom(seed) {
  let state = hashString(seed || new Date().toISOString());
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function chooseRandomTracks(allTracks, trackCount, seed) {
  const seen = new Set();
  const unique = [];
  for (const track of allTracks) {
    const key = track.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(track);
  }

  const random = createRandom(seed);
  for (let index = unique.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [unique[index], unique[swapIndex]] = [unique[swapIndex], unique[index]];
  }

  return trackCount > 0 ? unique.slice(0, trackCount) : unique;
}

function buildSelection(baseTracks, targetSeconds, minimumSeconds, crossfadeSeconds, allowRepeats, transitionMode) {
  if (baseTracks.length === 0) throw new Error("No tracks were selected for the mix.");

  const selected = [];
  let total = 0;
  let index = 0;
  const target = Math.max(targetSeconds, minimumSeconds);
  const overlapsTracks = transitionMode === "crossfade";

  while (total < target) {
    if (index >= baseTracks.length) {
      if (!allowRepeats) break;
      index = 0;
    }

    const track = baseTracks[index];
    selected.push(track);
    total += track.duration;
    if (overlapsTracks && selected.length > 1) total -= Math.min(crossfadeSeconds, track.duration / 3);
    index += 1;

    if (selected.length > 500) throw new Error("Mix selection loop stopped after 500 tracks.");
  }

  if (total < minimumSeconds) {
    throw new Error(`Not enough music for the requested minimum. Got ${formatTimestamp(total)}, need ${formatTimestamp(minimumSeconds)}.`);
  }

  return selected;
}

function getSelectionDuration(selected, crossfadeSeconds, transitionMode) {
  let total = 0;
  for (let i = 0; i < selected.length; i += 1) {
    total += selected[i].duration;
    if (transitionMode === "crossfade" && i > 0) {
      total -= Math.min(crossfadeSeconds, selected[i - 1].duration / 3, selected[i].duration / 3);
    }
  }
  return total;
}

function copyBackground(config, selected, projectPath) {
  const explicit = config.background || config.backgroundPath || config.mixBackgroundPath || "";
  const source = explicit && fs.existsSync(explicit)
    ? explicit
    : selected.map((track) => track.backgroundPath || track.thumbnailPath).find((filePath) => filePath && fs.existsSync(filePath));

  if (!source) {
    throw new Error("No background image found. Add background.jpg to the mix folder or make sure source tracks have backgrounds.");
  }

  const extension = path.extname(source).toLowerCase() || ".jpg";
  const target = path.join(projectPath, `background${extension}`);
  fs.copyFileSync(source, target);
  return target;
}

function renderDescription(config, title, timeline, durationSeconds) {
  const timestampLines = timeline.map((track) => `${formatTimestamp(track.start)} ${track.title}`).join("\n");
  const intro = config.descriptionIntro
    || "If you enjoyed this nightcore mix, please leave a like and subscribe for more.";
  const footer = config.descriptionFooter || "#nightcore #nightcoremix #spedup #speedup #anime #amv #musicmix";
  return `${intro}\n\nTimestamps\n${timestampLines}\n\nOutro: ${formatTimestamp(durationSeconds)}\n\n${footer}`;
}

function buildAudio(ffmpegPath, selected, timeline, crossfadeSeconds, outputPath, transitionMode) {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const track of selected) {
    args.push("-i", track.audioPath);
  }

  const useCrossfade = transitionMode === "crossfade" && selected.length > 1 && crossfadeSeconds > 0;
  const filters = selected.map((track, index) => {
    let chain = `[${index}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=duration=${track.duration.toFixed(3)},asetpts=PTS-STARTPTS`;
    if (!useCrossfade && crossfadeSeconds > 0) {
      const fade = Math.min(crossfadeSeconds, track.duration / 4);
      if (index > 0) chain += `,afade=t=in:st=0:d=${fade.toFixed(3)}`;
      if (index < selected.length - 1) {
        chain += `,afade=t=out:st=${Math.max(0, track.duration - fade).toFixed(3)}:d=${fade.toFixed(3)}`;
      }
    }
    return `${chain}[a${index}]`;
  });

  if (!useCrossfade) {
    if (selected.length === 1) {
      filters.push("[a0]anull[mix]");
    } else {
      filters.push(`${selected.map((_, index) => `[a${index}]`).join("")}concat=n=${selected.length}:v=0:a=1[mix]`);
    }
  } else {
    let previous = "a0";
    for (let index = 1; index < selected.length; index += 1) {
      const output = index === selected.length - 1 ? "mix" : `xf${index}`;
      const fade = Math.min(crossfadeSeconds, selected[index - 1].duration / 3, selected[index].duration / 3);
      filters.push(`[${previous}][a${index}]acrossfade=d=${fade.toFixed(3)}:c1=tri:c2=tri[${output}]`);
      previous = output;
    }
  }

  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[mix]",
    "-c:a", "pcm_s16le",
    "-ar", "48000",
    "-ac", "2",
    outputPath,
  );

  const result = spawnSync(ffmpegPath, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`ffmpeg could not build mix audio.\n${result.stderr}`);
  }

  return fs.statSync(outputPath).size;
}

function main() {
  const args = parseArgs(process.argv);
  const factoryRoot = path.resolve(
    args.factoryRoot || process.env.NIGHTCORE_FACTORY_ROOT || "C:\\NightcoreFactory"
  );
  const outputRoot = path.resolve(args.outputRoot || path.join(factoryRoot, "outputs"));
  const queueRoot = path.resolve(args.queueRoot || path.join(factoryRoot, "mix-queue"));
  const ffmpegPath = args.ffmpeg || process.env.FFMPEG_PATH || "ffmpeg";
  const ffprobePath = args.ffprobe || process.env.FFPROBE_PATH || "ffprobe";
  const configPath = args.config ? path.resolve(args.config) : "";
  const config = configPath && fs.existsSync(configPath) ? readJson(configPath) : {};

  const rawTitle = args.title || config.title || `Nightcore Mix ${new Date().toISOString().slice(0, 10)}`;
  const title = String(rawTitle || "")
    .replace(/\s+/g, " ")
    .trim() || `Nightcore Mix ${new Date().toISOString().slice(0, 10)}`;
  const minimumMinutes = Number(args.minimumMinutes || config.minimumMinutes || 60);
  const targetMinutes = Number(args.targetMinutes || config.targetMinutes || Math.max(62, minimumMinutes));
  const crossfadeSeconds = Math.max(0, Number(args.crossfadeSeconds || config.crossfadeSeconds || 3));
  const minTrackSeconds = Math.max(0, Number(args.minTrackSeconds || config.minTrackSeconds || 60));
  const trackCount = Number(args.trackCount || config.trackCount || 0);
  const allowRepeats = config.allowRepeats !== false && String(args.allowRepeats || "true").toLowerCase() !== "false";
  const includeAllConfiguredTracks = config.includeAllConfiguredTracks === true
    || String(args.includeAllConfiguredTracks || "false").toLowerCase() === "true";
  const transitionMode = String(args.transitionMode || config.transitionMode || "fade").toLowerCase();
  const mode = String(args.mode || config.mode || "latest").toLowerCase();
  const seed = args.seed || config.seed || title;
  if (args.backgroundPath) config.backgroundPath = path.resolve(args.backgroundPath);

  fs.mkdirSync(queueRoot, { recursive: true });
  const outputTracks = discoverTracks(outputRoot, ffprobePath);
  const libraryTracks = discoverLibraryTracks(config.sourceRoots || [], ffprobePath);
  const allTracks = outputTracks.concat(libraryTracks);
  const automaticTracks = minTrackSeconds > 0
    ? allTracks.filter((track) => track.duration >= minTrackSeconds)
    : allTracks;
  const skippedShortTracks = allTracks
    .filter((track) => minTrackSeconds > 0 && track.duration < minTrackSeconds)
    .map((track) => ({
      title: track.title,
      sourceFolder: track.folder,
      duration: Number(track.duration.toFixed(3)),
    }));
  const baseTracks = Array.isArray(config.tracks) && config.tracks.length > 0
    ? chooseConfiguredTracks(allTracks, config.tracks, ffprobePath)
    : mode === "random"
      ? chooseRandomTracks(automaticTracks, trackCount, seed)
      : chooseLatestTracks(automaticTracks, trackCount);

  const selected = includeAllConfiguredTracks && Array.isArray(config.tracks) && config.tracks.length > 0
    ? baseTracks
    : buildSelection(
      baseTracks,
      targetMinutes * 60,
      minimumMinutes * 60,
      crossfadeSeconds,
      allowRepeats,
      transitionMode,
    );

  const selectedDuration = getSelectionDuration(selected, crossfadeSeconds, transitionMode);
  if (selectedDuration < minimumMinutes * 60) {
    throw new Error(`Not enough music for the requested minimum. Got ${formatTimestamp(selectedDuration)}, need ${formatTimestamp(minimumMinutes * 60)}.`);
  }

  const projectPath = ensureUniqueDir(queueRoot, title);
  fs.mkdirSync(projectPath, { recursive: true });
  const backgroundPath = copyBackground(config, selected, projectPath);
  const mixAudioPath = path.join(projectPath, "mix.wav");

  const timeline = [];
  let cursor = 0;
  for (let i = 0; i < selected.length; i += 1) {
    const track = selected[i];
    const start = Math.max(0, cursor);
    const end = start + track.duration;
    timeline.push({
      index: i + 1,
      title: track.title,
      sourceFolder: track.folder,
      start,
      end,
      duration: track.duration,
    });
    cursor = end - (
      transitionMode === "crossfade" && i < selected.length - 1
        ? Math.min(crossfadeSeconds, track.duration / 3, selected[i + 1].duration / 3)
        : 0
    );
  }

  const audioBytes = buildAudio(ffmpegPath, selected, timeline, crossfadeSeconds, mixAudioPath, transitionMode);
  const durationSeconds = getDurationSeconds(ffprobePath, mixAudioPath);
  const timestamps = timeline.map((track) => ({
    time: formatTimestamp(track.start),
    title: track.title,
  }));

  const tags = Array.isArray(config.tags)
    ? config.tags
    : ["nightcore", "nightcore mix", "sped up", "speed up songs", "anime", "amv", "music mix", "1 hour nightcore"];

  const metadata = {
    visualArtist: "Nightcore Mix",
    title,
    visualTitle: title,
    youtubeTitle: title,
    description: renderDescription(config, title, timeline, durationSeconds),
    tags,
    privacy: config.privacy || "private",
    accentColor: config.accentColor || "auto",
    lyricsEnabled: false,
    shortsEnabled: false,
    mixTitle: title,
    mixTimeline: timeline.map((track) => ({
      index: track.index,
      title: track.title,
      start: Number(track.start.toFixed(3)),
      end: Number(Math.min(track.end, durationSeconds).toFixed(3)),
    })),
  };

  fs.writeFileSync(path.join(projectPath, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");
  const summary = {
    status: "prepared",
    title,
    projectPath,
    mixAudioPath,
    backgroundPath,
    durationSeconds,
    duration: formatTimestamp(durationSeconds),
    minimumMinutes,
    targetMinutes,
    crossfadeSeconds,
    transitionMode,
    includeAllConfiguredTracks,
    minTrackSeconds,
    mode,
    seed,
    trackCount: selected.length,
    availableTracks: automaticTracks.length,
    outputTracks: outputTracks.length,
    libraryTracks: libraryTracks.length,
    skippedShortTracks,
    audioBytes,
    timestamps,
    tracks: timeline,
  };
  fs.writeFileSync(path.join(projectPath, "mix-summary.json"), JSON.stringify(summary, null, 2), "utf8");
  process.stdout.write(JSON.stringify(summary, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
}
