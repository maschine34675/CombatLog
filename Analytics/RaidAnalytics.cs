using System.Collections.Generic;
using EFT;

namespace CombatLog.Analytics;

public struct ShotRecord
{
    public float Time;
    public EBodyPart BodyPart;
    public EBodyPartColliderType Collider;
    public float DamageBeforeArmor;
    public float DamageAfterArmor;
    public float ArmorDamage;
    public bool Penetrated;
    public bool Deflected;
    public bool Blocked;
    public string AmmoTemplateId;
    public string WeaponName;
    public string WeaponId;
    public string WeaponTemplateId;
    public float Distance;
    public string TargetProfileId;
    public string TargetName;
    public EPlayerSide TargetSide;
    public int TargetLevel;
    public WildSpawnType TargetRole;
    public string AttackerProfileId;
    public string AttackerName;
    public WildSpawnType AttackerRole;
    public bool Fatal;
    public bool FatalInferred;
    public string OpponentProfileId => TargetProfileId ?? AttackerProfileId;

    public string OpponentName => TargetName ?? AttackerName;
}

public class AmmoAccuracy
{
    public int Fired;
    public int Hits;
    public int CartridgesFired;
    public int CartridgesHit;
}

public class WeaponSample
{
    public string Id;
    public string TemplateId;
    public string Name;
    public string Image;
}

public static class RaidAnalytics
{
    public static readonly List<ShotRecord> ShotsDealt = new();
    public static readonly List<ShotRecord> ShotsReceived = new();
    public static readonly HashSet<string> KilledProfileIds = new();
    public static readonly HashSet<string> AlmostKilledIds = new();
    public static string RaidLocation = string.Empty;
    public static readonly Dictionary<string, AmmoAccuracy> Accuracy = new();
    public static readonly Dictionary<string, AmmoAccuracy> WeaponAccuracy = new();
    public static readonly Dictionary<string, WeaponSample> Weapons = new();
    public const string UnknownWeapon = "unknown";
    private sealed class CartridgeRegistration
    {
        public string AmmoTemplateId;
        public string WeaponId;
        public bool Hit;
    }

    private static readonly Dictionary<string, CartridgeRegistration> CountedFired = new();
    private static readonly Dictionary<string, CartridgeRegistration> CountedCartridges = new();
    private static readonly HashSet<string> CountedHits = new();

    public static string WeaponKey(string weaponId) =>
        string.IsNullOrEmpty(weaponId) ? UnknownWeapon : weaponId;

    public static void CountFired(string bulletId, string cartridgeId, string ammoTemplateId, string weaponId)
    {
        if (string.IsNullOrEmpty(bulletId) || string.IsNullOrEmpty(cartridgeId) || CountedFired.ContainsKey(bulletId))
            return;
        if (!CountedCartridges.TryGetValue(cartridgeId, out var cartridge))
        {
            cartridge = new CartridgeRegistration
            {
                AmmoTemplateId = string.IsNullOrEmpty(ammoTemplateId) ? "unknown" : ammoTemplateId,
                WeaponId = WeaponKey(weaponId)
            };
            CountedCartridges.Add(cartridgeId, cartridge);
            GetEntry(Accuracy, cartridge.AmmoTemplateId).CartridgesFired++;
            GetEntry(WeaponAccuracy, cartridge.WeaponId).CartridgesFired++;
        }
        CountedFired.Add(bulletId, cartridge);
        GetEntry(Accuracy, cartridge.AmmoTemplateId).Fired++;
        GetEntry(WeaponAccuracy, cartridge.WeaponId).Fired++;
    }

    internal static bool WasFired(string bulletId) =>
        !string.IsNullOrEmpty(bulletId) && CountedFired.ContainsKey(bulletId);

    public static void CountHit(string bulletId)
    {
        if (!WasFired(bulletId) || !CountedHits.Add(bulletId))
            return;
        var cartridge = CountedFired[bulletId];
        GetEntry(Accuracy, cartridge.AmmoTemplateId).Hits++;
        GetEntry(WeaponAccuracy, cartridge.WeaponId).Hits++;
        if (!cartridge.Hit)
        {
            cartridge.Hit = true;
            GetEntry(Accuracy, cartridge.AmmoTemplateId).CartridgesHit++;
            GetEntry(WeaponAccuracy, cartridge.WeaponId).CartridgesHit++;
        }
    }

    private static AmmoAccuracy GetEntry(Dictionary<string, AmmoAccuracy> table, string key)
    {
        if (!table.TryGetValue(key, out var acc))
            table[key] = acc = new AmmoAccuracy();
        return acc;
    }
    private static readonly HashSet<string> PendingFatalDealt = new();
    private static bool _pendingFatalReceived;
    private static string _pendingFatalReceivedFrom;

    public static void MarkFatalDealt(string targetProfileId)
    {
        if (!string.IsNullOrEmpty(targetProfileId))
            PendingFatalDealt.Add(targetProfileId);
    }

    public static void MarkFatalReceived(string attackerProfileId)
    {
        _pendingFatalReceived = true;
        _pendingFatalReceivedFrom = attackerProfileId;
    }
    public static void AddDealt(ShotRecord record)
    {
        if (!string.IsNullOrEmpty(record.TargetProfileId) && PendingFatalDealt.Remove(record.TargetProfileId))
            record.Fatal = true;
        ShotsDealt.Add(record);
    }
    public static void AddReceived(ShotRecord record)
    {
        if (_pendingFatalReceived &&
            (string.IsNullOrEmpty(_pendingFatalReceivedFrom) ||
             record.AttackerProfileId == _pendingFatalReceivedFrom))
        {
            record.Fatal = true;
            _pendingFatalReceived = false;
            _pendingFatalReceivedFrom = null;
        }
        ShotsReceived.Add(record);
    }
    public static void ResolvePendingFatal()
    {
        if (PendingFatalDealt.Count > 0)
        {
            foreach (string targetId in PendingFatalDealt)
            {
                for (int i = ShotsDealt.Count - 1; i >= 0; i--)
                {
                    if (ShotsDealt[i].TargetProfileId != targetId) continue;
                    var r = ShotsDealt[i];
                    r.Fatal = true;
                    r.FatalInferred = true;
                    ShotsDealt[i] = r;
                    break;
                }
            }
            PendingFatalDealt.Clear();
        }

        if (_pendingFatalReceived)
        {
            if (!string.IsNullOrEmpty(_pendingFatalReceivedFrom))
            {
                for (int i = ShotsReceived.Count - 1; i >= 0; i--)
                {
                    if (ShotsReceived[i].AttackerProfileId != _pendingFatalReceivedFrom) continue;
                    var r = ShotsReceived[i];
                    r.Fatal = true;
                    r.FatalInferred = true;
                    ShotsReceived[i] = r;
                    break;
                }
            }
            _pendingFatalReceived = false;
            _pendingFatalReceivedFrom = null;
        }
    }

    public static void Clear()
    {
        ShotsDealt.Clear();
        ShotsReceived.Clear();
        KilledProfileIds.Clear();
        AlmostKilledIds.Clear();
        Accuracy.Clear();
        WeaponAccuracy.Clear();
        Weapons.Clear();
        PendingFatalDealt.Clear();
        _pendingFatalReceived = false;
        _pendingFatalReceivedFrom = null;
        CountedFired.Clear();
        CountedCartridges.Clear();
        CountedHits.Clear();
        RaidLocation = string.Empty;
    }
}
