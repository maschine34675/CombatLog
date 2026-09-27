import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const result = spawnSync("dotnet", ["build", "CombatLog.csproj", "-c", "Release"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024,
});

if (result.status !== 0) {
  const output = String(result.stdout || "") + String(result.stderr || "");
  console.error(output.slice(-12000));
  process.exit(result.status || 1);
}

function findNamedFiles(directory, name) {
  const found = [];
  if (!existsSync(directory)) return found;
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      found.push(...findNamedFiles(full, name));
    } else if (entry === name) {
      found.push(full);
    }
  }
  return found;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const releaseDirectory = path.join(root, "bin", "Release");
const built = path.join(releaseDirectory, "netstandard2.1", "maschine-CombatLog.dll");
if (!existsSync(built)) throw new Error("Release output does not contain the current target DLL: " + built);
const bundledWebOverlay = findNamedFiles(releaseDirectory, "Anvil-WebOverlay.dll");
if (bundledWebOverlay.length > 0)
  throw new Error("CombatLog output must not bundle the shared WebOverlay DLL: " + bundledWebOverlay.join(", "));
const binary = readFileSync(built);
for (const marker of ["Immediate debrief", "Combat timeline", "combat-workspace", "scope-overall", "__combatLogTest"]) {
  if (!binary.includes(Buffer.from(marker, "utf8")))
    throw new Error("embedded report page is missing marker: " + marker);
}
for (const asset of ["web/combatlog.html", "web/mannequin.js", "web/records.js",
                     "assets/task-bar-icon.png"]) {
  if (!binary.includes(readFileSync(path.join(root, asset))))
    throw new Error("built DLL does not embed the exact current asset: " + asset);
}
const installed = path.resolve(root, "..", "..", "BepInEx", "plugins", "maschine-CombatLog.dll");
if (!existsSync(installed)) throw new Error("documented deploy target did not produce " + installed);
if (sha256(built) !== sha256(installed)) throw new Error("built and deployed DLL hashes differ");

console.log("COMBATLOG RELEASE BUILD VERIFIED");
