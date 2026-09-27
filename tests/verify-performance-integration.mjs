import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const checks = [
  [["tests/verify-shot-accounting.mjs"], "COMBATLOG SHOT ACCOUNTING VERIFIED"],
  [["tests/verify-weboverlay-v111.mjs"], "COMBATLOG WEBOVERLAY 1.11 INTEGRATION VERIFIED"],
  [["tests/verify-overlay-lifecycle.mjs"], "COMBATLOG OVERLAY LIFECYCLE VERIFIED"],
  [["tests/verify-combatlog.mjs", "--accuracy"], "COMBATLOG ACCURACY VERIFIED"],
  [["tests/verify-combatlog.mjs", "--equipment"], "COMBATLOG EQUIPMENT UI VERIFIED"],
  [["tests/verify-combatlog.mjs", "--records"], "COMBATLOG RECORD UI VERIFIED"],
  [["tests/verify-combatlog.mjs", "--scope"], "COMBATLOG SCOPE VERIFIED"],
  [["tests/verify-presentation.mjs"], "COMBATLOG PRESENTATION VERIFIED"],
  [["tests/verify-weapons.mjs"], "COMBATLOG WEAPONS VERIFIED"],
  [["tests/verify-records.mjs"], "COMBATLOG RECORD DERIVATION VERIFIED"],
  [["tests/verify-mannequin.mjs"], "COMBATLOG MANNEQUIN VERIFIED"],
  [["tests/verify-menu-button.mjs"], "COMBATLOG MENU BUTTON VERIFIED"],
];

for (const [args, marker] of checks) {
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `${args.join(" ")}\n${result.stdout || ""}\n${result.stderr || ""}\n${result.error || ""}`,
  );
  assert.ok(result.stdout.includes(marker), `${args.join(" ")} omitted success marker ${marker}`);
}

console.log("COMBATLOG PERFORMANCE INTEGRATION VERIFIED");
