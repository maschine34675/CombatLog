using System.Reflection;
using Comfort.Common;
using EFT;
using EFT.Ballistics;
using EFT.InventoryLogic;
using HarmonyLib;
using CombatLog.PostRaidScreens;
using SPT.Reflection.Patching;

namespace CombatLog.Analytics;
public static class CombatLogShotPatches
{
    private static string _localProfileId;

    public static void Enable()
    {
        new CombatLogShotCapturePatch().Enable();
        new CombatLogShotFiredPatch().Enable();
        new CombatLogShotHitPatch().Enable();
        new CombatLogKillPatch().Enable();
        new CombatLogDeathResetPatch().Enable();
        new CombatLogRaidStartPatch().Enable();
        new CombatLogRaidEndPatch().Enable();
    }
    private static string ObserveWeapon(Item weapon)
    {
        string key = RaidAnalytics.WeaponKey(weapon?.Id);
        if (!RaidAnalytics.Weapons.ContainsKey(key))
        {
            var sample = new WeaponSample
            {
                Id = key,
                TemplateId = weapon?.StringTemplateId ?? string.Empty,
                Name = weapon?.ShortName?.Localized(null) ?? "Unknown weapon"
            };
            RaidAnalytics.Weapons.Add(key, sample);
            try { sample.Image = RaidPresentation.RememberWeapon(weapon); }
            catch (System.Exception ex) { Plugin.Log.LogWarning($"Weapon image unavailable: {ex.Message}"); }
        }
        return key;
    }

    private static string ObservedWeaponName(string weaponId, Item weapon)
    {
        if (!string.IsNullOrEmpty(weaponId) &&
            RaidAnalytics.Weapons.TryGetValue(weaponId, out var observedWeapon) &&
            !string.IsNullOrEmpty(observedWeapon?.Name))
            return observedWeapon.Name;
        return weapon?.ShortName?.Localized(null) ?? "Unknown weapon";
    }

    private const int ProjectileParentLimit = 64;

    private static bool IsLocalFirearmController(Player.FirearmController controller)
    {
        var gameWorld = Singleton<GameWorld>.Instance;
        return gameWorld?.MainPlayer != null &&
            ReferenceEquals(controller, gameWorld.MainPlayer.HandsController);
    }
    private static Shot RootProjectile(Shot shot)
    {
        Shot root = shot;
        for (int depth = 0; depth < ProjectileParentLimit; depth++)
        {
            if (root?.Parent == null)
                return root;
            root = root.Parent;
        }
        return null;
    }
    private static string ProjectileKey(Shot shot)
    {
        Shot root = RootProjectile(shot);
        if (string.IsNullOrEmpty(root?.Ammo?.Id))
            return null;
        return root.Ammo.Id + ":" + root.FireIndex + ":" + root.FragmentIndex;
    }
    private static string CartridgeKey(Shot shot)
    {
        Shot root = RootProjectile(shot);
        if (string.IsNullOrEmpty(root?.Ammo?.Id))
            return null;
        return root.Ammo.Id + ":" + root.FireIndex;
    }
    public class CombatLogDeathResetPatch : ModulePatch
    {
        protected override MethodBase GetTargetMethod() =>
            AccessTools.Method(typeof(Player), nameof(Player.OnDead));

        [PatchPrefix]
        public static void Prefix(Player __instance, bool ___AggressorFound)
        {
            if (__instance.IsYourPlayer && !___AggressorFound && RaidMeta.Started && !RaidMeta.Finished)
                RaidPresentation.ClearKiller();
        }
    }
    public class CombatLogKillPatch : ModulePatch
    {
        protected override MethodBase GetTargetMethod()
        {
            return AccessTools.Method(typeof(Player), nameof(Player.OnBeenKilledByAggressor));
        }

        [PatchPrefix]
        public static void Prefix(Player __instance, IPlayer aggressor, bool ___AggressorFound, out bool __state)
        {
            __state = RaidMeta.Started && !RaidMeta.Finished && !___AggressorFound &&
                aggressor != null && aggressor.ProfileId != __instance.ProfileId;
        }

        [PatchPostfix]
        public static void Postfix(Player __instance, IPlayer aggressor, DamageInfo damageInfo, bool __state)
        {
            try
            {
                if (!__state) return;
                if (_localProfileId == null)
                {
                    var gw = Singleton<GameWorld>.Instance;
                    if (gw?.MainPlayer != null)
                        _localProfileId = gw.MainPlayer.ProfileId;
                }

                if (__instance.IsYourPlayer)
                {
                    RaidAnalytics.MarkFatalReceived(aggressor?.ProfileId);
                    if (aggressor != null && aggressor.ProfileId != __instance.ProfileId)
                        RaidPresentation.CaptureKiller(aggressor, damageInfo);
                    return;
                }

                if (_localProfileId == null || aggressor?.ProfileId != _localProfileId)
                    return;

                RaidAnalytics.KilledProfileIds.Add(__instance.ProfileId);
                RaidAnalytics.MarkFatalDealt(__instance.ProfileId);
                PostRaidScreenState.RecordKill(__instance.ProfileId, damageInfo.SourceId);
            }
            catch (System.Exception ex)
            {
                Plugin.Log.LogError($"Kill capture failed: {ex}");
            }
        }
    }

    public class CombatLogShotCapturePatch : ModulePatch
    {
        protected override MethodBase GetTargetMethod()
        {
            return AccessTools.Method(typeof(Player), nameof(Player.ApplyShot));
        }
        [PatchPrefix]
        public static void Prefix(DamageInfo damageInfo, out float __state)
        {
            __state = damageInfo.Damage;
        }

        [PatchPostfix]
        public static void Postfix(Player __instance, PlayerHitInfo __result, DamageInfo damageInfo,
            EBodyPart bodyPartType, EBodyPartColliderType colliderType, float __state)
        {
            try
            {
                if (__result == null || !RaidMeta.Started || RaidMeta.Finished) return;

                if (_localProfileId == null)
                {
                    var gw = Singleton<GameWorld>.Instance;
                    if (gw?.MainPlayer != null)
                        _localProfileId = gw.MainPlayer.ProfileId;
                }

                bool isIncoming = __instance.IsYourPlayer;
                bool isOutgoing = !isIncoming
                    && _localProfileId != null
                    && damageInfo.HaveOwner
                    && damageInfo.Player.iPlayer.ProfileId == _localProfileId;

                if (!isIncoming && !isOutgoing) return;

                string weaponId;
                string weaponName;
                if (isOutgoing)
                {
                    weaponId = ObserveWeapon(damageInfo.Weapon);
                    weaponName = ObservedWeaponName(weaponId, damageInfo.Weapon);
                }
                else
                {
                    weaponId = damageInfo.Weapon?.Id;
                    weaponName = damageInfo.Weapon?.ShortName?.Localized(null);
                }

                RaidMeta.CaptureLocation();
                DistanceHelper.TryGetDistance(damageInfo, out float distance);

                var record = new ShotRecord
                {
                    Time = UnityEngine.Time.time,
                    BodyPart = bodyPartType,
                    Collider = colliderType,
                    DamageBeforeArmor = __state,
                    DamageAfterArmor = damageInfo.Damage,
                    ArmorDamage = damageInfo.DidArmorDamage,
                    Penetrated = damageInfo.Penetrated,
                    Deflected = damageInfo.DeflectedBy != null,
                    Blocked = damageInfo.BlockedBy != null,
                    AmmoTemplateId = damageInfo.SourceId,
                    WeaponName = weaponName,
                    WeaponId = weaponId,
                    WeaponTemplateId = damageInfo.Weapon?.StringTemplateId,
                    Distance = distance
                };

                if (isOutgoing)
                {
                    record.TargetProfileId = __instance.ProfileId;
                    record.TargetName = __instance.Profile?.Nickname;
                    record.TargetSide = __instance.Side;
                    record.TargetLevel = __instance.Profile?.Info?.Level ?? 0;
                    record.TargetRole = __instance.Profile?.Info?.Settings?.Role ?? WildSpawnType.assault;
                    RaidAnalytics.AddDealt(record);
                }
                else
                {
                    var attacker = damageInfo.HaveOwner ? damageInfo.Player?.iPlayer : null;
                    if (attacker != null)
                    {
                        record.AttackerProfileId = attacker.ProfileId;
                        record.AttackerName = attacker.Profile?.Nickname;
                        record.AttackerRole = attacker.Profile?.Info?.Settings?.Role ?? WildSpawnType.assault;
                    }
                    RaidAnalytics.AddReceived(record);
                }
            }
            catch (System.Exception ex)
            {
                Plugin.Log.LogError($"Shot capture failed: {ex}");
            }
        }
    }
    public class CombatLogShotFiredPatch : ModulePatch
    {
        protected override MethodBase GetTargetMethod()
        {
            return AccessTools.Method(typeof(Player.FirearmController),
                nameof(Player.FirearmController.RegisterShot),
                new[] { typeof(Item), typeof(Shot) });
        }

        [PatchPostfix]
        public static void Postfix(Player.FirearmController __instance, Item weapon, Shot shot)
        {
            try
            {
                if (shot == null || !RaidMeta.Started || RaidMeta.Finished ||
                    !IsLocalFirearmController(__instance))
                    return;

                Shot root = RootProjectile(shot);
                if (root?.Ammo == null) return;

                string bulletId = ProjectileKey(root);
                string ammoTemplateId = root.Ammo.TemplateId;
                string weaponId = ObserveWeapon(weapon ?? root.Weapon);
                RaidAnalytics.CountFired(bulletId, CartridgeKey(root), ammoTemplateId, weaponId);
            }
            catch (System.Exception ex)
            {
                Plugin.Log.LogError($"Shot-fired capture failed: {ex}");
            }
        }
    }
    public class CombatLogShotHitPatch : ModulePatch
    {
        protected override MethodBase GetTargetMethod()
        {
            return AccessTools.Method(typeof(ClientGameWorld), nameof(ClientGameWorld.ShotDelegate));
        }

        [PatchPostfix]
        public static void Postfix(Shot shotResult)
        {
            try
            {
                if (shotResult == null || !RaidMeta.Started || RaidMeta.Finished) return;

                if (!(shotResult.HittedBallisticCollider is BodyPartCollider bodyPartCollider) ||
                    bodyPartCollider.Player == null || bodyPartCollider.Player.IsYourPlayer)
                    return;

                if (_localProfileId == null)
                {
                    var gw = Singleton<GameWorld>.Instance;
                    if (gw?.MainPlayer != null)
                        _localProfileId = gw.MainPlayer.ProfileId;
                }

                Shot root = RootProjectile(shotResult);
                if (root?.Ammo == null || _localProfileId == null ||
                    root.PlayerProfileID != _localProfileId)
                    return;

                string bulletId = ProjectileKey(root);
                if (!RaidAnalytics.WasFired(bulletId)) return;
                RaidAnalytics.CountHit(bulletId);
            }
            catch (System.Exception ex)
            {
                Plugin.Log.LogError($"Shot-hit capture failed: {ex}");
            }
        }
    }
    public class CombatLogRaidStartPatch : ModulePatch
    {
        protected override MethodBase GetTargetMethod()
        {
            return AccessTools.Method(typeof(LocalGame), nameof(LocalGame.vmethod_0));
        }

        [PatchPostfix]
        public static void Postfix(LocalGame __instance)
        {
            UI.CombatLogPanel.FlushPendingRaid();
            PostRaidScreenState.Clear();
            RaidAnalytics.Clear();
            _localProfileId = __instance?.Profile?.Id;

            var gw = Singleton<GameWorld>.Instance;
            string location = gw?.LocationId ?? string.Empty;
            RaidAnalytics.RaidLocation = location;
            RaidMeta.BeginRaid(location);
            UI.CombatLogPanel.BeginCurrentRaid();
        }
    }
    public class CombatLogRaidEndPatch : ModulePatch
    {
        protected override MethodBase GetTargetMethod()
        {
            return AccessTools.Method(typeof(LocalGame), nameof(LocalGame.Stop));
        }

        [PatchPrefix]
        public static void Prefix(ExitStatus exitStatus)
        {
            try
            {
                if (RaidMeta.EndRaid(exitStatus))
                    UI.CombatLogPanel.SaveCurrentRaid();
            }
            catch (System.Exception ex)
            {
                Plugin.Log.LogError($"Raid-end capture failed: {ex}");
            }
        }
    }
}
