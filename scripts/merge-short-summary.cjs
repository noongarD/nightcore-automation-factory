const fs = require("node:fs");
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

function readJson(filePath, label) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`${label} file not found: ${filePath}`);
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

const args = parseArgs(process.argv);
const mainSummaryPath = args.mainSummary ? path.resolve(args.mainSummary) : "";
const shortSummaryPath = args.shortSummary ? path.resolve(args.shortSummary) : "";

const mainSummary = readJson(mainSummaryPath, "Main summary");
const shortSummary = readJson(shortSummaryPath, "Short summary");

mainSummary.files = mainSummary.files || {};
mainSummary.files.shortMp4 = shortSummary.files?.mp4 || "";
mainSummary.files.shortWebm = shortSummary.files?.webm || "";
mainSummary.files.shortThumbnail = shortSummary.files?.thumbnail || "";
mainSummary.files.shortSummary = shortSummaryPath;

mainSummary.shorts = {
  enabled: true,
  variant: shortSummary.variant || "short",
  startSeconds: Number(args.startSeconds || 0),
  requestedDurationSeconds: Number(args.durationSeconds || 30),
  renderedDurationSeconds: shortSummary.durationSeconds || null,
  mp4: shortSummary.files?.mp4 || "",
  webm: shortSummary.files?.webm || "",
  thumbnail: shortSummary.files?.thumbnail || "",
  summary: shortSummaryPath,
};

fs.writeFileSync(mainSummaryPath, JSON.stringify(mainSummary, null, 2), "utf8");
