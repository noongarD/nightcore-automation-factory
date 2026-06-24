const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const failures = [];

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(filePath);
    return [filePath];
  });
}

for (const filePath of walk(root)) {
  const relative = path.relative(root, filePath);
  if (relative.startsWith("node_modules")) continue;

  if (filePath.endsWith(".cjs")) {
    const result = spawnSync(process.execPath, ["--check", filePath], { encoding: "utf8" });
    if (result.status !== 0) failures.push(`${relative}: ${result.stderr.trim()}`);
  }

  if (filePath.endsWith(".json")) {
    try {
      JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    } catch (error) {
      failures.push(`${relative}: ${error.message}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("JavaScript syntax and JSON validation passed.");
}
