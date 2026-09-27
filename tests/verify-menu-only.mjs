import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const source = {
  plugin: read("Plugin.cs"),
  panel: read("UI/CombatLogPanel.cs"),
  gate: read("UI/WebOverlayGate.cs"),
  history: read("Analytics/RaidHistory.cs"),
};

function method(text, name) {
  const start = text.search(new RegExp(`^    (?:private|internal|public) (?:static )?[^\\r\\n]+ ${name}\\(`, "m"));
  assert.notEqual(start, -1, `${name} exists`);
  const end = text.indexOf("\n    }", start);
  assert.ok(end > start, `${name} closes at class indentation`);
  return text.slice(start, end + 6);
}

function verifyContract({ plugin, panel, gate, history }) {
  assert.doesNotMatch(plugin + panel + gate, /\b(?:ToggleKey|KeyboardShortcut|togglePressed)\b|KeyCode\.F8|CloseKeysFor\(/,
    "opening shortcut and native toggle-key close are removed");
  assert.doesNotMatch(panel, /Input\.(?:GetKey|GetButton)/, "panel never polls an opening key");
  assert.doesNotMatch(plugin, /"(?:Toggle combat log|Menu bar button)"/, "obsolete config entries are not bound");
  assert.match(plugin, /internal bool ShowTaskBarButton => true;/, "sole entry cannot be hidden by old config");
  assert.match(plugin, /_panel\.ToggleFromMenu\(\)/, "menu still reaches the report");
  assert.match(gate, /CloseKeys = new\[\] \{ 0x1B \},/, "native Escape is the sole close key");
  assert.doesNotMatch(gate, /Frame\s*=\s*false/, "native close button remains available");
  assert.match(method(panel, "OnChannelMessage"), /channel == "close"[\s\S]*RequestVisibility\(false\)/,
    "page close controls still hide the report");

  const toggle = method(panel, "Toggle");
  const update = method(panel, "Update");
  assert.match(toggle, /if \(IsRaidActive\(\)\)[\s\S]*RequestVisibility\(false\)[\s\S]*return;/,
    "menu opening rejects active raids");
  assert.ok(toggle.indexOf("if (IsRaidActive())") < toggle.indexOf("EnsureCreated("), "raid guard runs before creating a window");
  assert.match(update, /if \(IsRaidActive\(\)\)[\s\S]*RequestVisibility\(false\)[\s\S]*return;/,
    "raid transitions hide an existing report");
  assert.match(toggle, /RefreshArchiveSnapshot\(\);\s*RequestVisibility\(true\)/, "menu opening refreshes availability first");
  assert.doesNotMatch(update, /RefreshArchiveSnapshot|RefreshDetailAvailability|Directory\.|File\./,
    "ordinary Update performs no archive scan");
  assert.doesNotMatch(method(panel, "GetCachedLivePayload"), /RefreshDetailAvailability|Directory\.|File\./,
    "payload delivery reads the cache only");
  assert.match(history, /DetailIdsAsJsonArrayBody\(\) => _detailIdsJson;/, "availability getter is a cached snapshot");
  for (const name of ["Initialize", "Save"])
    assert.match(method(history, name), /finally\s*\{[\s\S]*RefreshDetailAvailability\(\)/, `${name} refreshes after partial failure too`);
  assert.match(method(panel, "ComposeLivePayload"), /historyDetailIds[\s\S]*RaidHistory\.DetailIdsAsJsonArrayBody\(\)/,
    "live frame includes actual availability");
  const stats = method(panel, "BuildStatsJson");
  const historyBlock = stats.match(/if \(includeHistory\)\s*\{([\s\S]*?)\n        }/);
  assert.ok(historyBlock, "serializer has an explicit live-only history block");
  assert.match(historyBlock[1], /historyDetailLimit/);
  assert.match(historyBlock[1], /historyDetailIds/);
  assert.match(historyBlock[1], /IndexAsJsonArrayBody/);
  assert.doesNotMatch(stats.replace(historyBlock[0], ""), /historyDetailIds|historyDetailLimit|IndexAsJsonArrayBody/,
    "stored raid serializer excludes history metadata");
  assert.doesNotMatch(method(panel, "BuildIndexLine"), /historyDetailIds|historyDetailLimit|IndexAsJsonArrayBody/,
    "index summaries exclude nested history metadata");
}

verifyContract(source);
const mutations = [
  ["hotkey field", "plugin", "private CombatLogPanel _panel;", "private CombatLogPanel _panel; public static object ToggleKey;"],
  ["key polling", "panel", "RaidPresentation.Tick();", "RaidPresentation.Tick(); Input.GetKeyDown(KeyCode.F7);"],
  ["menu hidden by config", "plugin", "ShowTaskBarButton => true;", "ShowTaskBarButton => false;"],
  ["native F8 close", "gate", "CloseKeys = new[] { 0x1B },", "CloseKeys = new[] { 0x1B, 0x77 },"],
  ["opening raid guard", "panel", "private void Toggle()\n    {\n        if (IsRaidActive())", "private void Toggle()\n    {\n        if (false)"],
  ["opening archive refresh", "panel", "RefreshArchiveSnapshot();", "/* refresh removed */"],
  ["stored history metadata", "panel", "if (includeHistory)", "if (true)"],
];
for (const [label, key, before, after] of mutations) {
  const normalized = source[key].replace(/\r\n/g, "\n");
  const changed = normalized.replace(before, after);
  assert.notEqual(changed, normalized, `negative mutation applied: ${label}`);
  assert.throws(() => verifyContract({ ...source, [key]: changed }), { name: "AssertionError" }, `negative control rejected: ${label}`);
}
const scratch = mkdtempSync(path.join(tmpdir(), "combatlog-menu-archive-"));
const program = `
using System;
using System.IO;
using System.Linq;
using System.Globalization;
using System.Collections.Generic;
using System.Text.Json;
using CombatLog.Analytics;
namespace BepInEx {
  public static class Paths {
    public static string ConfigPath => Path.Combine(AppContext.BaseDirectory, "fixture-" + Environment.ProcessId);
  }
}
namespace CombatLog {
  public static class Plugin { public static Logger Log = new Logger(); }
  public sealed class Logger { public int Errors; public void LogError(string message) { Errors++; } }
}
namespace CombatLog.Analytics {
  public static class RaidPresentation {
    public static bool FailPrune;
    public static void Prune(List<long> ids) { if (FailPrune) throw new IOException("test prune failure"); }
  }
}
class Program {
  private static string _cachedLivePayload;
  private static int _cachedHistoryPrefixLength;
  static void Check(bool ok, string why) { if (!ok) throw new Exception(why); }
  static long[] Ids() {
    using var json = JsonDocument.Parse("[" + RaidHistory.DetailIdsAsJsonArrayBody() + "]");
    return json.RootElement.EnumerateArray().Select(x => x.GetInt64()).ToArray();
  }
  static string Index(long ts) => "{\\"ts\\":" + ts.ToString(CultureInfo.InvariantCulture) + "}";
  static void CheckFrame(string stored, long[] expected, int summaryCount) {
    using var json = JsonDocument.Parse(_cachedLivePayload);
    var root = json.RootElement;
    Check(root.GetProperty("historyDetailIds").EnumerateArray().Select(x => x.GetInt64()).SequenceEqual(expected), "live detail ids");
    Check(root.GetProperty("history").GetArrayLength() == summaryCount, "live summaries preserved");
    Check(root.GetProperty("historyDetailLimit").GetInt32() == RaidHistory.MaxStoredRaids, "retention limit preserved");
    Check(root.EnumerateObject().Count(x => x.Name == "historyDetailIds") == 1, "duplicate live metadata");
    Check("{" + _cachedLivePayload.Substring(_cachedHistoryPrefixLength) == stored, "cached raid body changed");
  }
  static void Main() {
    CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("de-DE");
    string dir = Path.Combine(BepInEx.Paths.ConfigPath, "CombatLog", "raids");
    Directory.CreateDirectory(dir);
    string stored = "{\\"v\\":2,\\"ts\\":1073,\\"raid\\":{\\"location\\":\\"Fixture\\"},\\"events\\":[{\\"damage\\":12.5}]}";
    string[] originalIndex = Enumerable.Range(1000, 75).Select(i => Index(i)).ToArray();
    File.WriteAllLines(Path.Combine(dir, "index.jsonl"), originalIndex);
    foreach (long ts in new long[] { 1001, 1004, 1073 }) File.WriteAllText(Path.Combine(dir, ts + ".json"), stored);
    File.WriteAllText(Path.Combine(dir, "notes.json"), "{}");
    File.WriteAllText(Path.Combine(dir, "01005.json"), "{}");
    RaidHistory.Initialize();
    Check(Ids().SequenceEqual(new long[] { 1073, 1004, 1001 }), "initial detail ids must reflect real canonical files and holes");
    Check(RaidHistory.IndexAsJsonArrayBody() == string.Join(",", originalIndex), "startup summaries changed");
    Check(RaidHistory.LoadRaid("1001") == stored && RaidHistory.LoadRaid("1072") == null, "detail existence positive/negative controls");
    Check(RaidHistory.LoadRaid("../1001") == null, "path traversal accepted");
    _cachedLivePayload = ComposeLivePayload(stored);
    _cachedHistoryPrefixLength = _cachedLivePayload.Length - stored.Length + 1;
    CheckFrame(stored, new long[] { 1073, 1004, 1001 }, 75);

    File.Delete(Path.Combine(dir, "1004.json"));
    Check(Ids().Contains(1004), "availability getter unexpectedly performs filesystem I/O");
    RefreshArchiveSnapshot();
    CheckFrame(stored, new long[] { 1073, 1001 }, 75);
    string stable = _cachedLivePayload;
    RefreshArchiveSnapshot();
    Check(_cachedLivePayload == stable, "unchanged menu opening changes payload");

    RaidPresentation.FailPrune = true;
    Check(!RaidHistory.Save(2000, stored, Index(2000)), "partial persistence failure not reported");
    Check(Ids().Contains(2000), "written detail missing after partial persistence failure");
    Check(CombatLog.Plugin.Log.Errors == 1, "failure was not logged once");
    RaidPresentation.FailPrune = false;
    Check(RaidHistory.Save(2000, stored, Index(2000)), "persistence retry failed");
    Check(File.ReadAllLines(Path.Combine(dir, "index.jsonl")).Count(x => x == Index(2000)) == 1, "retry duplicated summary");
    Check(File.ReadAllText(Path.Combine(dir, "2000.json")) == stored, "store added live metadata to payload");

    using (var lockedIndex = new FileStream(Path.Combine(dir, "index.jsonl"), FileMode.Open, FileAccess.Read, FileShare.Read))
      Check(!RaidHistory.Save(2100, stored, Index(2100)), "locked index write did not fail");
    Check(Ids().Contains(2100), "detail availability was inferred from the index after an append failure");
    Check(!File.ReadAllLines(Path.Combine(dir, "index.jsonl")).Contains(Index(2100)), "failed index append was recorded");
    Check(CombatLog.Plugin.Log.Errors == 2, "index failure was not logged once");
    Check(RaidHistory.Save(2100, stored, Index(2100)), "index append retry failed");

    for (int i = 0; i <= RaidHistory.MaxStoredRaids; i++)
      Check(RaidHistory.Save(3000 + i, stored, Index(3000 + i)), "retention save failed");
    long[] expected = Enumerable.Range(3001, RaidHistory.MaxStoredRaids).Reverse().Select(i => (long)i).ToArray();
    Check(Ids().SequenceEqual(expected), "retention detail ids do not match actual newest files");
    Check(RaidHistory.LoadRaid("3000") == null && RaidHistory.LoadRaid("3050") == stored, "retention load boundary failed");
    int summaryCount = originalIndex.Length + 2 + RaidHistory.MaxStoredRaids + 1;
    Check(File.ReadAllLines(Path.Combine(dir, "index.jsonl")).Length == summaryCount, "pruning removed summaries");
    Check(File.Exists(Path.Combine(dir, "notes.json")), "unrelated nonnumeric file removed");
    RefreshArchiveSnapshot();
    CheckFrame(stored, expected, summaryCount);
    foreach (long ts in expected) File.Delete(Path.Combine(dir, ts + ".json"));
    RefreshArchiveSnapshot();
    CheckFrame(stored, Array.Empty<long>(), summaryCount);
    Check(RaidHistory.LoadRaid("3050") == null, "external deletion still loads");
    RaidHistory.Initialize();
    Check(Ids().Length == 0, "empty archive details not published");
    using var index = JsonDocument.Parse("[" + RaidHistory.IndexAsJsonArrayBody() + "]");
    Check(index.RootElement.GetArrayLength() == summaryCount, "reinitialization duplicated summaries");
    Check(index.RootElement.EnumerateArray().All(row => !row.TryGetProperty("historyDetailIds", out _)), "index includes live metadata");
    Console.WriteLine("ACTUAL ARCHIVE STORAGE AND LIVE SNAPSHOT VERIFIED");
  }
${method(source.panel, "ComposeLivePayload")}
${method(source.panel, "RefreshArchiveSnapshot")}
}
`;

try {
  writeFileSync(path.join(scratch, "Test.csproj"), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><OutputType>Exe</OutputType><LangVersion>latest</LangVersion><Nullable>disable</Nullable></PropertyGroup></Project>');
  writeFileSync(path.join(scratch, "Program.cs"), program);
  const run = history => {
    writeFileSync(path.join(scratch, "RaidHistory.cs"), history);
    const result = spawnSync("dotnet", ["run", "--project", path.join(scratch, "Test.csproj"), "--configuration", "Release", "--verbosity", "quiet"],
      { cwd: scratch, encoding: "utf8", timeout: 60000, windowsHide: true });
    assert.ifError(result.error);
    return result;
  };
  const positive = run(source.history);
  assert.equal(positive.status, 0, positive.stdout + positive.stderr);
  assert.match(positive.stdout, /ACTUAL ARCHIVE STORAGE AND LIVE SNAPSHOT VERIFIED/);
  for (const [label, before, after, failure] of [
    ["empty availability", "DetailIdsAsJsonArrayBody() => _detailIdsJson;", 'DetailIdsAsJsonArrayBody() => "";', /initial detail ids/],
    ["pruning disabled", "for (int i = MaxStoredRaids; i < raids.Count; i++)", "for (int i = raids.Count; i < raids.Count; i++)", /retention detail ids/],
  ]) {
    const changed = source.history.replace(before, after);
    assert.notEqual(changed, source.history, `executable mutation applied: ${label}`);
    const negative = run(changed);
    assert.notEqual(negative.status, 0, `broken storage must fail: ${label}`);
    assert.match(negative.stdout + negative.stderr, failure, `behavioral failure observed: ${label}`);
    assert.doesNotMatch(negative.stdout, /ACTUAL ARCHIVE STORAGE AND LIVE SNAPSHOT VERIFIED/);
  }
} finally {
  const resolved = realpathSync(scratch);
  assert.equal(path.dirname(resolved), realpathSync(tmpdir()));
  assert.ok(path.basename(resolved).startsWith("combatlog-menu-archive-"));
  rmSync(resolved, { recursive: true });
}

console.log(`COMBATLOG MENU AND ARCHIVE CONTRACT VERIFIED (${mutations.length} source and 2 executable negative controls)`);
