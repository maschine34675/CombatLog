using EFT;

namespace CombatLog.Analytics;
public static class TargetClass
{
    public static string Of(WildSpawnType role)
    {
        string name = role.ToString();

        if (name.StartsWith("boss")) return "Boss";
        if (name.StartsWith("follower") || name.EndsWith("HelperAgro")) return "Guard";
        if (name.StartsWith("sect")) return "Cultist";
        if (name.StartsWith("infected")) return "Infected";
        if (name.StartsWith("pmc")) return "PMC";
        if (name.StartsWith("arenaFighter")) return "Raider";
        if (name == "exUsec") return "Rogue";
        if (name.Contains("Zryachiy")) return "Boss";

        return "Scav";
    }
}
