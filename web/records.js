/* Per-raid records from captured contacts only. No telemetry or dependencies. */
(function (root) {
  "use strict";

  function nonnegative(value) {
    return typeof value === "number" && isFinite(value) && value >= 0;
  }

  function opponentId(hit) {
    return typeof hit.opponentId === "string" && hit.opponentId.trim() ? hit.opponentId : null;
  }

  function opponentName(hit) {
    var name = typeof hit.who === "string" ? hit.who.trim() : "";
    return /^(unknown|unknown target|unknown opponent|unknown attacker)$/i.test(name) ? "" : name;
  }

  function chronological(a, b) {
    var at = nonnegative(a.hit.t) ? a.hit.t : Infinity;
    var bt = nonnegative(b.hit.t) ? b.hit.t : Infinity;
    if (at < bt) return -1;
    if (at > bt) return 1;
    return a.index - b.index;
  }

  function emptyRecord(id) {
    return { id: id, value: null, hit: null, tieCount: 0, groupHits: [], identityKnown: false };
  }

  function maximum(entries, id, field, dealt) {
    var record = emptyRecord(id);
    var tied = [];
    entries.forEach(function (entry) {
      var value = entry.hit[field];
      if (entry.hit.dealt !== dealt || !nonnegative(value) || value === 0) return;
      if (record.value === null || value > record.value) {
        record.value = value;
        tied = [entry];
      } else if (value === record.value) {
        tied.push(entry);
      }
    });
    if (!tied.length) return record;
    tied.sort(chronological);
    record.hit = tied[0].hit;
    record.tieCount = tied.length;
    record.groupHits = tied.map(function (entry) { return entry.hit; });
    record.identityKnown = opponentId(record.hit) !== null;
    return record;
  }

  function mostHitOpponent(entries) {
    var record = emptyRecord("most-hit-opponent");
    record.opponentId = null;
    record.name = "";
    var groups = Object.create(null);
    var candidates = [];
    entries.forEach(function (entry) {
      var hit = entry.hit;
      if (hit.dealt !== true) return;
      var id = opponentId(hit);
      var name = opponentName(hit);
      if (id === null && !name) return;
      var key = id !== null ? "id:" + id :
        "legacy:" + name.toLowerCase() + "|" + String(hit.cls || "").trim().toLowerCase();
      var group = groups[key];
      if (!group) {
        group = groups[key] = { opponentId: id, entries: [] };
        candidates.push(group);
      }
      group.entries.push(entry);
    });

    candidates.forEach(function (group) { group.entries.sort(chronological); });
    candidates.sort(function (a, b) {
      return b.entries.length - a.entries.length || chronological(a.entries[0], b.entries[0]);
    });
    if (!candidates.length) return record;
    var winner = candidates[0];
    record.value = winner.entries.length;
    record.hit = winner.entries[0].hit;
    record.tieCount = candidates.filter(function (group) { return group.entries.length === record.value; }).length;
    record.groupHits = winner.entries.map(function (entry) { return entry.hit; });
    record.opponentId = winner.opponentId;
    record.identityKnown = winner.opponentId !== null;
    for (var i = 0; i < winner.entries.length && !record.name; i++) {
      record.name = opponentName(winner.entries[i].hit);
    }
    if (!record.name) record.name = "Unknown opponent";
    return record;
  }

  function derive(hits) {
    var entries = [];
    if (Array.isArray(hits)) hits.forEach(function (hit, index) {
      if (hit && typeof hit === "object" && !Array.isArray(hit)) entries.push({ hit: hit, index: index });
    });
    return [
      maximum(entries, "farthest-hit", "dist", true),
      maximum(entries, "strongest-dealt", "after", true),
      maximum(entries, "strongest-taken", "after", false),
      mostHitOpponent(entries)
    ];
  }

  root.CombatRecords = { derive: derive };
})(window);
