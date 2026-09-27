using System;
using BepInEx.Bootstrap;
using BepInEx.Configuration;
using CombatLog.PostRaidScreens.DeathScreen;
using CombatLog.PostRaidScreens.KillList;
using CombatLog.PostRaidScreens.Treatment;

namespace CombatLog.PostRaidScreens;
internal static class PostRaidScreensFeature
{
    private const string Section = "Post-Raid Screens";
    private const string LegacyKadiGuid = "com.maschine.KillAndDamageInfo";

    private static ConfigEntry<bool> _killListAmmo;
    private static ConfigEntry<bool> _damagedTargets;
    private static ConfigEntry<bool> _deathDetails;
    private static ConfigEntry<bool> _killerModel;
    private static ConfigEntry<bool> _damageTooltips;
    private static bool _initialized;

    internal static bool KillListAvailable { get; private set; }
    internal static bool DeathScreenAvailable { get; private set; }
    internal static bool TreatmentAvailable { get; private set; }

    internal static bool KillListAmmoEnabled =>
        KillListAvailable && _killListAmmo?.Value == true;
    internal static bool DamagedTargetsEnabled =>
        KillListAvailable && _damagedTargets?.Value == true;
    internal static bool DeathDetailsEnabled =>
        DeathScreenAvailable && _deathDetails?.Value == true;
    internal static bool KillerModelEnabled =>
        DeathScreenAvailable && _killerModel?.Value == true;
    internal static bool DamageTooltipsEnabled =>
        TreatmentAvailable && _damageTooltips?.Value == true;

    internal static void Initialize(ConfigFile config)
    {
        if (_initialized)
            return;
        _initialized = true;

        try
        {
            _killListAmmo = config.Bind(Section, "Ammo in kill list", true,
                "Append the exact lethal ammunition to kills on the raid-end list");
            _damagedTargets = config.Bind(Section, "Damaged targets in kill list", true,
                "Add targets you damaged but did not kill to a display-only copy of the raid-end list");
            _deathDetails = config.Bind(Section, "Killer details on death screen", true,
                "Show killing weapon, ammunition, distance and remaining killer health");
            _killerModel = config.Bind(Section, "Killer 3D model on death screen", true,
                "Show the killer's native 3D model, equipment and level instead of your own");
            _damageTooltips = config.Bind(Section, "Weapon and distance in treatment tooltips", true,
                "Show weapon and truthful distance evidence in post-raid body-part damage tooltips");
        }
        catch (Exception ex)
        {
            Plugin.Log?.LogWarning("post-raid screen configuration was unavailable: " + ex.Message);
            return;
        }

        if (LegacyKadiLoaded())
        {
            Plugin.Log?.LogError(
                "KillAndDamageInfo is still loaded. CombatLog's Post-Raid Screens are disabled " +
                "to avoid duplicate UI patches; remove maschine-KillAndDamageInfo.dll.");
            return;
        }

        KillListAvailable = TryEnable("kill list", CombatLogKillListPatches.Enable);
        DeathScreenAvailable = TryEnable("death screen", CombatLogDeathScreenPatches.Enable);
        TreatmentAvailable = TryEnable("treatment screen", CombatLogDamageTooltipPatches.Enable);
    }

    private static bool TryEnable(string name, Action enable)
    {
        try
        {
            enable();
            return true;
        }
        catch (Exception ex)
        {
            Plugin.Log?.LogWarning($"the post-raid {name} integration is unavailable: {ex.Message}");
            return false;
        }
    }

    private static bool LegacyKadiLoaded()
    {
        try
        {
            return Chainloader.PluginInfos != null &&
                Chainloader.PluginInfos.ContainsKey(LegacyKadiGuid);
        }
        catch
        {
            return false;
        }
    }
}
