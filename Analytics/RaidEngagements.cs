using System.Collections.Generic;
using System.Linq;

namespace CombatLog.Analytics;
public class Engagement
{
    public float StartTime;
    public float EndTime;
    public readonly List<ShotRecord> Dealt = new();
    public readonly List<ShotRecord> Received = new();
    public readonly List<KeyValuePair<string, string>> Opponents = new();
    public int Kills;
    public int KillLinks;
    public bool EndedInPlayerDeath;

    public float Duration => EndTime - StartTime;
    public float DamageDealt => Dealt.Sum(s => s.DamageAfterArmor);
    public float DamageReceived => Received.Sum(s => s.DamageAfterArmor);
}
public static class RaidEngagements
{
    public const float GapSeconds = 25f;

    public static List<Engagement> Build()
    {
        var all = new List<(ShotRecord shot, bool dealt)>(
            RaidAnalytics.ShotsDealt.Count + RaidAnalytics.ShotsReceived.Count);

        foreach (var s in RaidAnalytics.ShotsDealt) all.Add((s, true));
        foreach (var s in RaidAnalytics.ShotsReceived) all.Add((s, false));
        if (all.Count == 0) return new List<Engagement>();

        all.Sort((a, b) => a.shot.Time.CompareTo(b.shot.Time));

        var result = new List<Engagement>();
        Engagement current = null;

        foreach (var (shot, dealt) in all)
        {
            if (current == null || shot.Time - current.EndTime > GapSeconds)
            {
                current = new Engagement { StartTime = shot.Time, EndTime = shot.Time };
                result.Add(current);
            }

            current.EndTime = shot.Time;
            (dealt ? current.Dealt : current.Received).Add(shot);

            string id = shot.OpponentProfileId;
            if (!string.IsNullOrEmpty(id) && !current.Opponents.Any(p => p.Key == id))
                current.Opponents.Add(new KeyValuePair<string, string>(id, shot.OpponentName ?? "Unknown"));
        }
        foreach (var engagement in result)
        {
            engagement.Kills = engagement.Dealt.Count(s => s.Fatal && !s.FatalInferred);
            engagement.KillLinks = engagement.Dealt.Count(s => s.Fatal && s.FatalInferred);
        }

        return result;
    }
}
