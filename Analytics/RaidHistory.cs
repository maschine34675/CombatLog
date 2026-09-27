using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;

namespace CombatLog.Analytics;
public static class RaidHistory
{
    public const int MaxStoredRaids = 50;

    private static readonly List<string> IndexLines = new();
    private static string _dir;
    private static bool _ready;
    private static string _detailIdsJson = "";

    private static string IndexPath => Path.Combine(_dir, "index.jsonl");

    public static void Initialize()
    {
        _ready = false;
        IndexLines.Clear();
        _detailIdsJson = "";
        try
        {
            _dir = Path.Combine(BepInEx.Paths.ConfigPath, "CombatLog", "raids");
            Directory.CreateDirectory(_dir);

            if (File.Exists(IndexPath))
            {
                foreach (string line in File.ReadAllLines(IndexPath))
                {
                    if (!string.IsNullOrWhiteSpace(line))
                        IndexLines.Add(line.Trim());
                }
            }

            Prune();
            _ready = true;
        }
        catch (Exception ex)
        {
            Plugin.Log.LogError($"Raid history unavailable: {ex}");
        }
        finally
        {
            RefreshDetailAvailability();
        }
    }
    public static bool Save(long timestamp, string payloadJson, string indexLine)
    {
        if (!_ready) return false;

        try
        {
            File.WriteAllText(Path.Combine(_dir, timestamp + ".json"), payloadJson);
            if (!IndexLines.Contains(indexLine))
            {
                File.AppendAllText(IndexPath, indexLine + "\n");
                IndexLines.Add(indexLine);
            }
            Prune();
            return true;
        }
        catch (Exception ex)
        {
            Plugin.Log.LogError($"Saving the raid failed: {ex}");
            return false;
        }
        finally
        {
            RefreshDetailAvailability();
        }
    }
    public static string IndexAsJsonArrayBody()
    {
        return string.Join(",", IndexLines);
    }
    public static string DetailIdsAsJsonArrayBody() => _detailIdsJson;
    public static void RefreshDetailAvailability()
    {
        if (_dir == null)
            return;

        try
        {
            var ids = new List<long>();
            if (Directory.Exists(_dir))
            {
                foreach (string file in Directory.GetFiles(_dir, "*.json"))
                {
                    string name = Path.GetFileNameWithoutExtension(file);
                    if (long.TryParse(name, NumberStyles.None, CultureInfo.InvariantCulture, out long ts) &&
                        name == ts.ToString(CultureInfo.InvariantCulture))
                        ids.Add(ts);
                }
            }
            ids.Sort((a, b) => b.CompareTo(a));
            _detailIdsJson = string.Join(",", ids.ConvertAll(id => id.ToString(CultureInfo.InvariantCulture)));
        }
        catch (Exception ex)
        {
            Plugin.Log.LogError($"Refreshing raid detail availability failed: {ex}");
        }
    }
    public static string LoadRaid(string id)
    {
        if (!_ready || !long.TryParse(id, out long ts))
            return null;

        try
        {
            string path = Path.Combine(_dir, ts + ".json");
            return File.Exists(path) ? File.ReadAllText(path) : null;
        }
        catch (Exception ex)
        {
            Plugin.Log.LogError($"Loading raid {id} failed: {ex}");
            return null;
        }
    }

    private static void Prune()
    {
        var raids = new List<(long ts, string path)>();
        foreach (string file in Directory.GetFiles(_dir, "*.json"))
        {
            if (long.TryParse(Path.GetFileNameWithoutExtension(file), out long ts))
                raids.Add((ts, file));
        }

        raids.Sort((a, b) => b.ts.CompareTo(a.ts));
        for (int i = MaxStoredRaids; i < raids.Count; i++)
            File.Delete(raids[i].path);
        RaidPresentation.Prune(raids.GetRange(0, System.Math.Min(raids.Count, MaxStoredRaids))
            .ConvertAll(raid => raid.ts));
    }
}
