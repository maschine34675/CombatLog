import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

if (process.argv[2] === "--cleanup") {
  assert(!existsSync("CODE-REVIEW.md"), "completed CODE-REVIEW.md still exists");
  const references = spawnSync("git", ["grep", "-n", "CODE-REVIEW", "--",
    ":(exclude)tests/verify-armor-impact.mjs"], { encoding: "utf8" });
  assert(references.status === 1, references.status === 0
    ? "current source or documentation still references CODE-REVIEW:\n" + references.stdout
    : "could not inspect CODE-REVIEW references:\n" + references.stderr);
  console.log("COMBATLOG REVIEW CLEANUP VERIFIED");
  process.exit(0);
}

const output = execFileSync(process.execPath, ["tests/verify-combatlog.mjs", "--armor"], {
  cwd: process.cwd(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024
});
assert(output.includes("COMBATLOG ARMOUR UI VERIFIED"), "armour UI verification did not complete");

const panel = readFileSync("UI/CombatLogPanel.cs", "utf8");
const page = readFileSync("web/combatlog.html", "utf8");
const notes = readFileSync("CLAUDE.md", "utf8");

assert(panel.includes("ArmorPrevented(s) > 0.001f") &&
  panel.includes("s.ArmorDamage > 0.001f || s.Blocked || s.Deflected"),
  "backend cannot identify reduced, blocked and ricocheted armour contacts");
assert(page.includes("function deriveArmourImpact") && page.includes("function renderArmourImpact") &&
  page.includes("Ricochets use EFT") && page.includes("deflection flag"),
  "armour and ricochet derivation is not visibly wired into the report");
assert(notes.includes("DidArmorDamage") && notes.includes("prevented body damage") &&
  notes.includes("head area"), "project notes do not preserve the verified EFT semantics");
assert(!panel.replace("ArmorPrevented(s) > 0.001f", "false")
  .includes("ArmorPrevented(s) > 0.001f"), "backend mutation control failed");
assert(!page.replace("function deriveArmourImpact", "function removedArmourImpact")
  .includes("function deriveArmourImpact"), "page mutation control failed");

console.log(output.trim());
console.log("COMBATLOG ARMOUR IMPACT VERIFIED");
