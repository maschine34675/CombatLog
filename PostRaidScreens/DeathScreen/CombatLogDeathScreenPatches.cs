using System;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using CombatLog.Analytics;
using EFT;
using EFT.UI;
using EFT.UI.SessionEnd;
using HarmonyLib;
using SPT.Reflection.Patching;
using TMPro;

namespace CombatLog.PostRaidScreens.DeathScreen;
public static class CombatLogDeathScreenPatches
{
    private const string MeterLocaleKey = "UI/ProfileStats/Meters";
    private const string HealthPrefix = " <size=70%>(HP: ";
    private static readonly FieldInfo KillerNameTextField =
        AccessTools.Field(typeof(PlayerNamePanel), "_name");

    public static void Enable()
    {
        new CombatLogDeathScreenShowPatch().Enable();
    }

    private sealed class CombatLogDeathScreenShowPatch : ModulePatch
    {
        protected override MethodBase GetTargetMethod()
        {
            return AccessTools.Method(
                typeof(SessionResultExitStatus),
                nameof(SessionResultExitStatus.Show),
                new[]
                {
                    typeof(Profile), typeof(PlayerVisualRepresentation), typeof(ESideType),
                    typeof(ExitStatus), typeof(TimeSpan), typeof(IEftSession), typeof(bool)
                });
        }

        [PatchPrefix]
        private static void Prefix(
            ExitStatus exitStatus,
            ref PlayerVisualRepresentation lastPlayerState,
            out RaidPresentation.KillerSnapshot __state)
        {
            __state = null;
            if (exitStatus != ExitStatus.Killed || !PostRaidScreensFeature.KillerModelEnabled)
                return;

            try
            {
                RaidPresentation.KillerSnapshot snapshot = RaidPresentation.Killer;
                PlayerVisualRepresentation visualState = snapshot?.NativeVisualState;
                if (visualState == null || visualState.IsEmpty())
                    return;

                lastPlayerState = visualState;
                __state = snapshot;
            }
            catch (Exception ex)
            {
                Plugin.Log?.LogWarning("the killer model could not be added to the death screen: " + ex.Message);
            }
        }

        [PatchPostfix]
        private static void Postfix(
            Profile activeProfile,
            ExitStatus exitStatus,
            RaidPresentation.KillerSnapshot __state,
            TextMeshProUGUI ____bodyPartLabel,
            PlayerNamePanel ____killerNamePanel,
            PlayerLevelPanel ____levelPanel)
        {
            if (exitStatus != ExitStatus.Killed)
                return;
            RaidPresentation.KillerSnapshot snapshot = __state ?? RaidPresentation.Killer;
            if (snapshot == null)
                return;

            if (PostRaidScreensFeature.DeathDetailsEnabled)
            {
                try
                {
                    AppendDeathDetails(____bodyPartLabel, activeProfile, snapshot);
                }
                catch (Exception ex)
                {
                    Plugin.Log?.LogWarning("death-screen weapon details were unavailable: " + ex.Message);
                }

                try
                {
                    AppendKillerHealth(____killerNamePanel, snapshot);
                }
                catch (Exception ex)
                {
                    Plugin.Log?.LogWarning("death-screen killer health was unavailable: " + ex.Message);
                }
            }
            if (__state != null)
            {
                try
                {
                    ShowKillerLevel(____levelPanel, __state);
                }
                catch (Exception ex)
                {
                    Plugin.Log?.LogWarning("the killer level could not be added to the death screen: " + ex.Message);
                }
            }
        }
    }

    private static void AppendDeathDetails(
        TextMeshProUGUI bodyPartLabel,
        Profile activeProfile,
        RaidPresentation.KillerSnapshot snapshot)
    {
        if (bodyPartLabel == null || snapshot == null || string.IsNullOrEmpty(bodyPartLabel.text))
            return;

        var details = new List<string>(3);
        string weaponName = ResolveWeaponName(activeProfile, snapshot);
        if (!string.IsNullOrWhiteSpace(weaponName))
            details.Add(weaponName);

        string ammoName = ResolveAmmoName(snapshot.KillingAmmoTemplateId);
        if (!string.IsNullOrWhiteSpace(ammoName))
            details.Add(ammoName);

        string distance = FormatDistance(snapshot.KillingDistance);
        if (!string.IsNullOrEmpty(distance))
            details.Add(distance);

        if (details.Count == 0)
            return;

        string text = bodyPartLabel.text;
        int close = text.LastIndexOf(')');
        if (close < 0 || !string.IsNullOrWhiteSpace(text.Substring(close + 1)))
            return;

        string suffix = ", " + string.Join(", ", details);
        string beforeClose = text.Substring(0, close);
        if (beforeClose.EndsWith(suffix, StringComparison.Ordinal))
            return;

        bodyPartLabel.text = beforeClose + suffix + text.Substring(close);
    }

    private static string ResolveWeaponName(
        Profile activeProfile,
        RaidPresentation.KillerSnapshot snapshot)
    {
        if (!string.IsNullOrWhiteSpace(snapshot.KillingWeaponName))
            return snapshot.KillingWeaponName;

        string fallback = activeProfile?.EftStats?.Aggressor?.WeaponName;
        if (string.IsNullOrWhiteSpace(fallback))
            return null;

        try
        {
            string localized = fallback.Localized(null);
            return string.IsNullOrWhiteSpace(localized) ? fallback : localized;
        }
        catch
        {
            return fallback;
        }
    }

    private static string ResolveAmmoName(string templateId)
    {
        if (string.IsNullOrWhiteSpace(templateId))
            return null;

        try
        {
            return AmmoLocale.GetAmmoShortName(templateId);
        }
        catch
        {
            return null;
        }
    }

    private static string FormatDistance(float distance)
    {
        if (distance <= 0f || float.IsNaN(distance) || float.IsInfinity(distance))
            return null;

        string meters;
        try
        {
            meters = MeterLocaleKey.Localized(null);
        }
        catch
        {
            return null;
        }

        return string.IsNullOrEmpty(meters)
            ? null
            : distance.ToString("0.#", CultureInfo.CurrentCulture) + meters;
    }

    private static void AppendKillerHealth(
        PlayerNamePanel killerNamePanel,
        RaidPresentation.KillerSnapshot snapshot)
    {
        if (killerNamePanel == null || snapshot == null || !snapshot.HasHealth ||
            snapshot.RemainingHp < 0f || snapshot.MaxHp <= 0f ||
            float.IsNaN(snapshot.RemainingHp) || float.IsInfinity(snapshot.RemainingHp) ||
            float.IsNaN(snapshot.MaxHp) || float.IsInfinity(snapshot.MaxHp))
            return;

        if (!(KillerNameTextField?.GetValue(killerNamePanel) is TMP_Text nameText) ||
            string.IsNullOrEmpty(nameText.text) ||
            nameText.text.IndexOf(HealthPrefix, StringComparison.Ordinal) >= 0)
            return;

        nameText.text += HealthPrefix +
            snapshot.RemainingHp.ToString("F0", CultureInfo.CurrentCulture) + "/" +
            snapshot.MaxHp.ToString("F0", CultureInfo.CurrentCulture) + ")</size>";
    }

    private static void ShowKillerLevel(
        PlayerLevelPanel levelPanel,
        RaidPresentation.KillerSnapshot snapshot)
    {
        PlayerVisualRepresentation visualState = snapshot?.NativeVisualState;
        var info = visualState?.Info;
        if (levelPanel == null || info == null)
            return;

        int level = snapshot.Level > 0 ? snapshot.Level : info.Level;
        if (level <= 0)
            return;

        levelPanel.Set(level,
            info.Side == EPlayerSide.Savage ? ESideType.Savage : ESideType.Pmc);
    }
}
