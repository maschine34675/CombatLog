using EFT;

namespace CombatLog.Analytics;

public static class AmmoLocale
{
    public static string GetAmmoShortName(string templateId)
    {
        return string.IsNullOrEmpty(templateId) ? null : $"{templateId} ShortName".Localized();
    }
}
