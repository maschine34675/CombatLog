using System;
using System.Collections;
using BepInEx;
using BepInEx.Logging;
using CombatLog.Analytics;
using CombatLog.PostRaidScreens;
using CombatLog.UI;
using UnityEngine;

namespace CombatLog;

[BepInPlugin(PluginGuid, PluginName, PluginVersion)]
[BepInDependency(WebOverlayGate.LibraryGuid, WebOverlayGate.MinimumVersionText)]
[BepInDependency("com.maschine.KillAndDamageInfo", BepInDependency.DependencyFlags.SoftDependency)]
public class Plugin : BaseUnityPlugin
{
    public const string PluginGuid = "com.maschine.CombatLog";
    public const string PluginName = "maschine-CombatLog";
    public const string PluginVersion = "1.0.0";

    public static ManualLogSource Log { get; private set; }
    internal static Plugin Instance { get; private set; }

    private CombatLogPanel _panel;
    internal bool ShowTaskBarButton => true;

    private void Awake()
    {
        Instance = this;
        Log = Logger;

        RaidHistory.Initialize();
        CombatLogShotPatches.Enable();
        PostRaidScreensFeature.Initialize(Config);
        _panel = gameObject.AddComponent<CombatLogPanel>();

        try
        {
            new Patches.CombatLogTaskBarButtonPatch().Enable();
        }
        catch (Exception ex)
        {
            Logger.LogError("The combat log menu button could not be installed; the report cannot be opened: " + ex.Message);
        }

        Log.LogInfo($"{PluginName} {PluginVersion} loaded");
    }
    internal void OpenFromTaskBar()
    {
        if (_panel != null)
            _panel.ToggleFromMenu();
    }
    internal void RunDelayed(float seconds, Action action)
    {
        StartCoroutine(RunDelayedRoutine(seconds, action));
    }

    private static IEnumerator RunDelayedRoutine(float seconds, Action action)
    {
        yield return new WaitForSecondsRealtime(seconds);
        try
        {
            action();
        }
        catch (Exception ex)
        {
            Log?.LogWarning("a delayed menu bar step failed: " + ex.Message);
        }
    }
}
