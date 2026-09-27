using EFT;

namespace CombatLog.Analytics;
public static class RaidMeta
{
    public static string Location = string.Empty;
    public static float StartTime;
    public static float EndTime;
    public static bool Finished;
    public static ExitStatus Exit = ExitStatus.Survived;
    public static bool Started;
    public static float Duration =>
        !Started ? 0f : (Finished ? EndTime : UnityEngine.Time.time) - StartTime;

    public static void BeginRaid(string location)
    {
        Location = location ?? string.Empty;
        StartTime = UnityEngine.Time.time;
        EndTime = 0f;
        Finished = false;
        Started = true;
        Exit = ExitStatus.Survived;
    }
    public static bool EndRaid(ExitStatus exitStatus)
    {
        if (Finished) return false;
        Exit = exitStatus;
        EndTime = UnityEngine.Time.time;
        Finished = true;
        CaptureLocation();
        return true;
    }
    public static void CaptureLocation()
    {
        if (!string.IsNullOrEmpty(Location)) return;
        var gw = Comfort.Common.Singleton<GameWorld>.Instance;
        if (gw != null && !string.IsNullOrEmpty(gw.LocationId))
            Location = gw.LocationId;
    }
    public static string ExitLabel
    {
        get
        {
            switch (Exit)
            {
                case ExitStatus.Survived: return "SURVIVED";
                case ExitStatus.Killed: return "KILLED IN ACTION";
                case ExitStatus.Left: return "LEFT";
                case ExitStatus.Runner: return "RAN THROUGH";
                case ExitStatus.MissingInAction: return "MISSING IN ACTION";
                case ExitStatus.Transit: return "IN TRANSIT";
                default: return "UNKNOWN";
            }
        }
    }
    public static string LocationName
    {
        get
        {
            CaptureLocation();
            if (string.IsNullOrEmpty(Location)) return "Unknown location";
            string localized = Location.Localized(null);
            return string.IsNullOrEmpty(localized) ? Location : localized;
        }
    }
}
