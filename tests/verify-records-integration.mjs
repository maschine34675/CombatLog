import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

assert(!existsSync('D:/SPT41/BepInEx/plugins/maschine-CombatLog'), 'inspect duplicate plugin folder before deployment');
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== '--no-build');
assert.deepEqual(unknownArguments, [], `unknown argument(s): ${unknownArguments.join(', ')}`);
const noBuild = process.argv.includes('--no-build');
const checks = [
  ['tests/verify-records.mjs'],
  ['tests/verify-combatlog.mjs', '--records'],
  ['tests/verify-combatlog.mjs', '--equipment'],
  ['tests/verify-weapons.mjs'],
  ['tests/verify-presentation.mjs'],
  ['tests/verify-equipment-integration.mjs', ...(noBuild ? ['--no-build'] : [])],
];
for (const args of checks) {
  const run = spawnSync(process.execPath, args, {encoding:'utf8', timeout:120000, maxBuffer:4*1024*1024});
  assert.equal(run.status, 0, `${args.join(' ')}\n${run.stdout}\n${run.stderr}\n${run.error || ''}`);
  assert.match(run.stdout, /COMBATLOG .* VERIFIED/);
}
console.log('COMBATLOG RECORD INTEGRATION VERIFIED');
