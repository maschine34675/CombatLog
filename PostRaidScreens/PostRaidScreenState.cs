using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using EFT;

namespace CombatLog.PostRaidScreens;
internal static class PostRaidScreenState
{
    private const int MaxIdentityLength = 256;
    private const int MaxSourceIdLength = 256;
    private const int MaxProfileSequences = 256;
    private const int MaxKillEvents = 512;
    private static readonly Dictionary<string, List<string>> KillAmmoByProfile =
        new(StringComparer.Ordinal);
    private static ConditionalWeakTable<VictimStats, KillAmmoBinding> KillAmmoByVictim = new();
    private static int _killEventCount;

    private sealed class KillAmmoBinding
    {
        internal readonly string AmmoTemplateId;

        internal KillAmmoBinding(string ammoTemplateId)
        {
            AmmoTemplateId = ammoTemplateId;
        }
    }

    internal static void RecordKill(string profileId, string ammoTemplateId)
    {
        string id = Bounded(profileId, MaxIdentityLength);
        string ammo = Bounded(ammoTemplateId, MaxSourceIdLength);
        if (id == null || _killEventCount >= MaxKillEvents)
            return;

        if (!KillAmmoByProfile.TryGetValue(id, out List<string> sequence))
        {
            if (KillAmmoByProfile.Count >= MaxProfileSequences)
                return;
            sequence = new List<string>();
            KillAmmoByProfile.Add(id, sequence);
        }
        sequence.Add(ammo);
        _killEventCount++;
    }

    internal static void BindKillAmmo(IEnumerable<VictimStats> victims)
    {
        if (victims == null)
            return;

        var occurrences = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (VictimStats victim in victims)
        {
            if (victim == null)
                continue;
            KillAmmoByVictim.Remove(victim);
            string id = Bounded(victim.ProfileId, MaxIdentityLength);
            if (id == null)
                continue;

            occurrences.TryGetValue(id, out int occurrence);
            occurrences[id] = occurrence + 1;
            if (!KillAmmoByProfile.TryGetValue(id, out List<string> sequence) ||
                occurrence >= sequence.Count)
                continue;

            string ammo = sequence[occurrence];
            if (ammo != null)
                KillAmmoByVictim.Add(victim, new KillAmmoBinding(ammo));
        }
    }

    internal static bool TryGetKillAmmo(VictimStats victim, out string ammoTemplateId)
    {
        if (victim != null && KillAmmoByVictim.TryGetValue(victim, out KillAmmoBinding binding))
        {
            ammoTemplateId = binding.AmmoTemplateId;
            return true;
        }

        ammoTemplateId = null;
        return false;
    }

    internal static void Clear()
    {
        KillAmmoByProfile.Clear();
        KillAmmoByVictim = new ConditionalWeakTable<VictimStats, KillAmmoBinding>();
        _killEventCount = 0;
    }

    private static string Bounded(string value, int maximumLength)
    {
        if (string.IsNullOrWhiteSpace(value))
            return null;
        string trimmed = value.Trim();
        return trimmed.Length <= maximumLength ? trimmed : null;
    }
}
