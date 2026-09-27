import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const patches = readFileSync("Analytics/CombatLogShotPatches.cs", "utf8");
const analytics = readFileSync("Analytics/RaidAnalytics.cs", "utf8");

function blockFrom(source, marker) {
  const start = source.indexOf(marker);
  assert(start >= 0, `missing production block: ${marker}`);
  const open = source.indexOf("{", start);
  assert(open >= 0, `missing opening brace: ${marker}`);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}" && --depth === 0)
      return source.slice(start, index + 1);
  }
  throw new Error(`unterminated production block: ${marker}`);
}

function verifyPatchContract(source) {
  const local = blockFrom(source, "    private static bool IsLocalFirearmController");
  const observedName = blockFrom(source, "    private static string ObservedWeaponName");
  const root = blockFrom(source, "    private static Shot RootProjectile");
  const key = blockFrom(source, "    private static string ProjectileKey");
  const cartridgeKey = blockFrom(source, "    private static string CartridgeKey");
  const fired = blockFrom(source, "    public class CombatLogShotFiredPatch");
  const hit = blockFrom(source, "    public class CombatLogShotHitPatch");
  const capture = blockFrom(source, "    public class CombatLogShotCapturePatch");
  const raidStart = blockFrom(source, "    public class CombatLogRaidStartPatch");

  assert.match(local, /ReferenceEquals\(controller, gameWorld\.MainPlayer\.HandsController\)/,
    "fired capture no longer proves the controller belongs to MainPlayer");
  assert.match(observedName, /!string\.IsNullOrEmpty\(weaponId\)[\s\S]*Weapons\.TryGetValue\(weaponId/,
    "weapon-name cache performs an unsafe null-key lookup");
  assert.match(observedName, /weapon\?\.ShortName\?\.Localized\(null\) \?\? "Unknown weapon"/,
    "missing weapon snapshots have no localized or unknown fallback");
  assert.match(root, /depth\s*<\s*ProjectileParentLimit/,
    "parent traversal is not bounded");
  assert.match(root, /root\?\.Parent\s*==\s*null[\s\S]*return root/,
    "parent traversal does not reach the original projectile");
  assert.match(key, /root\.FragmentIndex/,
    "buckshot root fragment identity was removed");
  assert.match(cartridgeKey, /root\.Ammo\.Id \+ ":" \+ root\.FireIndex/);
  assert.doesNotMatch(cartridgeKey, /FragmentIndex/,
    "cartridge identity still counts each pellet separately");

  assert.match(fired, /typeof\(Player\.FirearmController\)/);
  assert.match(fired, /nameof\(Player\.FirearmController\.RegisterShot\)/);
  assert.match(fired, /Postfix\(Player\.FirearmController __instance, Item weapon, Shot shot\)/);
  assert.match(fired, /IsLocalFirearmController\(__instance\)/);
  assert.match(fired, /Shot root = RootProjectile\(shot\)/);
  assert.match(fired, /ObserveWeapon\(weapon \?\? root\.Weapon\)/,
    "first-observed weapon snapshot moved out of the firing path");
  assert.match(fired, /CountFired\(bulletId, CartridgeKey\(root\), ammoTemplateId, weaponId\)/);
  assert.doesNotMatch(fired, /CountHit\(/,
    "registration hook also counts a collision");

  assert.match(hit, /typeof\(ClientGameWorld\)/);
  assert.match(hit, /nameof\(ClientGameWorld\.ShotDelegate\)/);
  assert.match(hit, /Shot root = RootProjectile\(shotResult\)/,
    "hit capture keys a child rather than its original projectile");
  assert.match(hit, /HittedBallisticCollider is BodyPartCollider bodyPartCollider/,
    "hit capture does not use the authoritative body collider");
  assert.match(hit, /bodyPartCollider\.Player/);
  assert.match(hit, /CountHit\(bulletId\)/);
  assert.match(hit, /RaidAnalytics\.WasFired\(bulletId\)/,
    "an unregistered projectile can create an accuracy hit");
  assert.doesNotMatch(hit, /CountFired\(/,
    "collision callback still inflates the fired denominator");
  assert.doesNotMatch(hit, /GetComponentInParent/,
    "collision hot path still walks the transform hierarchy");
  assert(hit.indexOf("is BodyPartCollider bodyPartCollider") < hit.indexOf("RootProjectile(shotResult)"),
    "map collisions still perform projectile identity work");

  assert.match(capture,
    /if \(isOutgoing\)[\s\S]*ObserveWeapon\(damageInfo\.Weapon\)[\s\S]*ObservedWeaponName\(weaponId, damageInfo\.Weapon\)[\s\S]*else[\s\S]*ShortName\?\.Localized/,
    "outgoing contacts do not reuse the first-observed localized weapon name");

  assert.match(raidStart, /Postfix\(LocalGame __instance\)/);
  assert.match(raidStart, /_localProfileId = __instance\?\.Profile\?\.Id/,
    "raid start does not initialize the known local profile");
  assert(raidStart.indexOf("FlushPendingRaid()") < raidStart.indexOf("RaidAnalytics.Clear()"),
    "a pending finished raid can be cleared before it is flushed");
}
verifyPatchContract(patches);
const mutants = [
  ["bot controller accepted", source => source.replace(
    "ReferenceEquals(controller, gameWorld.MainPlayer.HandsController)", "true")],
  ["collision child keyed directly", source => source.replace(
    "Shot root = RootProjectile(shotResult);", "Shot root = shotResult;")],
  ["buckshot pellets collapsed", source => source.replace(
    'return root.Ammo.Id + ":" + root.FireIndex + ":" + root.FragmentIndex;',
    'return root.Ammo.Id + ":" + root.FireIndex;')],
  ["pellets counted as cartridges", source => source.replace(
    'return root.Ammo.Id + ":" + root.FireIndex;',
    'return root.Ammo.Id + ":" + root.FireIndex + ":" + root.FragmentIndex;')],
  ["hierarchy collider lookup restored", source => source.replace(
    "shotResult.HittedBallisticCollider is BodyPartCollider bodyPartCollider",
    "shotResult.HittedBallisticCollider != null")],
  ["local profile reset to unknown", source => source.replace(
    "_localProfileId = __instance?.Profile?.Id;", "_localProfileId = null;")],
  ["sky misses returned to collision hook", source => source.replace(
    "nameof(Player.FirearmController.RegisterShot)", "nameof(ClientGameWorld.ShotDelegate)")],
  ["unregistered collision counted", source => source.replace(
    "if (!RaidAnalytics.WasFired(bulletId)) return;", "")],
  ["outgoing weapon relocalized", source => source.replace(
    "ObservedWeaponName(weaponId, damageInfo.Weapon)",
    "damageInfo.Weapon?.ShortName?.Localized(null)")],
  ["null weapon key reaches dictionary", source => source.replace(
    "if (!string.IsNullOrEmpty(weaponId) &&", "if (true &&")],
  ["missing snapshot loses localized fallback", source => source.replace(
    'return weapon?.ShortName?.Localized(null) ?? "Unknown weapon";',
    'return "Unknown weapon";')],
];
for (const [name, mutate] of mutants) {
  const mutant = mutate(patches);
  assert.notEqual(mutant, patches, `mutation control did not modify source: ${name}`);
  assert.throws(() => verifyPatchContract(mutant), undefined,
    `shot-accounting oracle accepted mutant: ${name}`);
}

function verifyCounterContract(source) {
  const hitCounter = blockFrom(source, "    public static void CountHit");
  assert.match(hitCounter, /!WasFired\(bulletId\)/,
    "counter accepts a hit that was never registered as fired");
  assert.match(hitCounter, /!CountedHits\.Add\(bulletId\)/,
    "counter no longer deduplicates repeated root callbacks");
}

verifyCounterContract(analytics);
const counterMutant = analytics.replace("!WasFired(bulletId) || ", "");
assert.notEqual(counterMutant, analytics, "counter mutation control did not modify source");
assert.throws(() => verifyCounterContract(counterMutant), undefined,
  "counter oracle accepted an unregistered hit mutant");

const limit = patches.match(/private const int ProjectileParentLimit = \d+;/)?.[0];
assert(limit, "missing projectile parent limit");
const localHelper = blockFrom(patches, "    private static bool IsLocalFirearmController");
const observeHelper = blockFrom(patches, "    private static string ObserveWeapon");
const observedNameHelper = blockFrom(patches, "    private static string ObservedWeaponName");
const rootHelper = blockFrom(patches, "    private static Shot RootProjectile");
const keyHelper = blockFrom(patches, "    private static string ProjectileKey");
const cartridgeHelper = blockFrom(patches, "    private static string CartridgeKey");
const firedPatch = blockFrom(patches, "    public class CombatLogShotFiredPatch");
const hitPatch = blockFrom(patches, "    public class CombatLogShotHitPatch");
const scratch = mkdtempSync(path.join(tmpdir(), "combatlog-shot-accounting-"));
try {
  writeFileSync(path.join(scratch, "Test.csproj"), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><OutputType>Exe</OutputType><LangVersion>latest</LangVersion><Nullable>disable</Nullable></PropertyGroup></Project>`);
  writeFileSync(path.join(scratch, "RaidAnalytics.cs"), analytics);
  writeFileSync(path.join(scratch, "Program.cs"), `
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Comfort.Common;
using EFT;
using EFT.Ballistics;
using EFT.InventoryLogic;
using CombatLog.Analytics;
using HarmonyLib;
using SPT.Reflection.Patching;

namespace SPT.Reflection.Patching {
  public abstract class ModulePatch { protected abstract MethodBase GetTargetMethod(); }
  public class PatchPostfixAttribute : Attribute { }
}
namespace HarmonyLib {
  public static class AccessTools {
    public static MethodBase Method(Type type, string name, Type[] args = null) => null;
  }
}
namespace CombatLog.Analytics {
  public static class RaidMeta { public static bool Started = true; public static bool Finished; }
  public static class RaidPresentation { public static string RememberWeapon(Item weapon) => null; }
}
public static class Plugin { public static TestLog Log = new TestLog(); }
public class TestLog {
  public void LogError(string message) { throw new Exception(message); }
  public void LogWarning(string message) { throw new Exception(message); }
}

namespace Comfort.Common {
  public static class Singleton<T> where T : class { public static T Instance { get; set; } }
}
namespace EFT.InventoryLogic {
  public class Item {
    public string Id; public string TemplateId; public string ShortName;
    public string StringTemplateId => TemplateId;
  }
  public static class LocalizationStub {
    public static string Localized(this string value, object _) =>
      value == null ? null : "localized:" + value;
  }
}
namespace EFT.Ballistics {
  public class Shot {
    public Item Ammo; public Item Weapon; public int FragmentIndex; public int FireIndex;
    public string PlayerProfileID; public Shot Parent;
    public object HittedBallisticCollider;
  }
}
namespace EFT {
  public enum EBodyPart { Head, Chest, Stomach, LeftArm, RightArm, LeftLeg, RightLeg }
  public enum EBodyPartColliderType { None, Eyes }
  public enum EPlayerSide { Usec }
  public enum WildSpawnType { assault }
  public class Player {
    public object HandsController; public string ProfileId; public bool IsYourPlayer;
    public class FirearmController { public void RegisterShot(Item weapon, Shot shot) { } }
  }
  public class BodyPartCollider { public Player Player; }
  public class GameWorld { public Player MainPlayer; }
  public class ClientGameWorld { public void ShotDelegate(Shot shot) { } }
}

class Program {
  private static string _localProfileId;
  ${limit}
  ${localHelper}
  ${observeHelper}
  ${observedNameHelper}
  ${rootHelper}
  ${keyHelper}
  ${cartridgeHelper}
  ${firedPatch}
  ${hitPatch}

  static void Check(bool condition, string message) {
    if (!condition) throw new Exception(message);
  }

  static Shot Root(Item ammo, Item weapon, int fireIndex, int fragmentIndex, string profile = "local") =>
    new Shot { Ammo = ammo, Weapon = weapon, FireIndex = fireIndex,
      FragmentIndex = fragmentIndex, PlayerProfileID = profile };

  static void Register(Player.FirearmController controller, Item weapon, Shot shot) =>
    CombatLogShotFiredPatch.Postfix(controller, weapon, shot);

  static void Hit(Shot callback, string targetProfile = "enemy") {
    callback.HittedBallisticCollider = new BodyPartCollider {
      Player = new Player { ProfileId = targetProfile }
    };
    CombatLogShotHitPatch.Postfix(callback);
  }

  static void Main() {
    RaidAnalytics.Clear();
    var local = new Player.FirearmController();
    var bot = new Player.FirearmController();
    Singleton<GameWorld>.Instance = new GameWorld {
      MainPlayer = new Player { HandsController = local, ProfileId = "local", IsYourPlayer = true }
    };

    var namedWeapon = new Item { Id = "named", ShortName = "fallback-name" };
    RaidAnalytics.Weapons["named"] = new WeaponSample { Id = "named", Name = "cached-name" };
    Check(ObservedWeaponName("named", namedWeapon) == "cached-name",
      "known weapon did not use its first-observed name");
    Check(ObservedWeaponName(null, namedWeapon) == "localized:fallback-name",
      "null weapon key did not use the localized item fallback");
    Check(ObservedWeaponName("missing", namedWeapon) == "localized:fallback-name",
      "missing weapon sample did not use the localized item fallback");
    Check(ObservedWeaponName(null, null) == "Unknown weapon",
      "null weapon and key did not use the unknown fallback");

    var shotgun = new Item { Id = "shotgun", TemplateId = "weapon-shotgun" };
    var shell = new Item { Id = "shell-instance", TemplateId = "buckshot" };
    var pellets = Enumerable.Range(0, 8)
      .Select(index => Root(shell, shotgun, 17, index * 2)).ToArray();
    foreach (Shot pellet in pellets) Register(local, shotgun, pellet);
    Register(local, shotgun, pellets[0]);
    Hit(pellets[0]);
    Hit(pellets[0]);
    var penetration = new Shot { Ammo = shell, Weapon = shotgun, FireIndex = 17,
      FragmentIndex = pellets[0].FragmentIndex, PlayerProfileID = "local", Parent = pellets[0] };
    var deviation = new Shot { Ammo = shell, Weapon = shotgun, FireIndex = 17,
      FragmentIndex = pellets[0].FragmentIndex, PlayerProfileID = "local", Parent = penetration };
    Hit(penetration);
    Hit(penetration, "second-enemy");
    Hit(deviation);
    var fragmentA = new Shot { Ammo = shell, Weapon = shotgun, FireIndex = 17,
      FragmentIndex = pellets[1].FragmentIndex + 1, PlayerProfileID = "local", Parent = pellets[1] };
    var fragmentB = new Shot { Ammo = shell, Weapon = shotgun, FireIndex = 17,
      FragmentIndex = pellets[1].FragmentIndex + 1, PlayerProfileID = "local", Parent = pellets[1] };
    Hit(fragmentA);
    Hit(fragmentB);
    Hit(pellets[2]);

    var buckshot = RaidAnalytics.Accuracy["buckshot"];
    Check(buckshot.Fired == 8 && buckshot.Hits == 3, "buckshot expected 8/3");
    Check(buckshot.CartridgesFired == 1 && buckshot.CartridgesHit == 1,
      "eight pellets with three hits must consume one cartridge and hit once");
    Check(RaidAnalytics.WeaponAccuracy["shotgun"].Fired == 8 &&
      RaidAnalytics.WeaponAccuracy["shotgun"].Hits == 3, "weapon buckshot expected 8/3");
    Check(RaidAnalytics.WeaponAccuracy["shotgun"].CartridgesFired == 1 &&
      RaidAnalytics.WeaponAccuracy["shotgun"].CartridgesHit == 1, "weapon cartridge expected 1/1");
    Check(pellets.Select(CartridgeKey).Distinct().Count() == 1,
      "buckshot roots do not share one cartridge identity");
    Check(pellets.Select(ProjectileKey).Distinct().Count() == 8,
      "buckshot roots do not have distinct identities");
    Check(ProjectileKey(fragmentA) == ProjectileKey(pellets[1]),
      "fragment did not collapse to its root identity");
    Check(CartridgeKey(fragmentA) == CartridgeKey(pellets[1]),
      "fragment did not collapse to its cartridge identity");
    Register(local, shotgun, fragmentA);
    Check(buckshot.Fired == 8 && buckshot.CartridgesFired == 1,
      "fragment registration counted another projectile or cartridge");
    var missedPellets = Enumerable.Range(0, 8).Select(i => Root(shell, shotgun, 18, i * 2)).ToArray();
    foreach (Shot pellet in missedPellets) Register(local, shotgun, pellet);
    var thirdDischarge = Enumerable.Range(0, 8).Select(i => Root(shell, shotgun, 19, i * 2)).ToArray();
    foreach (Shot pellet in thirdDischarge) Register(local, shotgun, pellet);
    Hit(thirdDischarge[7]);
    Check(buckshot.Fired == 24 && buckshot.Hits == 4 &&
      buckshot.CartridgesFired == 3 && buckshot.CartridgesHit == 2,
      "repeated and missed discharges did not remain 24/4 projectiles and 3/2 cartridges");
    missedPellets[0].HittedBallisticCollider = new BodyPartCollider {
      Player = Singleton<GameWorld>.Instance.MainPlayer
    };
    CombatLogShotHitPatch.Postfix(missedPellets[0]);
    missedPellets[0].HittedBallisticCollider = new BodyPartCollider();
    CombatLogShotHitPatch.Postfix(missedPellets[0]);
    missedPellets[0].HittedBallisticCollider = new object();
    CombatLogShotHitPatch.Postfix(missedPellets[0]);
    Check(buckshot.CartridgesHit == 2 && buckshot.Hits == 4,
      "local or world collision became an enemy hit");
    var wrongWeapon = new Item { Id = "wrong-weapon" };
    var attributedAmmo = new Item { Id = "attributed-round", TemplateId = "attributed-ammo" };
    var attributed = Root(attributedAmmo, wrongWeapon, 30, 0);
    Register(local, shotgun, attributed);
    attributedAmmo.TemplateId = "changed-ammo";
    Hit(attributed);
    Register(local, wrongWeapon, Root(attributedAmmo, wrongWeapon, 30, 2));
    Check(!RaidAnalytics.WeaponAccuracy.ContainsKey("wrong-weapon") &&
      !RaidAnalytics.Accuracy.ContainsKey("changed-ammo"), "registration attribution drifted");
    Check(RaidAnalytics.Accuracy["attributed-ammo"].Fired == 2 &&
      RaidAnalytics.Accuracy["attributed-ammo"].Hits == 1 &&
      RaidAnalytics.Accuracy["attributed-ammo"].CartridgesFired == 1 &&
      RaidAnalytics.Accuracy["attributed-ammo"].CartridgesHit == 1,
      "attributed cartridge counters diverged");
    var rifle = new Item { Id = "rifle", TemplateId = "weapon-rifle" };
    var missAmmo = new Item { Id = "miss-instance", TemplateId = "miss-ammo" };
    Register(local, rifle, Root(missAmmo, rifle, 18, 0));
    Check(RaidAnalytics.Accuracy["miss-ammo"].Fired == 1 &&
      RaidAnalytics.Accuracy["miss-ammo"].Hits == 0, "collision-free miss expected 1/0");
    Check(RaidAnalytics.Accuracy["miss-ammo"].CartridgesFired == 1 &&
      RaidAnalytics.Accuracy["miss-ammo"].CartridgesHit == 0, "miss cartridge expected 1/0");
    var botWeapon = new Item { Id = "bot-weapon", TemplateId = "bot-weapon-template" };
    var botAmmo = new Item { Id = "bot-round", TemplateId = "bot-ammo" };
    Register(bot, botWeapon, Root(botAmmo, botWeapon, 19, 0, "bot"));
    Check(!RaidAnalytics.Accuracy.ContainsKey("bot-ammo") &&
      !RaidAnalytics.WeaponAccuracy.ContainsKey("bot-weapon"), "bot shot entered local accuracy");
    var foreignAmmo = new Item { Id = "foreign-round", TemplateId = "foreign-ammo" };
    Hit(Root(foreignAmmo, botWeapon, 20, 0));
    Check(!RaidAnalytics.Accuracy.ContainsKey("foreign-ammo"),
      "unregistered projectile created an accuracy hit");
    var foreign = Root(missAmmo, rifle, 31, 0, "bot");
    Register(local, rifle, foreign);
    Hit(foreign);
    Check(RaidAnalytics.Accuracy["miss-ammo"].Hits == 0 &&
      RaidAnalytics.Accuracy["miss-ammo"].CartridgesHit == 0, "foreign owner was accepted by hit hook");

    RaidMeta.Finished = true;
    Register(local, rifle, Root(missAmmo, rifle, 32, 0));
    Hit(missedPellets[0]);
    RaidMeta.Finished = false;
    RaidMeta.Started = false;
    Register(local, rifle, Root(missAmmo, rifle, 33, 0));
    Hit(missedPellets[0]);
    RaidMeta.Started = true;
    Check(RaidAnalytics.Accuracy["miss-ammo"].CartridgesFired == 2 &&
      buckshot.CartridgesHit == 2, "capture escaped raid lifecycle guards");
    var cycle = Root(shell, shotgun, 21, 0); cycle.Parent = cycle;
    Check(RootProjectile(cycle) == null && ProjectileKey(cycle) == null,
      "cyclic parent graph was accepted");
    Shot deep = Root(shell, shotgun, 22, 0);
    for (int index = 0; index <= ProjectileParentLimit; index++)
      deep = new Shot { Ammo = shell, Weapon = shotgun, FireIndex = 22,
        FragmentIndex = 1, PlayerProfileID = "local", Parent = deep };
    Check(RootProjectile(deep) == null, "unbounded parent graph was accepted");
    Register(local, shotgun, cycle);
    Register(local, shotgun, deep);
    Register(local, shotgun, null);
    Register(local, shotgun, Root(new Item(), shotgun, 40, 0));
    CombatLogShotHitPatch.Postfix(null);
    RaidAnalytics.CountFired(null, "valid-cartridge", "invalid-ammo", null);
    RaidAnalytics.CountFired("invalid-bullet", null, "invalid-ammo", null);
    RaidAnalytics.CountFired("", "valid-cartridge", "invalid-ammo", null);
    Check(!RaidAnalytics.Accuracy.ContainsKey("invalid-ammo"), "missing identity created counters");

    RaidAnalytics.Clear();
    Check(RaidAnalytics.Accuracy.Count == 0 && RaidAnalytics.WeaponAccuracy.Count == 0,
      "raid reset retained accuracy data");
    Hit(pellets[0]);
    Check(RaidAnalytics.Accuracy.Count == 0, "raid reset retained registered projectiles");
    foreach (Shot pellet in pellets) Register(local, shotgun, pellet);
    Hit(pellets[0]);
    var reset = RaidAnalytics.Accuracy["buckshot"];
    Check(reset.Fired == 8 && reset.Hits == 1 && reset.CartridgesFired == 1 && reset.CartridgesHit == 1,
      "raid reset retained cartridge or hit deduplication state");
    RaidAnalytics.Clear();
    RaidAnalytics.CountFired("unknown-bullet", "unknown-cartridge", null, null);
    RaidAnalytics.CountHit("unknown-bullet");
    Check(RaidAnalytics.Accuracy["unknown"].CartridgesFired == 1 &&
      RaidAnalytics.WeaponAccuracy["unknown"].CartridgesHit == 1, "missing metadata lost counters");

    Console.WriteLine("ACCOUNTING HARNESS PASSED");
  }
}
`);
  const run = spawnSync("dotnet", ["run", "--project", path.join(scratch, "Test.csproj"), "-c", "Release"], {
    encoding: "utf8", timeout: 120000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /ACCOUNTING HARNESS PASSED/);
} finally {
  const resolved = realpathSync(scratch);
  const parent = realpathSync(tmpdir());
  assert.equal(path.dirname(resolved), parent);
  assert(path.basename(resolved).startsWith("combatlog-shot-accounting-"));
  rmSync(resolved, { recursive: true });
}

console.log("COMBATLOG SHOT ACCOUNTING VERIFIED");
