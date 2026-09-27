import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../PostRaidScreens/Treatment/CombatLogDamageTooltipPatches.cs", import.meta.url),
  "utf8").replace(/\r\n/g, "\n");

function blockFrom(text, marker) {
  const start = text.indexOf(marker);
  assert(start >= 0, `missing production block: ${marker}`);
  const open = text.indexOf("{", start);
  assert(open >= 0, `missing opening brace: ${marker}`);
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "{") depth++;
    else if (text[index] === "}" && --depth === 0)
      return text.slice(start, index + 1);
  }
  throw new Error(`unterminated production block: ${marker}`);
}

function verifySourceContract(text) {
  assert.match(text, /namespace CombatLog\.PostRaidScreens\.Treatment;/);
  assert.match(text, /public static class CombatLogDamageTooltipPatches/);
  assert.match(text,
    /private static readonly ConditionalWeakTable<DamageStats, DamageTooltipMetadata> Metadata = new\(\);/,
    "metadata is not weakly keyed by DamageStats identity");
  assert.doesNotMatch(text, /Dictionary<DamageStats\s*,/,
    "a strong DamageStats dictionary can retain raid history indefinitely");

  const metadata = blockFrom(text, "    private sealed class DamageTooltipMetadata");
  assert.match(metadata, /readonly string WeaponKey;/);
  assert.match(metadata, /readonly bool WeaponConflict;/);
  assert.match(metadata, /readonly bool HasDistance;/);
  assert.match(metadata, /readonly float MinimumDistance;/);
  assert.match(metadata, /readonly float MaximumDistance;/);
  assert.match(metadata, /weaponKey = weaponKey\.Trim\(\);[\s\S]*weaponKey\.Length > MaxWeaponKeyLength[\s\S]*weaponKey = null;/,
    "weapon identity is not trimmed and bounded before retention");
  assert.match(metadata,
    /hasDistance = hasDistance && !float\.IsNaN\(distance\) && !float\.IsInfinity\(distance\) && distance >= 0f;/,
    "capture no longer distinguishes valid zero evidence from absent or invalid distance");
  assert.match(metadata, /if \(weaponKey == null && !hasDistance\)\s*return null;/,
    "empty hits create fake metadata");
  assert.match(metadata, /left\.WeaponConflict \|\| right\.WeaponConflict/,
    "a weapon conflict is not sticky across later grouping");
  assert.match(metadata,
    /string\.Equals\(left\.WeaponKey, right\.WeaponKey, StringComparison\.Ordinal\)/,
    "weapon identities are not compared exactly");
  assert.match(metadata, /else\s*weaponConflict = true;/,
    "disagreeing grouped weapons do not suppress the weapon label");
  assert.match(metadata, /Math\.Min\(left\.MinimumDistance, right\.MinimumDistance\)/);
  assert.match(metadata, /Math\.Max\(left\.MaximumDistance, right\.MaximumDistance\)/);

  const enable = blockFrom(text, "    public static void Enable()");
  const enabled = [
    "CombatLogDamageMetadataCapturePatch",
    "CombatLogLethalDamageMetadataCapturePatch",
    "CombatLogDamageMetadataClonePatch",
    "CombatLogDamageMetadataAddPatch",
    "CombatLogDamageTooltipTextPatch"
  ];
  for (const patch of enabled) {
    assert.equal((enable.match(new RegExp(`new ${patch}\\(\\)\\.Enable\\(\\)`, "g")) || []).length, 1,
      `${patch} is not enabled exactly once`);
  }
  for (let index = 1; index < enabled.length; index++) {
    assert(enable.indexOf(enabled[index - 1]) < enable.indexOf(enabled[index]),
      "display must install only after capture, clone, and add propagation");
  }

  const patchNames = [...text.matchAll(/public sealed class (\w+) : ModulePatch/g)].map(match => match[1]);
  assert.deepEqual(patchNames, enabled, "unexpected or missing treatment Harmony patch class");
  assert(patchNames.every(name => name.startsWith("CombatLog")),
    "every Harmony id must carry the CombatLog prefix");

  const capture = blockFrom(text, "    public sealed class CombatLogDamageMetadataCapturePatch");
  const lethal = blockFrom(text, "    public sealed class CombatLogLethalDamageMetadataCapturePatch");
  const clone = blockFrom(text, "    public sealed class CombatLogDamageMetadataClonePatch");
  const add = blockFrom(text, "    public sealed class CombatLogDamageMetadataAddPatch");
  const tooltip = blockFrom(text, "    public sealed class CombatLogDamageTooltipTextPatch");

  assert.match(capture,
    /AccessTools\.Method\(typeof\(HealthStatisticsManager\), nameof\(HealthStatisticsManager\.LogDamage\),\s*new\[\] \{ typeof\(EBodyPart\), typeof\(float\), typeof\(DamageInfo\) \}\)/,
    "capture does not bind the exact SPT 4.1 LogDamage overload");
  assert.match(capture, /DamageHistory history = __instance\?\.DamageHistory;/);
  assert.match(capture, /list == null \|\| list\.Count == 0/);
  assert.match(capture, /DamageStats actualEntry = list\[list\.Count - 1\];/,
    "capture does not attach to LogDamage's actual final history entry");
  assert.match(capture, /damageInfo\.Weapon\?\.ShortName/,
    "weapon short-name localization key is not captured");
  assert.match(capture, /DistanceHelper\.TryGetDistance\(damageInfo, out float distance\)/);
  assert.match(capture,
    /MergeMetadata\(actualEntry, DamageTooltipMetadata\.FromHit\(weaponKey, hasDistance, distance\)\)/);
  assert.doesNotMatch(capture, /DamageTooltipsEnabled/,
    "capture was incorrectly gated by the display toggle");

  assert.match(lethal,
    /AccessTools\.Method\(typeof\(HealthStatisticsManager\), nameof\(HealthStatisticsManager\.OnApplyDamage\),\s*new\[\] \{ typeof\(EBodyPart\), typeof\(float\), typeof\(DamageInfo\) \}\)/,
    "lethal capture does not bind the exact SPT 4.1 OnApplyDamage overload");
  assert.match(lethal, /Postfix\(DamageStats ____lastDamage, DamageInfo damageInfo\)/,
    "lethal capture does not receive vanilla's newly-created _lastDamage object");
  assert.match(lethal,
    /MergeMetadata\(____lastDamage,\s*DamageTooltipMetadata\.FromHit\(weaponKey, hasDistance, distance\)\)/,
    "lethal DamageStats does not receive weapon and distance metadata");
  assert.doesNotMatch(lethal, /DamageTooltipsEnabled/,
    "lethal capture was incorrectly gated by the display toggle");

  assert.match(clone,
    /AccessTools\.Method\(typeof\(DamageStats\), nameof\(DamageStats\.Clone\), Type\.EmptyTypes\)/);
  assert.match(clone, /__result != null && TryGetMetadata\(__instance, out DamageTooltipMetadata metadata\)/);
  assert.match(clone, /SetMetadata\(__result, metadata\);/,
    "DamageStats.Clone no longer copies treatment metadata");
  assert.doesNotMatch(clone, /DamageTooltipsEnabled/,
    "clone propagation was incorrectly gated by the display toggle");

  assert.match(add,
    /AccessTools\.Method\(typeof\(DamageStats\), nameof\(DamageStats\.Add\), new\[\] \{ typeof\(DamageStats\) \}\)/);
  assert.match(add, /TryGetMetadata\(damage, out DamageTooltipMetadata incoming\)/);
  assert.match(add, /MergeMetadata\(__instance, incoming\);/,
    "DamageStats.Add no longer merges grouped metadata");
  assert.doesNotMatch(add, /DamageTooltipsEnabled/,
    "group propagation was incorrectly gated by the display toggle");

  assert.match(tooltip,
    /AccessTools\.Method\(typeof\(DamageStats\), nameof\(DamageStats\.ToString\), Type\.EmptyTypes\)/);
  assert.match(tooltip, /!PostRaidScreensFeature\.DamageTooltipsEnabled/,
    "only tooltip display may consult the feature toggle");
  assert.match(tooltip, /__instance == null \|\| __result == null/,
    "tooltip callback is not null-safe");
  assert.match(tooltip, /metadata\.WeaponKey\.Localized\(null\)/,
    "weapon short-name key is not localized at display time");
  assert.match(tooltip, /metadata\.WeaponConflict/,
    "tooltip can display a disputed weapon");

  const formatter = blockFrom(text, "    private static string FormatDistance");
  assert.match(formatter, /metadata == null \|\| !metadata\.HasDistance/,
    "absent distance can be rendered as a fabricated zero");
  assert.match(formatter, /MinimumDistance\.ToString\("0\.#"\)/);
  assert.match(formatter, /MaximumDistance\.ToString\("0\.#"\)/);
  assert.match(formatter, /minimum \+ "–" \+ maximum/,
    "different grouped distances are not presented as a min–max range");
  assert.match(formatter, /"UI\/ProfileStats\/Meters"\.Localized\(null\)/,
    "distance unit is not localized");

  for (const [name, patch] of [["capture", capture], ["lethal capture", lethal], ["clone", clone], ["add", add], ["tooltip", tooltip]]) {
    const callback = blockFrom(patch, "        public static void Postfix");
    assert.match(callback, /try\s*\{/,
      `${name} callback does not isolate supplementary work`);
    assert.match(callback, /catch \(Exception ex\)\s*\{[\s\S]*Warn\(/,
      `${name} callback can throw into vanilla`);
  }
  const warn = blockFrom(text, "    private static void Warn");
  assert.match(warn, /try\s*\{[\s\S]*Plugin\.Log\?\.LogWarning/);
  assert.match(warn, /catch\s*\{\s*\}/,
    "logger failure can escape a supplementary callback");
}
verifySourceContract(source);
const sourceMutants = [
  ["strong identity table", text => text.replace(
    "ConditionalWeakTable<DamageStats, DamageTooltipMetadata>",
    "Dictionary<DamageStats, DamageTooltipMetadata>")],
  ["first rather than final history entry", text => text.replace(
    "list[list.Count - 1]", "list[0]")],
  ["lethal capture removed", text => text.replace(
    "new CombatLogLethalDamageMetadataCapturePatch().Enable();", "")],
  ["lethal object not bound", text => text.replace(
    "MergeMetadata(____lastDamage,", "MergeMetadata(null,")],
  ["clone propagation removed", text => text.replace(
    "SetMetadata(__result, metadata);", "return;")],
  ["group merge removed", text => text.replace(
    "MergeMetadata(__instance, incoming);", "return;")],
  ["maximum collapsed to minimum", text => text.replace(
    "Math.Max(left.MaximumDistance, right.MaximumDistance)",
    "Math.Min(left.MaximumDistance, right.MaximumDistance)")],
  ["first weapon wins", text => text.replace(
    "else\n                    weaponConflict = true;",
    "else\n                    weaponKey = left.WeaponKey;")],
  ["capture gated by display", text => text.replace(
    "DamageHistory history = __instance?.DamageHistory;",
    "if (!PostRaidScreensFeature.DamageTooltipsEnabled) return;\n                DamageHistory history = __instance?.DamageHistory;")],
  ["unprefixed Harmony id", text => text.replace(
    "public sealed class CombatLogDamageMetadataAddPatch",
    "public sealed class DamageMetadataAddPatch")],
  ["missing distance rendered as zero", text => text.replace(
    "metadata == null || !metadata.HasDistance",
    "metadata == null")],
  ["display installed before merge", text => text.replace(
    "new CombatLogDamageMetadataAddPatch().Enable();\n        new CombatLogDamageTooltipTextPatch().Enable();",
    "new CombatLogDamageTooltipTextPatch().Enable();\n        new CombatLogDamageMetadataAddPatch().Enable();")]
];
for (const [name, mutate] of sourceMutants) {
  const mutant = mutate(source);
  assert.notEqual(mutant, source, `source mutation did not apply: ${name}`);
  assert.throws(() => verifySourceContract(mutant), undefined,
    `source oracle accepted mutant: ${name}`);
}

function createModel(options = {}) {
  const table = new WeakMap();

  function fromHit(weaponKey, hasDistance, distance) {
    if (typeof weaponKey !== "string" || weaponKey.trim() === "") weaponKey = null;
    hasDistance = Boolean(hasDistance) && Number.isFinite(distance) && distance >= 0;
    if (options.inventZero && !hasDistance) {
      hasDistance = true;
      distance = 0;
    }
    if (weaponKey === null && !hasDistance) return null;
    return {
      weaponKey,
      weaponConflict: false,
      hasDistance,
      minimumDistance: hasDistance ? distance : 0,
      maximumDistance: hasDistance ? distance : 0
    };
  }

  function merge(left, right) {
    if (!left) return right;
    if (!right) return left;
    let weaponConflict = left.weaponConflict || right.weaponConflict;
    let weaponKey = null;
    if (!weaponConflict) {
      if (!left.weaponKey) weaponKey = right.weaponKey;
      else if (!right.weaponKey) weaponKey = left.weaponKey;
      else if (left.weaponKey === right.weaponKey) weaponKey = left.weaponKey;
      else if (options.firstWeaponWins) weaponKey = left.weaponKey;
      else weaponConflict = true;
    }

    const hasDistance = left.hasDistance || right.hasDistance;
    let minimumDistance = 0;
    let maximumDistance = 0;
    if (left.hasDistance && right.hasDistance) {
      if (options.lastDistanceOnly) {
        minimumDistance = right.minimumDistance;
        maximumDistance = right.maximumDistance;
      } else {
        minimumDistance = Math.min(left.minimumDistance, right.minimumDistance);
        maximumDistance = Math.max(left.maximumDistance, right.maximumDistance);
      }
    } else if (left.hasDistance) {
      minimumDistance = left.minimumDistance;
      maximumDistance = left.maximumDistance;
    } else if (right.hasDistance) {
      minimumDistance = right.minimumDistance;
      maximumDistance = right.maximumDistance;
    }
    return { weaponKey, weaponConflict, hasDistance, minimumDistance, maximumDistance };
  }

  function mergeInto(target, incoming) {
    if (!target || !incoming) return;
    table.set(target, merge(table.get(target), incoming));
  }

  function capture(history, bodyPart, hit, displayEnabled = true) {
    try {
      if (options.gateCapture && !displayEnabled) return;
      const list = history?.[bodyPart];
      if (!Array.isArray(list) || list.length === 0) return;
      const target = options.captureFirst ? list[0] : list[list.length - 1];
      if (!target) return;
      mergeInto(target, fromHit(hit?.weaponKey, hit?.hasDistance, hit?.distance));
    } catch (error) {
      if (options.throwSupplementary) throw error;
    }
  }

  function captureLethal(lastDamage, hit, displayEnabled = true) {
    try {
      if (options.gateCapture && !displayEnabled) return;
      if (!lastDamage) return;
      mergeInto(lastDamage, fromHit(hit?.weaponKey, hit?.hasDistance, hit?.distance));
    } catch (error) {
      if (options.throwSupplementary) throw error;
    }
  }

  function clone(original) {
    const result = {};
    try {
      if (!options.dropClone && original && table.has(original))
        table.set(result, table.get(original));
    } catch (error) {
      if (options.throwSupplementary) throw error;
    }
    return result;
  }

  function add(target, incoming) {
    try {
      if (!options.dropAdd && target && incoming && table.has(incoming))
        mergeInto(target, table.get(incoming));
    } catch (error) {
      if (options.throwSupplementary) throw error;
    }
  }

  function rounded(value) {
    const tenths = Math.round(value * 10) / 10;
    return Object.is(tenths, -0) ? "0" : String(tenths);
  }

  function display(damage, vanilla = "vanilla", enabled = true, localize = key => key) {
    try {
      if ((!enabled && !options.displayIgnoresToggle) || !damage || vanilla == null || !table.has(damage))
        return vanilla;
      const metadata = table.get(damage);
      const weapon = metadata.weaponConflict || !metadata.weaponKey
        ? null
        : localize(metadata.weaponKey);
      let distance = null;
      if (metadata.hasDistance) {
        const minimum = rounded(metadata.minimumDistance);
        const maximum = rounded(metadata.maximumDistance);
        distance = (minimum === maximum ? minimum : `${minimum}–${maximum}`) + localize("meters");
      }
      const extra = weapon ? (distance ? `${weapon}, ${distance}` : weapon) : distance;
      return extra ? `${vanilla} <b>(${extra})</b>` : vanilla;
    } catch (error) {
      if (options.throwSupplementary) throw error;
      return vanilla;
    }
  }

  return { capture, captureLethal, clone, add, display, has: object => table.has(object) };
}

function behaviorFailures(model) {
  const failures = [];
  const check = (name, operation) => {
    try { operation(); }
    catch (error) { failures.push(`${name}: ${error.message}`); }
  };
  const localized = key => ({ rifle: "Rifle", pistol: "Pistol", meters: " m" })[key] ?? key;

  check("capture uses final entry", () => {
    const first = {};
    const final = {};
    model.capture({ Head: [first, final] }, "Head",
      { weaponKey: "rifle", hasDistance: true, distance: 42 });
    assert.equal(model.has(first), false);
    assert.equal(model.display(final, "base", true, localized), "base <b>(Rifle, 42 m)</b>");
  });

  check("capture stays active while display disabled", () => {
    const damage = {};
    model.capture({ Chest: [damage] }, "Chest",
      { weaponKey: "rifle", hasDistance: true, distance: 18 }, false);
    assert.equal(model.display(damage, "base", false, localized), "base");
    assert.equal(model.display(damage, "base", true, localized), "base <b>(Rifle, 18 m)</b>");
  });

  check("lethal entry carries metadata through its own clone", () => {
    const lethal = {};
    model.captureLethal(lethal,
      { weaponKey: "pistol", hasDistance: true, distance: 7.5 }, false);
    assert.equal(model.display(lethal, "lethal", false, localized), "lethal");
    const lethalClone = model.clone(lethal);
    assert.equal(model.display(lethalClone, "lethal", true, localized),
      "lethal <b>(Pistol, 7.5 m)</b>");
  });

  check("absent distance does not become zero", () => {
    const damage = {};
    model.capture({ Arm: [damage] }, "Arm",
      { weaponKey: "rifle", hasDistance: false, distance: 0 });
    assert.equal(model.display(damage, "base", true, localized), "base <b>(Rifle)</b>");
  });

  check("measured zero remains evidence", () => {
    const damage = {};
    model.capture({ Arm: [damage] }, "Arm",
      { weaponKey: null, hasDistance: true, distance: 0 });
    assert.equal(model.display(damage, "base", true, localized), "base <b>(0 m)</b>");
  });

  check("invalid distances are omitted", () => {
    for (const distance of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const damage = {};
      model.capture({ Leg: [damage] }, "Leg",
        { weaponKey: "pistol", hasDistance: true, distance });
      assert.equal(model.display(damage, "base", true, localized), "base <b>(Pistol)</b>");
    }
  });

  check("clone copies identity metadata independently", () => {
    const original = {};
    const second = {};
    model.capture({ Stomach: [original] }, "Stomach",
      { weaponKey: "rifle", hasDistance: true, distance: 10 });
    model.capture({ Stomach: [second] }, "Stomach",
      { weaponKey: "rifle", hasDistance: true, distance: 20 });
    const clone = model.clone(original);
    model.add(clone, second);
    assert.equal(model.display(clone, "base", true, localized), "base <b>(Rifle, 10–20 m)</b>");
    assert.equal(model.display(original, "base", true, localized), "base <b>(Rifle, 10 m)</b>");
  });

  check("repeated capture accumulates a range", () => {
    const actual = {};
    model.capture({ Head: [actual] }, "Head",
      { weaponKey: "rifle", hasDistance: true, distance: 55 });
    model.capture({ Head: [actual] }, "Head",
      { weaponKey: "rifle", hasDistance: true, distance: 40 });
    assert.equal(model.display(actual, "base", true, localized), "base <b>(Rifle, 40–55 m)</b>");
  });

  check("grouped weapon disagreement is omitted", () => {
    const first = {};
    const second = {};
    model.capture({ Head: [first] }, "Head",
      { weaponKey: "rifle", hasDistance: true, distance: 31 });
    model.capture({ Head: [second] }, "Head",
      { weaponKey: "pistol", hasDistance: true, distance: 34 });
    const group = model.clone(first);
    model.add(group, second);
    assert.equal(model.display(group, "base", true, localized), "base <b>(31–34 m)</b>");

    const third = {};
    model.capture({ Head: [third] }, "Head",
      { weaponKey: "rifle", hasDistance: true, distance: 35 });
    model.add(group, third);
    assert.equal(model.display(group, "base", true, localized), "base <b>(31–35 m)</b>");
  });

  check("display rounds an indistinguishable interval once", () => {
    const first = {};
    const second = {};
    model.capture({ Chest: [first] }, "Chest",
      { weaponKey: null, hasDistance: true, distance: 10.01 });
    model.capture({ Chest: [second] }, "Chest",
      { weaponKey: null, hasDistance: true, distance: 10.04 });
    const group = model.clone(first);
    model.add(group, second);
    assert.equal(model.display(group, "base", true, localized), "base <b>(10 m)</b>");
  });

  check("empty and null callbacks are supplementary no-ops", () => {
    assert.doesNotThrow(() => model.capture(null, "Head", null));
    assert.doesNotThrow(() => model.capture({ Head: [] }, "Head", null));
    assert.doesNotThrow(() => model.add(null, null));
    assert.equal(model.display(null, "base", true, localized), "base");
    assert.equal(model.display({}, null, true, localized), null);
  });

  check("localization failure preserves vanilla", () => {
    const damage = {};
    model.capture({ Head: [damage] }, "Head",
      { weaponKey: "rifle", hasDistance: true, distance: 12 });
    assert.doesNotThrow(() => model.display(damage, "base", true, () => { throw new Error("locale"); }));
    assert.equal(model.display(damage, "base", true, () => { throw new Error("locale"); }), "base");
  });

  return failures;
}

assert.deepEqual(behaviorFailures(createModel()), [], "production behavior model failed");
const behaviorMutants = [
  ["capture first entry", { captureFirst: true }],
  ["drop clone metadata", { dropClone: true }],
  ["drop grouped add metadata", { dropAdd: true }],
  ["keep last distance sample", { lastDistanceOnly: true }],
  ["invent zero without evidence", { inventZero: true }],
  ["keep first disagreeing weapon", { firstWeaponWins: true }],
  ["gate capture with display", { gateCapture: true }],
  ["ignore display toggle", { displayIgnoresToggle: true }],
  ["throw supplementary failures", { throwSupplementary: true }]
];
for (const [name, options] of behaviorMutants) {
  assert(behaviorFailures(createModel(options)).length > 0,
    `behavior oracle accepted mutant: ${name}`);
}

console.log("COMBATLOG POST-RAID TREATMENT VERIFIED");
