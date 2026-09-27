import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const source = readFileSync(path.resolve("Analytics/RaidPresentation.cs"), "utf8");
const rendererSource = readFileSync(path.resolve("Analytics/FullBodyPortraitRenderer.cs"), "utf8");
const prohibited = /(?:WebClient|HttpClient|UnityWebRequest|Camera\.main|ClearMemoryCache\s*\(|\.Changed\.(?:Bind|Unbind)|Task\.Run\s*\()/;
assert(!prohibited.test(source), "no network, shared camera/cache mutation or background Unity work");
assert(prohibited.test("Camera.main"), "negative-control matcher must detect a forbidden global camera");
for (const required of ["source.CloneVisibleItem()", "new BodyCustomization(profile.Customization)",
  "creator.RenderModel(request", "captured = renderer.Capture", "Task.FromResult(captured)", "new FullBodyPortraitRenderer()",
  "CaptureKillerCore(aggressor, killingDamage, true)", "CaptureNativeKillerEvidence(snapshot, aggressor, killingDamage, hasKillingDamage)",
  "snapshot.NativeVisualState = new PlayerVisualRepresentation(", "healthController.GetBodyPartHealth(bodyPart)",
  "Singleton<ItemIconCreator>.Instance.GetItemIcon",
  "Graphics.Blit(source, temporary", "Rect crop = sprite.textureRect", "RenderTexture.active = previous",
  "RenderTexture.ReleaseTemporary(temporary)", "UnityEngine.Object.Destroy(copy)", "InGameStatus.InRaid"])
  assert(source.includes(required), "required native wiring: " + required);
assert(!/Singleton<PlayerIconCreator>\.Instance\.GetIcon/.test(source), "full body render must bypass the shared head-portrait cache");
assert(!/Destroy\s*\(\s*(?:source|current\.Icon)/.test(source), "never destroy borrowed native icons");
for (const required of ["GetBounds(model)", "camera.orthographicSize", "FrameMargin = 1.08f",
  "Transform originalParent", "RenderTexture.ReleaseTemporary(supersampled)", "ShaderReplacer.Restore()"])
  assert(rendererSource.includes(required), "required isolated full-body capture: " + required);
assert(!/_settings\.(?:orthographicLocalPosition|orthographicSize|textureSize|isOrthographic)\s*=/.test(rendererSource),
  "CombatLog must not mutate the shared PlayerIconCreatorSettings asset");

const tempBase = realpathSync(os.tmpdir());
const temporary = mkdtempSync(path.join(tempBase, "combatlog-presentation-test-"));
const harness = String.raw`
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using CombatLog.Analytics;
using Comfort.Common;
using EFT;
using EFT.Ballistics;
using EFT.InventoryLogic;
using EFT.PlayerIcons;
using UnityEngine;

static class Test
{
    static int assertions;
    static readonly BindingFlags Flags = BindingFlags.Static | BindingFlags.NonPublic;
    static void Check(bool pass, string message) { assertions++; if (!pass) throw new Exception(message); }
    static object Field(string name) => typeof(RaidPresentation).GetField(name, Flags).GetValue(null);
    static void Set(string name, object value) => typeof(RaidPresentation).GetField(name, Flags).SetValue(null, value);
    static string State(string key) => System.Text.Json.JsonDocument.Parse(RaidPresentation.LoadImage(key)).RootElement.GetProperty("state").GetString();
    static string Key(Item weapon) => RaidPresentation.RememberWeapon(weapon);
    static Item Weapon(string id) => new Item { Id = id, TemplateId = "weapon-template", ShortName = "same name" };
    static void TickReady() { RaidPresentation.Tick(); RaidPresentation.Tick(); }
    static int PendingCount => ((IDictionary)Field("Pending")).Count;
    static string Cache(string key) => Path.Combine(BepInEx.Paths.ConfigPath, "CombatLog", "images", key + ".png");
    static void ExpireBatch() => Set("_endedAt", -1000000d);
    public static void Main(string[] args)
    {
        BepInEx.Paths.ConfigPath = Path.Combine(args[0], "config");
        Directory.CreateDirectory(BepInEx.Paths.ConfigPath);
        Singleton<ItemIconCreator>.Instance = new ItemIconCreator();
        Singleton<PlayerIconCreator>.Instance = new PlayerIconCreator();
        Check(RaidPresentation.MaxImageBytes == 256 * 1024,
            "per-image cache and transport boundary remains 256 KiB");
        RaidPresentation.Prune(Array.Empty<long>());
        const long first = 1700000000001L, second = first + 1;
        RaidPresentation.BeginRaid(first);
        var original = Weapon("a");
        string a = Key(original);
        Check(a == (first * 1000 + 1).ToString(), "stable canonical numeric key");
        Check(Key(original) == a && Item.CloneCalls == 1, "first-observed instance dedup");
        Check(Key(Weapon("b")) != a, "same names are separate instance images");
        Check(Key(Weapon(null)) == null, "unknown instance not invented");
        Check(State(a) == "pending", "immediate pending key before any render");
        RaidPresentation.Tick();
        Check(Render.Calls == 0, "no render during capture");
        RaidPresentation.EndRaid();
        InGameStatus.InRaid = true;
        RaidPresentation.Tick();
        Check(Render.Calls == 0, "native in-raid guard is independent");
        InGameStatus.InRaid = false;
        Task.Run(() => RaidPresentation.Tick()).GetAwaiter().GetResult();
        Check(Render.Calls == 0, "wrong-thread Tick cannot touch Unity");
        Render.NextSprite = Render.MakeSprite();
        RenderTexture.active = new RenderTexture();
        var previous = RenderTexture.active;
        TickReady();
        Check(State(a) == "ready", "post-raid job persisted and bridge ready");
        Check(Render.LastItem != original && Render.LastItem.Id == "a-clone", "native render receives independent cloned item");
        Check(RenderTexture.active == previous && RenderTexture.Taken == RenderTexture.Returned, "temporary RT cleanup and active restore");
        Check(UnityEngine.Object.Destroyed.All(o => !ReferenceEquals(o, Render.NextSprite.texture)), "borrowed source texture never destroyed");
        Check(Graphics.Scale.x == .5f && Graphics.Offset.x == .25f, "sprite atlas crop uses scale and offset");
        Check(ImageConversion.LastWidth == 512 && ImageConversion.LastHeight == 256,
            "item image keeps the existing 512px copy path");
        Check(RaidPresentation.LoadImage(a).Length < 350000, "bridge payload fits bounded JSON response");
        foreach (string invalid in new[] { "", "../"+a, a+".png", "C:\\x", " "+a, "+"+a, "0"+a, "١٧٠٠٠١", "9223372036854775808", (first*1000).ToString(), (first*1000+65).ToString() })
            Check(State(invalid) == "unavailable", "reject key: "+invalid);
        Check(State(null) == "unavailable", "null key rejected");
        Render.NextSprite = null;
        RaidPresentation.Tick();
        string stale = (first * 1000 + 2).ToString();
        Check(State(stale) == "pending", "active asynchronous request remains pending");
        RaidPresentation.BeginRaid(second);
        Render.LastIcon.Sprite = Render.MakeSprite();
        RaidPresentation.Tick();
        Check(State(stale) == "unavailable" && !File.Exists(Cache(stale)), "raid-change suppresses late native result");
        Check(PendingCount == 0 && Field("_active") == null, "raid change drops all managed job references");
        Check(State(a) == "ready", "previous persisted image survives next raid");
        int callsAfterCancellation = Render.Calls;
        Check(Key(Weapon("after-native-cancellation")) == null, "unsettled cancelled request trips session rendering circuit");
        RaidPresentation.EndRaid(); TickReady();
        RaidPresentation.BeginRaid(second);
        Check(Key(Weapon("another-raid")) == null && Render.Calls == callsAfterCancellation, "circuit breaker survives BeginRaid and prevents native queue growth");
        Check(CombatLog.Plugin.Log.Warnings == 1, "only one bounded native circuit warning");
        Set("_nativeBlocked", false);

        var equipment = new InventoryEquipment();
        var head = new Item { Id = "hat", ShortName = "Original helmet", TemplateId = "helmet-template",
            Armor = new ArmorComponent { ArmorClass = 4, Repairable = new RepairableComponent { Durability = 12.5f, MaxDurability = 40 } } };
        equipment.Set(EquipmentSlot.Headwear, head);
        equipment.Set(EquipmentSlot.SecuredContainer, Weapon("secret"));
        var player = new Player { ProfileId = "killer-original", Side = EPlayerSide.Bear,
            Profile = new Profile { Nickname = "Actual killer", Info = new ProfileInfo { Level = 42 },
                Inventory = new Inventory { Equipment = equipment },
                Customization = new BodyCustomization { [EBodyModelPart.Head] = "head-original" } },
            InventoryController = new InventoryController { Inventory = new Inventory { Equipment = equipment } },
            HealthController = HealthController.Create(39f, 60f, 80f) };
        var killingWeapon = new Item { Id = "fatal-rifle", TemplateId = "fatal-rifle-template", ShortName = "Fatal rifle" };
        var killingDamage = new DamageInfo { SourceId = "fatal-ammo-template", Weapon = killingWeapon,
            HasDistance = true, Distance = 42.5f };
        RaidPresentation.CaptureKiller(player, killingDamage);
        var killer = RaidPresentation.Killer;
        Check(killer.ProfileId == "killer-original" && killer.Name == "Actual killer" && killer.Level == 42 && killer.Side == "Bear", "actual aggressor identity captured");
        Check(killer.KillingAmmoTemplateId == "fatal-ammo-template" && killer.KillingWeaponName == "Fatal rifle" && killer.KillingDistance == 42.5f,
            "exact death ammo, weapon and distance captured in the shared snapshot");
        Check(killer.HasHealth && killer.RemainingHp == 273f && killer.MaxHp == 440f,
            "killer health snapshot totals all seven body parts");
        Check(killer.NativeVisualState != null && !killer.NativeVisualState.IsEmpty() &&
            !ReferenceEquals(killer.NativeVisualState.Equipment, equipment),
            "native death model uses a detached visual-state snapshot");
        Check(killer.Equipment.Count == 1 && killer.Equipment[0].Name == "Original helmet", "controller equipment, readable visible slots only");
        Check(killer.Equipment[0].ArmorClass == 4 && killer.Equipment[0].Durability == 12.5f, "armor values copied");
        string portrait = killer.PortraitImage;
        player.ProfileId = "changed"; player.Profile.Nickname = "Changed"; head.ShortName = "Changed";
        head.Armor.Repairable.Durability = 0;
        player.Profile.Customization[EBodyModelPart.Head] = "changed";
        Check(killer.ProfileId == "killer-original" && killer.Name == "Actual killer" && killer.Equipment[0].Name == "Original helmet" && killer.Equipment[0].Durability == 12.5f,
            "snapshot unaffected by live player/item mutations");
        Check(killer.NativeVisualState.Customization[EBodyModelPart.Head] == "head-original" &&
            killer.NativeVisualState.Equipment.GetSlot(EquipmentSlot.Headwear).ContainedItem.ShortName == "Original helmet",
            "native visual snapshot is unaffected by later player/item mutations");
        RaidPresentation.EndRaid(); Render.NextSprite = Render.MakeFullBodySprite();
        ImageConversion.NativePortrait = true; TickReady(); ImageConversion.NativePortrait = false;
        Check(State(portrait) == "ready" && Render.LastRequest.customization[EBodyModelPart.Head] == "head-original", "portrait uses death-time customization copy");
        Check(FullBodyPortraitRenderer.LastWidth == 360 && FullBodyPortraitRenderer.LastHeight == 480,
            "CombatLog requests a native 3:4 full-body capture");
        Check(ImageConversion.LastWidth == 180 && ImageConversion.LastHeight == 240,
            "full-body portrait is proportionally bounded only in CombatLog's copied texture");
        Check(UnityEngine.Object.Destroyed.Count(o => ReferenceEquals(o, Render.NextSprite)) == 1 &&
            UnityEngine.Object.Destroyed.Count(o => ReferenceEquals(o, Render.NextSprite.texture)) == 1,
            "cache-free full-body Sprite and Texture are released exactly once after copy");
        Check(new FileInfo(Cache(portrait)).Length <= RaidPresentation.MaxImageBytes &&
            RaidPresentation.LoadImage(portrait).Length < 400000,
            "downscaled portrait fits the bounded cache and JSON image bridge");
        Check(!ReferenceEquals(Render.LastRequest.equipment, equipment), "portrait receives cloned equipment");
        RaidPresentation.ClearKiller();
        Check(RaidPresentation.Killer == null && PendingCount == 0, "clearing killer cancels only its pending image jobs");
        RaidPresentation.Prune(Array.Empty<long>());
        Check(State(a) == "unavailable" && State(portrait) == "ready", "prune old raid, protect active report");
        string cacheDir = Path.GetDirectoryName(Cache(portrait));
        File.WriteAllText(Path.Combine(cacheDir, "README.txt"), "not owned");
        File.WriteAllText(Path.Combine(cacheDir, "anything.png"), "not owned");
        File.WriteAllText(Path.Combine(cacheDir, "123000.png"), "invalid sequence, not owned");
        RaidPresentation.Prune(new[] { second });
        Check(File.Exists(Path.Combine(cacheDir, "README.txt")) && File.Exists(Path.Combine(cacheDir, "anything.png")) && File.Exists(Path.Combine(cacheDir, "123000.png")), "only strict owned key files pruned");
        File.WriteAllBytes(Cache(portrait), new byte[RaidPresentation.MaxImageBytes + 1]);
        Check(State(portrait) == "unavailable", "oversized stored file rejected before allocation");
        File.WriteAllBytes(Cache(portrait), new byte[40]);
        Check(State(portrait) == "unavailable", "non-PNG stored file rejected");
        byte[] bomb = Render.Png(); bomb[16] = 1;
        File.WriteAllBytes(Cache(portrait), bomb);
        Check(State(portrait) == "unavailable", "oversized PNG header dimensions rejected");
        File.WriteAllBytes(Cache(portrait), Render.Png().Take(33).ToArray());
        Check(State(portrait) == "unavailable", "header-only PNG from interrupted write rejected");
        File.WriteAllBytes(Cache(portrait), Render.Png().Take(Render.Png().Length - 1).ToArray());
        Check(State(portrait) == "unavailable", "truncated final PNG chunk rejected");
        byte[] oversizedChunk = Render.Png(); oversizedChunk[33] = 127;
        File.WriteAllBytes(Cache(portrait), oversizedChunk);
        Check(State(portrait) == "unavailable", "invalid PNG chunk length rejected without overflow");

        string foreign = Path.Combine(args[0], "foreign.png");
        File.WriteAllBytes(foreign, Render.Png());
        string linkedKey = (second * 1000 + 63).ToString();
        File.CreateSymbolicLink(Cache(linkedKey), foreign);
        Check(State(linkedKey) == "unavailable", "file symlink cannot expose an external PNG");
        RaidPresentation.Prune(Array.Empty<long>());
        Check(File.Exists(foreign), "retention never deletes through a symlink");
        string originalConfig = BepInEx.Paths.ConfigPath;
        string outsideConfig = Path.Combine(args[0], "outside-config"); Directory.CreateDirectory(outsideConfig);
        string linkedConfig = Path.Combine(args[0], "linked-config"); Directory.CreateSymbolicLink(linkedConfig, outsideConfig);
        BepInEx.Paths.ConfigPath = linkedConfig;
        Check(State(portrait) == "unavailable", "linked cache ancestor refused");
        RaidPresentation.Prune(Array.Empty<long>());
        Check(Directory.GetFileSystemEntries(outsideConfig).Length == 0, "no creation or pruning through linked cache ancestor");
        BepInEx.Paths.ConfigPath = originalConfig;

        RaidPresentation.BeginRaid(second + 1);
        Render.NextSprite = null;
        string timeout = Key(Weapon("timeout"));
        string behindTimeout = Key(Weapon("behind-timeout"));
        RaidPresentation.EndRaid(); RaidPresentation.Tick();
        var active = Field("_active"); active.GetType().GetField("Started").SetValue(active, -1000000d);
        RaidPresentation.Tick();
        Check(State(timeout) == "unavailable" && Field("_active") == null, "one native request has a finite timeout");
        Check(State(behindTimeout) == "unavailable" && PendingCount == 0, "timeout does not stack more native work behind a stuck creator");
        int callsAfterTimeout = Render.Calls;
        RaidPresentation.BeginRaid(second + 2);
        Check(Key(Weapon("after-timeout")) == null, "timeout circuit survives a following raid");
        RaidPresentation.EndRaid(); TickReady();
        Check(Render.Calls == callsAfterTimeout, "timed-out native request cannot accumulate cross-raid work");
        Set("_nativeBlocked", false);
        RaidPresentation.BeginRaid(second + 2);
        string batch = Key(Weapon("batch")); RaidPresentation.EndRaid(); ExpireBatch(); RaidPresentation.Tick();
        Check(State(batch) == "unavailable" && PendingCount == 0, "entire queue has a finite wall-time budget");
        RaidPresentation.BeginRaid(second + 3);
        Singleton<ItemIconCreator>.Instance = null;
        string missing = Key(Weapon("missing")); RaidPresentation.EndRaid(); TickReady();
        Check(State(missing) == "unavailable", "missing vanilla singleton has readable fallback state");
        Singleton<ItemIconCreator>.Instance = new ItemIconCreator();
        RaidPresentation.BeginRaid(second + 4);
        Item.FailClone = true;
        int before = Item.CloneCalls;
        Check(Key(Weapon("broken")) == null && Key(Weapon("broken")) == null && Item.CloneCalls == before + 1, "failed clone attempted only once per weapon instance");
        Item.FailClone = false;
        var cycle = new ContainerCollection { Id = "cycle" };
        cycle.Containers.Add(new SimpleContainer { Values = new List<Item> { cycle } });
        Check(Key(cycle) == null, "cyclic inventory fails bounded preflight without cloning");
        var deep = new ContainerCollection { Id = "deep" }; var cursor = deep;
        for (int i=0;i<30;i++) { var child = new ContainerCollection(); cursor.Containers.Add(new SimpleContainer { Values = new List<Item> { child } }); cursor=child; }
        Check(Key(deep) == null, "deep pathological inventory rejected");
        for (int i=0;i<100;i++) Key(Weapon("limit"+i));
        Check(PendingCount <= 32 && ((IDictionary)Field("WeaponKeys")).Count <= 32, "weapon capture and clone queue are bounded");
        for (int i=0;i<80;i++) RaidPresentation.CaptureKiller(player);
        Check((int)Field("_sequence") <= 64 && PendingCount <= 64, "total per-raid key and image-work bound includes repeated deaths");
        Check(RaidPresentation.Killer != null && RaidPresentation.Killer.Equipment[0].Image == null, "exhausted image budget preserves readable death snapshot");
        RaidPresentation.BeginRaid(second + 5); Render.NextSprite = Render.MakeSprite();
        string badEncode = Key(Weapon("bad-encode")); RaidPresentation.EndRaid();
        ImageConversion.Throw = true; TickReady(); ImageConversion.Throw = false;
        Check(State(badEncode) == "unavailable" && RenderTexture.active == previous && RenderTexture.Taken == RenderTexture.Returned, "failed encoding restores temporary GPU state");
        RaidPresentation.BeginRaid(second + 6);
        string huge = Key(Weapon("huge")); RaidPresentation.EndRaid();
        ImageConversion.Huge = true; TickReady(); ImageConversion.Huge = false;
        Check(State(huge) == "unavailable" && !File.Exists(Cache(huge)), "oversized encoded PNG never written");
        RaidPresentation.BeginRaid(second + 7);
        string full = Key(Weapon("full")); RaidPresentation.EndRaid();
        Set("_cacheBytes", 64L * 1024 * 1024); TickReady();
        Check(State(full) == "unavailable" && !File.Exists(Cache(full)), "cache byte limit fails safely");
        RaidPresentation.BeginRaid(second + 8);
        File.WriteAllBytes(Cache(portrait), Render.Png());
        string afterFailedPrune = Key(Weapon("failed-prune")); RaidPresentation.EndRaid();
        using (var heldFile = new FileStream(Cache(portrait), FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            RaidPresentation.Prune(Array.Empty<long>());
            Check((long)Field("_cacheBytes") >= 64L * 1024 * 1024 && (int)Field("_cacheFiles") >= 3200,
                "interrupted locked-file prune cannot publish undercounted quota");
            Check(State(portrait) == "ready", "failed pruning does not disable reading existing images");
            TickReady();
            Check(State(afterFailedPrune) == "unavailable" && !File.Exists(Cache(afterFailedPrune)), "failed prune refuses new quota-unaccounted writes");
        }
        RaidPresentation.Prune(Array.Empty<long>());
        Check((long)Field("_cacheBytes") == 0 && (int)Field("_cacheFiles") == 0, "successful recount recovers write quota after failed prune");
        RaidPresentation.BeginRaid(second + 20);
        Render.PortraitGate = new TaskCompletionSource<bool>();
        Render.NextSprite = Render.MakeFullBodySprite();
        RaidPresentation.CaptureKiller(player);
        string latePortrait = RaidPresentation.Killer.PortraitImage;
        RaidPresentation.EndRaid(); RaidPresentation.Tick();
        Check(State(latePortrait) == "pending", "delayed full-body render is pending after submission");
        var lateSprite = Render.NextSprite;
        RaidPresentation.BeginRaid(second + 21);
        Check((bool)Field("_nativeBlocked") && Field("_retiredPortrait") != null,
            "cancelled native full-body work trips the sticky circuit and occupies one drain slot");
        Render.PortraitGate.SetResult(true);
        RaidPresentation.Tick();
        Check(Field("_retiredPortrait") == null && State(latePortrait) == "unavailable",
            "late result is drained without reviving the cancelled raid image");
        Check(UnityEngine.Object.Destroyed.Count(o => ReferenceEquals(o, lateSprite)) == 1 &&
            UnityEngine.Object.Destroyed.Count(o => ReferenceEquals(o, lateSprite.texture)) == 1,
            "late owned portrait Sprite and Texture are released exactly once");
        Render.PortraitGate = null;
        Set("_nativeBlocked", false);

        RaidPresentation.BeginRaid(second + 30);
        Render.FaultAfterPortraitFactory = true;
        Render.NextSprite = Render.MakeFullBodySprite();
        RaidPresentation.CaptureKiller(player);
        string faultedPortrait = RaidPresentation.Killer.PortraitImage;
        var faultedSprite = Render.NextSprite;
        RaidPresentation.EndRaid(); TickReady(); RaidPresentation.Tick();
        Check(State(faultedPortrait) == "unavailable" && (bool)Field("_nativeBlocked"),
            "native fault after the factory fails closed and trips the rendering circuit");
        Check(UnityEngine.Object.Destroyed.Count(o => ReferenceEquals(o, faultedSprite)) == 1 &&
            UnityEngine.Object.Destroyed.Count(o => ReferenceEquals(o, faultedSprite.texture)) == 1,
            "factory-owned Sprite is released even when native post-capture cleanup faults");
        Render.FaultAfterPortraitFactory = false;
        Set("_nativeBlocked", false);

        RaidPresentation.BeginRaid(second + 9);
        string disposed = Key(Weapon("disposed"));
        RaidPresentation.Dispose(); RaidPresentation.EndRaid(); TickReady();
        Check(PendingCount == 0 && State(disposed) == "unavailable" && RaidPresentation.Killer == null, "dispose cancels all state");
        Check(Key(Weapon("after-dispose")) == null, "disposed service cannot restart capture");
        Console.WriteLine("HARNESS ASSERTIONS " + assertions);
    }
}

namespace BepInEx { public static class Paths { public static string ConfigPath; } }
namespace CombatLog { public static class Plugin { public static TestLog Log=new(); } public class TestLog { public int Warnings; public void LogWarning(string s)=>Warnings++; } }
namespace Comfort.Common { public static class Singleton<T> where T:class { public static T Instance; public static bool Instantiated => Instance != null; } }
public struct IntVec2 { public int X,Y; public IntVec2(int x,int y) { X=x;Y=y; } }
public class ItemIcon { public Sprite Sprite; }
public class PlayerIconRequest
{
    public InventoryEquipment equipment; public BodyCustomization customization;
    public PlayerIconRequest(InventoryEquipment e, BodyCustomization c) { equipment=e;customization=c; }
}
public class ItemIconCreator
{
    public ItemIcon GetItemIcon(Item item, in IntVec2 size) { Render.Calls++;Render.LastItem=item;return Render.LastIcon = new ItemIcon { Sprite = Render.NextSprite }; }
}
static class Render
{
    public static int Calls; public static Sprite NextSprite; public static Item LastItem; public static ItemIcon LastIcon; public static PlayerIconRequest LastRequest;
    public static TaskCompletionSource<bool> PortraitGate; public static bool FaultAfterPortraitFactory;
    public static Sprite MakeSprite() => new Sprite { texture = new Texture2D(1024,512,TextureFormat.RGBA32,false),textureRect = new Rect(256,0,512,256) };
    public static Sprite MakeFullBodySprite() => new Sprite { texture = new Texture2D(360,480,TextureFormat.RGBA32,false),textureRect = new Rect(0,0,360,480) };
    public static byte[] Png() => Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6TxkAAAAASUVORK5CYII=");
}
namespace EFT.PlayerIcons
{
    public struct RenderModelResult { public Sprite sprite; }
    public class PlayerIconCreator
    {
        public delegate Task<Sprite> SpriteFactory(GameObject model, object pivot);
        public async Task<RenderModelResult> RenderModel(PlayerIconRequest request, SpriteFactory factory)
        {
            Render.Calls++; Render.LastRequest=request;
            if(Render.PortraitGate!=null) await Render.PortraitGate.Task;
            Sprite sprite=await factory(new GameObject(),null);
            if(Render.FaultAfterPortraitFactory) throw new Exception("native cleanup failed");
            return new RenderModelResult { sprite=sprite };
        }
    }
}
namespace CombatLog.Analytics
{
    public static class DistanceHelper
    {
        public static bool TryGetDistance(DamageInfo info,out float distance)
        { distance=info.Distance;return info.HasDistance; }
    }
    internal sealed class FullBodyPortraitRenderer:IDisposable
    {
        public static int LastWidth,LastHeight,Disposes;
        public Task<bool> PrepareAsync()=>Task.FromResult(true);
        public Sprite Capture(GameObject model,IntVec2 size) { LastWidth=size.X;LastHeight=size.Y;return Render.NextSprite; }
        public void Dispose()=>Disposes++;
    }
}
namespace EFT
{
    public enum EPlayerSide { Usec, Bear, Savage }
    public enum EBodyModelPart { Head, Body }
    public enum EBodyPart { Head, Chest, Stomach, LeftArm, RightArm, LeftLeg, RightLeg }
    public class BodyCustomization:Dictionary<EBodyModelPart,string>
    { public BodyCustomization() {} public BodyCustomization(Dictionary<EBodyModelPart,string> source):base(source) {} }
    public interface IPlayer { string ProfileId{get;} Profile Profile{get;} EPlayerSide Side{get;} InventoryController InventoryController{get;} }
    public class Player:IPlayer { public string ProfileId{get;set;} public Profile Profile{get;set;} public EPlayerSide Side{get;set;} public InventoryController InventoryController{get;set;} public HealthController HealthController{get;set;} }
    public class Profile
    {
        public string Nickname; public ProfileInfo Info;public Inventory Inventory;public BodyCustomization Customization;
        public PlayerVisualRepresentation GetVisualEquipmentState(bool includeWeapons)
        {
            var source=Inventory?.Equipment;
            if(source==null)return null;
            var copy=source.CloneVisibleItem();
            return new PlayerVisualRepresentation(Info,new BodyCustomization(Customization),copy);
        }
    }
    public class ProfileInfo { public int Level; }
    public readonly struct BodyPartHealth
    {
        public readonly float Current,Maximum;
        public BodyPartHealth(float current,float maximum){Current=current;Maximum=maximum;}
    }
    public class HealthController
    {
        readonly Dictionary<EBodyPart,BodyPartHealth> parts=new();
        public BodyPartHealth GetBodyPartHealth(EBodyPart part)=>parts[part];
        public static HealthController Create(float current,float regularMaximum,float chestMaximum)
        {
            var result=new HealthController();
            foreach(EBodyPart part in Enum.GetValues(typeof(EBodyPart)))
                result.parts[part]=new BodyPartHealth(current,part==EBodyPart.Chest?chestMaximum:regularMaximum);
            return result;
        }
    }
    public class PlayerVisualRepresentation
    {
        public ProfileInfo Info; public BodyCustomization Customization; public InventoryEquipment Equipment;
        public PlayerVisualRepresentation(ProfileInfo info,BodyCustomization customization,InventoryEquipment equipment)
        {Info=info;Customization=customization;Equipment=equipment;}
        public bool IsEmpty()=>Equipment==null;
    }
    public static class InGameStatus { public static bool InRaid; }
    public static class Localization { public static string Localized(this string s) => s; public static string Localized(this string s,object args) => s; }
}
namespace EFT.Ballistics
{
    public struct DamageInfo
    {
        public string SourceId; public Item Weapon; public bool HasDistance; public float Distance;
    }
}
namespace EFT.InventoryLogic
{
    public enum EquipmentSlot { Headwear,FaceCover,Eyewear,Earpiece,ArmBand,ArmorVest,TacticalVest,Backpack,FirstPrimaryWeapon,SecondPrimaryWeapon,Holster,Scabbard,SecuredContainer }
    public class Inventory { public InventoryEquipment Equipment; }
    public class InventoryController { public Inventory Inventory; }
    public interface IContainer { IEnumerable<Item> Items{get;} }
    public class SimpleContainer:IContainer { public List<Item> Values=new(); public IEnumerable<Item> Items=>Values; }
    public class Slot:IContainer { public Item ContainedItem;public IEnumerable<Item> Items=>ContainedItem==null?Array.Empty<Item>():new[]{ContainedItem}; }
    public class Item
    {
        public static int CloneCalls;public static bool FailClone;public string Id,ShortName,TemplateId;public bool HideEntrails;public ArmorComponent Armor;
        public T GetItemComponent<T>() where T:class => Armor as T;
        public IntVec2 CalculateCellSize()=>new IntVec2(2,1);
        public virtual Item Clone() => new Item { Id=Id+"-clone",ShortName=ShortName,TemplateId=TemplateId,HideEntrails=HideEntrails };
    }
    public class ContainerCollection:Item { public List<IContainer> Containers=new(); }
    public class InventoryEquipment:ContainerCollection
    {
        public Dictionary<EquipmentSlot,Slot> Slots=new();
        public Slot GetSlot(EquipmentSlot s)=>Slots.TryGetValue(s,out var slot)?slot:null;
        public void Set(EquipmentSlot s,Item item) { var slot=new Slot { ContainedItem=item };Slots[s]=slot;Containers.Add(slot); }
        public override Item Clone() { var clone=new InventoryEquipment();foreach(var pair in Slots) clone.Set(pair.Key,pair.Value.ContainedItem.Clone());return clone; }
    }
    public class ArmorComponent { public int ArmorClass;public RepairableComponent Repairable; }
    public class RepairableComponent { public float Durability,MaxDurability; }
    public static class ItemExtensions
    { public static T CloneVisibleItem<T>(this T item) where T:Item { Item.CloneCalls++;if(Item.FailClone) throw new Exception("clone failed");return (T)item.Clone(); } }
}
namespace UnityEngine
{
    public class Object { public static readonly List<Object> Destroyed=new(); public static void Destroy(Object o)=>Destroyed.Add(o); }
    public class GameObject:Object { }
    public struct Vector2 { public float x,y;public Vector2(float a,float b) { x=a;y=b; } }
    public struct Rect { public float x,y,width,height;public float xMax=>x+width;public float yMax=>y+height;public Rect(float a,float b,float c,float d) {x=a;y=b;width=c;height=d;} }
    public enum SpritePackingRotation { None,Any }
    public class Sprite:Object { public Texture2D texture;public Rect textureRect;public bool packed;public SpritePackingRotation packingRotation; }
    public enum TextureFormat { RGBA32 }
    public enum RenderTextureFormat { ARGB32 }
    public class Texture2D:Object { public int width,height;public Texture2D(int w,int h,TextureFormat f,bool m){width=w;height=h;}public void ReadPixels(Rect r,int x,int y,bool m){}public void Apply(bool a,bool b){} }
    public class RenderTexture:Object { public static RenderTexture active;public static int Taken,Returned;public static RenderTexture GetTemporary(int w,int h,int d,RenderTextureFormat f){Taken++;return new RenderTexture();}public static void ReleaseTemporary(RenderTexture r)=>Returned++; }
    public static class Graphics {public static Vector2 Scale,Offset;public static void Blit(Texture2D source,RenderTexture target,Vector2 scale,Vector2 offset){Scale=scale;Offset=offset;} }
    public static class ImageConversion
    {
        public static bool Throw,Huge,NativePortrait; public static int LastWidth,LastHeight;
        public static byte[] EncodeToPNG(Texture2D t)
        {
            LastWidth=t.width; LastHeight=t.height;
            if(Throw)throw new Exception("encode failure");
            if(NativePortrait && (t.width>240 || t.height>240)) return new byte[320*1024];
            return Huge?new byte[CombatLog.Analytics.RaidPresentation.MaxImageBytes+1]:Render.Png();
        }
    }
}
`;
try {
  writeFileSync(path.join(temporary, "RaidPresentation.cs"), source);
  writeFileSync(path.join(temporary, "Program.cs"), harness);
  writeFileSync(path.join(temporary, "Harness.csproj"), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><LangVersion>latest</LangVersion><Nullable>disable</Nullable><EnableNETAnalyzers>false</EnableNETAnalyzers></PropertyGroup></Project>');
  const result = spawnSync("dotnet", ["run", "--project", path.join(temporary, "Harness.csproj"), "--configuration", "Release", "--", temporary], {
    encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 90000,
    env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" }
  });
  assert.equal(result.status, 0, String(result.stdout || "") + String(result.stderr || "") + String(result.error || ""));
  assert.match(result.stdout, /HARNESS ASSERTIONS \d+/);
  console.log(result.stdout.trim());
  console.log("COMBATLOG PRESENTATION VERIFIED");
} finally {
  const actual = realpathSync(temporary);
  assert.equal(path.dirname(actual).toLowerCase(), tempBase.toLowerCase());
  assert(path.basename(actual).startsWith("combatlog-presentation-test-"));
  rmSync(actual, { recursive: true, force: true });
}
