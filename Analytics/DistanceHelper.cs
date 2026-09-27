using EFT.Ballistics;
using UnityEngine;

namespace CombatLog.Analytics;

public static class DistanceHelper
{
    public static bool TryGetDistance(DamageInfo damageInfo, out float distance)
    {
        if (damageInfo.HaveOwner)
        {
            distance = Vector3.Distance(damageInfo.HitPoint, damageInfo.Player.iPlayer.Position);
            return true;
        }

        distance = 0f;
        return false;
    }
}
