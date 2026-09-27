using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using CombatLog.Analytics;
using Diz.Binding;
using EFT;
using EFT.InventoryLogic;
using EFT.UI.SessionEnd;
using HarmonyLib;
using SPT.Reflection.Patching;
using TMPro;

namespace CombatLog.PostRaidScreens.KillList;
public static class CombatLogKillListPatches
{
    private const int MaxSyntheticRows = 64;
    private const int MaxProfileIdLength = 256;
    private const int MaxNameLength = 128;
    private const int MaxWeaponLength = 256;
    private const int MaxLocationLength = 128;
    private const int MaxAmmoNameLength = 128;
    private static readonly ConditionalWeakTable<VictimStats, CombatLogSyntheticVictimInfo>
        SyntheticVictims = new();

    public static void Enable()
    {
        new CombatLogKillListShowPatch().Enable();
        new CombatLogKillListVictimShowPatch().Enable();
    }

    public sealed class CombatLogKillListShowPatch : ModulePatch
    {
        protected override MethodBase GetTargetMethod() =>
            AccessTools.Method(
                typeof(SessionResultKillList),
                nameof(SessionResultKillList.Show),
                new[] { typeof(UpdatableBindableList<VictimStats>), typeof(DogtagComponent[]) });

        [PatchPrefix]
        public static void Prefix(ref UpdatableBindableList<VictimStats> victims)
        {
            try
            {
                if (PostRaidScreensFeature.KillListAmmoEnabled)
                    PostRaidScreenState.BindKillAmmo(victims);

                if (!PostRaidScreensFeature.DamagedTargetsEnabled)
                    return;
                var uiVictims = victims == null
                    ? new UpdatableBindableList<VictimStats>()
                    : new UpdatableBindableList<VictimStats>(victims);
                RemovePriorSyntheticVictims(uiVictims);
                victims = uiVictims;

                AppendSyntheticVictims(uiVictims);
            }
            catch (Exception ex)
            {
                Plugin.Log?.LogWarning("post-raid damaged-target rows were unavailable: " + ex.Message);
            }
        }
    }

    public sealed class CombatLogKillListVictimShowPatch : ModulePatch
    {
        protected override MethodBase GetTargetMethod() =>
            AccessTools.Method(
                typeof(KillListVictim),
                nameof(KillListVictim.Show),
                new[] { typeof(VictimStats), typeof(bool), typeof(int) });

        [PatchPostfix]
        public static void Postfix(
            VictimStats victim,
            bool knownName,
            TextMeshProUGUI ____status,
            TextMeshProUGUI ____name,
            TextMeshProUGUI ____level)
        {
            try
            {
                if (victim == null)
                    return;

                if (SyntheticVictims.TryGetValue(victim, out var synthetic))
                {
                    StyleSyntheticVictim(synthetic, ____status, ____name, ____level);
                    return;
                }
                if (!knownName && victim.Side != EPlayerSide.Savage)
                    return;

                if (!PostRaidScreensFeature.KillListAmmoEnabled || ____status == null ||
                    !PostRaidScreenState.TryGetKillAmmo(victim, out string ammoTemplateId))
                    return;

                string ammoName = AmmoDisplayName(ammoTemplateId);
                if (ammoName.Length == 0)
                    return;

                AppendAmmo(____status, EscapeRichText(ammoName));
            }
            catch (Exception ex)
            {
                Plugin.Log?.LogWarning("post-raid kill-list detail was unavailable: " + ex.Message);
            }
        }
    }

    private static void RemovePriorSyntheticVictims(UpdatableBindableList<VictimStats> uiVictims)
    {
        for (int index = uiVictims.Count - 1; index >= 0; index--)
        {
            VictimStats candidate = uiVictims[index];
            if (candidate != null && SyntheticVictims.TryGetValue(candidate, out _))
                uiVictims.RemoveAt(index);
        }
    }

    private static void AppendSyntheticVictims(UpdatableBindableList<VictimStats> uiVictims)
    {
        var originalVictimIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (VictimStats victim in uiVictims)
        {
            string id = StableProfileId(victim?.ProfileId);
            if (id != null)
                originalVictimIds.Add(id);
        }

        var killedProfileIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (string killedId in RaidAnalytics.KilledProfileIds)
        {
            string id = StableProfileId(killedId);
            if (id != null)
                killedProfileIds.Add(id);
        }

        var groups = new Dictionary<string, CombatLogTargetDamage>(StringComparer.Ordinal);
        foreach (ShotRecord shot in RaidAnalytics.ShotsDealt)
        {
            string id = StableProfileId(shot.TargetProfileId);
            if (id == null || originalVictimIds.Contains(id) || killedProfileIds.Contains(id))
                continue;

            if (!groups.TryGetValue(id, out var target))
            {
                target = new CombatLogTargetDamage(id, shot);
                groups.Add(id, target);
            }
            target.Observe(shot);
        }

        foreach (CombatLogTargetDamage target in groups.Values
            .Where(candidate => candidate.TotalDamage > 0d)
            .OrderByDescending(candidate => candidate.TotalDamage)
            .ThenBy(candidate => candidate.ProfileId, StringComparer.Ordinal)
            .Take(MaxSyntheticRows))
        {
            string name = BoundedDisplay(target.Name, "Unknown target", MaxNameLength);
            string weapon = BoundedDisplay(target.Weapon, "Unknown weapon", MaxWeaponLength);
            string location = BoundedDisplay(RaidMeta.Location, string.Empty, MaxLocationLength);
            float distance = target.AverageDistance;

            var synthetic = new VictimStats
            {
                AccountId = string.Empty,
                ProfileId = target.ProfileId,
                Name = name,
                Side = target.Side,
                Time = TimeSpan.Zero,
                Level = target.Level > 0 ? target.Level : 0,
                BodyPart = EBodyPart.Chest,
                Weapon = weapon,
                Distance = distance,
                Role = target.Role,
                Location = location
            };

            SyntheticVictims.Add(synthetic, new CombatLogSyntheticVictimInfo(
                name,
                synthetic.Level,
                target.TotalDamage,
                target.HitCount,
                target.ArmorPenetrations));
            uiVictims.Add(synthetic);
        }
    }

    private static void StyleSyntheticVictim(
        CombatLogSyntheticVictimInfo synthetic,
        TextMeshProUGUI status,
        TextMeshProUGUI name,
        TextMeshProUGUI level)
    {
        if (name != null)
            name.text = EscapeRichText(synthetic.Name);
        if (level != null)
            level.text = synthetic.Level > 0
                ? synthetic.Level.ToString(CultureInfo.InvariantCulture)
                : "--";
        if (status != null)
        {
            string penetration = synthetic.ArmorPenetrations > 0
                ? ", " + synthetic.ArmorPenetrations.ToString(CultureInfo.InvariantCulture) + " pen"
                : string.Empty;
            string hitLabel = synthetic.HitCount == 1 ? " hit" : " hits";
            status.text = "<b>Damaged</b> (" +
                synthetic.TotalDamage.ToString("F0", CultureInfo.InvariantCulture) + " dmg, " +
                synthetic.HitCount.ToString(CultureInfo.InvariantCulture) + hitLabel +
                penetration + ")";
        }
    }

    private static void AppendAmmo(TextMeshProUGUI status, string ammoName)
    {
        string current = status.text ?? string.Empty;
        string parenthesizedSuffix = ", " + ammoName + ")";
        string fallbackSuffix = " (" + ammoName + ")";
        if (current.EndsWith(parenthesizedSuffix, StringComparison.Ordinal) ||
            current.EndsWith(fallbackSuffix, StringComparison.Ordinal))
            return;

        status.text = current.EndsWith(")", StringComparison.Ordinal)
            ? current.Substring(0, current.Length - 1) + parenthesizedSuffix
            : current + fallbackSuffix;
    }

    private static string StableProfileId(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return null;
        string trimmed = value.Trim();
        return trimmed.Length <= MaxProfileIdLength ? trimmed : null;
    }

    private static string BoundedDisplay(string value, string fallback, int maxLength)
    {
        string display = string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
        if (display == null)
            return string.Empty;
        return display.Length <= maxLength ? display : display.Substring(0, maxLength);
    }

    private static string AmmoDisplayName(string ammoTemplateId)
    {
        string fallback = BoundedDisplay(ammoTemplateId, string.Empty, MaxAmmoNameLength);
        if (fallback.Length == 0)
            return string.Empty;

        try
        {
            return BoundedDisplay(
                AmmoLocale.GetAmmoShortName(ammoTemplateId),
                fallback,
                MaxAmmoNameLength);
        }
        catch (Exception)
        {
            return fallback;
        }
    }

    private static string EscapeRichText(string value) =>
        (value ?? string.Empty).Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");

    private sealed class CombatLogSyntheticVictimInfo
    {
        public readonly string Name;
        public readonly int Level;
        public readonly double TotalDamage;
        public readonly int HitCount;
        public readonly int ArmorPenetrations;

        public CombatLogSyntheticVictimInfo(
            string name,
            int level,
            double totalDamage,
            int hitCount,
            int armorPenetrations)
        {
            Name = name;
            Level = level;
            TotalDamage = totalDamage;
            HitCount = hitCount;
            ArmorPenetrations = armorPenetrations;
        }
    }

    private sealed class CombatLogTargetDamage
    {
        private double _distanceTotal;
        private int _distanceCount;

        public readonly string ProfileId;
        public readonly EPlayerSide Side;
        public readonly int Level;
        public readonly WildSpawnType Role;
        public string Name;
        public string Weapon;
        public double TotalDamage;
        public int HitCount;
        public int ArmorPenetrations;

        public CombatLogTargetDamage(string profileId, ShotRecord first)
        {
            ProfileId = profileId;
            Side = first.TargetSide;
            Level = first.TargetLevel;
            Role = first.TargetRole;
        }

        public void Observe(ShotRecord shot)
        {
            if (HitCount < int.MaxValue)
                HitCount++;

            if (!float.IsNaN(shot.DamageAfterArmor) && !float.IsInfinity(shot.DamageAfterArmor))
                TotalDamage += shot.DamageAfterArmor;

            if (shot.Penetrated && !shot.Blocked && !shot.Deflected &&
                !float.IsNaN(shot.ArmorDamage) && !float.IsInfinity(shot.ArmorDamage) &&
                shot.ArmorDamage > 0f && ArmorPenetrations < int.MaxValue)
                ArmorPenetrations++;

            if (!float.IsNaN(shot.Distance) && !float.IsInfinity(shot.Distance) && shot.Distance > 0f)
            {
                _distanceTotal += shot.Distance;
                if (_distanceCount < int.MaxValue)
                    _distanceCount++;
            }

            if (string.IsNullOrWhiteSpace(Name) && !string.IsNullOrWhiteSpace(shot.TargetName))
                Name = shot.TargetName;
            if (string.IsNullOrWhiteSpace(Weapon) && !string.IsNullOrWhiteSpace(shot.WeaponName))
                Weapon = shot.WeaponName;
        }

        public float AverageDistance
        {
            get
            {
                if (_distanceCount == 0 || _distanceTotal <= 0d)
                    return 0f;
                double average = _distanceTotal / _distanceCount;
                return average >= float.MaxValue ? float.MaxValue : (float)average;
            }
        }
    }
}
