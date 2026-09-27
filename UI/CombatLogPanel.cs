using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using CombatLog.Analytics;
using EFT;
using UnityEngine;

namespace CombatLog.UI;
public class CombatLogPanel : MonoBehaviour
{
    private const string StatsChannel = "stats";

    private static CombatLogPanel _instance;
    private string _html;
    private bool _open;
    private bool _awaitingVisibility;
    private bool _requestedVisible;
    private bool _retryVisibility;
    private long _visibilityRequestId;
    private float _nextPush;
    private string _lastPayload;
    private sealed class PendingRaidSnapshot
    {
        internal long Timestamp;
        internal string StoredPayload;
        internal string IndexLine;
    }
    private static readonly List<PendingRaidSnapshot> PendingRaids = new();
    private static bool _finalizationAttempted;
    private static string _cachedLivePayload;
    private static int _cachedHistoryPrefixLength;
    private static long _currentRaidTs;

    private void Awake()
    {
        _instance = this;
    }

    internal static void BeginCurrentRaid()
    {
        _currentRaidTs = System.DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        _cachedLivePayload = null;
        RaidPresentation.BeginRaid(_currentRaidTs);
        if (WebOverlayGate.IsCreated)
            _instance?.RequestVisibility(false);
    }

    private void Update()
    {
        ReconcileNativeOverlayState();
        RetryPendingVisibility();
        bool pumped = PumpOverlayEvents();
        if (PendingRaids.Count > 0 && !_finalizationAttempted)
            FlushPendingRaid();
        RaidPresentation.Tick();
        if (IsRaidActive())
        {
            if (_open || (_awaitingVisibility && _requestedVisible) ||
                (WebOverlayGate.IsCreated && WebOverlayGate.IsUsable && WebOverlayGate.IsVisible()))
                RequestVisibility(false);
            return;
        }

        if (!pumped)
            PumpOverlayEvents();
        if (!_open)
            return;
        if (Time.unscaledTime >= _nextPush)
        {
            _nextPush = Time.unscaledTime + 1f;
            PushStats();
        }
    }

    private void OnDestroy()
    {
        if (object.ReferenceEquals(_instance, this))
            _instance = null;
        FlushPendingRaid();
        RaidPresentation.Dispose();
        if (WebOverlayGate.IsCreated)
            WebOverlayGate.Dispose();
    }
    internal void ToggleFromMenu()
    {
        Toggle();
    }

    private void Toggle()
    {
        if (IsRaidActive())
        {
            if (_open || (_awaitingVisibility && _requestedVisible) ||
                (WebOverlayGate.IsCreated && WebOverlayGate.IsUsable && WebOverlayGate.IsVisible()))
                RequestVisibility(false);
            Plugin.Log.LogWarning("The combat log is available after the raid has ended.");
            return;
        }
        if (WebOverlayGate.HasFailed)
            return;

        if (!WebOverlayGate.IsUsable)
        {
            Plugin.Log.LogWarning(
                $"Anvil-WebOverlay {WebOverlayGate.MinimumVersion} or newer is required " +
                $"(found: {WebOverlayGate.FoundVersion?.ToString() ?? "nothing"}).");
            return;
        }

        if (_html == null)
            _html = LoadPage();
        if (_html == null)
            return;

        bool hasWindowSize = TryGetWindowSize(Screen.width, Screen.height, out int windowWidth, out int windowHeight);
        if (!WebOverlayGate.IsCreated && !hasWindowSize)
        {
            Plugin.Log.LogWarning("The combat log cannot open until the game window has a usable size.");
            return;
        }

        if (!WebOverlayGate.EnsureCreated(_html, windowWidth, windowHeight,
                OnChannelMessage, RaidHistory.LoadRaid, RaidPresentation.LoadImage, m => Plugin.Log.LogWarning(m)))
            return;
        WebOverlayGate.Pump();
        ReconcileNativeOverlayState();
        if (WebOverlayGate.HasFailed)
            return;
        if (_open || (_awaitingVisibility && _requestedVisible) || WebOverlayGate.IsVisible())
            RequestVisibility(false);
        else
        {
            RefreshArchiveSnapshot();
            RequestVisibility(true);
        }
    }
    internal static bool TryGetWindowSize(int screenWidth, int screenHeight, out int width, out int height)
    {
        width = 0;
        height = 0;
        if (screenWidth < 200 || screenHeight < 150)
            return false;

        int availableWidth = System.Math.Max(200, (int)(screenWidth * 0.9));
        int availableHeight = System.Math.Max(150, (int)(screenHeight * 0.9));
        width = (int)System.Math.Min(availableWidth, availableHeight * 16.0 / 9.0);
        height = System.Math.Min(availableHeight, (int)(width * 9.0 / 16.0));
        width = System.Math.Max(200, width);
        height = System.Math.Max(150, height);
        return true;
    }

    private void OnChannelMessage(string channel, string payload)
    {
        if (channel == "close")
            RequestVisibility(false);
    }

    private static bool IsRaidActive() => RaidMeta.Started && !RaidMeta.Finished;

    private void RequestVisibility(bool visible)
    {
        if (_awaitingVisibility && _requestedVisible == visible)
            return;

        _requestedVisible = visible;
        _awaitingVisibility = true;
        _retryVisibility = false;
        if (!visible)
            _open = false;

        IssueVisibilityRequest();
    }

    private void IssueVisibilityRequest()
    {
        long requestId = WebOverlayGate.RequestVisibility(_requestedVisible);
        if (requestId == 0)
        {
            CompleteVisibilityRequest(false);
            return;
        }

        _visibilityRequestId = requestId;
        if (_requestedVisible)
            _nextPush = 0f;
    }

    private void RetryPendingVisibility()
    {
        if (!_awaitingVisibility || !_retryVisibility ||
            !WebOverlayGate.IsCreated || WebOverlayGate.HasFailed)
        {
            return;
        }
        _retryVisibility = false;
        IssueVisibilityRequest();
    }

    private bool PumpOverlayEvents()
    {
        if (!WebOverlayGate.IsCreated || (!_open && !_awaitingVisibility))
            return false;

        WebOverlayGate.Pump();
        ReconcileNativeOverlayState();
        return true;
    }

    private void ReconcileNativeOverlayState()
    {
        if (WebOverlayGate.TryConsumeVisibility(out bool reportedVisible))
        {
            bool visible = WebOverlayGate.IsCreated && WebOverlayGate.IsUsable
                ? WebOverlayGate.IsVisible()
                : reportedVisible;

            if (_awaitingVisibility && visible != _requestedVisible)
            {
                _open = false;
            }
            else
            {
                _open = visible;
                if (!_awaitingVisibility)
                    _requestedVisible = visible;
            }
        }

        while (WebOverlayGate.TryConsumeVisibilityCompletion(out OverlayVisibilityCompletion completion))
        {
            if (!_awaitingVisibility || completion.RequestId != _visibilityRequestId)
                continue;

            switch (completion.Outcome)
            {
                case OverlayVisibilityOutcome.Applied:
                case OverlayVisibilityOutcome.AlreadyThere:
                    CompleteVisibilityRequest(completion.RequestedVisible, reconcileNative: true);
                    break;
                case OverlayVisibilityOutcome.QueueRefused:
                case OverlayVisibilityOutcome.Superseded:
                    _retryVisibility = true;
                    break;
                case OverlayVisibilityOutcome.RefusedFullscreen:
                    CompleteVisibilityRequest(false);
                    Plugin.Log.LogWarning(
                        "Exclusive fullscreen cannot host an overlay — use borderless or windowed mode.");
                    break;
                case OverlayVisibilityOutcome.Failed:
                case OverlayVisibilityOutcome.Disposed:
                default:
                    CompleteVisibilityRequest(false);
                    break;
            }
        }

        if (WebOverlayGate.ConsumeFailureWarning())
            Plugin.Log.LogWarning("the overlay failed; the window will stay closed for this session.");
        if (WebOverlayGate.HasFailed)
        {
            _open = false;
            _requestedVisible = false;
            _awaitingVisibility = false;
            _retryVisibility = false;
        }
    }

    private void CompleteVisibilityRequest(bool visible, bool reconcileNative = false)
    {
        if (reconcileNative && WebOverlayGate.IsCreated && WebOverlayGate.IsUsable)
            visible = WebOverlayGate.IsVisible();

        _open = visible;
        _requestedVisible = visible;
        _awaitingVisibility = false;
        _retryVisibility = false;
    }

    private static string LoadPage()
    {
        try
        {
            using (Stream stream = Assembly.GetExecutingAssembly()
                       .GetManifestResourceStream("CombatLog.combatlog.html"))
            {
                if (stream == null)
                {
                    Plugin.Log.LogError("Embedded page CombatLog.combatlog.html not found.");
                    return null;
                }
                using (var reader = new StreamReader(stream))
                using (Stream mannequin = Assembly.GetExecutingAssembly()
                           .GetManifestResourceStream("CombatLog.mannequin.js"))
                using (Stream records = Assembly.GetExecutingAssembly()
                           .GetManifestResourceStream("CombatLog.records.js"))
                {
                    if (mannequin == null || records == null)
                    {
                        Plugin.Log.LogError("Embedded report script (mannequin or records) not found.");
                        return null;
                    }
                    using (var script = new StreamReader(mannequin))
                    using (var recordScript = new StreamReader(records))
                        return reader.ReadToEnd().Replace("<script src=\"mannequin.js\"></script>",
                            "<script>" + script.ReadToEnd() + "</script>")
                            .Replace("<script src=\"records.js\"></script>",
                                "<script>" + recordScript.ReadToEnd() + "</script>");
                }
            }
        }
        catch (System.Exception ex)
        {
            Plugin.Log.LogError($"Loading the embedded page failed: {ex}");
            return null;
        }
    }

    private void PushStats()
    {
        try
        {
            string json = GetCachedLivePayload();
            if (json == null)
                return;
            if (json == _lastPayload)
                return;
            if (WebOverlayGate.Post(StatsChannel, json, retain: true))
                _lastPayload = json;
        }
        catch (System.Exception ex)
        {
            Plugin.Log.LogError($"Pushing stats failed: {ex}");
        }
    }
    internal static void SaveCurrentRaid()
    {
        if (_currentRaidTs <= 0)
            _currentRaidTs = System.DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        RaidPresentation.EndRaid();
        PendingRaids.Add(new PendingRaidSnapshot { Timestamp = _currentRaidTs });
        _finalizationAttempted = false;
        _cachedLivePayload = null;
    }
    internal static void FlushPendingRaid()
    {
        if (PendingRaids.Count == 0)
            return;

        _finalizationAttempted = true;
        try
        {
            PendingRaidSnapshot latest = PendingRaids[PendingRaids.Count - 1];
            if (latest.StoredPayload == null || latest.IndexLine == null)
            {
                string stored = BuildStatsJson(latest.Timestamp, includeHistory: false);
                string indexLine = BuildIndexLine(latest.Timestamp);
                latest.StoredPayload = stored;
                latest.IndexLine = indexLine;
            }
            while (PendingRaids.Count > 0)
            {
                PendingRaidSnapshot pending = PendingRaids[0];
                if (pending.StoredPayload == null || pending.IndexLine == null ||
                    !RaidHistory.Save(pending.Timestamp, pending.StoredPayload, pending.IndexLine))
                    break;
                PendingRaids.RemoveAt(0);
            }
            _cachedLivePayload = ComposeLivePayload(latest.StoredPayload);
            _cachedHistoryPrefixLength = _cachedLivePayload.Length - latest.StoredPayload.Length + 1;
        }
        catch (System.Exception ex)
        {
            Plugin.Log.LogError($"Persisting the raid failed: {ex}");
        }
    }

    private static void RefreshArchiveSnapshot()
    {
        RaidHistory.RefreshDetailAvailability();
        if (_cachedLivePayload == null)
            return;

        string stored = "{" + _cachedLivePayload.Substring(_cachedHistoryPrefixLength);
        _cachedLivePayload = ComposeLivePayload(stored);
        _cachedHistoryPrefixLength = _cachedLivePayload.Length - stored.Length + 1;
    }

    private static string GetCachedLivePayload()
    {
        if (_cachedLivePayload != null)
            return _cachedLivePayload;
        if (PendingRaids.Count > 0 || IsRaidActive())
            return null;
        string stored = BuildStatsJson(_currentRaidTs, includeHistory: false);
        _cachedLivePayload = ComposeLivePayload(stored);
        _cachedHistoryPrefixLength = _cachedLivePayload.Length - stored.Length + 1;
        return _cachedLivePayload;
    }

    private static string ComposeLivePayload(string stored)
    {
        if (string.IsNullOrEmpty(stored) || stored[0] != '{')
            return stored;
        return "{\"historyDetailLimit\":" + RaidHistory.MaxStoredRaids.ToString(CultureInfo.InvariantCulture) +
            ",\"historyDetailIds\":[" + RaidHistory.DetailIdsAsJsonArrayBody() + "]" +
            ",\"history\":[" + RaidHistory.IndexAsJsonArrayBody() + "]," + stored.Substring(1);
    }
    private static string BuildIndexLine(long ts)
    {
        var dealt = RaidAnalytics.ShotsDealt;
        var received = RaidAnalytics.ShotsReceived;
        int fired = RaidAnalytics.Accuracy.Values.Sum(a => a.Fired);
        int accHits = RaidAnalytics.Accuracy.Values.Sum(a => a.Hits);
        int cartridgesFired = RaidAnalytics.Accuracy.Values.Sum(a => a.CartridgesFired);
        int cartridgesHit = RaidAnalytics.Accuracy.Values.Sum(a => a.CartridgesHit);

        float ammoCost = 0f;
        foreach (var entry in RaidAnalytics.Accuracy)
        {
            if (entry.Value.CartridgesFired <= 0) continue;
            if (AmmoPrice.TryGetUnitPrice(entry.Key, out float unit))
                ammoCost += unit * entry.Value.CartridgesFired;
        }

        var sb = new StringBuilder(256);
        sb.Append('{');
        Num(sb, "ts", ts).Append(',');
        Str(sb, "date", System.DateTimeOffset.FromUnixTimeMilliseconds(ts).ToLocalTime()
            .ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture)).Append(',');
        Str(sb, "location", RaidMeta.LocationName).Append(',');
        Str(sb, "outcome", RaidMeta.ExitLabel).Append(',');
        Num(sb, "duration", (int)RaidMeta.Duration).Append(',');
        Num(sb, "kills", RaidAnalytics.KilledProfileIds.Count).Append(',');
        Num(sb, "hitsDealt", dealt.Count).Append(',');
        Num(sb, "hitsReceived", received.Count).Append(',');
        Num(sb, "damageDealt", dealt.Sum(x => x.DamageAfterArmor)).Append(',');
        Num(sb, "damageReceived", received.Sum(x => x.DamageAfterArmor)).Append(',');
        Num(sb, "shotsFired", fired).Append(',');
        Num(sb, "shotsHit", accHits).Append(',');
        Num(sb, "cartridgesFired", cartridgesFired).Append(',');
        Num(sb, "cartridgesHit", cartridgesHit).Append(',');
        AppendWeapons(sb, dealt);
        Num(sb, "ammoCost", ammoCost).Append(',');
        Str(sb, "costBasis", "cartridge");
        sb.Append('}');
        return sb.ToString();
    }
    private static float ArmorPrevented(ShotRecord s) =>
        System.Math.Max(0f, s.DamageBeforeArmor - s.DamageAfterArmor);
    private static bool IsArmorHit(ShotRecord s) =>
        ArmorPrevented(s) > 0.001f || s.ArmorDamage > 0.001f || s.Blocked || s.Deflected;
    private static bool IsArmorPen(ShotRecord s) => IsArmorHit(s) && !s.Blocked && !s.Deflected;

    private static string BuildStatsJson(long timestamp, bool includeHistory)
    {
        RaidAnalytics.ResolvePendingFatal();

        var dealt = RaidAnalytics.ShotsDealt;
        var received = RaidAnalytics.ShotsReceived;

        int fired = RaidAnalytics.Accuracy.Values.Sum(a => a.Fired);
        int accHits = RaidAnalytics.Accuracy.Values.Sum(a => a.Hits);
        int cartridgesFired = RaidAnalytics.Accuracy.Values.Sum(a => a.CartridgesFired);
        int cartridgesHit = RaidAnalytics.Accuracy.Values.Sum(a => a.CartridgesHit);

        float ammoCost = 0f;
        foreach (var entry in RaidAnalytics.Accuracy)
        {
            if (entry.Value.CartridgesFired <= 0) continue;
            if (AmmoPrice.TryGetUnitPrice(entry.Key, out float unit))
                ammoCost += unit * entry.Value.CartridgesFired;
        }

        var sb = new StringBuilder(2048);
        sb.Append('{');
        Num(sb, "v", 2).Append(',');
        Num(sb, "ts", timestamp).Append(',');

        if (includeHistory)
        {
            Num(sb, "historyDetailLimit", RaidHistory.MaxStoredRaids).Append(',');
            sb.Append("\"historyDetailIds\":[").Append(RaidHistory.DetailIdsAsJsonArrayBody()).Append("],");
            sb.Append("\"history\":[").Append(RaidHistory.IndexAsJsonArrayBody()).Append("],");
        }

        sb.Append("\"raid\":{");
        Str(sb, "outcome", RaidMeta.ExitLabel).Append(',');
        Str(sb, "location", RaidMeta.LocationName).Append(',');
        Num(sb, "duration", (int)RaidMeta.Duration).Append(',');
        Str(sb, "timeOrigin", "raid").Append(',');
        sb.Append("\"started\":").Append(RaidMeta.Started ? "true" : "false").Append(',');
        sb.Append("\"finished\":").Append(RaidMeta.Finished ? "true" : "false");
        sb.Append("},");

        AppendDeathReport(sb, received);
        AppendKiller(sb);

        sb.Append("\"findings\":[");
        var findings = RaidFindings.Build();
        for (int i = 0; i < findings.Count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append('{');
            Str(sb, "title", findings[i].Title).Append(',');
            Str(sb, "detail", findings[i].Detail).Append(',');
            sb.Append("\"negative\":").Append(findings[i].Negative ? "true" : "false");
            sb.Append('}');
        }
        sb.Append("],");
        Num(sb, "hitsDealt", dealt.Count).Append(',');
        Num(sb, "hitsReceived", received.Count).Append(',');
        Num(sb, "damageDealt", dealt.Sum(s => s.DamageAfterArmor)).Append(',');
        Num(sb, "damageReceived", received.Sum(s => s.DamageAfterArmor)).Append(',');
        Num(sb, "armorDamageDealt", dealt.Sum(s => s.ArmorDamage)).Append(',');
        Num(sb, "armorSavedYou", received.Sum(ArmorPrevented)).Append(',');
        Num(sb, "shotsFired", fired).Append(',');
        Num(sb, "shotsHit", accHits).Append(',');
        Num(sb, "cartridgesFired", cartridgesFired).Append(',');
        Num(sb, "cartridgesHit", cartridgesHit).Append(',');
        Num(sb, "kills", RaidAnalytics.KilledProfileIds.Count).Append(',');
        Num(sb, "ammoCost", ammoCost).Append(',');
        Str(sb, "costBasis", "cartridge").Append(',');
        Num(sb, "deflectedOffYou", received.Count(s => s.Deflected)).Append(',');
        Num(sb, "armorHitsDealt", dealt.Count(IsArmorHit)).Append(',');
        Num(sb, "armorPensDealt", dealt.Count(IsArmorPen)).Append(',');

        sb.Append("\"bodyParts\":{");
        bool firstPart = true;
        foreach (EBodyPart part in new[]
                 {
                     EBodyPart.Head, EBodyPart.Chest, EBodyPart.Stomach,
                     EBodyPart.LeftArm, EBodyPart.RightArm, EBodyPart.LeftLeg, EBodyPart.RightLeg
                 })
        {
            if (!firstPart) sb.Append(',');
            firstPart = false;
            sb.Append('"').Append(part).Append("\":{");
            Num(sb, "dealtHits", dealt.Count(s => s.BodyPart == part)).Append(',');
            Num(sb, "dealtDamage", dealt.Where(s => s.BodyPart == part).Sum(s => s.DamageAfterArmor)).Append(',');
            Num(sb, "receivedHits", received.Count(s => s.BodyPart == part)).Append(',');
            Num(sb, "receivedDamage", received.Where(s => s.BodyPart == part).Sum(s => s.DamageAfterArmor));
            sb.Append('}');
        }
        sb.Append("},");

        AppendAmmo(sb, dealt);
        AppendLoadout(sb, dealt);
        AppendWeapons(sb, dealt);

        sb.Append("\"engagements\":[");
        var fights = RaidEngagements.Build();
        float raidStart = RaidMeta.StartTime > 0f
            ? RaidMeta.StartTime
            : (fights.Count > 0 ? fights[0].StartTime : 0f);
        for (int i = 0; i < fights.Count; i++)
        {
            var f = fights[i];
            if (i > 0) sb.Append(',');
            sb.Append('{');
            Num(sb, "start", f.StartTime - raidStart).Append(',');
            Num(sb, "duration", f.Duration).Append(',');
            Num(sb, "hitsDealt", f.Dealt.Count).Append(',');
            Num(sb, "hitsReceived", f.Received.Count).Append(',');
            Num(sb, "damageDealt", f.DamageDealt).Append(',');
            Num(sb, "damageReceived", f.DamageReceived).Append(',');
            Num(sb, "kills", f.Kills).Append(',');
            Num(sb, "killLinks", f.KillLinks).Append(',');
            sb.Append("\"opponents\":[");
            for (int o = 0; o < f.Opponents.Count; o++)
            {
                if (o > 0) sb.Append(',');
                sb.Append('{');
                Str(sb, "id", f.Opponents[o].Key).Append(',');
                Str(sb, "name", f.Opponents[o].Value);
                sb.Append('}');
            }
            sb.Append("],");
            sb.Append("\"hits\":[");
            bool firstHit = true;
            AppendHits(sb, f.Dealt, true, raidStart, ref firstHit);
            AppendHits(sb, f.Received, false, raidStart, ref firstHit);
            sb.Append("]}");
        }
        sb.Append(']');

        sb.Append('}');
        return sb.ToString();
    }
    private static void AppendKiller(StringBuilder sb)
    {
        var killer = RaidPresentation.Killer;
        if (!RaidMeta.Finished || RaidMeta.Exit != ExitStatus.Killed || killer == null) return;
        sb.Append("\"killer\":{");
        Str(sb, "profileId", killer.ProfileId).Append(',');
        Str(sb, "name", killer.Name).Append(',');
        Num(sb, "level", killer.Level).Append(',');
        Str(sb, "side", killer.Side).Append(',');
        Str(sb, "portraitImage", killer.PortraitImage).Append(',');
        sb.Append("\"equipment\":[");
        bool first = true;
        foreach (var item in killer.Equipment)
        {
            if (!first) sb.Append(',');
            first = false;
            sb.Append('{');
            Str(sb, "slot", item.Slot).Append(',');
            Str(sb, "name", item.Name).Append(',');
            Str(sb, "templateId", item.TemplateId).Append(',');
            Str(sb, "image", item.Image);
            if (item.ArmorClass.HasValue) { sb.Append(','); Num(sb, "armorClass", item.ArmorClass.Value); }
            if (item.Durability.HasValue) { sb.Append(','); Num(sb, "durability", item.Durability.Value); }
            if (item.MaxDurability.HasValue) { sb.Append(','); Num(sb, "maxDurability", item.MaxDurability.Value); }
            sb.Append('}');
        }
        sb.Append("]},");
    }

    private static void AppendAmmo(StringBuilder sb, List<ShotRecord> dealt)
    {
        sb.Append("\"ammo\":[");
        var groups = dealt.GroupBy(s => string.IsNullOrEmpty(s.AmmoTemplateId) ? "unknown" : s.AmmoTemplateId)
            .ToDictionary(g => g.Key, g => g.ToList());
        var keys = RaidAnalytics.Accuracy.Keys.Union(groups.Keys)
            .OrderByDescending(key => groups.TryGetValue(key, out var hits) ? hits.Sum(s => s.DamageAfterArmor) : 0f)
            .ThenBy(key => key, System.StringComparer.Ordinal).ToList();
        for (int i = 0; i < keys.Count; i++)
        {
            string key = keys[i];
            var hits = groups.TryGetValue(key, out var group) ? group : new List<ShotRecord>();
            if (i > 0) sb.Append(',');
            sb.Append('{');
            Str(sb, "id", key).Append(',');
            Str(sb, "name", AmmoLocale.GetAmmoShortName(key) ?? key).Append(',');
            if (RaidAnalytics.Accuracy.TryGetValue(key, out var accuracy))
            {
                Num(sb, "fired", accuracy.Fired).Append(',');
                Num(sb, "shotsHit", accuracy.Hits).Append(',');
                Num(sb, "cartridgesFired", accuracy.CartridgesFired).Append(',');
                Num(sb, "cartridgesHit", accuracy.CartridgesHit).Append(',');
            }
            Num(sb, "hits", hits.Count).Append(',');
            Num(sb, "damage", hits.Sum(s => s.DamageAfterArmor));
            sb.Append('}');
        }
        sb.Append("],");
    }

    private static void AppendWeapons(StringBuilder sb, List<ShotRecord> dealt)
    {
        sb.Append("\"weapons\":[");
        var groups = dealt.GroupBy(s => RaidAnalytics.WeaponKey(s.WeaponId))
            .ToDictionary(g => g.Key, g => g.ToList());
        var keys = RaidAnalytics.WeaponAccuracy.Keys.Union(groups.Keys)
            .OrderByDescending(key => groups.TryGetValue(key, out var hits) ? hits.Sum(s => s.DamageAfterArmor) : 0f)
            .ThenBy(key => key, System.StringComparer.Ordinal).ToList();
        for (int i = 0; i < keys.Count; i++)
        {
            string key = keys[i];
            if (i > 0) sb.Append(',');
            var hits = groups.TryGetValue(key, out var group) ? group : new List<ShotRecord>();
            RaidAnalytics.Weapons.TryGetValue(key, out var sample);
            var firstHit = hits.FirstOrDefault();
            sb.Append('{');
            Str(sb, "id", key).Append(',');
            Str(sb, "templateId", sample?.TemplateId ?? firstHit.WeaponTemplateId).Append(',');
            Str(sb, "name", sample?.Name ?? firstHit.WeaponName ?? "Unknown weapon").Append(',');
            Str(sb, "image", sample?.Image).Append(',');
            if (RaidAnalytics.WeaponAccuracy.TryGetValue(key, out var accuracy))
            {
                Num(sb, "fired", accuracy.Fired).Append(',');
                Num(sb, "shotsHit", accuracy.Hits).Append(',');
                Num(sb, "cartridgesFired", accuracy.CartridgesFired).Append(',');
                Num(sb, "cartridgesHit", accuracy.CartridgesHit).Append(',');
            }
            Num(sb, "hits", hits.Count).Append(',');
            Num(sb, "damage", hits.Sum(s => s.DamageAfterArmor)).Append(',');
            Num(sb, "armorDamage", hits.Sum(ArmorPrevented)).Append(',');
            Num(sb, "kills", hits.Count(s => s.Fatal && !s.FatalInferred)).Append(',');
            Num(sb, "killLinks", hits.Count(s => s.Fatal && s.FatalInferred));
            sb.Append('}');
        }
        sb.Append("],");
    }

    private static void AppendLoadout(StringBuilder sb, List<ShotRecord> dealt)
    {
        sb.Append("\"loadout\":[");

        var byAmmo = dealt
            .GroupBy(s => string.IsNullOrEmpty(s.AmmoTemplateId) ? "unknown" : s.AmmoTemplateId)
            .ToDictionary(g => g.Key, g => g.ToList());
        var keys = RaidAnalytics.Accuracy.Keys.Union(byAmmo.Keys)
            .OrderByDescending(key => byAmmo.TryGetValue(key, out var hits) ? hits.Sum(s => s.DamageAfterArmor) : 0f)
            .ThenBy(key => key, System.StringComparer.Ordinal).ToList();

        for (int i = 0; i < keys.Count; i++)
        {
            string key = keys[i];
            var hits = byAmmo.TryGetValue(key, out var group) ? group : new List<ShotRecord>();
            if (i > 0) sb.Append(',');

            RaidAnalytics.Accuracy.TryGetValue(key, out var acc);
            int kills = hits.Count(s => s.Fatal && !s.FatalInferred);
            float cost = acc != null && AmmoPrice.TryGetUnitPrice(key, out float unit)
                ? unit * acc.CartridgesFired : 0f;

            sb.Append('{');
            Str(sb, "id", key).Append(',');
            Str(sb, "ammo", AmmoLocale.GetAmmoShortName(key) ?? key).Append(',');
            Num(sb, "hits", hits.Count).Append(',');
            if (acc != null)
            {
                Num(sb, "fired", acc.Fired).Append(',');
                Num(sb, "shotsHit", acc.Hits).Append(',');
                Num(sb, "cartridgesFired", acc.CartridgesFired).Append(',');
                Num(sb, "cartridgesHit", acc.CartridgesHit).Append(',');
                Str(sb, "costBasis", "cartridge").Append(',');
            }
            Num(sb, "kills", kills).Append(',');
            Num(sb, "cost", cost).Append(',');

            sb.Append("\"classes\":[");
            var byClass = hits
                .GroupBy(s => TargetClass.Of(s.TargetRole))
                .OrderByDescending(c => c.Count())
                .ToList();

            for (int c = 0; c < byClass.Count; c++)
            {
                var cg = byClass[c];
                var ch = cg.ToList();
                if (c > 0) sb.Append(',');
                int blocked = ch.Count(s => s.Blocked && !s.Deflected);
                int deflected = ch.Count(s => s.Deflected);
                int armorHits = ch.Count(IsArmorHit);

                sb.Append('{');
                Str(sb, "cls", cg.Key).Append(',');
                Num(sb, "hits", ch.Count).Append(',');
                Num(sb, "armorHits", armorHits).Append(',');
                Num(sb, "through", ch.Count(IsArmorPen)).Append(',');
                Num(sb, "blocked", blocked).Append(',');
                Num(sb, "deflected", deflected).Append(',');
                Num(sb, "avgBefore", ch.Sum(s => s.DamageBeforeArmor) / ch.Count).Append(',');
                Num(sb, "avgAfter", ch.Sum(s => s.DamageAfterArmor) / ch.Count).Append(',');
                Num(sb, "absorbed", ch.Sum(ArmorPrevented)).Append(',');
                Num(sb, "kills", ch.Count(s => s.Fatal && !s.FatalInferred));
                sb.Append('}');
            }
            sb.Append("]}");
        }

        sb.Append("],");
    }
    private static void AppendDeathReport(StringBuilder sb, List<ShotRecord> received)
    {
        ShotRecord fatal = default;
        bool found = false;
        for (int i = received.Count - 1; i >= 0; i--)
        {
            if (!received[i].Fatal) continue;
            fatal = received[i];
            found = true;
            break;
        }

        if (RaidMeta.Exit != ExitStatus.Killed || !found)
            return;

        sb.Append("\"death\":{");
        Str(sb, "killer", string.IsNullOrEmpty(fatal.AttackerName) ? "Unknown" : fatal.AttackerName).Append(',');
        Str(sb, "weapon", fatal.WeaponName ?? string.Empty).Append(',');
        Str(sb, "ammo", AmmoLocale.GetAmmoShortName(fatal.AmmoTemplateId) ?? string.Empty).Append(',');
        Str(sb, "part", BodyPartLabel(fatal.BodyPart)).Append(',');
        Num(sb, "distance", fatal.Distance).Append(',');
        Num(sb, "damage", fatal.DamageAfterArmor).Append(',');
        Num(sb, "absorbed", Mathf.Max(0f, fatal.DamageBeforeArmor - fatal.DamageAfterArmor)).Append(',');
        sb.Append("\"stopped\":").Append(fatal.Blocked || fatal.Deflected ? "true" : "false").Append(',');
        sb.Append("\"fatalInferred\":").Append(fatal.FatalInferred ? "true" : "false").Append(',');
        var fromKiller = string.IsNullOrEmpty(fatal.AttackerProfileId)
            ? new List<ShotRecord>()
            : received.Where(s => s.AttackerProfileId == fatal.AttackerProfileId).ToList();
        Num(sb, "hitsFromKiller", fromKiller.Count).Append(',');
        Num(sb, "damageFromKiller", fromKiller.Sum(s => s.DamageAfterArmor));
        sb.Append("},");
    }

    private static void AppendHits(StringBuilder sb, List<ShotRecord> shots, bool dealt,
        float raidStart, ref bool first)
    {
        foreach (var s in shots)
        {
            if (!first) sb.Append(',');
            first = false;
            sb.Append('{');
            Num(sb, "t", s.Time - raidStart).Append(',');
            sb.Append("\"dealt\":").Append(dealt ? "true" : "false").Append(',');
            Str(sb, "opponentId", (dealt ? s.TargetProfileId : s.AttackerProfileId) ?? string.Empty).Append(',');
            Str(sb, "who", (dealt ? s.TargetName : s.AttackerName) ?? "Unknown").Append(',');
            Str(sb, "cls", TargetClass.Of(dealt ? s.TargetRole : s.AttackerRole)).Append(',');
            Str(sb, "part", BodyPartLabel(s.BodyPart)).Append(',');
            Str(sb, "collider", s.Collider.ToString()).Append(',');
            Num(sb, "before", s.DamageBeforeArmor).Append(',');
            Num(sb, "after", s.DamageAfterArmor).Append(',');
            Num(sb, "armorDamage", s.ArmorDamage).Append(',');
            sb.Append("\"blocked\":").Append(s.Blocked ? "true" : "false").Append(',');
            sb.Append("\"deflected\":").Append(s.Deflected ? "true" : "false").Append(',');
            Str(sb, "weapon", s.WeaponName ?? string.Empty).Append(',');
            Str(sb, "weaponId", s.WeaponId ?? string.Empty).Append(',');
            Str(sb, "weaponTemplateId", s.WeaponTemplateId ?? string.Empty).Append(',');
            Str(sb, "ammoId", s.AmmoTemplateId ?? string.Empty).Append(',');
            Str(sb, "ammo", AmmoLocale.GetAmmoShortName(s.AmmoTemplateId) ?? string.Empty).Append(',');
            sb.Append("\"fatal\":").Append(s.Fatal ? "true" : "false").Append(',');
            sb.Append("\"fatalInferred\":").Append(s.FatalInferred ? "true" : "false").Append(',');
            Num(sb, "dist", s.Distance);
            sb.Append('}');
        }
    }

    private static string BodyPartLabel(EBodyPart part)
    {
        switch (part)
        {
            case EBodyPart.LeftArm: return "left arm";
            case EBodyPart.RightArm: return "right arm";
            case EBodyPart.LeftLeg: return "left leg";
            case EBodyPart.RightLeg: return "right leg";
            default: return part.ToString().ToLowerInvariant();
        }
    }
    private static StringBuilder Num(StringBuilder sb, string key, float value)
    {
        sb.Append('"').Append(key).Append("\":");
        sb.Append(float.IsNaN(value) || float.IsInfinity(value)
            ? "0"
            : value.ToString("0.##", CultureInfo.InvariantCulture));
        return sb;
    }

    private static StringBuilder Num(StringBuilder sb, string key, long value)
    {
        sb.Append('"').Append(key).Append("\":").Append(value.ToString(CultureInfo.InvariantCulture));
        return sb;
    }

    private static StringBuilder Num(StringBuilder sb, string key, int value)
    {
        sb.Append('"').Append(key).Append("\":").Append(value.ToString(CultureInfo.InvariantCulture));
        return sb;
    }

    private static StringBuilder Str(StringBuilder sb, string key, string value)
    {
        sb.Append('"').Append(key).Append("\":\"");
        foreach (char c in value ?? string.Empty)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb;
    }
}
