import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const plugin = readFileSync('Plugin.cs', 'utf8');
const version = plugin.match(/PluginVersion = "([^"]+)"/)?.[1];
const expected = process.argv[2] || version;
assert.match(expected || '', /^\d+\.\d+\.\d+$/, 'Expected a stable three-part version');
assert.equal(version, expected, 'Plugin version differs from requested release');
const result = spawnSync('dotnet', ['msbuild', 'CombatLog.csproj', '-nologo',
  '-getProperty:AssemblyVersion,FileVersion,Version,AssemblyName'], {
  encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30_000,
});
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
const properties = JSON.parse(result.stdout).Properties;
function checkMetadata(values) {
  assert.equal(values.AssemblyName, 'maschine-CombatLog', 'Existing assembly identity must not change');
  for (const key of ['AssemblyVersion', 'FileVersion', 'Version'])
    assert.equal(values[key], expected, `${key} differs from plugin version`);
}
checkMetadata(properties);
for (const key of ['AssemblyVersion', 'FileVersion', 'Version'])
  assert.throws(() => checkMetadata({ ...properties, [key]: '99.99.99' }),
    new RegExp(`${key} differs`), `Version mismatch must be rejected: ${key}`);

const changelog = readFileSync('CHANGELOG.md', 'utf8');
const released = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map(match => match[1]).filter(v => v !== 'Unreleased');
assert.equal(released[0], expected, 'Newest release notes differ from plugin version');
assert.equal(released.filter(v => v === expected).length, 1, 'Duplicate release notes');
const whitespace = spawnSync('git', ['diff', '--check'], { encoding: 'utf8' });
assert.equal(whitespace.status, 0, `${whitespace.stdout}\n${whitespace.stderr}`);
console.log(`Plugin and evaluated project metadata: ${expected}; three negative controls passed.`);
console.log('COMBATLOG RELEASE VERSION VERIFIED');
