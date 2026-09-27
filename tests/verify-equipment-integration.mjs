import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
assert(!existsSync("D:/SPT41/BepInEx/plugins/maschine-CombatLog"), "duplicate plugin folder requires explicit inspection");
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--no-build");
assert.deepEqual(unknownArguments, [], `unknown argument(s): ${unknownArguments.join(", ")}`);
const noBuild = process.argv.includes("--no-build");
const checks = [
  ["tests/verify-combatlog.mjs", "--accuracy"],
  ["tests/verify-combatlog.mjs", "--debrief"],
  ["tests/verify-combatlog.mjs", "--tape"],
  ["tests/verify-combatlog.mjs", "--zones"],
  ["tests/verify-combatlog.mjs", "--scope"],
  ["tests/verify-mannequin.mjs"],
];
if (!noBuild) checks.push(["tests/verify-build.mjs"]);
for (const args of checks) {
  const run = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(run.status, 0, `${args.join(" ")}\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /COMBATLOG .* VERIFIED/);
}
if (!noBuild) {
  const binary = readFileSync("bin/Release/netstandard2.1/maschine-CombatLog.dll");
  for (const name of ["RaidPresentation", "WeaponSample", "CaptureKiller", "LoadImage", "AppendWeapons"]) {
    assert(binary.includes(Buffer.from(name)), `built plugin missing ${name}`);
  }
}
console.log("COMBATLOG EQUIPMENT INTEGRATION VERIFIED");
