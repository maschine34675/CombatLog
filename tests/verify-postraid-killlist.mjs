import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sourcePath = "PostRaidScreens/KillList/CombatLogKillListPatches.cs";
const source = readFileSync(sourcePath, "utf8");
const stateSource = readFileSync("PostRaidScreens/PostRaidScreenState.cs", "utf8");

function blockFrom(text, marker) {
  const start = text.indexOf(marker);
  assert(start >= 0, `missing production block: ${marker}`);
  const open = text.indexOf("{", start);
  assert(open >= 0, `missing opening brace: ${marker}`);

  let depth = 0;
  let mode = "code";
  for (let index = open; index < text.length; index++) {
    const current = text[index];
    const next = text[index + 1];
    if (mode === "line") {
      if (current === "\n") mode = "code";
      continue;
    }
    if (mode === "block") {
      if (current === "*" && next === "/") { mode = "code"; index++; }
      continue;
    }
    if (mode === "string") {
      if (current === "\\") { index++; continue; }
      if (current === '"') mode = "code";
      continue;
    }
    if (mode === "char") {
      if (current === "\\") { index++; continue; }
      if (current === "'") mode = "code";
      continue;
    }
    if (current === "/" && next === "/") { mode = "line"; index++; continue; }
    if (current === "/" && next === "*") { mode = "block"; index++; continue; }
    if (current === '"') { mode = "string"; continue; }
    if (current === "'") { mode = "char"; continue; }
    if (current === "{") depth++;
    if (current === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  throw new Error(`unterminated production block: ${marker}`);
}

function contractFailures(text) {
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const body = marker => {
    try { return blockFrom(text, marker); }
    catch { failures.push(`missing ${marker}`); return ""; }
  };

  check(text.includes("namespace CombatLog.PostRaidScreens.KillList;"),
    "kill-list namespace drifted");
  check(text.includes("public static class CombatLogKillListPatches"),
    "CombatLogKillListPatches is missing");
  check(/ConditionalWeakTable\s*<\s*VictimStats\s*,\s*CombatLogSyntheticVictimInfo\s*>/.test(text),
    "synthetic rows are not marked by object identity in a weak table");
  check(!/\b(?:Dictionary|HashSet)\s*<\s*VictimStats\s*>\s+SyntheticVictims/.test(text),
    "synthetic object ownership uses a strong collection");

  const patchNames = [...text.matchAll(/\bclass\s+(\w+)\s*:\s*ModulePatch\b/g)].map(match => match[1]);
  check(patchNames.length === 2, "expected exactly two kill-list patch classes");
  check(patchNames.every(name => name.startsWith("CombatLog")),
    "every Harmony patch class name must start with CombatLog");

  const enable = body("public static void Enable()");
  check(enable.includes("new CombatLogKillListShowPatch().Enable()") &&
    enable.includes("new CombatLogKillListVictimShowPatch().Enable()"),
  "Enable does not install both kill-list patches");

  const showPatch = body("public sealed class CombatLogKillListShowPatch");
  check(showPatch.includes("typeof(SessionResultKillList)"),
    "list patch does not target SessionResultKillList");
  check(showPatch.includes("nameof(SessionResultKillList.Show)"),
    "list patch does not target Show");
  check(/new\[\]\s*\{\s*typeof\(UpdatableBindableList<VictimStats>\),\s*typeof\(DogtagComponent\[\]\)\s*\}/s.test(showPatch),
    "list patch does not bind the exact SPT 4.1 Show overload");
  check(/Prefix\s*\(\s*ref\s+UpdatableBindableList<VictimStats>\s+victims\s*\)/.test(showPatch),
    "Show prefix cannot replace the victims argument");
  check(showPatch.includes("PostRaidScreensFeature.DamagedTargetsEnabled"),
    "damaged-target toggle is not honored");
  check(showPatch.includes("PostRaidScreenState.BindKillAmmo(victims)"),
    "ordinary kill rows are not rebound to ordered lethal-ammo events");
  check(showPatch.indexOf("PostRaidScreenState.BindKillAmmo(victims)") <
    showPatch.indexOf("if (!PostRaidScreensFeature.DamagedTargetsEnabled)"),
  "ammo binding incorrectly depends on damaged-target display");
  check(showPatch.includes("new UpdatableBindableList<VictimStats>(victims)"),
    "enabled UI does not receive a new shallow victims list");
  check(showPatch.includes("new UpdatableBindableList<VictimStats>()"),
    "null victims do not receive a safe UI-owned list");
  check(showPatch.includes("RemovePriorSyntheticVictims(uiVictims)"),
    "re-show does not prune prior module-owned rows from the new copy");
  const assignIndex = showPatch.indexOf("victims = uiVictims;");
  const appendIndex = showPatch.indexOf("AppendSyntheticVictims(uiVictims)");
  const pruneIndex = showPatch.indexOf("RemovePriorSyntheticVictims(uiVictims)");
  check(pruneIndex >= 0 && assignIndex > pruneIndex && appendIndex > assignIndex,
    "prior rows are not pruned before the UI copy is installed and rebuilt");
  check(!showPatch.includes("victims.Add("),
    "Show prefix directly mutates its profile/controller argument");

  const prune = body("private static void RemovePriorSyntheticVictims(");
  check(prune.includes("SyntheticVictims.TryGetValue(candidate, out _)"),
    "re-show pruning is not restricted to module-owned object identities");
  check(prune.includes("uiVictims.RemoveAt(index)"),
    "prior module-owned rows are not removed from the UI copy");
  check(!prune.includes("victims.Remove") && !prune.includes("victims.Clear"),
    "re-show pruning can mutate the caller-owned list");

  const append = body("private static void AppendSyntheticVictims(");
  check(append.includes("new HashSet<string>(StringComparer.Ordinal)"),
    "victim identity sets are not ordinal");
  check(append.includes("foreach (VictimStats victim in uiVictims)"),
    "original victim ids are not measured from the shallow copy");
  check(append.includes("foreach (string killedId in RaidAnalytics.KilledProfileIds)"),
    "credited kill ids are not excluded");
  check(append.includes("foreach (ShotRecord shot in RaidAnalytics.ShotsDealt)"),
    "damaged rows are not derived from CombatLog dealt shots");
  check(/id\s*==\s*null\s*\|\|\s*originalVictimIds\.Contains\(id\)\s*\|\|\s*killedProfileIds\.Contains\(id\)/.test(append),
    "missing, original, or killed target identities can enter synthetic rows");
  check(append.includes("candidate.TotalDamage > 0d"),
    "non-positive target groups are not rejected");
  check(append.includes(".Take(MaxSyntheticRows)"),
    "synthetic row count is not bounded");
  check(append.includes("var synthetic = new VictimStats"),
    "synthetic rows do not use new VictimStats instances");
  check(append.includes("BoundedDisplay(RaidMeta.Location, string.Empty, MaxLocationLength)"),
    "synthetic rows do not use the bounded captured raid location");
  check(append.includes("SyntheticVictims.Add(synthetic") && append.includes("uiVictims.Add(synthetic)"),
    "new rows are not object-marked before addition to the UI list");
  check(append.indexOf("SyntheticVictims.Add(synthetic") < append.indexOf("uiVictims.Add(synthetic)"),
    "synthetic row is exposed before its weak-table marker exists");
  check(!/\bvictim\.\w+\s*=/.test(text),
    "an original VictimStats instance is mutated");
  check(!text.includes("RaidAnalytics.AlmostKilledIds"),
    "styling identity leaked into profile-id analytics state");
  check(!text.includes("KilledProfileIds.Add"),
    "kill-list presentation mutates capture-owned kill identity");

  const stable = body("private static string StableProfileId(");
  check(stable.includes("string.IsNullOrWhiteSpace(value)"),
    "missing target ids are not rejected");
  check(stable.includes("value.Trim()") && stable.includes("MaxProfileIdLength"),
    "stable target ids are neither trimmed nor bounded");
  check(!stable.includes("TargetName") && !stable.includes("TargetSide"),
    "display fields are incorrectly used as fallback identity");

  const rowLimit = Number(text.match(/MaxSyntheticRows\s*=\s*(\d+)/)?.[1]);
  check(Number.isInteger(rowLimit) && rowLimit > 0 && rowLimit <= 128,
    "synthetic row limit is missing or implausibly high");
  for (const bound of ["MaxNameLength", "MaxWeaponLength", "MaxLocationLength"]) {
    const value = Number(text.match(new RegExp(`${bound}\\s*=\\s*(\\d+)`))?.[1]);
    check(Number.isInteger(value) && value > 0 && value <= 512, `${bound} is not bounded`);
  }

  const victimPatch = body("public sealed class CombatLogKillListVictimShowPatch");
  check(/new\[\]\s*\{\s*typeof\(VictimStats\),\s*typeof\(bool\),\s*typeof\(int\)\s*\}/s.test(victimPatch),
    "victim row patch does not bind the exact SPT 4.1 Show overload");
  const weakLookup = victimPatch.indexOf("SyntheticVictims.TryGetValue(victim");
  const ammoLookup = victimPatch.indexOf("PostRaidScreenState.TryGetKillAmmo(victim");
  check(weakLookup >= 0 && ammoLookup > weakLookup,
    "synthetic object styling is not resolved before ordinary kill ammo");
  check(victimPatch.includes("if (victim == null)"),
    "victim styling is not null-safe");
  check(victimPatch.includes("PostRaidScreensFeature.KillListAmmoEnabled"),
    "kill-list ammo toggle is not honored");
  check(/Postfix\s*\(\s*VictimStats victim,\s*bool knownName,/.test(victimPatch),
    "victim postfix does not receive vanilla's knownName argument");
  const identificationGuard = victimPatch.match(/if\s*\(!knownName && victim\.Side != EPlayerSide\.Savage\)\s*return;/);
  check(identificationGuard && identificationGuard.index > weakLookup &&
    identificationGuard.index < ammoLookup,
  "unidentified ordinary victims can expose ammo, or the guard affects synthetic rows");
  check(victimPatch.includes("AmmoDisplayName(ammoTemplateId)"),
    "exact lethal ammo is not resolved from shared state");
  check(victimPatch.includes("AppendAmmo(____status, EscapeRichText(ammoName))"),
    "ordinary kill status does not append bounded safe ammo text");

  const ammoDisplay = body("private static string AmmoDisplayName(");
  check(ammoDisplay.includes("AmmoLocale.GetAmmoShortName(ammoTemplateId)"),
    "lethal ammo does not prefer its localized short name");
  check(ammoDisplay.includes("BoundedDisplay(ammoTemplateId, string.Empty, MaxAmmoNameLength)"),
    "missing ammo localization loses the exact bounded template id");
  check(ammoDisplay.includes("return fallback;"),
    "ammo locale failures have no exact template-id fallback");

  const style = body("private static void StyleSyntheticVictim(");
  check(style.includes("name.text = EscapeRichText(synthetic.Name)"),
    "synthetic name is not styled from weak-table metadata");
  check(style.includes("level.text = synthetic.Level > 0"),
    "synthetic level has no bounded fallback");
  check(style.includes('status.text = "<b>Damaged</b> ("'),
    "synthetic status is not assigned idempotently");
  check(!style.includes("status.text +="),
    "synthetic status accumulates across repeated Show calls");

  const ammo = body("private static void AppendAmmo(");
  check(ammo.includes("current.EndsWith(parenthesizedSuffix, StringComparison.Ordinal)") &&
    ammo.includes("current.EndsWith(fallbackSuffix, StringComparison.Ordinal)"),
  "ammo append has no exact idempotency guards");
  check(ammo.includes('current.EndsWith(")", StringComparison.Ordinal)'),
    "ammo is not inserted into ordinary parenthesized kill status");

  return failures;
}

function stateContractFailures(text) {
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  check(/Dictionary\s*<\s*string\s*,\s*List<string>\s*>\s+KillAmmoByProfile/.test(text),
    "lethal ammo is not stored as an ordered sequence per profile");
  check(/ConditionalWeakTable\s*<\s*VictimStats\s*,\s*KillAmmoBinding\s*>/.test(text),
    "result rows are not bound by object identity after profile replacement");
  check(text.includes("sequence.Add(ammo);") && text.includes("_killEventCount++;"),
    "kill events, including missing ammo, are not appended in order");
  check(!/if\s*\(ammo\s*!=\s*null\)\s*sequence\.Add\(ammo\);/.test(text),
    "missing SourceId is dropped and shifts later repeated-profile events");
  check(text.includes("internal static void BindKillAmmo(IEnumerable<VictimStats> victims)"),
    "ordered events cannot be rebound to result rows");
  check(text.includes("new Dictionary<string, int>(StringComparer.Ordinal)"),
    "per-profile result occurrences are not counted ordinally");
  check(text.includes("occurrence >= sequence.Count") && text.includes("string ammo = sequence[occurrence];"),
    "result occurrence is not matched to the same ordered kill event");
  check(text.includes("KillAmmoByVictim.Remove(victim);") &&
    text.includes("KillAmmoByVictim.Add(victim, new KillAmmoBinding(ammo));"),
  "re-show cannot safely replace an object's previous ammo binding");
  check(text.includes("KillAmmoByVictim = new ConditionalWeakTable<VictimStats, KillAmmoBinding>();") &&
    text.includes("_killEventCount = 0;"),
  "raid reset does not discard ordered/object-bound ammo state");
  const eventLimit = Number(text.match(/MaxKillEvents\s*=\s*(\d+)/)?.[1]);
  check(Number.isInteger(eventLimit) && eventLimit >= 64 && eventLimit <= 4096,
    "kill-event state has no plausible hard bound");
  return failures;
}

const positiveFailures = contractFailures(source);
assert.deepEqual(positiveFailures, [], `source contract failed:\n- ${positiveFailures.join("\n- ")}`);
const positiveStateFailures = stateContractFailures(stateSource);
assert.deepEqual(positiveStateFailures, [],
  `state contract failed:\n- ${positiveStateFailures.join("\n- ")}`);
const MODEL_LIMITS = { rows: 64, id: 256, name: 128, weapon: 256, location: 128 };
const modelMarks = new WeakSet();
function stableId(value) {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > MODEL_LIMITS.id)
    return null;
  return value.trim();
}
function bounded(value, fallback, limit) {
  const display = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return String(display ?? "").slice(0, limit);
}
function present(original, shots, killed, enabled, location) {
  if (!enabled) return original;
  const ui = original == null ? [] : original.filter(row => !modelMarks.has(row));
  const originalIds = new Set(ui.map(row => stableId(row?.profileId)).filter(Boolean));
  const killedIds = new Set(killed.map(stableId).filter(Boolean));
  const groups = new Map();
  for (const shot of shots) {
    const id = stableId(shot.profileId);
    if (!id || originalIds.has(id) || killedIds.has(id)) continue;
    let group = groups.get(id);
    if (!group) {
      group = { id, damage: 0, hits: 0, pens: 0, distances: [], first: shot, name: null, weapon: null };
      groups.set(id, group);
    }
    group.hits++;
    if (Number.isFinite(shot.damage)) group.damage += shot.damage;
    if (shot.penetrated && !shot.blocked && !shot.deflected && Number.isFinite(shot.armorDamage) && shot.armorDamage > 0)
      group.pens++;
    if (Number.isFinite(shot.distance) && shot.distance > 0) group.distances.push(shot.distance);
    if (!group.name && typeof shot.name === "string" && shot.name.trim()) group.name = shot.name;
    if (!group.weapon && typeof shot.weapon === "string" && shot.weapon.trim()) group.weapon = shot.weapon;
  }
  const selected = [...groups.values()]
    .filter(group => group.damage > 0)
    .sort((left, right) => right.damage - left.damage || left.id.localeCompare(right.id))
    .slice(0, MODEL_LIMITS.rows);
  for (const group of selected) {
    const row = {
      profileId: group.id,
      name: bounded(group.name, "Unknown target", MODEL_LIMITS.name),
      weapon: bounded(group.weapon, "Unknown weapon", MODEL_LIMITS.weapon),
      location: bounded(location, "", MODEL_LIMITS.location),
      level: group.first.level > 0 ? group.first.level : 0,
      damage: group.damage,
      hits: group.hits,
      pens: group.pens,
    };
    modelMarks.add(row);
    ui.push(row);
  }
  return ui;
}
function styleSynthetic(row, view) {
  if (!modelMarks.has(row)) return false;
  view.name = row.name;
  view.level = row.level > 0 ? String(row.level) : "--";
  const pen = row.pens > 0 ? `, ${row.pens} pen` : "";
  const hitLabel = row.hits === 1 ? "hit" : "hits";
  view.status = `<b>Damaged</b> (${row.damage.toFixed(0)} dmg, ${row.hits} ${hitLabel}${pen})`;
  return true;
}
function appendAmmo(status, ammo) {
  const parenthesized = `, ${ammo})`;
  const fallback = ` (${ammo})`;
  if (status.endsWith(parenthesized) || status.endsWith(fallback)) return status;
  return status.endsWith(")") ? status.slice(0, -1) + parenthesized : status + fallback;
}
const identificationCondition = blockFrom(source, "public static void Postfix(")
  .match(/if\s*\((!knownName[^)]+)\)\s*return;/)?.[1];
assert(identificationCondition, "missing production identification condition");
const hidesAmmo = new Function("victim", "knownName", "EPlayerSide",
  `return (${identificationCondition});`);
const sides = Object.freeze({ Usec: 1, Bear: 2, Savage: 4 });
function presentOrdinaryAmmo(victim, knownName, status, ammo) {
  return hidesAmmo(victim, knownName, sides) ? status : appendAmmo(status, ammo);
}

function bindKillAmmo(victims, eventsByProfile) {
  const bound = new WeakMap();
  const occurrences = new Map();
  for (const victim of victims ?? []) {
    const id = stableId(victim?.profileId);
    if (!id) continue;
    const occurrence = occurrences.get(id) ?? 0;
    occurrences.set(id, occurrence + 1);
    const sequence = eventsByProfile.get(id);
    if (sequence && occurrence < sequence.length && sequence[occurrence] != null)
      bound.set(victim, sequence[occurrence]);
  }
  return bound;
}

const originalVictim = Object.freeze({ profileId: "victim-existing", name: "Original" });
const original = Object.freeze([originalVictim]);
const longText = "x".repeat(600);
const shots = [
  { profileId: "victim-existing", damage: 999, name: "duplicate" },
  { profileId: "victim-killed", damage: 999, name: "killed" },
  { profileId: "   ", damage: 999, name: "missing-id" },
  { profileId: "x".repeat(257), damage: 999, name: "oversized-id" },
  { profileId: "zero", damage: 0, name: "zero" },
  { profileId: "negative", damage: -1, name: "negative" },
  { profileId: " wounded-a ", damage: 32.4, armorDamage: 4, penetrated: true, distance: 20, name: longText, weapon: "" , level: 31 },
  { profileId: "wounded-a", damage: 0, armorDamage: 0, penetrated: true, distance: 40, name: "ignored later", weapon: "AK", level: 31 },
  { profileId: "wounded-b", damage: Number.NaN, name: "B" },
  { profileId: "wounded-b", damage: 12, distance: Number.POSITIVE_INFINITY, name: "B", level: 0 },
];
for (let index = 0; index < 70; index++) {
  shots.push({ profileId: `bulk-${String(index).padStart(2, "0")}`, damage: index + 1, name: `Bulk ${index}`, level: 1 });
}

assert.strictEqual(present(original, shots, ["victim-killed"], false, "factory4_day"), original,
  "disabled presentation replaced the profile list");
const nullUi = present(null, [], [], true, null);
assert(Array.isArray(nullUi) && nullUi.length === 0,
  "null victims did not become an empty UI-owned list");
const firstUi = present(original, shots, [" victim-killed "], true, longText);
const secondUi = present(original, shots, ["victim-killed"], true, longText);
assert.notStrictEqual(firstUi, original, "enabled presentation reused the profile list");
assert.strictEqual(firstUi[0], originalVictim, "shallow copy cloned an original victim entry");
assert.equal(original.length, 1, "profile/controller list was mutated");
assert.deepEqual(originalVictim, { profileId: "victim-existing", name: "Original" },
  "original victim fields were mutated");
assert.equal(firstUi.length, 1 + MODEL_LIMITS.rows, "synthetic row cap was not enforced");
assert.equal(secondUi.length, firstUi.length, "re-show accumulated synthetic rows");
assert.notStrictEqual(secondUi[1], firstUi[1], "re-show reused stale synthetic objects");
const retainedUi = present(firstUi, shots, ["victim-killed"], true, longText);
assert.equal(retainedUi.length, firstUi.length,
  "re-passing the previous UI list revealed another capped batch");
assert.strictEqual(retainedUi[0], originalVictim,
  "re-show pruning replaced an ordinary shallow-copied victim");
assert.notStrictEqual(retainedUi[1], firstUi[1],
  "re-show retained a stale module-owned synthetic object");
assert(!firstUi.some(row => ["victim-killed", "zero", "negative"].includes(row.profileId)),
  "excluded or non-positive target reached the UI");
assert(!firstUi.some(row => row.name === "missing-id" || row.name === "oversized-id"),
  "unstable target identity reached the UI");
const wounded = firstUi.find(row => row.profileId === "wounded-a");
assert(wounded && wounded.name.length === MODEL_LIMITS.name && wounded.weapon === "AK",
  "bounded name or weapon fallback selection failed");
assert.equal(wounded.location.length, MODEL_LIMITS.location, "location was not bounded");
assert.equal(wounded.hits, 2, "target hits were not grouped by stable trimmed id");
assert.equal(wounded.pens, 1, "flesh penetration inflated armor penetration count");

const syntheticView = { name: "stale", level: "stale", status: "stale" };
assert(styleSynthetic(wounded, syntheticView), "weak-table synthetic marker was not honored");
const styledOnce = { ...syntheticView };
styleSynthetic(wounded, syntheticView);
assert.deepEqual(syntheticView, styledOnce, "synthetic style accumulated on re-show");
assert(!styleSynthetic(originalVictim, syntheticView), "ordinary victim was styled as synthetic by id/value");
const killStatus = "<b>Killed</b> (M4A1, thorax, 42m)";
const appended = appendAmmo(killStatus, "M855A1");
assert.equal(appended, "<b>Killed</b> (M4A1, thorax, 42m, M855A1)");
assert.equal(appendAmmo(appended, "M855A1"), appended, "ordinary ammo duplicated on re-show");
for (const side of [sides.Usec, sides.Bear, 0, 999]) {
  const victim = Object.freeze({ Side: side, Name: "Known capture name", Role: "boss" });
  for (const status of ["???", "Unknown", "<b>???</b>"]) {
    assert.equal(presentOrdinaryAmmo(victim, false, status, "AP-20"), status,
      "unidentified non-scav leaked ammo despite hidden vanilla status");
  }
  assert.equal(presentOrdinaryAmmo(victim, true, killStatus, "M855A1"), appended,
    "identified victim lost lethal ammo");
}
for (const knownName of [false, true]) {
  assert.equal(presentOrdinaryAmmo({ Side: sides.Savage }, knownName, killStatus, "M855A1"), appended,
    "vanilla-known scav lost ammo when no dogtag was collected");
}
const reusedVictim = { Side: sides.Usec };
assert.equal(presentOrdinaryAmmo(reusedVictim, true, killStatus, "M855A1"), appended);
assert.equal(presentOrdinaryAmmo(reusedVictim, false, "???", "M855A1"), "???",
  "re-show reused identification from an earlier call");
const repeatedEvents = new Map([
  ["respawned", ["ammo-first", "ammo-second"]],
  ["missing-first", [null, "ammo-after-missing"]],
]);
const repeatedRows = [
  { profileId: "respawned" }, { profileId: "other" },
  { profileId: "respawned" }, { profileId: "missing-first" },
  { profileId: "missing-first" },
];
let repeatedBindings = bindKillAmmo(repeatedRows, repeatedEvents);
assert.equal(repeatedBindings.get(repeatedRows[0]), "ammo-first",
  "first kill of a repeated profile lost its own ammunition");
assert.equal(repeatedBindings.get(repeatedRows[2]), "ammo-second",
  "second kill of a repeated profile did not receive the second event");
assert.equal(repeatedBindings.has(repeatedRows[3]), false,
  "missing first SourceId was presented as known ammunition");
assert.equal(repeatedBindings.get(repeatedRows[4]), "ammo-after-missing",
  "missing first SourceId shifted the later event onto the wrong row");
const replacementRows = repeatedRows.map(row => ({ ...row }));
repeatedBindings = bindKillAmmo(replacementRows, repeatedEvents);
assert.equal(repeatedBindings.get(replacementRows[0]), "ammo-first");
assert.equal(repeatedBindings.get(replacementRows[2]), "ammo-second",
  "result-profile object replacement broke ordered ammo rebinding");
const mutants = [
  ["argument not replaceable", text => text.replace("Prefix(ref UpdatableBindableList<VictimStats> victims)", "Prefix(UpdatableBindableList<VictimStats> victims)")],
  ["original list reused", text => text.replace("new UpdatableBindableList<VictimStats>(victims)", "victims")],
  ["UI copy not installed", text => text.replace("victims = uiVictims;", "")],
  ["prior synthetic rows retained", text => text.replace("RemovePriorSyntheticVictims(uiVictims);", "")],
  ["original target exclusion removed", text => text.replace("originalVictimIds.Contains(id) || ", "")],
  ["credited kill exclusion removed", text => text.replace(" || killedProfileIds.Contains(id)", "")],
  ["unstable id accepted", text => text.replace("if (string.IsNullOrWhiteSpace(value))", "if (value == null)")],
  ["row cap removed", text => text.replace(".Take(MaxSyntheticRows)", ".Where(_ => true)")],
  ["weak object marker removed", text => text.replace("ConditionalWeakTable<VictimStats, CombatLogSyntheticVictimInfo>", "Dictionary<VictimStats, CombatLogSyntheticVictimInfo>")],
  ["captured location removed", text => text.replace("BoundedDisplay(RaidMeta.Location, string.Empty, MaxLocationLength)", "string.Empty")],
  ["damaged toggle removed", text => text.replace("if (!PostRaidScreensFeature.DamagedTargetsEnabled)", "if (false)")],
  ["shared ammo lookup removed", text => text.replace("PostRaidScreenState.TryGetKillAmmo(victim, out string ammoTemplateId)", "false")],
  ["identification argument removed", text => text.replace("bool knownName,", "")],
  ["unknown ammo revealed", text => text.replace("!knownName && victim.Side != EPlayerSide.Savage", "false")],
  ["known scav ammo hidden", text => text.replace("!knownName && victim.Side != EPlayerSide.Savage", "!knownName")],
  ["identification guard reversed", text => text.replace("!knownName && victim.Side != EPlayerSide.Savage", "knownName && victim.Side != EPlayerSide.Savage")],
  ["identification guard does not return", text => text.replace(
    /if \(!knownName && victim\.Side != EPlayerSide\.Savage\)\s*return;/, "if (!knownName && victim.Side != EPlayerSide.Savage) { }")],
  ["ordered ammo binding removed", text => text.replace("PostRaidScreenState.BindKillAmmo(victims);", "")],
  ["victim Show overload ambiguous", text => text.replace(
    /,\r?\n\s*new\[\] \{ typeof\(VictimStats\), typeof\(bool\), typeof\(int\) \}/, "")],
  ["ammo template fallback removed", text => text.replace("BoundedDisplay(ammoTemplateId, string.Empty, MaxAmmoNameLength)", "string.Empty")],
  ["synthetic style accumulates", text => text.replace('status.text = "<b>Damaged</b> ("', 'status.text += "<b>Damaged</b> ("')],
  ["ammo idempotency removed", text => text.replace("current.EndsWith(parenthesizedSuffix, StringComparison.Ordinal) ||", "false ||")],
  ["profile victim mutated", text => text.replace("AppendSyntheticVictims(uiVictims);", "victim.Name = name; AppendSyntheticVictims(uiVictims);")],
];
for (const [name, mutate] of mutants) {
  const mutant = mutate(source);
  assert.notEqual(mutant, source, `mutation control did not modify source: ${name}`);
  assert(contractFailures(mutant).length > 0, `kill-list oracle accepted mutant: ${name}`);
}

const stateMutants = [
  ["single last ammo value", text => text.replace("Dictionary<string, List<string>>", "Dictionary<string, string>")],
  ["kill event not appended", text => text.replace("sequence.Add(ammo);", "")],
  ["occurrence always first", text => text.replace("string ammo = sequence[occurrence];", "string ammo = sequence[0];")],
  ["missing ammo shifts sequence", text => text.replace("sequence.Add(ammo);", "if (ammo != null) sequence.Add(ammo);")],
  ["object rebind omitted", text => text.replace("KillAmmoByVictim.Remove(victim);", "")],
];
for (const [name, mutate] of stateMutants) {
  const mutant = mutate(stateSource);
  assert.notEqual(mutant, stateSource, `state mutation control did not modify source: ${name}`);
  assert(stateContractFailures(mutant).length > 0, `kill-ammo state oracle accepted mutant: ${name}`);
}

console.log("COMBATLOG POST-RAID KILL LIST VERIFIED");
