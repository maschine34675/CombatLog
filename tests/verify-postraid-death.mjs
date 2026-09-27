import { readFileSync } from "node:fs";

const path = "PostRaidScreens/DeathScreen/CombatLogDeathScreenPatches.cs";
const source = readFileSync(path, "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function compact(text) {
  return text.replace(/\/\/[^\n]*/g, " ").replace(/\s+/g, " ").trim();
}

function bodyAfter(text, marker) {
  const start = text.indexOf(marker);
  assert(start >= 0, `missing ${marker}`);
  const open = text.indexOf("{", start + marker.length);
  assert(open >= 0, `missing body for ${marker}`);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error(`unterminated body for ${marker}`);
}

function verify(candidate) {
  const flat = compact(candidate);
  assert(flat.includes("namespace CombatLog.PostRaidScreens.DeathScreen;"), "wrong death-screen namespace");
  assert(/public static class CombatLogDeathScreenPatches\b/.test(candidate), "missing public CombatLogDeathScreenPatches entrypoint");

  const patchClasses = [...candidate.matchAll(/class\s+(\w+)\s*:\s*ModulePatch/g)].map(match => match[1]);
  assert(patchClasses.length === 1 && patchClasses.every(name => name.startsWith("CombatLog")),
    "patch class names are not uniquely CombatLog-prefixed");
  assert(flat.includes("new CombatLogDeathScreenShowPatch().Enable();"), "Enable does not install the death-screen patch");
  assert((candidate.match(/\[PatchPrefix\]/g) || []).length === 1 &&
    (candidate.match(/\[PatchPostfix\]/g) || []).length === 1,
  "death-screen prefix/postfix annotations are missing or duplicated");
  assert(!/typeof\s*\(\s*Player\s*\)|nameof\s*\(\s*Player\.(?:ManageAggressor|OnDead|ApplyShot)/.test(candidate),
    "death screen introduced a forbidden Player capture patch");

  const target = compact(bodyAfter(candidate, "GetTargetMethod()"));
  const exactSignature = [
    "typeof(Profile)", "typeof(PlayerVisualRepresentation)", "typeof(ESideType)",
    "typeof(ExitStatus)", "typeof(TimeSpan)", "typeof(IEftSession)", "typeof(bool)"
  ];
  assert(target.includes("AccessTools.Method( typeof(SessionResultExitStatus), nameof(SessionResultExitStatus.Show)"),
    "target is not SessionResultExitStatus.Show");
  let cursor = -1;
  for (const type of exactSignature) {
    const next = target.indexOf(type, cursor + 1);
    assert(next > cursor, `exact Show overload is missing or reordered at ${type}`);
    cursor = next;
  }
  assert((target.match(/typeof\(/g) || []).length === 8, "target overload contains unexpected parameter types");

  const prefix = compact(bodyAfter(candidate, "private static void Prefix("));
  assert(flat.includes("ref PlayerVisualRepresentation lastPlayerState"), "prefix cannot replace lastPlayerState");
  assert(flat.includes("out RaidPresentation.KillerSnapshot __state"), "prefix does not carry the model-producing snapshot");
  assert(prefix.includes("__state = null"), "prefix state is not safely initialized");
  assert(prefix.includes("exitStatus != ExitStatus.Killed") && prefix.includes("!PostRaidScreensFeature.KillerModelEnabled"),
    "model swap is not guarded by killed exit and its feature flag");
  assert(prefix.includes("snapshot?.NativeVisualState") && prefix.includes("visualState == null || visualState.IsEmpty()"),
    "model swap does not require a nonempty native snapshot");
  assert(prefix.indexOf("lastPlayerState = visualState") < prefix.indexOf("__state = snapshot") &&
    prefix.includes("lastPlayerState = visualState") && prefix.includes("__state = snapshot"),
    "prefix does not bind swap state to the exact substituted model");

  const postfix = compact(bodyAfter(candidate, "private static void Postfix("));
  assert(postfix.includes("exitStatus != ExitStatus.Killed"), "postfix can alter non-killed exits");
  assert(postfix.includes("snapshot = __state ?? RaidPresentation.Killer"), "details are not sourced from the shared killer snapshot");
  assert(postfix.includes("if (snapshot == null)") && postfix.includes("PostRaidScreensFeature.DeathDetailsEnabled"),
    "postfix lacks snapshot or details-feature guards");
  assert(postfix.includes("if (__state != null)") && postfix.includes("ShowKillerLevel(____levelPanel, __state)"),
    "level badge is not tied exclusively to an active model swap");

  const details = compact(bodyAfter(candidate, "private static void AppendDeathDetails("));
  assert(details.includes("bodyPartLabel == null") && details.includes("snapshot == null"), "detail label lacks null guards");
  assert(details.includes("ResolveWeaponName(activeProfile, snapshot)"), "death weapon is not resolved from the snapshot");
  assert(details.includes("ResolveAmmoName(snapshot.KillingAmmoTemplateId)"), "death ammo does not use the snapshot template id");
  assert(details.includes("FormatDistance(snapshot.KillingDistance)"), "death distance does not use the snapshot distance");
  assert(details.includes("details.Count == 0") && details.includes("LastIndexOf(')')"), "vanilla label is not preserved without safe evidence");
  assert(details.includes("beforeClose.EndsWith(suffix, StringComparison.Ordinal)"), "death detail text is not idempotent");

  const weapon = compact(bodyAfter(candidate, "private static string ResolveWeaponName("));
  assert(weapon.includes("if (!string.IsNullOrWhiteSpace(snapshot.KillingWeaponName))"),
    "exact snapshot weapon is not an active first choice");
  assert(weapon.indexOf("snapshot.KillingWeaponName") < weapon.indexOf("activeProfile?.EftStats?.Aggressor?.WeaponName"),
    "profile aggressor incorrectly outranks the exact snapshot weapon");
  assert(weapon.includes("activeProfile?.EftStats?.Aggressor?.WeaponName") && weapon.includes("fallback.Localized(null)"),
    "localized active-profile aggressor weapon fallback is missing");
  const ammo = compact(bodyAfter(candidate, "private static string ResolveAmmoName("));
  assert(ammo.includes("AmmoLocale.GetAmmoShortName(templateId)"), "AmmoLocale is not used");
  const distance = compact(bodyAfter(candidate, "private static string FormatDistance("));
  assert(distance.includes("distance <= 0f") && distance.includes("float.IsNaN(distance)") && distance.includes("float.IsInfinity(distance)"),
    "distance absence/non-finite guards are missing");
  assert(distance.includes("MeterLocaleKey.Localized(null)") && distance.includes('distance.ToString("0.#", CultureInfo.CurrentCulture)'),
    "distance does not use a localized meter suffix and local number format");

  const health = compact(bodyAfter(candidate, "private static void AppendKillerHealth("));
  for (const token of ["snapshot.HasHealth", "snapshot.RemainingHp", "snapshot.MaxHp", "KillerNameTextField?.GetValue", "HealthPrefix"])
    assert(health.includes(token), `killer-health handling is missing ${token}`);
  assert(health.includes("nameText.text.IndexOf(HealthPrefix, StringComparison.Ordinal) >= 0"),
    "killer HP append is not idempotent");
  assert(health.includes("float.IsNaN(snapshot.RemainingHp)") && health.includes("float.IsInfinity(snapshot.MaxHp)"),
    "killer HP accepts corrupt non-finite evidence");

  const level = compact(bodyAfter(candidate, "private static void ShowKillerLevel("));
  assert(level.includes("snapshot?.NativeVisualState") && level.includes("visualState?.Info"), "killer level is detached from native model evidence");
  assert(level.includes("snapshot.Level > 0 ? snapshot.Level : info.Level"), "killer snapshot level is not preferred");
  assert(level.includes("EPlayerSide.Savage ? ESideType.Savage : ESideType.Pmc"), "killer model side is not reflected in the badge");
}
function appendDetails(text, values) {
  const details = values.filter(value => typeof value === "string" && value.trim());
  if (!text || details.length === 0) return text;
  const close = text.lastIndexOf(")");
  if (close < 0 || text.slice(close + 1).trim()) return text;
  const suffix = ", " + details.join(", ");
  const before = text.slice(0, close);
  return before.endsWith(suffix) ? text : before + suffix + text.slice(close);
}

function appendHealth(text, hasHealth, current, maximum) {
  const prefix = " <size=70%>(HP: ";
  if (!text || !hasHealth || !Number.isFinite(current) || !Number.isFinite(maximum) || current < 0 || maximum <= 0 || text.includes(prefix))
    return text;
  return text + prefix + current.toFixed(0) + "/" + maximum.toFixed(0) + ")</size>";
}

assert(appendDetails("(thorax)", ["AK-74N", "BS", "42.5m"]) === "(thorax, AK-74N, BS, 42.5m)",
  "positive detail behavior control failed");
const once = appendDetails("(thorax)", ["AK-74N", "BS", "42.5m"]);
assert(appendDetails(once, ["AK-74N", "BS", "42.5m"]) === once, "detail idempotence behavior control failed");
assert(appendDetails("(thorax)", []) === "(thorax)" && appendDetails("thorax", ["BS"]) === "thorax",
  "vanilla-preservation behavior control failed");
const hpOnce = appendHealth("Killer", true, 273, 440);
assert(hpOnce === "Killer <size=70%>(HP: 273/440)</size>" && appendHealth(hpOnce, true, 273, 440) === hpOnce,
  "positive HP/idempotence behavior control failed");
assert(appendHealth("Killer", false, 273, 440) === "Killer" && appendHealth("Killer", true, NaN, 440) === "Killer",
  "missing/corrupt HP behavior control failed");
verify(source);
const mutants = [
  ["wrong exit", text => text.replace("exitStatus != ExitStatus.Killed", "exitStatus != ExitStatus.Survived")],
  ["missing prefix annotation", text => text.replace("[PatchPrefix]", "")],
  ["missing postfix annotation", text => text.replace("[PatchPostfix]", "")],
  ["broad overload", text => text.replace(", typeof(IEftSession), typeof(bool)", ", typeof(IEftSession)")],
  ["model flag bypass", text => text.replace("!PostRaidScreensFeature.KillerModelEnabled", "false")],
  ["details flag bypass", text => text.replace("if (PostRaidScreensFeature.DeathDetailsEnabled)", "if (true)")],
  ["empty model", text => text.replace("visualState == null || visualState.IsEmpty()", "visualState == null")],
  ["unbound level", text => text.replace("if (__state != null)", "if (snapshot != null)")],
  ["profile weapon first", text => text.replace("if (!string.IsNullOrWhiteSpace(snapshot.KillingWeaponName))", "if (false && !string.IsNullOrWhiteSpace(snapshot.KillingWeaponName))")],
  ["raw ammo", text => text.replace("AmmoLocale.GetAmmoShortName(templateId)", "templateId")],
  ["hard-coded meters", text => text.replace("MeterLocaleKey.Localized(null)", '"m"')],
  ["duplicate details", text => text.replace("beforeClose.EndsWith(suffix, StringComparison.Ordinal)", "false")],
  ["unproven health", text => text.replace("!snapshot.HasHealth", "false")],
  ["level without swap", text => text.replace("ShowKillerLevel(____levelPanel, __state)", "ShowKillerLevel(____levelPanel, snapshot)")],
  ["duplicate HP", text => text.replace("nameText.text.IndexOf(HealthPrefix, StringComparison.Ordinal) >= 0", "false")],
  ["second capture patch", text => text.replace("public static class CombatLogDeathScreenPatches", "public static class CombatLogDeathScreenPatches { private sealed class CombatLogOnDeadPatch : ModulePatch { protected override MethodBase GetTargetMethod() => AccessTools.Method(typeof(Player), nameof(Player.OnDead)); } } public static class Mutated")]
];
for (const [name, mutate] of mutants) {
  const mutated = mutate(source);
  assert(mutated !== source, `mutant control did not alter source: ${name}`);
  let rejected = false;
  try { verify(mutated); } catch { rejected = true; }
  assert(rejected, `oracle accepted mutant: ${name}`);
}

console.log("COMBATLOG POST-RAID DEATH SCREEN VERIFIED");
