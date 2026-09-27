import { readFileSync } from "node:fs";

function readSource(path) {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

const panel = readSource("UI/CombatLogPanel.cs");
const gate = readSource("UI/WebOverlayGate.cs");
const patches = readSource("Analytics/CombatLogShotPatches.cs");
const history = readSource("Analytics/RaidHistory.cs");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function method(source, marker) {
  const start = source.indexOf(marker);
  assert(start >= 0, "method marker missing: " + marker);
  const open = source.indexOf("{", start);
  assert(open >= 0, "method body missing: " + marker);
  let depth = 0;
  let mode = "code";
  for (let i = open; i < source.length; i++) {
    const c = source[i], n = source[i + 1];
    if (mode === "line") { if (c === "\n") mode = "code"; continue; }
    if (mode === "block") { if (c === "*" && n === "/") { mode = "code"; i++; } continue; }
    if (mode === "string") {
      if (c === "\\") { i++; continue; }
      if (c === '"') mode = "code";
      continue;
    }
    if (mode === "char") {
      if (c === "\\") { i++; continue; }
      if (c === "'") mode = "code";
      continue;
    }
    if (c === "/" && n === "/") { mode = "line"; i++; continue; }
    if (c === "/" && n === "*") { mode = "block"; i++; continue; }
    if (c === '"') { mode = "string"; continue; }
    if (c === "'") { mode = "char"; continue; }
    if (c === "{") depth++;
    if (c === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error("unterminated method: " + marker);
}

function contractFailures(panelSource, gateSource, patchSource) {
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const body = (source, marker) => {
    try { return method(source, marker); }
    catch { failures.push("missing " + marker); return ""; }
  };

  const update = body(panelSource, "private void Update()");
  const toggle = body(panelSource, "private void Toggle()");
  const begin = body(panelSource, "internal static void BeginCurrentRaid()");
  const save = body(panelSource, "internal static void SaveCurrentRaid()");
  const flush = body(panelSource, "internal static void FlushPendingRaid()");
  const destroy = body(panelSource, "private void OnDestroy()");
  const push = body(panelSource, "private void PushStats()");
  const pump = body(panelSource, "private bool PumpOverlayEvents()");
  const reconcile = body(panelSource, "private void ReconcileNativeOverlayState()");
  const cached = body(panelSource, "private static string GetCachedLivePayload()");
  const compose = body(panelSource, "private static string ComposeLivePayload(");
  const indexLine = body(panelSource, "private static string BuildIndexLine(");
  const ensure = body(gateSource, "public static bool EnsureCreated(");
  const publishVisibility = body(gateSource, "private static void PublishVisibility(");
  const publishFailure = body(gateSource, "private static void PublishFailure()");
  const consumeVisibility = body(gateSource, "public static bool TryConsumeVisibility(");
  const consumeFailure = body(gateSource, "public static bool ConsumeFailureWarning()");

  check(panelSource.includes("private static bool IsRaidActive() => RaidMeta.Started && !RaidMeta.Finished;"),
    "active-raid predicate is not tied to RaidMeta lifecycle");
  check(begin.includes("_instance?.RequestVisibility(false)") &&
      !begin.includes("WebOverlayGate.Hide()"),
    "raid start bypasses the correlated visibility state machine");
  check(update.includes("if (IsRaidActive())") && update.indexOf("if (IsRaidActive())") < update.indexOf("PushStats()"),
    "Update can push stats before rejecting an active raid");
  check(toggle.includes("if (IsRaidActive())") && toggle.indexOf("if (IsRaidActive())") < toggle.indexOf("EnsureCreated"),
    "F8/menu toggle can create or show the report during a raid");

  check(gateSource.includes("handle.VisibilityChanged += PublishVisibility;"),
    "native visibility is not subscribed through WebOverlayGate");
  check(gateSource.includes("handle.Failed += PublishFailure;"),
    "native failure is not subscribed through WebOverlayGate");
  check(gateSource.slice(Math.max(0, gateSource.indexOf("public static bool EnsureCreated(") - 100),
    gateSource.indexOf("public static bool EnsureCreated(")).includes("MethodImplOptions.NoInlining"),
    "WebOverlay EnsureCreated lost its no-inlining boundary");
  for (const [name, callback] of [["visibility", publishVisibility], ["failure", publishFailure]]) {
    check(!/Plugin\.|UnityEngine|LogWarning|logWarning\s*\(/.test(callback),
      name + " callback mutates/logs through game state instead of publishing callback state");
  }
  const callbackBridge = publishVisibility + publishFailure + consumeVisibility + consumeFailure;
  check(!/\block\s*\(|Monitor\.(Enter|TryEnter)/.test(callbackBridge) &&
      !gateSource.includes("CallbackState"),
    "per-frame callback reconciliation still acquires a Monitor lock");
  check(publishVisibility.includes("Volatile.Write") && publishVisibility.includes("Interlocked.Exchange") &&
      consumeVisibility.includes("Interlocked.Exchange") && consumeVisibility.includes("Volatile.Read") &&
      publishFailure.includes("Interlocked.Exchange") && consumeFailure.includes("Interlocked.Exchange") &&
      consumeFailure.includes("Volatile.Read"),
    "callback state is not published and consumed through lock-free memory barriers");
  check(reconcile.includes("TryConsumeVisibility") && reconcile.includes("_open = false") &&
      reconcile.includes("HasFailed"),
    "Update-side reconciliation does not clear open state after native hide/failure");
  check(pump.includes("ReconcileNativeOverlayState()"),
    "Pump does not reconcile a close/failure before payload work resumes");
  check(update.indexOf("if (!_open)") > update.indexOf("PumpOverlayEvents()") &&
      update.indexOf("if (!_open)") < update.indexOf("PushStats()"),
    "hidden overlay can still serialize after native event pumping");

  check(save.includes("PendingRaids.Add(new PendingRaidSnapshot") && save.includes("RaidPresentation.EndRaid()"),
    "Stop-side save does not mark a finalized presentation as pending");
  check(!save.includes("BuildStatsJson") && !save.includes("BuildIndexLine") && !save.includes("RaidHistory.Save"),
    "Stop-side save still aggregates or writes history synchronously");
  check(panelSource.includes("private static readonly List<PendingRaidSnapshot> PendingRaids = new();") &&
      flush.includes("PendingRaidSnapshot latest = PendingRaids[PendingRaids.Count - 1]") &&
      flush.includes("string stored = BuildStatsJson(latest.Timestamp, includeHistory: false)") &&
      flush.includes("string indexLine = BuildIndexLine(latest.Timestamp)") &&
      flush.indexOf("latest.StoredPayload = stored") > flush.indexOf("string indexLine = BuildIndexLine") &&
      flush.indexOf("latest.IndexLine = indexLine") > flush.indexOf("string indexLine = BuildIndexLine") &&
      !flush.includes("latest.StoredPayload = null") &&
      flush.includes("while (PendingRaids.Count > 0)") &&
      flush.includes("!RaidHistory.Save(pending.Timestamp, pending.StoredPayload, pending.IndexLine)") &&
      flush.indexOf("break;") < flush.indexOf("PendingRaids.RemoveAt(0)") &&
      flush.includes("ComposeLivePayload(latest.StoredPayload)"),
    "deferred flush does not retain immutable ordered snapshots across persistence failures");
  check(update.includes("if (PendingRaids.Count > 0 && !_finalizationAttempted)") && update.includes("FlushPendingRaid()"),
    "ordinary main-thread Update does not perform pending finalization");
  check(destroy.indexOf("FlushPendingRaid()") >= 0 &&
      destroy.indexOf("FlushPendingRaid()") < destroy.indexOf("RaidPresentation.Dispose()"),
    "destroy does not flush before presentation ownership is released");
  check(push.includes("GetCachedLivePayload()") && !push.includes("BuildStatsJson"),
    "polling still re-aggregates the raid payload");
  check(cached.includes("_cachedLivePayload") && compose.includes("RaidHistory.IndexAsJsonArrayBody()") &&
      compose.includes("stored.Substring(1)"),
    "live history is not composed from the cached history-free payload");
  check(!panelSource.includes("_cachedStoredPayload"),
    "history-free and live payloads are both retained in memory");
  check(!toggle.includes("_lastPayload = null"), "reopening discards retained-delivery state");
  check(push.includes("retain: true"), "stats delivery is no longer retained");
  check(toggle.includes("RaidHistory.LoadRaid") && toggle.includes("RaidPresentation.LoadImage"),
    "archived raid or image request handlers were dropped");
  check(indexLine.includes("DateTimeOffset.FromUnixTimeMilliseconds(ts).ToLocalTime()") &&
      !indexLine.includes("DateTime.Now"),
    "history date is derived from flush time instead of the stable raid timestamp");

  const raidStart = body(patchSource, "public class CombatLogRaidStartPatch");
  check(raidStart.includes("CombatLogPanel.FlushPendingRaid()") &&
      raidStart.indexOf("CombatLogPanel.FlushPendingRaid()") < raidStart.indexOf("RaidAnalytics.Clear()"),
    "next raid does not flush pending data before analytics are cleared");

  return failures;
}

const positive = contractFailures(panel, gate, patches);
assert(positive.length === 0, "source contract failed:\n- " + positive.join("\n- "));
assert(history.includes("public static bool Save(long timestamp, string payloadJson, string indexLine)") &&
  history.includes("if (!_ready) return false;") && history.includes("return true;") &&
  history.includes("if (!IndexLines.Contains(indexLine))"),
  "history persistence cannot report or idempotently retry a failed save");
class Lifecycle {
  constructor() {
    this.active = false; this.open = false; this.visible = false; this.failed = false;
    this.pending = []; this.cache = null; this.builds = 0; this.writes = 0;
    this.analyticsCleared = false; this.flushSawCleared = null;
    this.attempted = false; this.failedWrites = 0; this.analytics = "raid-1";
  }
  requestOpen() {
    if (this.active || this.failed) { this.open = false; this.visible = false; return false; }
    this.open = true; this.visible = true; return true;
  }
  nativeVisibility(value) { this.visible = value; this.open = value && !this.failed && !this.active; }
  fail() { this.failed = true; this.nativeVisibility(false); }
  finish() { this.active = false; this.pending.push({ stored: null }); this.attempted = false; this.cache = null; }
  flush() {
    if (this.pending.length === 0) return;
    this.attempted = true;
    const latest = this.pending.at(-1);
    if (latest.stored === null) {
      this.flushSawCleared = this.analyticsCleared;
      latest.stored = this.analytics;
      this.builds++;
    }
    while (this.pending.length > 0) {
      this.writes++;
      if (this.failedWrites > 0) { this.failedWrites--; break; }
      this.pending.shift();
    }
    this.cache = latest.stored;
  }
  update() { if (this.pending.length > 0 && !this.attempted) this.flush(); if (this.active) this.nativeVisibility(false); }
  start() {
    this.flush();
    this.analyticsCleared = true;
    this.analytics = "new-raid";
    this.active = true;
    this.cache = null;
    this.nativeVisibility(false);
  }
  destroy() { this.flush(); }
  poll() { if (this.open && this.cache === null) { this.builds++; this.cache = "finished-raid"; } }
}

{
  const life = new Lifecycle();
  life.active = true;
  assert(!life.requestOpen() && !life.open, "active raid accepted F8/menu open");
}
{
  const life = new Lifecycle();
  life.requestOpen(); life.start();
  assert(!life.visible && !life.open, "raid start left an existing report visible");
}
{
  const life = new Lifecycle();
  life.requestOpen(); life.nativeVisibility(false); life.poll();
  assert(!life.open && life.builds === 0, "native close kept polling/serialization alive");
  life.requestOpen(); life.fail(); life.poll();
  assert(!life.open && life.builds === 0, "overlay failure kept polling/serialization alive");
}
{
  const life = new Lifecycle();
  life.finish();
  assert(life.builds === 0 && life.writes === 0, "Stop-side finish eagerly aggregated or wrote");
  life.update();
  assert(life.builds === 1 && life.writes === 1, "Update did not finalize exactly once");
  life.requestOpen();
  for (let i = 0; i < 10; i++) life.poll();
  life.nativeVisibility(false); life.requestOpen(); life.poll();
  assert(life.builds === 1, "poll/reopen rebuilt an immutable finished payload");
}
{
  const life = new Lifecycle();
  life.finish(); life.start();
  assert(life.builds === 1 && life.writes === 1 && life.flushSawCleared === false,
    "next-raid fallback did not flush before analytics clear");
}
{
  const life = new Lifecycle();
  life.finish(); life.destroy();
  assert(life.builds === 1 && life.writes === 1, "destroy fallback lost a pending raid");
}
{
  const life = new Lifecycle();
  life.failedWrites = 1; life.finish(); life.update();
  assert(life.pending.length === 1 && life.pending[0].stored === "raid-1" &&
    life.cache === "raid-1" && life.writes === 1,
    "failed persistence discarded either the retry marker or live report");
  life.update();
  assert(life.writes === 1, "failed persistence retried on every frame");
  life.start();
  assert(life.pending.length === 0 && life.writes === 2 && life.flushSawCleared === false,
    "next-raid fallback did not retry failed persistence before analytics clear");
}
{
  const life = new Lifecycle();
  life.failedWrites = 2; life.finish(); life.update();
  life.start();
  assert(life.pending.length === 1 && life.pending[0].stored === "raid-1" &&
    life.analytics === "new-raid" && life.writes === 2,
    "second start-time failure lost the immutable previous raid snapshot");
  life.analyticsCleared = false;
  life.finish(); life.update();
  assert(life.pending.length === 0 && life.builds === 2 && life.writes === 4 &&
    life.cache === "new-raid",
    "later raid did not drain old and new immutable snapshots in chronological order");
}
const mutants = [
  ["active predicate", panel.replace(
    "private static bool IsRaidActive() => RaidMeta.Started && !RaidMeta.Finished;",
    "private static bool IsRaidActive() => false;"), gate, patches],
  ["raid-start visibility bypass", panel.replace(
    "_instance?.RequestVisibility(false);", "WebOverlayGate.Hide();"), gate, patches],
  ["visibility subscription", panel, gate.replace("handle.VisibilityChanged += PublishVisibility;", ""), patches],
  ["per-frame callback lock", panel, gate.replace(
    "public static bool TryConsumeVisibility(out bool visible)\n    {",
    "public static bool TryConsumeVisibility(out bool visible)\n    {\n        lock (new object()) { }"), patches],
  ["eager Stop aggregation", panel.replace(
    "internal static void SaveCurrentRaid()\n    {",
    "internal static void SaveCurrentRaid()\n    {\n        string eager = BuildStatsJson(_currentRaidTs, includeHistory: false);"), gate, patches],
  ["destroy loss", panel.replace(
    "private void OnDestroy()\n    {\n        if (object.ReferenceEquals(_instance, this))\n            _instance = null;\n\n        // Shutdown and an immediate next raid are the two loss-safety paths\n        // for a finalization that did not receive another ordinary Update.\n        FlushPendingRaid();",
    "private void OnDestroy()\n    {\n        if (object.ReferenceEquals(_instance, this))\n            _instance = null;"), gate, patches],
  ["reopen reset", panel.replace(
    "WebOverlayGate.Pump();\n        ReconcileNativeOverlayState();",
    "WebOverlayGate.Pump();\n        _lastPayload = null;\n        ReconcileNativeOverlayState();"), gate, patches],
  ["missing next-raid flush", panel, gate,
    patches.replace("UI.CombatLogPanel.FlushPendingRaid();", "")],
  ["discarded failed save", panel.replace("                PendingRaids.RemoveAt(0);", "                PendingRaids.Clear();"), gate, patches],
  ["rebuilt pending snapshot", panel.replace(
    "            if (latest.StoredPayload == null || latest.IndexLine == null)",
    "            latest.StoredPayload = null;\n            if (latest.StoredPayload == null || latest.IndexLine == null)"), gate, patches],
  ["flush-time history date", panel.replace(
    "System.DateTimeOffset.FromUnixTimeMilliseconds(ts).ToLocalTime()",
    "System.DateTimeOffset.Now"), gate, patches],
];
for (const [name, mutantPanel, mutantGate, mutantPatches] of mutants) {
  assert(contractFailures(mutantPanel, mutantGate, mutantPatches).length > 0,
    "mutant control escaped: " + name);
}

console.log("COMBATLOG OVERLAY LIFECYCLE VERIFIED");
