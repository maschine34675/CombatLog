import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "combatlog-overall-build-"));
const fakeSpt = path.join(tempRoot, "spt");
const output = path.join(tempRoot, "output");
const liveDll = path.resolve(root, "..", "..", "BepInEx", "plugins", "maschine-CombatLog.dll");
const developmentRoot = path.dirname(root);
const sourceRoot = path.join(developmentRoot, `CombatLog-overall-source-${process.pid}-${Date.now()}`);

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function namedFiles(directory, name) {
  if (!existsSync(directory)) return [];
  const result = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    const info = statSync(full);
    if (info.isDirectory()) result.push(...namedFiles(full, name));
    else if (entry === name) result.push(full);
  }
  return result;
}

const liveBefore = existsSync(liveDll) ? sha256(liveDll) : null;
let failure = null;
let worktreeAdded = false;
try {
  if (existsSync(sourceRoot)) throw new Error("refusing to reuse temporary source path: " + sourceRoot);
  const worktree = spawnSync("git", ["worktree", "add", "--detach", sourceRoot, "HEAD"], {
    cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
  });
  if (worktree.status !== 0)
    throw new Error("could not create isolated committed source:\n" + String(worktree.stdout || "") + String(worktree.stderr || ""));
  worktreeAdded = true;
  const inputs = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
  });
  if (inputs.status !== 0) throw new Error("could not enumerate current build inputs");
  const currentInputs = [...new Set(inputs.stdout.split("\0").filter(file =>
    /\.(cs|csproj|props|targets)$/.test(file) || /^(web|assets)\//.test(file)))];
  for (const file of currentInputs) {
    const source = path.join(root, file), destination = path.join(sourceRoot, file);
    if (!existsSync(source)) { if (existsSync(destination)) rmSync(destination); continue; }
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    if (sha256(source) !== sha256(destination)) throw new Error("isolated input mismatch: " + file);
  }

  mkdirSync(path.join(fakeSpt, "BepInEx", "plugins"), { recursive: true });
  writeFileSync(path.join(fakeSpt, "EscapeFromTarkov.exe"), "isolated CombatLog build sentinel\n");
  const result = spawnSync("dotnet", [
    "build", "CombatLog.csproj", "-c", "Release",
    `-p:SptRoot=${fakeSpt}${path.sep}`,
    `-p:OutputPath=${output}${path.sep}`,
  ], { cwd: sourceRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    const text = String(result.stdout || "") + String(result.stderr || "");
    throw new Error("isolated Release build failed:\n" + text.slice(-12000));
  }

  const builtCandidates = namedFiles(output, "maschine-CombatLog.dll");
  if (builtCandidates.length !== 1)
    throw new Error(`isolated output contains ${builtCandidates.length} CombatLog DLLs`);
  const built = builtCandidates[0];
  const deployed = path.join(fakeSpt, "BepInEx", "plugins", "maschine-CombatLog.dll");
  if (!existsSync(deployed)) throw new Error("isolated SPT root did not receive the built DLL");
  if (sha256(built) !== sha256(deployed)) throw new Error("isolated build and deployment hashes differ");
  if (namedFiles(output, "Anvil-WebOverlay.dll").length)
    throw new Error("isolated output bundled the shared WebOverlay dependency");

  const binary = readFileSync(built);
  for (const marker of ["view-overall-history", "canonicalHistoryRows", "Shot accuracy", "scope-overall", "combat-workspace", "Most-used weapons", "deriveOverallWeapons", "cartridgesFired", "costBasis"]) {
    if (!binary.includes(Buffer.from(marker, "utf8")))
      throw new Error("embedded report page is missing Overall marker: " + marker);
  }
  for (const asset of ["web/combatlog.html", "web/mannequin.js", "web/records.js", "assets/task-bar-icon.png"]) {
    if (!binary.includes(readFileSync(path.join(root, asset))))
      throw new Error("isolated DLL does not embed the exact current asset: " + asset);
  }

  const liveAfter = existsSync(liveDll) ? sha256(liveDll) : null;
  if (liveAfter !== liveBefore) throw new Error("isolated build changed the live SPT CombatLog DLL");
} catch (error) {
  failure = error;
} finally {
  if (worktreeAdded) {
    const resolvedSource = path.resolve(sourceRoot);
    if (path.dirname(resolvedSource) !== path.resolve(developmentRoot) || !path.basename(resolvedSource).startsWith("CombatLog-overall-source-")) {
      failure ||= new Error("refusing to remove unexpected worktree path: " + resolvedSource);
    } else {
      const remove = spawnSync("git", ["worktree", "remove", "--force", resolvedSource], {
        cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
      });
      if (remove.status !== 0)
        failure ||= new Error("could not remove isolated source worktree:\n" + String(remove.stdout || "") + String(remove.stderr || ""));
    }
  }
  const resolved = path.resolve(tempRoot), base = path.resolve(os.tmpdir()) + path.sep;
  if (!resolved.startsWith(base) || !path.basename(resolved).startsWith("combatlog-overall-build-")) {
    failure ||= new Error("refusing to clean unexpected temporary path: " + resolved);
  } else {
    rmSync(resolved, { recursive: true, force: true });
  }
}

if (failure) throw failure;
console.log("COMBATLOG OVERALL RELEASE BUILD VERIFIED");
