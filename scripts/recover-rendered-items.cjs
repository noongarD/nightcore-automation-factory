const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    args[key.slice(2)] = argv[i + 1] || "";
    i += 1;
  }
  return args;
}

function encode(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

const FACTORY_ROOT = path.resolve(process.env.NIGHTCORE_FACTORY_ROOT || "C:\\NightcoreFactory");
const N8N_EXPORT_ROOT = path.resolve(
  process.env.N8N_FILES_ROOT || path.join(os.homedir(), ".n8n-files", "NightcoreFactory")
);

function copyForN8nAccess(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return filePath || "";

  const resolved = path.resolve(filePath);
  const relativePath = path.relative(FACTORY_ROOT, resolved);
  const targetPath = relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
    ? path.join(N8N_EXPORT_ROOT, relativePath)
    : path.join(N8N_EXPORT_ROOT, "files", path.basename(resolved));

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  const sourceStat = fs.statSync(resolved);
  let shouldCopy = true;
  if (fs.existsSync(targetPath)) {
    const targetStat = fs.statSync(targetPath);
    shouldCopy = targetStat.size !== sourceStat.size || targetStat.mtimeMs < sourceStat.mtimeMs;
  }

  if (shouldCopy) {
    fs.copyFileSync(resolved, targetPath);
  }

  return targetPath;
}

function makeItem(summaryPath, summary) {
  const mp4Path = summary.files?.mp4 || "";
  const thumbnailPath = summary.files?.thumbnail || "";
  const shortMp4Path = summary.files?.shortMp4 || "";
  const shortThumbnailPath = summary.files?.shortThumbnail || "";
  const youtubeTitle = summary.youtube?.title || "";

  const n8nMp4Path = copyForN8nAccess(mp4Path);
  const n8nThumbnailPath = copyForN8nAccess(thumbnailPath);
  const n8nShortMp4Path = copyForN8nAccess(shortMp4Path);
  const n8nShortThumbnailPath = copyForN8nAccess(shortThumbnailPath);

  return {
    audio: summary.files?.audio ? path.basename(summary.files.audio) : "",
    image: summary.files?.background ? path.basename(summary.files.background) : "",
    status: "rendered",
    projectPath: summary.projectPath || "",
    renderLog: summary.projectPath ? path.join(summary.projectPath, "render.log") : "",
    outputPath: n8nMp4Path ? path.dirname(n8nMp4Path) : "",
    summaryPath,
    factoryMp4Path: mp4Path,
    factoryThumbnailPath: thumbnailPath,
    factoryShortMp4Path: shortMp4Path,
    factoryShortThumbnailPath: shortThumbnailPath,
    mp4Path: n8nMp4Path,
    thumbnailPath: n8nThumbnailPath,
    shortMp4Path: n8nShortMp4Path,
    shortThumbnailPath: n8nShortThumbnailPath,
    shortYoutubeTitle: youtubeTitle ? `${youtubeTitle} #Shorts` : "#Shorts",
    youtubeTitleBase64: encode(youtubeTitle),
    descriptionBase64: encode(summary.youtube?.description || ""),
    tags: Array.isArray(summary.youtube?.tags) ? summary.youtube.tags : [],
    privacy: summary.youtube?.privacy || "private",
  };
}

const args = parseArgs(process.argv);
const outputRoot = path.resolve(args.outputRoot || path.join(FACTORY_ROOT, "outputs"));
const limit = Number(args.limit || 0);
const names = String(args.names || "")
  .split("|")
  .map((name) => name.trim())
  .filter(Boolean);

if (!fs.existsSync(outputRoot)) {
  throw new Error(`Output folder not found: ${outputRoot}`);
}

const folders = fs.readdirSync(outputRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const folderPath = path.join(outputRoot, entry.name);
    const summaryPath = path.join(folderPath, `${entry.name}-render-summary.json`);
    if (!fs.existsSync(summaryPath)) return null;
    const stat = fs.statSync(summaryPath);
    return { name: entry.name, folderPath, summaryPath, mtimeMs: stat.mtimeMs };
  })
  .filter(Boolean)
  .filter((entry) => names.length === 0 || names.some((name) => name.toLowerCase() === entry.name.toLowerCase()));

let selected = folders;
if (names.length === 0 && limit > 0) {
  selected = folders
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);
}

selected = selected.sort((a, b) => a.mtimeMs - b.mtimeMs);

const items = selected.map((entry) => makeItem(entry.summaryPath, readJson(entry.summaryPath)));
process.stdout.write(JSON.stringify(items));
