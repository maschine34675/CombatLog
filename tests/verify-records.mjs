import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const window = Object.create(null);
const context = vm.createContext({ window });
new vm.Script(readFileSync(new URL("../web/records.js", import.meta.url), "utf8"), {
  filename: "records.js",
}).runInContext(context);
const derive = window.CombatRecords?.derive;
assert.equal(typeof derive, "function", "browser-native derivation API missing");
const ids = ["farthest-hit", "strongest-dealt", "strongest-taken", "most-hit-opponent"];
let cases = 0;
function test(name, run) {
  try { run(); } catch (error) { error.message = name + ": " + error.message; throw error; }
  cases++;
}
function hit(overrides = {}) {
  return {
    t: 1, dealt: true, opponentId: "op-a", who: "Alpha", cls: "PMC",
    dist: 24, before: 80, after: 30, armorDamage: 50,
    weapon: "M4A1", ammo: "M855", ...overrides,
  };
}
function records(hits) {
  const result = derive(hits);
  assert.equal(result.length, 4);
  assert.deepEqual(Array.from(result, (r) => r.id), ids);
  for (const record of result) {
    assert(Array.isArray(record.groupHits));
    assert.equal(typeof record.identityKnown, "boolean");
    assert(Number.isInteger(record.tieCount) && record.tieCount >= 0);
    if (record.value === null) {
      assert.equal(record.hit, null);
      assert.equal(record.tieCount, 0);
      assert.equal(record.groupHits.length, 0);
      assert.equal(record.identityKnown, false);
    } else {
      assert(Number.isFinite(record.value) && record.value > 0);
      assert(hits.includes(record.hit), "selected hit must be an original object");
      assert(record.tieCount >= 1);
      assert(record.groupHits.length >= 1);
      assert.equal(record.groupHits[0], record.hit);
      for (const evidence of record.groupHits) assert(hits.includes(evidence), "group evidence must preserve references");
    }
  }
  assert(result[3].opponentId === null || typeof result[3].opponentId === "string");
  assert.equal(typeof result[3].name, "string");
  return result;
}
function refs(actual, expected) {
  assert.equal(actual.length, expected.length);
  expected.forEach((value, index) => assert.equal(actual[index], value, "evidence order/reference differs at " + index));
}
function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

test("no browser, backend or module dependency", () => {
  assert.deepEqual(Object.keys(window), ["CombatRecords"]);
  assert.deepEqual(Object.keys(context), ["window"]);
  assert.deepEqual(Object.keys(window.CombatRecords), ["derive"]);
});

test("empty and missing arrays retain the four honest placeholders", () => {
  for (const input of [[], undefined, null, {}, "", "hits", true, 1]) {
    const result = records(input);
    assert(result.every((record) => record.value === null));
    assert.equal(result[3].opponentId, null);
    assert.equal(result[3].name, "");
  }
});

test("sparse arrays and non-hit elements are harmless", () => {
  const malformed = [null, undefined, false, true, 42, "hit", [], () => {}, {}];
  malformed.length += 3;
  assert(records(malformed).every((record) => record.value === null));
});

test("four records select the correct direction and post-armour body damage", () => {
  const far = hit({ t: 50, dist: 123.75, after: 15 });
  const strong = hit({ t: 80, opponentId: "op-b", who: "Bravo", dist: 4, before: 150, after: 100.5 });
  const incoming = hit({ t: 20, dealt: false, dist: 9000, before: 300, after: 260.25 });
  const contact = hit({ t: 30, dist: 1, before: 9999, armorDamage: 9999, after: 0 });
  const result = records([far, strong, incoming, contact]);
  assert.equal(result[0].value, 123.75);
  assert.equal(result[0].hit, far);
  assert.equal(result[1].value, 100.5);
  assert.equal(result[1].hit, strong);
  assert.equal(result[2].value, 260.25);
  assert.equal(result[2].hit, incoming);
  assert.equal(result[3].value, 2);
  assert.equal(result[3].hit, contact);
  assert.equal(result[3].opponentId, "op-a");
  assert.equal(result[3].name, "Alpha");
  refs(result[3].groupHits, [contact, far]);
  assert(result.every((record) => record.tieCount === 1 && record.identityKnown));
});

test("zero body damage cannot invent numeric records but is still a contact", () => {
  const outgoing = hit({ dist: 0, before: 999, after: 0, armorDamage: 999, blocked: true });
  const incoming = hit({ dealt: false, dist: 300, before: 999, after: 0, armorDamage: 999 });
  const result = records([outgoing, incoming]);
  assert(result.slice(0, 3).every((record) => record.value === null));
  assert.equal(result[3].value, 1);
  refs(result[3].groupHits, [outgoing]);
});

test("directions must be actual true or false booleans", () => {
  const malformed = [undefined, null, 0, 1, "", "true", "false", {}, []].map((dealt) =>
    hit({ dealt, dist: 9999, after: 9999 }));
  const outgoing = hit({ dist: 1, after: 2 });
  const incoming = hit({ dealt: false, dist: 999, after: 3 });
  const result = records([...malformed, outgoing, incoming]);
  refs(result.map((record) => record.hit), [outgoing, outgoing, incoming, outgoing]);
  assert.equal(result[3].value, 1);
  assert(records(malformed).every((record) => record.value === null));
});

test("numeric metrics reject coercion, missing, negative and nonfinite values", () => {
  const invalid = [undefined, null, false, true, "", "9000", NaN, Infinity, -Infinity, -1, 0, -0, {}, [], new Number(999), 1n];
  const inputs = invalid.flatMap((value) => [
    hit({ dist: value, after: value }),
    hit({ dealt: false, dist: value, after: value }),
  ]);
  assert(records(inputs).slice(0, 3).every((record) => record.value === null));
  const outgoing = hit({ dist: 0.125, after: 0.25 });
  const incoming = hit({ dealt: false, after: 0.5 });
  const result = records([...inputs, outgoing, incoming]);
  assert.equal(result[0].value, 0.125);
  assert.equal(result[1].value, 0.25);
  assert.equal(result[2].value, 0.5);
});

test("every positive finite magnitude is valid, including subnormal values", () => {
  const smallest = hit({ dist: Number.MIN_VALUE, after: Number.MIN_VALUE });
  const largest = hit({ dealt: false, after: Number.MAX_VALUE });
  const result = records([smallest, largest]);
  assert.equal(result[0].value, Number.MIN_VALUE);
  assert.equal(result[1].value, Number.MIN_VALUE);
  assert.equal(result[2].value, Number.MAX_VALUE);
});

test("numeric ties use earliest valid time then original input order", () => {
  const late = hit({ t: 30 });
  const invalid = hit({ t: -1 });
  const first = hit({ t: 0 });
  const sameTime = hit({ t: -0 });
  const middle = hit({ t: 10 });
  const result = records([late, invalid, first, sameTime, middle]);
  for (const record of result.slice(0, 2)) {
    assert.equal(record.hit, first);
    assert.equal(record.tieCount, 5);
    refs(record.groupHits, [first, sameTime, middle, late, invalid]);
  }
  refs(result[3].groupHits, [first, sameTime, middle, late, invalid]);
});

test("invalid clocks cannot outrank even the largest valid clock", () => {
  const clocks = [undefined, null, NaN, Infinity, -Infinity, -1, "0", "", false, true, {}, [], new Number(0)];
  const invalid = clocks.map((t) => hit({ t, dealt: false }));
  const valid = hit({ t: Number.MAX_VALUE, dealt: false });
  const result = records([...invalid, valid]);
  assert.equal(result[2].hit, valid);
  assert.equal(result[2].tieCount, clocks.length + 1);
  refs(result[2].groupHits, [valid, ...invalid]);
});

test("all-invalid clocks still produce deterministic evidence without fabricated time", () => {
  const first = hit({ t: undefined });
  const second = hit({ t: NaN });
  const third = hit({ t: -5 });
  const result = records([first, second, third]);
  for (const record of [result[0], result[1], result[3]]) {
    assert.equal(record.hit, first);
    refs(record.groupHits, [first, second, third]);
    assert.equal(record.hit.t, undefined);
  }
});

test("numeric records retain independent maxima and evidence lists", () => {
  const far = hit({ t: 1, dist: 100, after: 5 });
  const both = hit({ t: 2, dist: 100, after: 90 });
  const damage = hit({ t: 0, dist: 2, after: 90 });
  const result = records([far, both, damage]);
  refs(result[0].groupHits, [far, both]);
  refs(result[1].groupHits, [damage, both]);
  assert.notEqual(result[0].groupHits, result[1].groupHits);
});

test("same-name opponents are separated by stable ID and projectiles are not deduplicated", () => {
  const a = hit({ t: 1, opponentId: "a", who: "Twin", bulletId: "same-bullet" });
  const b = hit({ t: 2, opponentId: "b", who: "Twin", bulletId: "same-bullet" });
  const b2 = hit({ t: 3, opponentId: "b", who: "Renamed", cls: "Scav", bulletId: "same-bullet", after: 0 });
  const incoming = hit({ t: 0, dealt: false, opponentId: "a", who: "Twin" });
  const result = records([a, b2, incoming, b])[3];
  assert.equal(result.value, 2);
  assert.equal(result.opponentId, "b");
  assert.equal(result.name, "Twin");
  assert.equal(result.identityKnown, true);
  assert.equal(result.tieCount, 1);
  refs(result.groupHits, [b, b2]);
});

test("repeated references remain separate recorded contacts without cloning their evidence", () => {
  const shared = hit({ t: 0, bulletId: "one-projectile" });
  const result = records(Object.freeze([shared, shared]));
  assert.equal(result[0].tieCount, 2);
  assert.equal(result[1].tieCount, 2);
  assert.equal(result[3].value, 2);
  assert.equal(result[3].tieCount, 1);
  refs(result[0].groupHits, [shared, shared]);
  refs(result[3].groupHits, [shared, shared]);
});

test("opponent ties count groups and use the earliest group's first contact", () => {
  const aLate = hit({ t: 20, opponentId: "a" });
  const bLate = hit({ t: 15, opponentId: "b" });
  const aFirst = hit({ t: 5, opponentId: "a" });
  const bFirst = hit({ t: 2, opponentId: "b" });
  const lesser = hit({ t: 0, opponentId: "c" });
  const result = records([aLate, bLate, aFirst, bFirst, lesser])[3];
  assert.equal(result.value, 2);
  assert.equal(result.tieCount, 2);
  assert.equal(result.hit, bFirst);
  refs(result.groupHits, [bFirst, bLate]);
  const aTie = hit({ t: 2, opponentId: "a" });
  assert.equal(records([aTie, bFirst])[3].hit, aTie);
  assert.equal(records([bFirst, aTie])[3].hit, bFirst);
  const noTimeA = hit({ t: "1", opponentId: "a" });
  const noTimeB = hit({ t: -1, opponentId: "b" });
  assert.equal(records([noTimeA, noTimeB])[3].hit, noTimeA);
  assert.equal(records([noTimeA, bFirst])[3].hit, bFirst);
});

test("legacy grouping matches normalized name and class but cannot claim known identity", () => {
  const late = hit({ t: 30, opponentId: "", who: "  Legacy Name ", cls: " Scav  " });
  const early = hit({ t: 10, opponentId: undefined, who: "LEGACY NAME", cls: "scav" });
  const otherClass = hit({ t: 0, opponentId: null, who: "Legacy Name", cls: "PMC" });
  const known = hit({ t: 0, opponentId: "known", who: "Legacy Name", cls: "scav" });
  const incoming = hit({ t: 0, dealt: false, opponentId: "", who: "Legacy Name", cls: "scav" });
  const result = records([late, early, otherClass, known, incoming])[3];
  assert.equal(result.value, 2);
  assert.equal(result.opponentId, null);
  assert.equal(result.name, "LEGACY NAME");
  assert.equal(result.identityKnown, false);
  refs(result.groupHits, [early, late]);
  assert.equal(records([late])[0].identityKnown, false);
});

test("unknown legacy names cannot manufacture an opponent", () => {
  const unknownNames = [undefined, null, "", " \t ", "Unknown", "unknown target", " UNKNOWN OPPONENT ", "Unknown Attacker", 7, {}, []];
  const unknown = unknownNames.map((who) => hit({ opponentId: "", who }));
  assert.equal(records(unknown)[3].value, null);
  assert.notEqual(records(unknown)[0].value, null, "known distance does not require opponent identity");
  const named = hit({ opponentId: "", who: "UnknownHero", t: 20 });
  const result = records([...unknown, named])[3];
  assert.equal(result.value, 1);
  assert.equal(result.name, "UnknownHero");
  assert.equal(result.hit, named);
});

test("stable identity survives unknown names without fabricating a display name", () => {
  const unknown = hit({ t: 1, opponentId: "known-id", who: "Unknown" });
  const unnamed = hit({ t: 2, opponentId: "known-id", who: undefined });
  let result = records([unknown, unnamed])[3];
  assert.equal(result.value, 2);
  assert.equal(result.identityKnown, true);
  assert.equal(result.name, "Unknown opponent");
  const named = hit({ t: 3, opponentId: "known-id", who: "  Known later  " });
  result = records([named, unknown, unnamed])[3];
  assert.equal(result.hit, unknown);
  assert.equal(result.name, "Known later");
});

test("ID validation, key namespaces and prototype-like strings are safe", () => {
  const ids = [undefined, null, "", " \t ", false, 0, 5, {}, []];
  const legacy = ids.map((opponentId, i) => hit({ opponentId, t: i, who: "__proto__", cls: "constructor" }));
  const record = records(legacy)[3];
  assert.equal(record.value, ids.length);
  assert.equal(record.identityKnown, false);
  const preserved = hit({ opponentId: " id-with-spaces ", who: "constructor" });
  assert.equal(records([preserved])[3].opponentId, " id-with-spaces ");
  const protoId = hit({ opponentId: "__proto__", who: "constructor" });
  const protoName = hit({ opponentId: "", who: "__proto__" });
  const mixed = records([protoId, protoName])[3];
  assert.equal(mixed.value, 1);
  assert.equal(mixed.tieCount, 2);
});

test("deep-frozen inputs remain unchanged and every selected event retains its identity", () => {
  const late = hit({ t: 10, metadata: { nested: [1, { value: "unchanged" }] } });
  const early = hit({ t: 0 });
  const incoming = hit({ t: 5, dealt: false });
  const input = freezeDeep([late, early, incoming]);
  const before = structuredClone(input);
  const result = records(input);
  assert.deepEqual(input, before);
  refs(result.map((record) => record.hit), [early, early, incoming, early]);
  for (const record of result) assert.notEqual(record.groupHits, input);
  assert.notEqual(result[0].groupHits, result[1].groupHits);
  assert.notEqual(result[0].groupHits, result[3].groupHits);
  result[0].groupHits.pop();
  result[0].value = 999;
  result[3].groupHits.reverse();
  assert.deepEqual(input, before);
  const again = records(input);
  assert.equal(again[0].value, 24);
  refs(again[0].groupHits, [early, late]);
  refs(again[3].groupHits, [early, late]);
});

test("new, empty and legacy raids cannot retain previous derived state", () => {
  const original = records([hit()]);
  const empty = records([]);
  assert(empty.every((record) => record.value === null));
  empty[0].groupHits.push("outside mutation");
  assert.equal(records([])[0].groupHits.length, 0);
  const next = hit({ opponentId: "", who: "Next", dist: 1, after: 2 });
  const legacy = records([next]);
  assert.equal(legacy[0].value, 1);
  assert.equal(legacy[3].name, "Next");
  assert.equal(legacy[3].identityKnown, false);
  assert.equal(original[0].value, 24);
  assert.equal(original[3].name, "Alpha");
  for (let i = 0; i < 4; i++) {
    assert.notEqual(original[i], empty[i]);
    assert.notEqual(original[i].groupHits, empty[i].groupHits);
  }
});

test("seeded mixed streams agree with independent ordered numeric and opponent oracles", () => {
  let seed = 0x5a17;
  function pick(values) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return values[seed % values.length];
  }
  const validTime = (event) => typeof event.t === "number" && Number.isFinite(event.t) && event.t >= 0;
  function order(input, a, b) {
    if (validTime(a) !== validTime(b)) return validTime(a) ? -1 : 1;
    if (validTime(a) && a.t !== b.t) return a.t < b.t ? -1 : 1;
    return input.indexOf(a) - input.indexOf(b);
  }
  for (let trial = 0; trial < 160; trial++) {
    const input = Array.from({ length: trial % 41 }, () => hit({
      t: pick([0, 1, 2, 2, 15, undefined, null, "0", -1, NaN, Infinity]),
      dealt: pick([true, true, false, undefined, 1]),
      opponentId: pick(["a", "b", "c"]),
      who: "Same display name",
      dist: pick([0, 1, 1, 3, 25, undefined, "99", -1, NaN, Infinity]),
      after: pick([0, 5, 5, 10, 30, null, "90", -1, NaN, Infinity]),
    }));
    const output = records(freezeDeep(input));
    for (const [index, field, direction] of [[0, "dist", true], [1, "after", true], [2, "after", false]]) {
      const eligible = input.filter((event) => event.dealt === direction &&
        typeof event[field] === "number" && Number.isFinite(event[field]) && event[field] > 0);
      eligible.sort((a, b) => b[field] - a[field] || order(input, a, b));
      const maximum = eligible[0]?.[field] ?? null;
      assert.equal(output[index].value, maximum);
      assert.equal(output[index].hit, eligible[0] ?? null);
      const tied = eligible.filter((event) => event[field] === maximum);
      assert.equal(output[index].tieCount, tied.length);
      refs(output[index].groupHits, tied);
    }
    const groups = new Map();
    for (const event of input.filter((event) => event.dealt === true)) {
      if (!groups.has(event.opponentId)) groups.set(event.opponentId, []);
      groups.get(event.opponentId).push(event);
    }
    const ranked = [...groups.values()].map((group) => group.sort((a, b) => order(input, a, b)));
    ranked.sort((a, b) => b.length - a.length || order(input, a[0], b[0]));
    const mostContacts = ranked[0]?.length ?? null;
    assert.equal(output[3].value, mostContacts);
    assert.equal(output[3].hit, ranked[0]?.[0] ?? null);
    assert.equal(output[3].tieCount, ranked.filter((group) => group.length === mostContacts).length);
    refs(output[3].groupHits, ranked[0] ?? []);
  }
});

console.log("COMBATLOG RECORD DERIVATION VERIFIED (" + cases + " cases; 160 seeded mixed streams)");
