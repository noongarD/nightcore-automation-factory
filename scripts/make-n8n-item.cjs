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

const args = parseArgs(process.argv);
const summaryPath = args.summaryPath;

if (!summaryPath || !fs.existsSync(summaryPath)) {
  throw new Error(`Summary file not found: ${summaryPath}`);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8").replace(/^\uFEFF/, ""));
const mp4Path = summary.files?.mp4 || "";
const thumbnailPath = summary.files?.thumbnail || "";
const shortMp4Path = summary.files?.shortMp4 || "";
const shortThumbnailPath = summary.files?.shortThumbnail || "";
const youtubeTitle = summary.youtube?.title || "";

const n8nMp4Path = copyForN8nAccess(mp4Path);
const n8nThumbnailPath = copyForN8nAccess(thumbnailPath);
const n8nShortMp4Path = copyForN8nAccess(shortMp4Path);
const n8nShortThumbnailPath = copyForN8nAccess(shortThumbnailPath);

const item = {
  audio: args.audio || "",
  image: args.image || "",
  status: args.status || "rendered",
  projectPath: args.projectPath || summary.projectPath || "",
  renderLog: args.renderLog || "",
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

process.stdout.write(JSON.stringify(item));
