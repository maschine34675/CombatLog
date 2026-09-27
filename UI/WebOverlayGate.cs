using System;
using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Threading;

namespace CombatLog.UI;

internal enum OverlayVisibilityOutcome
{
    Applied,
    AlreadyThere,
    RefusedFullscreen,
    Superseded,
    Failed,
    Disposed,
    QueueRefused,
}

internal readonly struct OverlayVisibilityCompletion
{
    internal OverlayVisibilityCompletion(long requestId, bool requestedVisible,
        OverlayVisibilityOutcome outcome)
    {
        RequestId = requestId;
        RequestedVisible = requestedVisible;
        Outcome = outcome;
    }

    internal long RequestId { get; }
    internal bool RequestedVisible { get; }
    internal OverlayVisibilityOutcome Outcome { get; }
}
internal static class WebOverlayGate
{
    public const string LibraryGuid = "com.anvil.weboverlay";
    public const string MinimumVersionText = "1.11.0";
    public static readonly Version MinimumVersion = new Version(MinimumVersionText);

    private static bool? _loaded;
    private static Version _foundVersion;
    private static object _overlay;
    private static int _failed;
    private static int _visibilityChanged;
    private static int _reportedVisible;
    private static int _failureWarningPending;
    private static long _nextVisibilityRequestId;
    private static readonly ConcurrentQueue<OverlayVisibilityCompletion> VisibilityCompletions = new();
    private sealed class VisibilityCompletionBridge
    {
        private readonly long _requestId;
        private readonly bool _requestedVisible;

        internal VisibilityCompletionBridge(long requestId, bool requestedVisible)
        {
            _requestId = requestId;
            _requestedVisible = requestedVisible;
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        internal void Complete(WebOverlay.VisibilityOutcome outcome)
        {
            OverlayVisibilityOutcome translated;
            switch (outcome)
            {
                case WebOverlay.VisibilityOutcome.Applied:
                    translated = OverlayVisibilityOutcome.Applied;
                    break;
                case WebOverlay.VisibilityOutcome.AlreadyThere:
                    translated = OverlayVisibilityOutcome.AlreadyThere;
                    break;
                case WebOverlay.VisibilityOutcome.RefusedFullscreen:
                    translated = OverlayVisibilityOutcome.RefusedFullscreen;
                    break;
                case WebOverlay.VisibilityOutcome.Superseded:
                    translated = OverlayVisibilityOutcome.Superseded;
                    break;
                case WebOverlay.VisibilityOutcome.Failed:
                    translated = OverlayVisibilityOutcome.Failed;
                    PublishFailure();
                    break;
                case WebOverlay.VisibilityOutcome.Disposed:
                    translated = OverlayVisibilityOutcome.Disposed;
                    break;
                case WebOverlay.VisibilityOutcome.QueueRefused:
                    translated = OverlayVisibilityOutcome.QueueRefused;
                    break;
                default:
                    translated = OverlayVisibilityOutcome.Failed;
                    PublishFailure();
                    break;
            }

            VisibilityCompletions.Enqueue(new OverlayVisibilityCompletion(
                _requestId, _requestedVisible, translated));
        }
    }

    public static bool IsLoaded
    {
        get
        {
            if (_loaded == null)
            {
                _loaded = BepInEx.Bootstrap.Chainloader.PluginInfos.TryGetValue(LibraryGuid, out BepInEx.PluginInfo info);
                if (_loaded.Value)
                    _foundVersion = info.Metadata.Version;
            }
            return _loaded.Value;
        }
    }

    public static Version FoundVersion => IsLoaded ? _foundVersion : null;
    public static bool IsUsable => IsLoaded && _foundVersion != null && _foundVersion >= MinimumVersion;
    public static bool HasFailed => Volatile.Read(ref _failed) != 0;

    public static bool IsCreated => _overlay != null;
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static bool EnsureCreated(string html, int width, int height,
        Action<string, string> onChannel, Func<string, string> onLoadRaid,
        Func<string, string> onLoadImage, Action<string> logWarning)
    {
        if (HasFailed)
            return false;
        if (_overlay is WebOverlay.IWebOverlay)
            return true;

        var handle = WebOverlay.WebOverlays.Create("CombatLog", new WebOverlay.OverlayOptions
        {
            Width = width,
            Height = height,
            PersistenceKey = "com.maschine.CombatLog/desktop-workspace-v1",
            CloseKeys = new[] { 0x1B },
            Dispatch = WebOverlay.EventDispatch.Manual,
            FreeCursorWhileShown = true,
            ClickThroughWhenUnfocused = true,
        });

        if (handle == null)
        {
            logWarning("overlays are unavailable (is the WebView2 runtime installed?).");
            Interlocked.Exchange(ref _failed, 1);
            return false;
        }
        _overlay = handle;

        handle.VisibilityChanged += PublishVisibility;
        handle.Failed += PublishFailure;
        if (onChannel != null)
            handle.ChannelMessage += (channel, payload) => onChannel(channel, payload);
        if (onLoadRaid != null)
            handle.OnRequest("loadRaid", onLoadRaid);
        if (onLoadImage != null)
            handle.OnRequest("loadImage", onLoadImage);

        handle.LoadHtml(html);
        return true;
    }

    private static void PublishVisibility(bool visible)
    {
        Volatile.Write(ref _reportedVisible, visible ? 1 : 0);
        Interlocked.Exchange(ref _visibilityChanged, 1);
    }

    private static void PublishFailure()
    {
        Volatile.Write(ref _reportedVisible, 0);
        Interlocked.Exchange(ref _visibilityChanged, 1);
        if (Interlocked.Exchange(ref _failed, 1) == 0)
            Interlocked.Exchange(ref _failureWarningPending, 1);
    }
    public static bool TryConsumeVisibility(out bool visible)
    {
        if (Volatile.Read(ref _visibilityChanged) == 0)
        {
            visible = Volatile.Read(ref _reportedVisible) != 0;
            return false;
        }
        if (Interlocked.Exchange(ref _visibilityChanged, 0) == 0)
        {
            visible = Volatile.Read(ref _reportedVisible) != 0;
            return false;
        }

        visible = Volatile.Read(ref _reportedVisible) != 0;
        return true;
    }
    public static bool ConsumeFailureWarning()
    {
        if (Volatile.Read(ref _failureWarningPending) == 0)
            return false;
        return Interlocked.Exchange(ref _failureWarningPending, 0) != 0;
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static long RequestVisibility(bool visible)
    {
        var handle = _overlay as WebOverlay.IWebOverlay;
        if (handle == null)
            return 0;

        long requestId = Interlocked.Increment(ref _nextVisibilityRequestId);
        var completion = new VisibilityCompletionBridge(requestId, visible);
        if (visible)
            handle.Show(completion.Complete);
        else
            handle.Hide(completion.Complete);
        return requestId;
    }
    public static bool TryConsumeVisibilityCompletion(out OverlayVisibilityCompletion completion)
    {
        return VisibilityCompletions.TryDequeue(out completion);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    public static bool IsVisible()
    {
        var handle = _overlay as WebOverlay.IWebOverlay;
        return handle != null && handle.IsVisible;
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static bool Post(string channel, string payload, bool retain)
    {
        var handle = _overlay as WebOverlay.IWebOverlay;
        if (handle == null)
            return false;
        return handle.TryPost(channel, payload, retain
            ? WebOverlay.PostOptions.Retain | WebOverlay.PostOptions.LatestOnly
            : WebOverlay.PostOptions.LatestOnly);
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static void Pump()
    {
        (_overlay as WebOverlay.IWebOverlay)?.PumpEvents();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    public static void Dispose()
    {
        (_overlay as WebOverlay.IWebOverlay)?.Dispose();
        _overlay = null;
        PublishVisibility(false);
    }
}
