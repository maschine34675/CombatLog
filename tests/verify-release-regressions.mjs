import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const live = path.resolve('../../BepInEx/plugins/maschine-CombatLog.dll');
const hash = () => existsSync(live) ? createHash('sha256').update(readFileSync(live)).digest('hex') : null;
const before = hash();
const checks = [
  ['tests/verify-release-docs.mjs'],
  ['tests/verify-release-version.mjs'],
  ['tests/verify-postraid-integration.mjs', '--all'],
  ['tests/verify-postraid-integration.mjs', '--regressions'],
  ['tests/verify-weboverlay-v111.mjs'],
  ['tests/verify-menu-only.mjs'],
  ['tests/verify-archive-usability.mjs'],
  ['tests/verify-portrait-lighting.mjs'],
  ['tests/preview-mannequin.mjs', '--verify'],
];
try {
  for (const [script, ...args] of checks) {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: process.cwd(), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 180_000,
    });
    assert.equal(result.status, 0, `${script} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
    console.log(`${script} ${args.join(' ')}: passed`);
  }
} finally {
  assert.equal(hash(), before, 'Regression suite changed the live CombatLog DLL');
}
console.log('COMBATLOG RELEASE REGRESSIONS VERIFIED');
