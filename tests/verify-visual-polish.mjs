import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
assert(!existsSync('D:/SPT41/BepInEx/plugins/maschine-CombatLog'), 'inspect duplicate plugin folder before deployment');
const checks = [
  ['tests/preview-mannequin.mjs', '--verify'],
  ['tests/verify-combatlog.mjs', '--polish'],
  ['tests/verify-menu-button.mjs'],
  ['tests/verify-records-integration.mjs'],
];
for (const args of checks) {
  const result = spawnSync(process.execPath, args, {encoding:'utf8', timeout:180000, maxBuffer:4*1024*1024});
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}\n${result.error || ''}`);
  assert.match(result.stdout, /COMBATLOG .* VERIFIED/);
  process.stdout.write(result.stdout);
}
console.log('COMBATLOG VISUAL POLISH INTEGRATION VERIFIED');
