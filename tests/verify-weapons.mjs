import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const panel = readFileSync("UI/CombatLogPanel.cs", "utf8");
const analytics = readFileSync("Analytics/RaidAnalytics.cs", "utf8");
const history = readFileSync("Analytics/RaidHistory.cs", "utf8");
const patches = readFileSync("Analytics/CombatLogShotPatches.cs", "utf8");
const methodStart = panel.indexOf("    private static void AppendAmmo(");
const methodEnd = panel.indexOf("    // The one question a dead player has:", methodStart);
const armorHelperStart = panel.indexOf("    private static float ArmorPrevented(");
const armorHelperEnd = panel.indexOf("    private static string BuildStatsJson(", armorHelperStart);
const statsEnd = panel.indexOf("    // Did this loadout work?", armorHelperEnd);
const helpersStart = panel.indexOf("    private static StringBuilder Num(");
const liveStart = panel.indexOf("    private static string ComposeLivePayload(");
const liveEnd = panel.indexOf("    // One summary line per raid,", liveStart);
const indexStart = panel.indexOf("    private static string BuildIndexLine(");
const indexEnd = panel.indexOf("    // DamageInfo.Penetrated", indexStart);
assert(armorHelperStart >= 0 && armorHelperEnd > armorHelperStart && statsEnd > armorHelperEnd &&
  methodStart >= 0 && methodEnd > methodStart && helpersStart > methodEnd &&
  liveStart >= 0 && liveEnd > liveStart && indexStart >= liveEnd && indexEnd > indexStart);
const armorHelper = panel.slice(armorHelperStart, armorHelperEnd);
const statsMethod = panel.slice(armorHelperEnd, statsEnd);
const method = panel.slice(methodStart, methodEnd);
const liveMethod = panel.slice(liveStart, liveEnd);
const indexMethod = panel.slice(indexStart, indexEnd);
const helpers = panel.slice(helpersStart, panel.lastIndexOf("\n}"));
const scratch = mkdtempSync(path.join(tmpdir(), "combatlog-weapons-"));
try {
  writeFileSync(path.join(scratch, "Test.csproj"), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><OutputType>Exe</OutputType><LangVersion>latest</LangVersion><Nullable>disable</Nullable></PropertyGroup></Project>`);
  writeFileSync(path.join(scratch, "RaidAnalytics.cs"), analytics);
  writeFileSync(path.join(scratch, "RaidHistory.cs"), history);
  writeFileSync(path.join(scratch, "Program.cs"), `
using System;
using System.Linq;
using System.IO;
using System.Text;
using System.Globalization;
using System.Collections.Generic;
using System.Text.Json;
using EFT;
using CombatLog.Analytics;
namespace EFT {
  public enum EBodyPart { Head, Chest, Stomach, LeftArm, RightArm, LeftLeg, RightLeg }
  public enum EBodyPartColliderType { None, Eyes }
  public enum EPlayerSide { Usec }
  public enum WildSpawnType { assault }
}
namespace BepInEx {
  public static class Paths { public static string ConfigPath => Path.Combine(AppContext.BaseDirectory, "test-config"); }
}
namespace CombatLog {
  public static class Plugin { public static Logger Log = new Logger(); }
  public sealed class Logger { public void LogError(string message) { throw new Exception(message); } }
}
namespace CombatLog.Analytics {
  public static class RaidPresentation { public static void Prune(List<long> timestamps) {} }
  public static class RaidMeta {
    public static string LocationName = "Test location";
    public static string ExitLabel = "Survived";
    public static float Duration = 600.9f;
    public static bool Started = true;
    public static bool Finished = true;
    public static float StartTime = 100;
  }
  public static class AmmoLocale {
    public static string GetAmmoShortName(string templateId) => templateId;
  }
  public static class TargetClass { public static string Of(EFT.WildSpawnType role) => "Scav"; }
  public static class RaidFindings { public static List<Finding> Build() => new List<Finding>(); }
  public class Finding { public string Title; public string Detail; public bool Negative; }
  public static class RaidEngagements { public static List<Engagement> Build() => new List<Engagement>(); }
  public class Engagement {
    public float StartTime, Duration, DamageDealt, DamageReceived;
    public int Kills, KillLinks;
    public List<ShotRecord> Dealt = new List<ShotRecord>();
    public List<ShotRecord> Received = new List<ShotRecord>();
    public List<KeyValuePair<string, string>> Opponents = new List<KeyValuePair<string, string>>();
  }
  public static class AmmoPrice {
    public static bool TryGetUnitPrice(string templateId, out float unit) { unit = 2.5f; return templateId != "no-price"; }
  }
}
class Program {
  static void Check(bool ok, string why) { if (!ok) throw new Exception(why); }
  static void Main() {
    CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("de-DE");
    RaidAnalytics.Clear();
    string escapedName = "Weapon " + (char)34 + "quote" + (char)34 + (char)92 + (char)10 + (char)9 + (char)1 + " <&>";
    RaidAnalytics.Weapons.Add("gun-a", new WeaponSample { Id="gun-a", TemplateId="tpl-a", Name="Same weapon", Image="1770000000000001" });
    RaidAnalytics.Weapons.Add("gun-b", new WeaponSample { Id="gun-b", TemplateId="tpl-b", Name="Same weapon" });
    for (int i = 0; i < 8; i++) {
      RaidAnalytics.CountFired("pellet-a-" + i, "cartridge-a", "ammo-a", "gun-a");
      RaidAnalytics.CountFired("pellet-b-" + i, "cartridge-b", "ammo-a", "gun-a");
      if (i < 3) RaidAnalytics.CountHit("pellet-a-" + i);
    }
    RaidAnalytics.CountFired("pellet-a-0", "cartridge-a", "ammo-a", "gun-a");
    RaidAnalytics.CountHit("pellet-a-0");
    RaidAnalytics.CountFired("bullet-c", "cartridge-c", "ammo-b", "gun-b");
    RaidAnalytics.CountFired("bullet-d", "cartridge-d", "ammo-b", "gun-b");
    RaidAnalytics.CountFired(null, "cartridge-d", "ammo-b", "gun-b");
    RaidAnalytics.CountHit("");
    Check(RaidAnalytics.WeaponAccuracy["gun-a"].Fired == 16 && RaidAnalytics.WeaponAccuracy["gun-a"].Hits == 3, "projectile deduplication");
    Check(RaidAnalytics.WeaponAccuracy["gun-a"].CartridgesFired == 2 && RaidAnalytics.WeaponAccuracy["gun-a"].CartridgesHit == 1, "weapon cartridge deduplication");
    Check(RaidAnalytics.WeaponAccuracy["gun-b"].Fired == 2 && RaidAnalytics.WeaponAccuracy["gun-b"].Hits == 0, "same-name miss-only weapon");
    Check(RaidAnalytics.Accuracy.Values.Sum(a=>a.Fired)==18 && RaidAnalytics.Accuracy.Values.Sum(a=>a.Hits)==3, "ammo counters regressed");
    RaidAnalytics.AddDealt(new ShotRecord { WeaponId="gun-a", AmmoTemplateId="ammo-a", WeaponName="Same weapon", DamageBeforeArmor=15.5f, DamageAfterArmor=12.5f, ArmorDamage=3, Fatal=true });
    RaidAnalytics.AddDealt(new ShotRecord { WeaponId="gun-a", AmmoTemplateId="ammo-a", WeaponName="Same weapon", DamageBeforeArmor=24, DamageAfterArmor=22, ArmorDamage=2, Fatal=true, FatalInferred=true });
    RaidAnalytics.AddDealt(new ShotRecord { WeaponId="gun-a", AmmoTemplateId="ammo-a", WeaponName="Same weapon", DamageAfterArmor=0 });
    RaidAnalytics.AddDealt(new ShotRecord { WeaponId="gun-a", AmmoTemplateId="ammo-a", WeaponName="Same weapon", DamageAfterArmor=0 });
    RaidAnalytics.AddDealt(new ShotRecord { WeaponId="gun-c", AmmoTemplateId="contact-only", WeaponName=escapedName, WeaponTemplateId="tpl-c", DamageAfterArmor=8 });
    RaidAnalytics.AddDealt(new ShotRecord { WeaponName="Unknown source", DamageAfterArmor=1 });
    string json = Render();
    using (var doc = JsonDocument.Parse(json)) {
      var rows=doc.RootElement.GetProperty("weapons").EnumerateArray().ToArray();
      Check(rows.Length==4, "weapon union dropped misses or unknown identity");
      var a=rows.Single(r=>r.GetProperty("id").GetString()=="gun-a");
      var b=rows.Single(r=>r.GetProperty("id").GetString()=="gun-b");
      var c=rows.Single(r=>r.GetProperty("id").GetString()=="gun-c");
      Check(a.GetProperty("hits").GetInt32()==4 && a.GetProperty("shotsHit").GetInt32()==3, "contacts confused with projectile hits");
      Check(a.GetProperty("cartridgesFired").GetInt32()==2 && a.GetProperty("cartridgesHit").GetInt32()==1, "weapon cartridge payload changed");
      Check(a.GetProperty("damage").GetDouble()==34.5 && a.GetProperty("armorDamage").GetDouble()==5, "damage aggregation or invariant JSON");
      Check(a.GetProperty("kills").GetInt32()==1 && a.GetProperty("killLinks").GetInt32()==1, "inferred link counted as direct kill");
      Check(a.GetProperty("image").GetString()=="1770000000000001", "representative icon reference");
      Check(a.GetProperty("name").GetString()==b.GetProperty("name").GetString(), "same-name fixture no longer tests distinct identities");
      Check(c.GetProperty("name").GetString()==escapedName, "weapon names must round-trip quotes and control characters");
      Check(b.GetProperty("fired").GetInt32()==2 && b.GetProperty("shotsHit").GetInt32()==0 && b.GetProperty("hits").GetInt32()==0, "miss-only payload row");
      Check(b.GetProperty("cartridgesFired").GetInt32()==2 && b.GetProperty("cartridgesHit").GetInt32()==0, "miss-only weapon cartridge row");
      Check(!c.TryGetProperty("fired", out _) && !c.TryGetProperty("shotsHit", out _), "contact-only row invented accuracy");
      Check(!c.TryGetProperty("cartridgesFired", out _) && !c.TryGetProperty("cartridgesHit", out _), "contact-only weapon invented cartridges");
      Check(c.GetProperty("templateId").GetString()=="tpl-c", "fallback metadata");
      Check(rows.Any(r=>r.GetProperty("id").GetString()=="unknown"), "unknown identity lost");
      var report = doc.RootElement;
      Check(report.GetProperty("shotsFired").GetInt32()==18 && report.GetProperty("shotsHit").GetInt32()==3, "top-level projectile counts changed");
      Check(report.GetProperty("cartridgesFired").GetInt32()==4 && report.GetProperty("cartridgesHit").GetInt32()==1, "top-level cartridge counts changed");
      Check(report.GetProperty("ammoCost").GetDouble()==10 && report.GetProperty("costBasis").GetString()=="cartridge", "report cost used pellets instead of cartridges");
      foreach (string field in new[] { "ammo", "loadout" }) {
        var ammoRows = report.GetProperty(field).EnumerateArray().ToArray();
        Check(ammoRows.Length == 4, field + " union lost miss-only or contact-only ammo");
        var hitAmmo = ammoRows.Single(r=>r.GetProperty("id").GetString()=="ammo-a");
        var missAmmo = ammoRows.Single(r=>r.GetProperty("id").GetString()=="ammo-b");
        var contactAmmo = ammoRows.Single(r=>r.GetProperty("id").GetString()=="contact-only");
        Check(hitAmmo.GetProperty("fired").GetInt32()==16 && hitAmmo.GetProperty("shotsHit").GetInt32()==3 && hitAmmo.GetProperty("hits").GetInt32()==4, field + " projectile/contact evidence changed");
        Check(hitAmmo.GetProperty("cartridgesFired").GetInt32()==2 && hitAmmo.GetProperty("cartridgesHit").GetInt32()==1, field + " cartridge counters changed");
        Check(missAmmo.GetProperty("fired").GetInt32()==2 && missAmmo.GetProperty("shotsHit").GetInt32()==0 && missAmmo.GetProperty("hits").GetInt32()==0, field + " miss-only projectile row");
        Check(missAmmo.GetProperty("cartridgesFired").GetInt32()==2 && missAmmo.GetProperty("cartridgesHit").GetInt32()==0, field + " miss-only cartridge row");
        Check(!contactAmmo.TryGetProperty("fired", out _) && !contactAmmo.TryGetProperty("shotsHit", out _) && !contactAmmo.TryGetProperty("cartridgesFired", out _) && !contactAmmo.TryGetProperty("cartridgesHit", out _), field + " invented contact-only accuracy");
        if (field == "loadout") {
          Check(hitAmmo.GetProperty("cost").GetDouble()==5 && missAmmo.GetProperty("cost").GetDouble()==5, "loadout cost used pellets or dropped misses");
          Check(hitAmmo.GetProperty("costBasis").GetString()=="cartridge" && missAmmo.GetProperty("costBasis").GetString()=="cartridge", "loadout cost units unknown");
          Check(!contactAmmo.TryGetProperty("costBasis", out _), "unregistered ammo invented known cost");
          Check(missAmmo.GetProperty("classes").GetArrayLength()==0, "miss-only loadout invented targets");
        }
      }
    }
    const long timestamp = 1770000000000L;
    string indexLine = BuildIndexLine(timestamp);
    using(var index = JsonDocument.Parse(indexLine))
    using(var report = JsonDocument.Parse(json)) {
      var summary = index.RootElement;
      Check(summary.GetProperty("weapons").GetRawText()==report.RootElement.GetProperty("weapons").GetRawText(), "index/report weapon summaries differ");
      Check(summary.GetProperty("ts").GetInt64()==timestamp, "index timestamp truncated");
      Check(summary.GetProperty("duration").GetInt32()==600, "index duration changed");
      Check(summary.GetProperty("shotsFired").GetInt32()==18 && summary.GetProperty("shotsHit").GetInt32()==3, "index accuracy changed");
      Check(summary.GetProperty("cartridgesFired").GetInt32()==4 && summary.GetProperty("cartridgesHit").GetInt32()==1, "index cartridge counts changed");
      Check(summary.GetProperty("ammoCost").GetDouble()==10 && summary.GetProperty("costBasis").GetString()=="cartridge", "index ammo cost used pellets");
      Check(!summary.TryGetProperty("history", out _) && !summary.TryGetProperty("historyDetailLimit", out _) && !summary.TryGetProperty("historyDetailIds", out _), "index recursively included history");
      Check(!report.RootElement.TryGetProperty("history", out _) && !report.RootElement.TryGetProperty("historyDetailLimit", out _) && !report.RootElement.TryGetProperty("historyDetailIds", out _), "stored report included live history metadata");
    }
    RaidHistory.Initialize();
    Check(RaidHistory.Save(timestamp, json, indexLine), "could not save test raid");
    Check(RaidHistory.Save(timestamp, json, indexLine), "could not retry test raid");
    Check(RaidHistory.LoadRaid(timestamp.ToString(CultureInfo.InvariantCulture))==json, "saved detail positive control failed");
    using(var live = JsonDocument.Parse(ComposeLivePayload(json))) {
      Check(live.RootElement.GetProperty("historyDetailLimit").GetInt32()==RaidHistory.MaxStoredRaids, "live retention limit differs from store");
      Check(live.RootElement.GetProperty("history").GetArrayLength()==1, "retry duplicated index summary");
      Check(live.RootElement.GetProperty("weapons").GetRawText()==live.RootElement.GetProperty("history")[0].GetProperty("weapons").GetRawText(), "live history lost weapons");
    }
    Check(ComposeLivePayload(null)==null && ComposeLivePayload("")=="" && ComposeLivePayload("invalid")=="invalid", "invalid live payload guard changed");
    RaidAnalytics.Clear();
    Check(RaidAnalytics.Weapons.Count==0 && RaidAnalytics.WeaponAccuracy.Count==0, "raid reset leaks previous weapons");
    RaidAnalytics.CountFired("pellet-a-0", "cartridge-a", "ammo-a", "gun-a");
    Check(RaidAnalytics.WeaponAccuracy["gun-a"].Fired==1, "raid reset retained dedup IDs");
    RaidAnalytics.Clear();
    foreach(string emptyJson in new[] { Render(), BuildIndexLine(timestamp+1) })
    using(var empty=JsonDocument.Parse(emptyJson)) {
      Check(empty.RootElement.GetProperty("weapons").GetArrayLength()==0, "empty raid/index stale weapons");
      Check(empty.RootElement.GetProperty("shotsFired").GetInt32()==0 && empty.RootElement.GetProperty("shotsHit").GetInt32()==0, "empty projectile totals unknown");
      Check(empty.RootElement.GetProperty("cartridgesFired").GetInt32()==0 && empty.RootElement.GetProperty("cartridgesHit").GetInt32()==0, "empty cartridge totals unknown");
      Check(empty.RootElement.GetProperty("ammoCost").GetDouble()==0 && empty.RootElement.GetProperty("costBasis").GetString()=="cartridge", "empty cartridge cost unknown");
    }
    for(int i=1; i<=RaidHistory.MaxStoredRaids; i++)
      Check(RaidHistory.Save(timestamp+i, Render(), BuildIndexLine(timestamp+i)), "could not save retention test raid");
    Check(RaidHistory.LoadRaid(timestamp.ToString(CultureInfo.InvariantCulture))==null, "old detail file not pruned");
    Check(RaidHistory.LoadRaid((timestamp+RaidHistory.MaxStoredRaids).ToString(CultureInfo.InvariantCulture))==Render(), "retained detail positive control failed");
    string[] indexOnDisk = File.ReadAllLines(Path.Combine(BepInEx.Paths.ConfigPath, "CombatLog", "raids", "index.jsonl"));
    Check(indexOnDisk.Length==RaidHistory.MaxStoredRaids+1 && indexOnDisk[0]==indexLine, "durable index lost weapon stats after pruning");
    string retainedIndex = "[" + RaidHistory.IndexAsJsonArrayBody() + "]";
    using(var all = JsonDocument.Parse(retainedIndex)) {
      Check(all.RootElement.GetArrayLength()==RaidHistory.MaxStoredRaids+1, "summary retention was capped with detail files");
      Check(all.RootElement[0].GetRawText()==indexLine, "pruning or reset changed saved weapon stats");
    }
    RaidAnalytics.AddDealt(new ShotRecord { WeaponId="non-finite", DamageBeforeArmor=float.PositiveInfinity, DamageAfterArmor=float.NaN });
    using(var finite=JsonDocument.Parse(BuildIndexLine(timestamp+100))) {
      var row=finite.RootElement.GetProperty("weapons")[0];
      Check(row.GetProperty("damage").GetDouble()==0 && row.GetProperty("armorDamage").GetDouble()==0, "weapon index emitted non-finite JSON");
    }
    RaidAnalytics.Clear();
    RaidAnalytics.CountFired("unpriced-pellet", "unpriced-cartridge", "no-price", "unpriced-weapon");
    using(var unpriced=JsonDocument.Parse(Render())) {
      Check(unpriced.RootElement.GetProperty("cartridgesFired").GetInt32()==1, "unpriced ammo lost consumption");
      Check(unpriced.RootElement.GetProperty("ammoCost").GetDouble()==0 && unpriced.RootElement.GetProperty("loadout")[0].GetProperty("cost").GetDouble()==0, "missing handbook price emitted invalid cost");
    }
    Console.WriteLine("WEAPON COUNTERS AND SERIALIZER VERIFIED");
    Console.WriteLine("DURABLE WEAPON HISTORY VERIFIED");
  }
  static string Render() => BuildStatsJson(1770000000000L, false);
  static void AppendDeathReport(StringBuilder sb, List<ShotRecord> received) { }
  static void AppendKiller(StringBuilder sb) { }
  static void AppendHits(StringBuilder sb, List<ShotRecord> shots, bool dealt, float raidStart, ref bool first) { }
 ${armorHelper}
 ${statsMethod}
 ${method}
 ${liveMethod}
 ${indexMethod}
${helpers}
}
`);
  const run = spawnSync("dotnet", ["run", "--project", path.join(scratch, "Test.csproj"), "-c", "Release"], {
    encoding: "utf8", timeout: 120000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /WEAPON COUNTERS AND SERIALIZER VERIFIED/);
  assert.match(run.stdout, /DURABLE WEAPON HISTORY VERIFIED/);
} finally {
  const resolved = realpathSync(scratch);
  const parent = realpathSync(tmpdir());
  assert.equal(path.dirname(resolved), parent);
  assert(path.basename(resolved).startsWith("combatlog-weapons-"));
  rmSync(resolved, { recursive: true });
}

assert.match(patches, /CountFired\(bulletId, CartridgeKey\(root\), ammoTemplateId, weaponId\)/);
assert.match(patches, /CountHit\(bulletId\)/);
assert.match(patches, /weaponId = ObserveWeapon\(damageInfo\.Weapon\)/);
assert.match(patches, /weaponName = ObservedWeaponName\(weaponId, damageInfo\.Weapon\)/);
assert.match(patches, /WeaponId = weaponId/);
assert.match(patches, /WeaponName = weaponName/);
assert.match(patches, /RaidAnalytics\.Weapons\.Add\(key, sample\)[\s\S]*RaidPresentation\.RememberWeapon\(weapon\)/);
assert.match(patches, /CombatLogDeathResetPatch/);
assert.match(patches, /CaptureKiller\(aggressor, damageInfo\)/);
assert.match(panel, /Str\(sb, "weaponId", s\.WeaponId/);
assert.match(panel, /RaidPresentation\.Tick\(\)[\s\S]*if \(!_open\)/);
assert.match(panel, /RaidPresentation\.EndRaid\(\);[\s\S]*RaidHistory\.Save/);
assert.match(panel, /RaidMeta\.Exit != ExitStatus\.Killed/);
assert.match(panel, /if \(includeHistory\)\s*\{\s*Num\(sb, "historyDetailLimit", RaidHistory\.MaxStoredRaids\)/);
assert.match(readFileSync("UI/WebOverlayGate.cs", "utf8"), /OnRequest\("loadImage", onLoadImage\)/);
assert.match(readFileSync("Analytics/RaidHistory.cs", "utf8"), /RaidPresentation\.Prune/);
console.log("COMBATLOG WEAPONS VERIFIED");
