import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const read = path => readFileSync(path, "utf8");
const production = {
  plugin: read("Plugin.cs"),
  project: read("CombatLog.csproj"),
  feature: read("PostRaidScreens/PostRaidScreensFeature.cs"),
  state: read("PostRaidScreens/PostRaidScreenState.cs"),
  capture: read("Analytics/CombatLogShotPatches.cs"),
  presentation: read("Analytics/RaidPresentation.cs"),
  killList: read("PostRaidScreens/KillList/CombatLogKillListPatches.cs"),
  death: read("PostRaidScreens/DeathScreen/CombatLogDeathScreenPatches.cs"),
  treatment: read("PostRaidScreens/Treatment/CombatLogDamageTooltipPatches.cs"),
  guidance: read("CLAUDE.md"),
};

function integrationFailures(source) {
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };

  check(source.plugin.includes("using CombatLog.PostRaidScreens;"),
    "Plugin does not reference the internal feature");
  check(source.plugin.includes("PostRaidScreensFeature.Initialize(Config);"),
    "Plugin does not initialize Post-Raid Screens");
  check((source.plugin.match(/PostRaidScreensFeature\.Initialize\(Config\)/g) || []).length === 1,
    "Post-Raid Screens are initialized more than once");
  check(source.plugin.includes("com.maschine.KillAndDamageInfo") &&
    source.plugin.includes("BepInDependency.DependencyFlags.SoftDependency"),
  "legacy KADI is not a deterministic soft load-order dependency");

  for (const key of [
    "Ammo in kill list", "Damaged targets in kill list",
    "Killer details on death screen", "Killer 3D model on death screen",
    "Weapon and distance in treatment tooltips"
  ]) {
    check(source.feature.includes(`"${key}"`), `missing config entry: ${key}`);
  }
  check(source.feature.includes('private const string Section = "Post-Raid Screens";'),
    "screen settings do not share one CombatLog config section");
  for (const property of [
    "KillListAmmoEnabled", "DamagedTargetsEnabled", "DeathDetailsEnabled",
    "KillerModelEnabled", "DamageTooltipsEnabled"
  ]) {
    check(new RegExp(`internal static bool ${property} =>`).test(source.feature),
      `missing display property: ${property}`);
  }
  for (const availability of ["KillListAvailable", "DeathScreenAvailable", "TreatmentAvailable"]) {
    check(source.feature.includes(`${availability} { get; private set; }`),
      `missing isolated availability: ${availability}`);
  }
  check(source.feature.includes('TryEnable("kill list", CombatLogKillListPatches.Enable)'),
    "kill-list group is not isolated");
  check(source.feature.includes('TryEnable("death screen", CombatLogDeathScreenPatches.Enable)'),
    "death-screen group is not isolated");
  check(source.feature.includes('TryEnable("treatment screen", CombatLogDamageTooltipPatches.Enable)'),
    "treatment group is not isolated");
  check(/private static bool TryEnable[\s\S]*catch \(Exception ex\)[\s\S]*return false;/.test(source.feature),
    "a failed screen installer can escape or report available");

  check(source.capture.includes("DamageInfo damageInfo, bool __state"),
    "existing kill hook does not receive lethal DamageInfo");
  check(source.capture.includes("RaidPresentation.CaptureKiller(aggressor, damageInfo);"),
    "death evidence does not extend the existing killer capture");
  check(source.capture.includes("PostRaidScreenState.RecordKill(__instance.ProfileId, damageInfo.SourceId);"),
    "exact lethal SourceId is not recorded by the existing kill hook");
  check(source.capture.includes("PostRaidScreenState.Clear();") &&
    source.capture.indexOf("PostRaidScreenState.Clear();") < source.capture.indexOf("RaidAnalytics.Clear();"),
  "native screen state is not cleared before the next raid analytics reset");
  check(source.state.includes("Dictionary<string, List<string>>") &&
    source.state.includes("StringComparer.Ordinal"),
  "lethal ammo events are not ordered per stable ordinal profile id");
  check(source.state.includes("BindKillAmmo(IEnumerable<VictimStats> victims)") &&
    source.killList.includes("PostRaidScreenState.BindKillAmmo(victims);"),
  "ordered lethal-ammo events are not rebound to result rows");
  check(source.state.includes("TryGetKillAmmo(VictimStats victim"),
    "kill-list UI cannot resolve state across result-object replacement");

  for (const field of [
    "KillingAmmoTemplateId", "KillingWeaponName", "KillingDistance",
    "RemainingHp", "MaxHp", "HasHealth", "NativeVisualState"
  ]) {
    check(source.presentation.includes(field), `shared killer snapshot lacks ${field}`);
  }
  check(source.presentation.includes("CaptureKillerCore(aggressor, killingDamage, true);"),
    "damage-aware capture is not routed into the shared killer snapshot");
  check(source.presentation.includes("CaptureNativeKillerEvidence(snapshot, aggressor, killingDamage, hasKillingDamage);"),
    "native evidence is detached from killer identity/equipment capture");
  check(source.presentation.includes("GetVisualEquipmentState(true)") &&
    source.presentation.includes("new BodyCustomization(visual.Customization)"),
  "native model is not a death-time visible/customization snapshot");

  check(source.killList.includes("new UpdatableBindableList<VictimStats>(victims)"),
    "damaged rows do not use a UI-only list copy");
  check(source.death.includes("RaidPresentation.Killer"),
    "native death screen does not consume the browser killer source");
  check(source.treatment.includes("nameof(DamageStats.Clone)") &&
    source.treatment.includes("nameof(DamageStats.Add)") &&
    source.treatment.includes("nameof(HealthStatisticsManager.OnApplyDamage)"),
  "normal/lethal treatment evidence does not survive vanilla capture, clone and group behavior");

  check(!source.project.includes("KillAndDamageInfo") &&
    !source.project.includes("ProjectReference"),
  "CombatLog gained a KADI/shared-library build dependency");
  check(source.guidance.includes("KillAndDamageInfo plugin is retired") &&
    source.guidance.includes("PostRaidScreens/"),
  "repository guidance still describes KADI as a parallel product");
  return failures;
}

function isolationFailures(source) {
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const screens = source.killList + "\n" + source.death + "\n" + source.treatment;

  for (const forbidden of [
    "DumbStatisticsManager", "BaseStatisticsManager", "Player.ManageAggressor",
    "Player.OnDead", "Player.ApplyShot", "LocalGame.vmethod_0",
    "AnalyticsOverlay", "AnalyticsInputPatch", "KillAndDamageInfo."
  ]) {
    check(!screens.includes(forbidden), `screen modules copied forbidden capture/product layer: ${forbidden}`);
  }
  check((source.capture.match(/nameof\(Player\.OnBeenKilledByAggressor\)/g) || []).length === 1,
    "kill/death capture has more than one credited-kill hook");
  check(source.feature.includes("if (LegacyKadiLoaded())") &&
    /if \(LegacyKadiLoaded\(\)\)[\s\S]*Post-Raid Screens are disabled[\s\S]*return;/.test(source.feature),
  "legacy KADI detection does not disable duplicate native UI patches");
  for (const [property, availability] of [
    ["KillListAmmoEnabled", "KillListAvailable"],
    ["DamagedTargetsEnabled", "KillListAvailable"],
    ["DeathDetailsEnabled", "DeathScreenAvailable"],
    ["KillerModelEnabled", "DeathScreenAvailable"],
    ["DamageTooltipsEnabled", "TreatmentAvailable"]
  ]) {
    check(new RegExp(`${property} =>\\s*${availability} &&`).test(source.feature),
      `${property} can expose a partially installed screen group`);
  }
  check(source.treatment.indexOf("CombatLogDamageTooltipTextPatch().Enable()") >
    source.treatment.indexOf("CombatLogDamageMetadataAddPatch().Enable()"),
  "treatment UI is installed before its propagation chain");
  return failures;
}

function verifyIntegration(source = production) {
  assert.deepEqual(integrationFailures(source), [],
    "post-raid integration failed:\n- " + integrationFailures(source).join("\n- "));
}

function verifyIsolation(source = production) {
  assert.deepEqual(isolationFailures(source), [],
    "post-raid isolation failed:\n- " + isolationFailures(source).join("\n- "));
}

function runNode(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) {
    const output = String(result.stdout || "") + String(result.stderr || "");
    throw new Error(`${script} ${args.join(" ")} failed:\n${output.slice(-12000)}`);
  }
}

function runLeafSuite() {
  for (const script of [
    "tests/verify-postraid-killlist.mjs",
    "tests/verify-postraid-death.mjs",
    "tests/verify-postraid-treatment.mjs"
  ]) runNode(script);
}

function runRegressions() {
  const commands = [
    ["tests/verify-shot-accounting.mjs"],
    ["tests/verify-performance-integration.mjs"],
    ["tests/verify-overlay-lifecycle.mjs"],
    ["tests/verify-desktop-window.mjs"],
    ["tests/verify-presentation.mjs"],
    ["tests/verify-equipment-integration.mjs", "--no-build"],
    ["tests/verify-weapons.mjs"],
    ["tests/verify-records-integration.mjs", "--no-build"],
    ["tests/verify-mannequin.mjs"],
    ["tests/verify-menu-button.mjs"],
    ["tests/verify-armor-impact.mjs"],
    ["tests/verify-ui-architecture.mjs"],
    ["tests/verify-combatlog.mjs", "--debrief"],
    ["tests/verify-combatlog.mjs", "--tape"],
    ["tests/verify-combatlog.mjs", "--scope"],
    ["tests/verify-combatlog.mjs", "--zones"],
    ["tests/verify-combatlog.mjs", "--polish"],
    ["tests/verify-combatlog.mjs", "--overall"],
    ["tests/verify-combatlog.mjs", "--overall-weapons"],
    ["tests/verify-combatlog.mjs", "--cartridges"]
  ];
  for (const [script, ...args] of commands) runNode(script, args);
}
verifyIntegration();
verifyIsolation();
const mutants = [
  ["plugin wiring", { ...production, plugin: production.plugin.replace("PostRaidScreensFeature.Initialize(Config);", "") }, integrationFailures],
  ["lethal ammo capture", { ...production, capture: production.capture.replace("PostRaidScreenState.RecordKill(__instance.ProfileId, damageInfo.SourceId);", "") }, integrationFailures],
  ["ordered lethal ammo binding", { ...production, killList: production.killList.replace("PostRaidScreenState.BindKillAmmo(victims);", "") }, integrationFailures],
  ["lethal treatment capture", { ...production, treatment: production.treatment.replace("nameof(HealthStatisticsManager.OnApplyDamage)", "nameof(HealthStatisticsManager.LogDamage)") }, integrationFailures],
  ["shared death capture", { ...production, capture: production.capture.replace("RaidPresentation.CaptureKiller(aggressor, damageInfo);", "RaidPresentation.CaptureKiller(aggressor);") }, integrationFailures],
  ["partial availability", { ...production, feature: production.feature.replace("KillListAvailable && _killListAmmo", "true && _killListAmmo") }, isolationFailures],
  ["duplicate statistics hook", { ...production, killList: production.killList + " DumbStatisticsManager" }, isolationFailures],
  ["legacy conflict bypass", { ...production, feature: production.feature.replace("if (LegacyKadiLoaded())", "if (false)") }, isolationFailures]
];
for (const [name, mutant, oracle] of mutants)
  assert(oracle(mutant).length > 0, `integration oracle accepted mutant: ${name}`);

const mode = process.argv[2] || "integration";
if (mode === "--isolation") {
  console.log("COMBATLOG POST-RAID ISOLATION VERIFIED");
} else if (mode === "--all") {
  runLeafSuite();
  console.log("COMBATLOG POST-RAID FULL SUITE VERIFIED");
} else if (mode === "--regressions") {
  runRegressions();
  console.log("COMBATLOG POST-RAID REGRESSIONS VERIFIED");
} else if (mode === "integration") {
  console.log("COMBATLOG POST-RAID INTEGRATION VERIFIED");
} else {
  throw new Error("unknown mode: " + mode);
}
