using Comfort.Common;
using EFT.HandBook;

namespace CombatLog.Analytics;
public static class AmmoPrice
{
    public static bool TryGetUnitPrice(string templateId, out float roubles)
    {
        roubles = 0f;

        if (string.IsNullOrEmpty(templateId) || !Singleton<Handbook>.Instantiated)
            return false;

        try
        {
            HandbookNode node = Singleton<Handbook>.Instance[templateId];
            if (node?.Data == null || node.Data.Type != ENodeType.Item)
                return false;

            roubles = node.Data.Price;
            return roubles > 0f;
        }
        catch (System.Exception ex)
        {
            Plugin.Log.LogError($"Handbook price lookup failed for {templateId}: {ex}");
            return false;
        }
    }
}
