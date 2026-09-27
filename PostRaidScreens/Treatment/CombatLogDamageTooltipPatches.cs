using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.CompilerServices;
using CombatLog.Analytics;
using EFT;
using EFT.Ballistics;
using HarmonyLib;
using SPT.Reflection.Patching;

namespace CombatLog.PostRaidScreens.Treatment;
public static class CombatLogDamageTooltipPatches
{
    private const int MaxWeaponKeyLength = 256;
    private static readonly ConditionalWeakTable<DamageStats, DamageTooltipMetadata> Metadata = new();
    private static readonly object MetadataSync = new();

    public static void Enable()
    {
        new CombatLogDamageMetadataCapturePatch().Enable();
        new CombatLogLethalDamageMetadataCapturePatch().Enable();
        new CombatLogDamageMetadataClonePatch().Enable();
        new CombatLogDamageMetadataAddPatch().Enable();
        new CombatLogDamageTooltipTextPatch().Enable();
    }

    private sealed class DamageTooltipMetadata
    {
        public readonly string WeaponKey;
        public readonly bool WeaponConflict;
        public readonly bool HasDistance;
        public readonly float MinimumDistance;
        public readonly float MaximumDistance;

        private DamageTooltipMetadata(string weaponKey, bool weaponConflict,
            bool hasDistance, float minimumDistance, float maximumDistance)
        {
            WeaponKey = weaponKey;
            WeaponConflict = weaponConflict;
            HasDistance = hasDistance;
            MinimumDistance = minimumDistance;
            MaximumDistance = maximumDistance;
        }

        public static DamageTooltipMetadata FromHit(string weaponKey, bool hasDistance, float distance)
        {
            if (string.IsNullOrWhiteSpace(weaponKey))
                weaponKey = null;
            else
            {
                weaponKey = weaponKey.Trim();
                if (weaponKey.Length > MaxWeaponKeyLength)
                    weaponKey = null;
            }
            hasDistance = hasDistance && !float.IsNaN(distance) && !float.IsInfinity(distance) && distance >= 0f;
            if (weaponKey == null && !hasDistance)
                return null;

            return new DamageTooltipMetadata(weaponKey, false, hasDistance,
                hasDistance ? distance : 0f, hasDistance ? distance : 0f);
        }

        public static DamageTooltipMetadata Merge(DamageTooltipMetadata left, DamageTooltipMetadata right)
        {
            if (left == null)
                return right;
            if (right == null)
                return left;

            bool weaponConflict = left.WeaponConflict || right.WeaponConflict;
            string weaponKey = null;
            if (!weaponConflict)
            {
                if (string.IsNullOrEmpty(left.WeaponKey))
                    weaponKey = right.WeaponKey;
                else if (string.IsNullOrEmpty(right.WeaponKey))
                    weaponKey = left.WeaponKey;
                else if (string.Equals(left.WeaponKey, right.WeaponKey, StringComparison.Ordinal))
                    weaponKey = left.WeaponKey;
                else
                    weaponConflict = true;
            }

            bool hasDistance = left.HasDistance || right.HasDistance;
            float minimumDistance = 0f;
            float maximumDistance = 0f;
            if (left.HasDistance && right.HasDistance)
            {
                minimumDistance = Math.Min(left.MinimumDistance, right.MinimumDistance);
                maximumDistance = Math.Max(left.MaximumDistance, right.MaximumDistance);
            }
            else if (left.HasDistance)
            {
                minimumDistance = left.MinimumDistance;
                maximumDistance = left.MaximumDistance;
            }
            else if (right.HasDistance)
            {
                minimumDistance = right.MinimumDistance;
                maximumDistance = right.MaximumDistance;
            }

            return new DamageTooltipMetadata(weaponKey, weaponConflict, hasDistance,
                minimumDistance, maximumDistance);
        }
    }

    private static bool TryGetMetadata(DamageStats damage, out DamageTooltipMetadata metadata)
    {
        metadata = null;
        if (damage == null)
            return false;

        lock (MetadataSync)
            return Metadata.TryGetValue(damage, out metadata);
    }

    private static void SetMetadata(DamageStats damage, DamageTooltipMetadata metadata)
    {
        if (damage == null || metadata == null)
            return;

        lock (MetadataSync)
        {
            Metadata.Remove(damage);
            Metadata.Add(damage, metadata);
        }
    }

    private static void MergeMetadata(DamageStats damage, DamageTooltipMetadata incoming)
    {
        if (damage == null || incoming == null)
            return;

        lock (MetadataSync)
        {
            Metadata.TryGetValue(damage, out DamageTooltipMetadata current);
            DamageTooltipMetadata merged = DamageTooltipMetadata.Merge(current, incoming);
            Metadata.Remove(damage);
            Metadata.Add(damage, merged);
        }
    }

    private static string FormatDistance(DamageTooltipMetadata metadata)
    {
        if (metadata == null || !metadata.HasDistance)
            return null;

        string minimum = metadata.MinimumDistance.ToString("0.#");
        string maximum = metadata.MaximumDistance.ToString("0.#");
        string value = string.Equals(minimum, maximum, StringComparison.Ordinal)
            ? minimum
            : minimum + "–" + maximum;
        return value + "UI/ProfileStats/Meters".Localized(null);
    }

    private static void Warn(string operation, Exception exception)
    {
        try
        {
            Plugin.Log?.LogWarning($"Post-raid treatment {operation} failed: {exception}");
        }
        catch
        {
        }
    }

    public sealed class CombatLogDamageMetadataCapturePatch : ModulePatch
    {
        protected override MethodBase GetTargetMethod() =>
            AccessTools.Method(typeof(HealthStatisticsManager), nameof(HealthStatisticsManager.LogDamage),
                new[] { typeof(EBodyPart), typeof(float), typeof(DamageInfo) });

        [PatchPostfix]
        public static void Postfix(HealthStatisticsManager __instance, EBodyPart bodyPart, DamageInfo damageInfo)
        {
            try
            {
                DamageHistory history = __instance?.DamageHistory;
                if (history == null || history.BodyParts == null ||
                    !history.BodyParts.TryGetValue(bodyPart, out List<DamageStats> list) ||
                    list == null || list.Count == 0)
                    return;
                DamageStats actualEntry = list[list.Count - 1];
                if (actualEntry == null)
                    return;

                string weaponKey = damageInfo.Weapon?.ShortName;
                bool hasDistance = DistanceHelper.TryGetDistance(damageInfo, out float distance);
                MergeMetadata(actualEntry, DamageTooltipMetadata.FromHit(weaponKey, hasDistance, distance));
            }
            catch (Exception ex)
            {
                Warn("capture", ex);
            }
        }
    }

    public sealed class CombatLogLethalDamageMetadataCapturePatch : ModulePatch
    {
        protected override MethodBase GetTargetMethod() =>
            AccessTools.Method(typeof(HealthStatisticsManager), nameof(HealthStatisticsManager.OnApplyDamage),
                new[] { typeof(EBodyPart), typeof(float), typeof(DamageInfo) });

        [PatchPostfix]
        public static void Postfix(DamageStats ____lastDamage, DamageInfo damageInfo)
        {
            try
            {
                if (____lastDamage == null)
                    return;

                string weaponKey = damageInfo.Weapon?.ShortName;
                bool hasDistance = DistanceHelper.TryGetDistance(damageInfo, out float distance);
                MergeMetadata(____lastDamage,
                    DamageTooltipMetadata.FromHit(weaponKey, hasDistance, distance));
            }
            catch (Exception ex)
            {
                Warn("lethal capture", ex);
            }
        }
    }

    public sealed class CombatLogDamageMetadataClonePatch : ModulePatch
    {
        protected override MethodBase GetTargetMethod() =>
            AccessTools.Method(typeof(DamageStats), nameof(DamageStats.Clone), Type.EmptyTypes);

        [PatchPostfix]
        public static void Postfix(DamageStats __instance, DamageStats __result)
        {
            try
            {
                if (__result != null && TryGetMetadata(__instance, out DamageTooltipMetadata metadata))
                    SetMetadata(__result, metadata);
            }
            catch (Exception ex)
            {
                Warn("clone", ex);
            }
        }
    }

    public sealed class CombatLogDamageMetadataAddPatch : ModulePatch
    {
        protected override MethodBase GetTargetMethod() =>
            AccessTools.Method(typeof(DamageStats), nameof(DamageStats.Add), new[] { typeof(DamageStats) });

        [PatchPostfix]
        public static void Postfix(DamageStats __instance, DamageStats damage)
        {
            try
            {
                if (__instance != null && TryGetMetadata(damage, out DamageTooltipMetadata incoming))
                    MergeMetadata(__instance, incoming);
            }
            catch (Exception ex)
            {
                Warn("group merge", ex);
            }
        }
    }

    public sealed class CombatLogDamageTooltipTextPatch : ModulePatch
    {
        protected override MethodBase GetTargetMethod() =>
            AccessTools.Method(typeof(DamageStats), nameof(DamageStats.ToString), Type.EmptyTypes);

        [PatchPostfix]
        public static void Postfix(DamageStats __instance, ref string __result)
        {
            try
            {
                if (!PostRaidScreensFeature.DamageTooltipsEnabled || __instance == null || __result == null ||
                    !TryGetMetadata(__instance, out DamageTooltipMetadata metadata))
                    return;

                string weapon = metadata.WeaponConflict || string.IsNullOrEmpty(metadata.WeaponKey)
                    ? null
                    : metadata.WeaponKey.Localized(null);
                string distance = FormatDistance(metadata);
                string extra = string.IsNullOrEmpty(weapon)
                    ? distance
                    : string.IsNullOrEmpty(distance) ? weapon : weapon + ", " + distance;
                if (!string.IsNullOrEmpty(extra))
                    __result += " <b>(" + extra + ")</b>";
            }
            catch (Exception ex)
            {
                Warn("display", ex);
            }
        }
    }
}
