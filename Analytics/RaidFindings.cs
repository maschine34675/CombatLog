using System.Collections.Generic;
using System.Linq;

namespace CombatLog.Analytics;
public class Finding
{
    public string Title;
    public string Detail;
    public bool Negative;
}
public static class RaidFindings
{
    public static List<Finding> Build()
    {
        var found = new List<Finding>();
        var dealt = RaidAnalytics.ShotsDealt;
        var received = RaidAnalytics.ShotsReceived;
        if (dealt.Count == 0 && received.Count == 0)
            return found;

        var byTarget = dealt
            .Where(s => !string.IsNullOrEmpty(s.TargetProfileId))
            .GroupBy(s => s.TargetProfileId)
            .ToList();
        int oneTaps = byTarget.Count(g =>
            g.Count() == 1 && g.Any(s => s.Fatal && !s.FatalInferred));
        if (oneTaps > 0)
            Add(found, "One-tap", $"{oneTaps} {(oneTaps == 1 ? "target" : "targets")} killed with a single hit", false);
        var longest = dealt.Where(s => s.Distance > 0).OrderByDescending(s => s.Distance).FirstOrDefault();
        if (longest.Distance >= 100f)
            Add(found, "Long shot", $"{longest.Distance:F0} m with {longest.WeaponName ?? "unknown weapon"}", false);
        var wall = byTarget
            .Select(g => new { g.Key, Stopped = g.Count(s => s.Blocked || s.Deflected), Total = g.Count(), First = g.First() })
            .Where(x => x.Stopped >= 4)
            .OrderByDescending(x => x.Stopped)
            .FirstOrDefault();
        if (wall != null)
        {
            string ammo = AmmoLocale.GetAmmoShortName(wall.First.AmmoTemplateId) ?? "your ammo";
            Add(found, "Armour wall",
                $"{wall.Stopped} of {wall.Total} hits on {wall.First.TargetName ?? "one target"} stopped — {ammo} did not get through",
                true);
        }
        var overkill = byTarget
            .Where(g => g.Any(s => s.Fatal && !s.FatalInferred) && g.Count() >= 12)
            .OrderByDescending(g => g.Count())
            .FirstOrDefault();
        if (overkill != null)
            Add(found, "Overkill",
                $"{overkill.Count()} hits to kill {overkill.First().TargetName ?? "one target"}",
                true);
        int helmetSaves = received.Count(s => s.Deflected && s.BodyPart == EBodyPart.Head);
        if (helmetSaves > 0)
            Add(found, "Helmet held",
                $"{helmetSaves} {(helmetSaves == 1 ? "round" : "rounds")} deflected off your head",
                false);
        int fired = RaidAnalytics.Accuracy.Values.Sum(a => a.Fired);
        int hits = RaidAnalytics.Accuracy.Values.Sum(a => a.Hits);
        if (fired >= 40)
        {
            float rate = (float)hits / fired * 100f;
            if (rate < 25f)
                Add(found, "Spray", $"{hits} of {fired} rounds found a target ({rate:F0}%)", true);
            else if (rate >= 60f)
                Add(found, "Disciplined fire", $"{hits} of {fired} rounds on target ({rate:F0}%)", false);
        }
        if (dealt.Count >= 8)
        {
            int heads = dealt.Count(s => s.BodyPart == EBodyPart.Head);
            float share = (float)heads / dealt.Count * 100f;
            if (share >= 25f)
                Add(found, "Head hunter", $"{heads} of {dealt.Count} hits to the head ({share:F0}%)", false);
        }
        float saved = received.Sum(s => UnityEngine.Mathf.Max(0f, s.DamageBeforeArmor - s.DamageAfterArmor));
        if (saved >= 50f)
            Add(found, "Armour earned its weight", $"{saved:F0} damage absorbed across {received.Count} hits", false);

        return found;
    }

    private static void Add(List<Finding> list, string title, string detail, bool negative)
    {
        list.Add(new Finding { Title = title, Detail = detail, Negative = negative });
    }
}
