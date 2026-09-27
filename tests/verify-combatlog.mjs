import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import vm from "node:vm";

const mode = process.argv[2];
if (!new Set(["--debrief", "--armor", "--tape", "--scope", "--zones", "--accuracy", "--equipment", "--records", "--polish", "--overall", "--overall-weapons", "--cartridges"]).has(mode)) {
  console.error("usage: node tests/verify-combatlog.mjs --debrief|--armor|--tape|--scope|--zones|--accuracy|--equipment|--records|--polish|--overall|--overall-weapons|--cartridges");
  process.exit(2);
}

const html = readFileSync("web/combatlog.html", "utf8");
const panel = readFileSync("UI/CombatLogPanel.cs", "utf8");
const analytics = readFileSync("Analytics/RaidAnalytics.cs", "utf8");
const engagements = readFileSync("Analytics/RaidEngagements.cs", "utf8");
const findings = readFileSync("Analytics/RaidFindings.cs", "utf8");
const patches = readFileSync("Analytics/CombatLogShotPatches.cs", "utf8");
const projectNotes = readFileSync("CLAUDE.md", "utf8");
const presentation = readFileSync("Analytics/RaidPresentation.cs", "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function inlineScript(source) {
  const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert(scripts.length > 0, "embedded page has no inline script");
  return scripts[scripts.length - 1][1];
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  toggle(value, force) {
    if (force === true) this.values.add(value);
    else if (force === false) this.values.delete(value);
    else this.values.has(value) ? this.values.delete(value) : this.values.add(value);
  }
}

class FakeElement {
  constructor(id) {
    this.id = id;
    this.tagName = "DIV";
    this.innerHTML = "";
    this.textContent = "";
    this.className = "";
    this.value = "";
    this.style = {};
    this.classList = new FakeClassList();
    this.parentNode = this;
    this.lastElementChild = null;
    this.events = {};
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.scrollTop = 0;
    this.tabIndex = 0;
  }
  addEventListener(name, callback) { this.events[name] = callback; }
  getAttribute(name) { return this[name] == null ? null : this[name]; }
  setAttribute(name, value) {
    this[name] = String(value);
    if (name === "class") {
      this.className = String(value);
      this.classList.values = new Set(String(value).split(/\s+/).filter(Boolean));
    }
  }
  removeAttribute(name) { delete this[name]; }
  markupElements() {
    if (this.markupCache === this.innerHTML) return this.markupChildren;
    this.markupCache = this.innerHTML;
    this.markupChildren = [];
    let index = 0;
    for (const match of this.innerHTML.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
      const child = new FakeElement(this.id + "-markup-" + index++);
      child.tagName = match[1].toUpperCase();
      child.parentNode = this;
      for (const attr of match[2].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))
        child.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? "");
      child.disabled = /(?:^|\s)disabled(?:\s|$|=)/.test(match[2]);
      this.markupChildren.push(child);
    }
    return this.markupChildren;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const simple = selector.trim().split(/\s+/).pop();
    const tag = simple.match(/^[a-z][\w-]*/i)?.[0].toUpperCase();
    const classes = [...simple.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
    const attributes = [...simple.matchAll(/\[([^\]\s=]+)(?:\s*=\s*["']?([^\]"']*)["']?)?\]/g)];
    return this.markupElements().filter((child) => {
      if (tag && child.tagName !== tag) return false;
      if (classes.some((name) => !child.classList.values.has(name))) return false;
      return attributes.every((attr) => {
        const actual = child.getAttribute(attr[1]);
        return actual !== null && (attr[2] === undefined || actual === attr[2]);
      });
    });
  }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolled = true; }
  getBoundingClientRect() { return { top: 0 }; }
}

function runtime(options = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  };
  for (const name of ["overview", "combat", "arsenal"]) {
    const view = element("view-" + name);
    view.setAttribute("data-report-view", name);
    view.hidden = name !== "overview";
    const tab = element("view-tab-" + name);
    tab.setAttribute("data-view-target", name);
    tab.setAttribute("aria-selected", String(name === "overview"));
  }
  for (const name of ["anatomy", "table"]) {
    const view = element("hit-" + name + "-panel");
    view.setAttribute("data-hit-subview", name);
    view.hidden = false;
  }
  for (const name of ["overview", "weapons", "locations"]) {
    const view = element("overall-" + name + "-panel");
    view.setAttribute("data-overall-view", name);
    const tab = element("overall-tab-" + name);
    tab.setAttribute("data-overall-target", name);
    tab.setAttribute("aria-selected", String(name === "overview"));
  }
  const zoneToggle = element("show-all-zones");
  zoneToggle.setAttribute("data-show-all-zones", "");
  zoneToggle.setAttribute("aria-pressed", "false");
  element("advanced-filters").innerHTML = "<summary>More filters</summary>";
  const document = {
    hidden: false,
    imageTargets: [],
    getElementById: element,
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) {
      if (selector === "[data-local-image]") return document.imageTargets;
      if (selector === "#filters select")
        return element("primary-filters").querySelectorAll("select")
          .concat(element("advanced-filter-controls").querySelectorAll("select"));
      if (selector === ".tape-hit") return element("tape").querySelectorAll(selector);
      if (selector === "main") return [element("main")];
      const simple = selector.trim().split(/\s+/).pop();
      const attribute = simple.match(/^\[([^\]]+)\]$/)?.[1];
      if (attribute) return [...elements.values()].filter((candidate) => candidate.getAttribute(attribute) !== null);
      return [];
    },
    events: {},
    addEventListener(name, callback) { this.events[name] = callback; },
  };
  const window = {
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    events: {},
    addEventListener(name, callback) { this.events[name] = callback; },
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    setTimeout: options.timers ? options.timers.set : setTimeout,
    clearTimeout: options.timers ? options.timers.clear : clearTimeout,
  };
  if (options.request) window.overlay = { request: options.request, on: options.on || function () {}, send() {} };
  const context = vm.createContext({ window, document, console });
  new vm.Script(readFileSync("web/mannequin.js", "utf8"), { filename: "mannequin.js" }).runInContext(context);
  if (options.mannequinCreate) {
    const base = window.CombatMannequin;
    window.CombatMannequin = Object.freeze({ zones: base.zones, classify: base.classify,
      create: options.mannequinCreate, _test: base._test });
  }
  new vm.Script(readFileSync("web/records.js", "utf8"), { filename: "records.js" }).runInContext(context);
  new vm.Script(inlineScript(html), { filename: "combatlog.inline.js" }).runInContext(context);
  assert(window.__combatLogRender, "offline render hook was not exposed");
  assert(window.__combatLogTest, "pure verification hooks were not exposed");
  return { window, elements, document };
}

function activeReportView(elements) {
  return ["overview", "combat", "arsenal"].find((name) => !elements.get("view-" + name).hidden);
}

function activeHitView(elements) {
  return ["anatomy", "table"].every((name) => !elements.get("hit-" + name + "-panel").hidden) ? "split" : undefined;
}

function hit(overrides = {}) {
  return {
    t: 0, dealt: true, opponentId: "op-a", who: "Alpha", cls: "PMC",
    part: "chest", collider: "RibcageUp", before: 55, after: 40,
    armorDamage: 15, blocked: false, deflected: false, weapon: "M4A1",
    ammoId: "ammo-a", ammo: "M855", fatal: false, fatalInferred: false, dist: 24,
    ...overrides,
  };
}

function fixture(version = 2) {
  const late = [
    hit({ t: 10, dealt: false, opponentId: "op-b", who: "Bravo", before: 80, after: 60, fatal: false }),
    hit({ t: 11, opponentId: "op-b", who: "Bravo", before: 70, after: 55, fatal: true }),
  ];
  const early = [
    hit({ t: 0, after: 42 }),
    hit({ t: 1, dealt: false, after: 20 }),
    hit({ t: 2, after: 45, fatal: true }),
  ];
  if (version === 1) {
    [...late, ...early].forEach((h) => {
      delete h.opponentId;
      delete h.collider;
      delete h.ammoId;
      delete h.fatalInferred;
    });
  }
  return {
    v: version, ts: version, history: [],
    raid: { outcome: "SURVIVED", location: "Factory", duration: 30, finished: true },
    findings: [], hitsDealt: 3, hitsReceived: 2, damageDealt: 142,
    damageReceived: 80, armorSavedYou: 35, shotsFired: 8, shotsHit: 5,
    kills: 2, ammoCost: 800, loadout: [],
    ...(version === 2 ? { cartridgesFired: 8, cartridgesHit: 5, costBasis: "cartridge" } : {}),
    engagements: [
      { start: 10, duration: 1, damageDealt: 55, damageReceived: 60, kills: 1, killLinks: 0, opponents: [{ id: "op-b", name: "Bravo" }], hits: late },
      { start: 0, duration: 2, damageDealt: 87, damageReceived: 20, kills: 1, killLinks: 0, opponents: [{ id: "op-a", name: "Alpha" }], hits: early },
    ],
  };
}

function verifyDebrief() {
  const { window, elements } = runtime();
  const hooks = window.__combatLogTest;
  const dense = fixture(2);
  const moments = hooks.buildMoments(dense);
  assert(moments.length === 2, "five-second gap did not produce two evidence moments");
  const cards = hooks.deriveDebrief(dense, moments);
  assert(cards.length === 3, "dense fixture did not produce the three-card debrief");
  cards.forEach((card) => {
    assert(card.title && card.value && card.detail, "debrief card lacks evidence text");
    assert(Number.isFinite(card.start) && Number.isFinite(card.end) && card.end > card.start,
      "debrief card lacks a valid evidence range");
  });

  const sparse = fixture(2);
  sparse.engagements = [{ start: 4, duration: 0, damageDealt: 25, damageReceived: 0, kills: 0, opponents: [{ name: "Solo" }], hits: [hit({ t: 4, who: "Solo", opponentId: "solo" })] }];
  const sparseCards = hooks.deriveDebrief(sparse);
  assert(sparseCards.length === 3, "single-hit raid did not retain a useful debrief");
  sparseCards.filter((card) => card.kind === "clean" || card.kind === "discipline").forEach((card) => {
    assert(card.start === 0 && card.end === sparse.raid.duration,
      "raid-wide debrief claim did not retain a raid-wide evidence range");
  });

  const blocked = fixture(2);
  blocked.engagements = [{
    start: 7, duration: 0, damageDealt: 0, damageReceived: 0, kills: 0,
    opponents: [{ id: "shield", name: "Shield" }],
    hits: [hit({ t: 7, dealt: false, opponentId: "shield", who: "Shield", before: 70, after: 0, blocked: true })],
  }];
  const blockedCards = hooks.deriveDebrief(blocked);
  assert(!blockedCards.some((card) => card.kind === "clean"),
    "fully stopped incoming hit was incorrectly described as no incoming hit");
  assert(blockedCards.some((card) => card.kind === "pressure" && card.title === "Incoming contact"),
    "fully stopped incoming hit did not retain an evidence card");

  window.__combatLogRender(dense, false);
  assert(elements.get("debrief").innerHTML.includes("debrief-card"), "rendered page has no debrief cards");
  assert(elements.get("tape").innerHTML.includes("tape-svg"), "rendered page has no combat tape");
  console.log("COMBATLOG DEBRIEF VERIFIED");
}

function verifyArmor() {
  const { window, elements } = runtime();
  const hooks = window.__combatLogTest;
  const flesh = hit({ t: 1, before: 50, after: 50, armorDamage: 0 });
  const outgoingPen = hit({ t: 2, before: 60, after: 35, armorDamage: 0 });
  const reportedOnly = hit({ t: 3, before: 20, after: 20, armorDamage: 3 });
  const outgoingBlocked = hit({ t: 4, before: 50, after: 4, armorDamage: 0, blocked: true });
  const outgoingRicochet = hit({ t: 5, before: 45, after: 5, armorDamage: 0, blocked: true, deflected: true, part: "head", collider: "Eyes" });
  const incomingPen = hit({ t: 6, dealt: false, before: 80, after: 30, armorDamage: 0 });
  const incomingBlocked = hit({ t: 7, dealt: false, before: 90, after: 10, armorDamage: 0, blocked: true });
  const incomingRicochet = hit({ t: 8, dealt: false, before: 70, after: 5, armorDamage: 0, blocked: true, deflected: true, part: "head", collider: "Jaw" });
  const hits = [flesh, outgoingPen, reportedOnly, outgoingBlocked, outgoingRicochet,
    incomingPen, incomingBlocked, incomingRicochet];
  const raid = fixture(2);
  raid.engagements = [{ start: 1, duration: 7, damageDealt: 64, damageReceived: 45,
    kills: 0, killLinks: 0, opponents: [{ id: "op-a", name: "Alpha" }], hits }];
  raid.loadout = [];

  assert(hooks.armourPrevented(outgoingPen) === 25 && hooks.armourPrevented(flesh) === 0,
    "pre/post body-damage prevention was not derived exactly");
  assert(hooks.hitArmourState(flesh) === "none" && hooks.hitArmourState(outgoingPen) === "penetrated" &&
    hooks.hitArmourState(outgoingBlocked) === "blocked" && hooks.hitArmourState(outgoingRicochet) === "deflected",
    "the four armour outcome states are not mutually meaningful");
  assert(hooks.isArmourContact(reportedOnly), "legacy DidArmorDamage evidence was discarded");
  const malformed = hit({ before: "90", after: 0, armorDamage: "3", blocked: "false", deflected: 0 });
  assert(hooks.armourPrevented(malformed) === 0 && !hooks.isArmourContact(malformed),
    "malformed field types invented an armour contact");

  const impact = hooks.deriveArmourImpact(raid);
  assert(JSON.stringify(impact.dealt) === JSON.stringify({ contacts: 4, penetrations: 2, stopped: 2,
    blocked: 1, ricochets: 1, headRicochets: 1, prevented: 111 }),
    "outgoing armour impact or overlapping block/ricochet accounting is wrong");
  assert(JSON.stringify(impact.received) === JSON.stringify({ contacts: 3, penetrations: 1, stopped: 2,
    blocked: 1, ricochets: 1, headRicochets: 1, prevented: 195 }),
    "incoming armour impact or head-area ricochet accounting is wrong");

  const base = { dir: "all", opponent: "", cls: "", weapon: "", ammo: "", part: "", zone: "", armour: "" };
  assert(hooks.passesWith(flesh, { ...base, armour: "none" }) &&
    !hooks.passesWith(flesh, { ...base, armour: "penetrated" }),
    "flesh hit is still presented as an armour penetration");
  assert(hooks.passesWith(outgoingPen, { ...base, armour: "penetrated" }) &&
    hooks.passesWith(outgoingPen, { ...base, armour: "absorbed" }) &&
    hooks.passesWith(outgoingRicochet, { ...base, armour: "stopped" }),
    "armour filters do not follow the derived outcome state");

  window.__combatLogRender(raid, false);
  const summary = elements.get("armour-impact").innerHTML;
  assert(summary.includes("Your armour") && summary.includes("Enemy armour") &&
    summary.includes("195 dmg") && summary.includes("111 dmg") && summary.includes("1/3") && summary.includes("2/4"),
    "armour summary omitted a direction, prevented damage or penetration denominator");
  assert(summary.includes("Ricochet events") && summary.includes("in the head area") && !/helmet/i.test(summary),
    "ricochet summary overclaims a helmet or omits the head-area subset");
  assert(!summary.includes("NaN") && !summary.includes("Infinity"), "armour summary rendered an invalid number");
  const hitMarkup = elements.get("allhits").innerHTML;
  for (const label of ["no armour", "penetrated", "blocked", "ricochet"])
    assert(hitMarkup.includes(label), "hit log omitted armour state: " + label);
  const filtersMarkup = elements.get("primary-filters").innerHTML +
    elements.get("advanced-filter-controls").innerHTML;
  assert(filtersMarkup.includes("No armour contact") && filtersMarkup.includes("Armour penetrated") &&
    filtersMarkup.includes("Blocked / ricochet") && filtersMarkup.includes("Target: all") &&
    filtersMarkup.includes("Weapon: all") && filtersMarkup.includes("Ammo: all") &&
    filtersMarkup.includes("Body part: all"),
    "primary or disclosed advanced filters lost armour and evidence scope controls");

  const empty = fixture(2);
  empty.engagements = [{ start: 1, duration: 0, damageDealt: 50, damageReceived: 0,
    kills: 0, killLinks: 0, opponents: [], hits: [flesh] }];
  window.__combatLogRender(empty, false);
  assert((elements.get("armour-impact").innerHTML.match(/No armour contact recorded/g) || []).length === 4,
    "zero-contact raid invented armour metrics instead of showing unavailable outcomes");

  assert(panel.includes("private static float ArmorPrevented") &&
    panel.includes("ArmorPrevented(s) > 0.001f") && panel.includes('Num(sb, "armorHits", armorHits)') &&
    panel.includes('Num(sb, "through", ch.Count(IsArmorPen))'),
    "backend armour-contact or ammo-through aggregation is not aligned with the page");
  assert(!panel.includes('Num(sb, "through", ch.Count - blocked - deflected)'),
    "backend still counts flesh hits as through-armour events");
  console.log("COMBATLOG ARMOUR UI VERIFIED");
}

function verifyTape() {
  const { window, elements } = runtime();
  const hooks = window.__combatLogTest;
  const current = fixture(2);
  const ordered = hooks.allHits(current);
  assert(ordered.map((h) => h.t).join(",") === "0,1,2,10,11", "hit stream is not chronological");
  assert(hooks.hitIdentity(hit({ dealt: true })) === hooks.hitIdentity(hit({ dealt: false })),
    "stable opponent id split the two directions of one duel");
  const twinA = hit({ opponentId: "twin-a", who: "Same name" });
  const twinB = hit({ opponentId: "twin-b", who: "Same name" });
  assert(hooks.hitIdentity(twinA) !== hooks.hitIdentity(twinB),
    "stable opponent ids merged two same-name opponents");
  const opponentFilter = { dir: "all", opponent: hooks.hitIdentity(twinA), cls: "", weapon: "", ammo: "", armour: "", part: "" };
  assert(hooks.passesWith(twinA, opponentFilter) && !hooks.passesWith(twinB, opponentFilter),
    "evidence filter ignored stable opponent identity");

  const ammoA = hit({ ammoId: "ammo-a", ammo: "PS" });
  const ammoB = hit({ ammoId: "ammo-b", ammo: "PS" });
  assert(hooks.ammoIdentity(ammoA) !== hooks.ammoIdentity(ammoB),
    "stable ammunition ids merged two same-name cartridges");
  const ammoFilter = { dir: "all", opponent: "", cls: "", weapon: "", ammo: hooks.ammoIdentity(ammoA), armour: "", part: "" };
  assert(hooks.passesWith(ammoA, ammoFilter) && !hooks.passesWith(ammoB, ammoFilter),
    "hit-log filter ignored stable ammunition identity");

  const legacyOut = hit({ dealt: true, who: "Legacy", cls: "Scav" });
  const legacyIn = hit({ dealt: false, who: "Legacy", cls: "Scav" });
  delete legacyOut.opponentId;
  delete legacyIn.opponentId;
  assert(hooks.hitIdentity(legacyOut) === hooks.hitIdentity(legacyIn),
    "legacy name/class fallback split the two directions of one duel");

  const gapRange = { start: 0, end: 30 };
  assert(hooks.hitIndexAtOrBefore(ordered, 5, gapRange) === 2,
    "scrubber selected the future hit after a quiet gap");
  assert(hooks.fatalIsLinked({ v: 1 }, hit({ fatal: true })),
    "legacy fatal marker was presented with invented direct-hit provenance");
  assert(!hooks.fatalIsLinked({ v: 2 }, hit({ fatal: true })),
    "direct v2 fatal marker lost its direct-hit provenance");
  assert(hooks.fatalIsLinked({ v: 2 }, hit({ fatal: true, fatalInferred: true })),
    "inferred v2 fatal marker lost its link provenance");

  assert(panel.includes('Num(sb, "v", 2)'), "backend payload version was not advanced");
  for (const field of ["opponentId", "collider", "ammoId"]) {
    assert(panel.includes('"' + field + '"'), "backend does not serialize " + field);
  }
  assert(panel.includes('\\"fatalInferred\\"'), "backend does not serialize fatalInferred");
  assert(analytics.includes("FatalInferred = true"),
    "fallback fatal resolution does not preserve inferred provenance");
  assert(patches.includes("MarkFatalReceived(aggressor?.ProfileId)") &&
      analytics.includes("record.AttackerProfileId == _pendingFatalReceivedFrom") &&
      analytics.includes("ShotsReceived[i].AttackerProfileId != _pendingFatalReceivedFrom"),
    "inferred death context can still attach to an unrelated latest attacker");
  assert(findings.includes("s.Fatal && !s.FatalInferred") &&
      panel.includes("s.Fatal && !s.FatalInferred") && engagements.includes("KillLinks"),
    "inferred fatal links still count as direct finding, ammunition, or engagement kills");
  assert(patches.includes("CombatLogPanel.BeginCurrentRaid()") && panel.includes("internal static void BeginCurrentRaid()"),
    "a new live raid does not receive a fresh browser state key at raid start");
  window.__combatLogRender(current, false);
  const tapeMarkup = elements.get("tape").innerHTML;
  const tapeSvgTag = tapeMarkup.match(/<svg class="tape-svg"[^>]*>/)?.[0] || "";
  assert(tapeSvgTag && !/viewBox=|preserveAspectRatio=/.test(tapeSvgTag),
    "tape stretches circle geometry through a fixed SVG viewBox");
  const markerCoordinates = [...tapeMarkup.matchAll(/<circle[^>]* cx="([^"]+)" cy="([^"]+)" r="([^"]+)"/g)];
  assert(markerCoordinates.length === 10 && markerCoordinates.every(([,x,y,r]) =>
    /^\d+(?:\.\d+)?%$/.test(x) && Number.isFinite(+y) && Number.isFinite(+r) &&
    +r > 0 && +y - +r >= 0 && +y + +r <= 64),
    "tape markers need proportional time positions and unclipped pixel-sized circular geometry");
  assert((tapeMarkup.match(/class="tape-hit /g) || []).length === 5,
    "combat tape did not emit one marker per hit event");
  assert((tapeMarkup.match(/class="tape-hit-target"/g) || []).length === 5,
    "combat tape did not emit a usable target for every hit event");
  assert((tapeMarkup.match(/class="tape-moment(?: |")/g) || []).length === 2,
    "combat tape did not expose both micro moments");
  const tapeHit = ordered[0];
  assert(!hooks.recordState().hit, "new raid fabricated an initial selected event");
  hooks.setReportView("combat");
  hooks.selectCombatHit(0);
  assert(activeReportView(elements) === "combat" && activeHitView(elements) === "split" && hooks.recordState().hit === tapeHit,
    "shared event selection did not coordinate the combined combat workspace");
  assert(elements.get("anatomy-readout").innerHTML.includes(hooks.hitZoneLabel(tapeHit)),
    "shared event selection lost the active event's body-zone evidence");
  hooks.openHitExplorer({dir:tapeHit.dealt ? "dealt" : "taken",opponent:hooks.hitIdentity(tapeHit),zone:hooks.hitZone(tapeHit).id});
  const tapeFilters = hooks.recordState().filters;
  assert(activeReportView(elements) === "combat" && activeHitView(elements) === "split" &&
    tapeFilters.dir === (tapeHit.dealt ? "dealt" : "taken") &&
    tapeFilters.opponent === hooks.hitIdentity(tapeHit) && tapeFilters.zone === hooks.hitZone(tapeHit).id,
    "event evidence did not open its exact context in the combined workspace");

  const engagementMarkup = elements.get("log").innerHTML;
  const engagementButtons = elements.get("log").querySelectorAll("[data-engagement-hits]");
  assert(!/<table\b|fatal-badge/.test(engagementMarkup) && engagementButtons.length === current.engagements.length,
    "engagement summaries still duplicate the canonical hit table or lack a scoped drilldown");
  assert(engagementButtons.every((button) => button.events.click),
    "engagement hit drilldown is not wired");
  engagementButtons[1].events.click();
  const engagementFilters = hooks.recordState().filters;
  const scopedHits = hooks.allHits(current).filter((h) => hooks.passesWith(h, engagementFilters));
  assert(activeReportView(elements) === "combat" && activeHitView(elements) === "split" &&
    engagementFilters.engagement === 1 && scopedHits.length === current.engagements[1].hits.length &&
    scopedHits.every((h) => current.engagements[1].hits.includes(h)),
    "engagement drilldown did not open the combat workspace with exactly that engagement's contacts");
  if (process.env.COMBATLOG_REAL_RAID) {
    const real = JSON.parse(readFileSync(process.env.COMBATLOG_REAL_RAID, "utf8"));
    const realHits = hooks.allHits(real);
    window.__combatLogRender(real, true);
    const realMarkup = elements.get("tape").innerHTML;
    if (!realHits.length) {
      assert(hooks.buildMoments(real).length === 0 && realMarkup.includes("No hit events to replay"),
        "zero-hit captured raid did not render its tape empty state");
    } else {
      assert(hooks.buildMoments(real).length > 0, "captured hit stream produced no moments");
      assert((realMarkup.match(/class="tape-hit /g) || []).length === realHits.length,
        "captured raid lost hit events while rendering the tape");
    }
    console.log("CAPTURED RAID VERIFIED: " + realHits.length + " hits, " + hooks.buildMoments(real).length + " moments");
  }
  window.__combatLogRender(fixture(1), true);
  assert(elements.get("tape").innerHTML.includes("Legacy combat clock"),
    "stored v1 raid does not receive its honest legacy clock label");
  assert(elements.get("tape").innerHTML.includes("linked"),
    "stored v1 fatal marker invented direct-hit provenance");
  assert(elements.get("ribbon").innerHTML.includes(">0:11<") && !elements.get("ribbon").innerHTML.includes(">0:30<"),
    "stored v1 engagement ribbon invented a silent tail to raid duration");

  const legacyClaims = fixture(1);
  legacyClaims.findings = [{ title: "One-tap", detail: "1 target killed with a single hit", negative: false }];
  window.__combatLogRender(legacyClaims, true);
  assert(elements.get("findings").innerHTML.includes("legacy kill attribution"),
    "stored v1 direct-kill claim was shown without a provenance warning");

  const inferred = fixture(2);
  inferred.engagements[1].hits[2].fatalInferred = true;
  inferred.engagements[1].kills = 0;
  inferred.engagements[1].killLinks = 1;
  window.__combatLogRender(inferred, false);
  assert(!elements.get("log").innerHTML.includes("KILL LINK") && elements.get("allhits").innerHTML.includes("linked"),
    "engagement summary duplicated hit-level provenance or the central Hit Explorer lost an inferred fatal link");

  const twins = fixture(2);
  hooks.allHits(twins).forEach((h) => { h.who = "Same name"; });
  window.__combatLogRender(twins, false);
  assert(elements.get("facts").textContent.includes("2 opponents engaged"),
    "verdict merged same-name opponents despite stable ids");
  console.log("COMBATLOG TAPE VERIFIED");
}

function forbiddenAddedCode(diff) {
  const added = diff.split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
  return /\b(?:mapReplay|worldPosition|playerPosition|targetPosition|movementPath|MasterOrigin|HitPoint)\b|\.\s*Position\b|(?:Str|Num)\(sb,\s*"(?:position|origin|direction|x|y|z)"/i.test(added);
}

function verifyZones() {
  const { window, elements, document } = runtime();
  const hooks = window.__combatLogTest;
  const current = fixture(2);
  const fine = [
    hit({ t: 0, part: "head", collider: "Eyes", after: 25 }),
    hit({ t: 1, part: "head", collider: "Jaw", after: 35 }),
    hit({ t: 2, part: "head", collider: "BackHead", dealt: false, after: 50 }),
    hit({ t: 3, part: "chest", collider: "NeckBack", dealt: false, after: 30 }),
    hit({ t: 4, part: "head", collider: "HeadCommon", after: 5 }),
    hit({ t: 5, part: "head", collider: "FutureCollider<script>", after: 10 }),
  ];
  current.engagements = [{ start: 0, duration: 5, hits: fine, opponents: [] }];
  assert(hooks.hitZone(fine[0]).id === "Eyes", "eyes lost their exact collider identity");
  assert(hooks.hitZone(fine[2]).id !== hooks.hitZone(fine[3]).id, "nape and back of neck were merged");
  const counts = hooks.zoneHistogram(fine);
  assert(counts.Eyes === 1 && counts.Jaw === 1 && counts.BackHead === 1 && counts.NeckBack === 1,
    "precise histogram dropped or merged zones");
  assert(counts["part:head"] === 2, "coarse head records were spread over fine zones");
  assert(Object.values(counts).reduce((a, b) => a + b, 0) === fine.length, "zone counts do not conserve hit count");
  const filter = { zone: "Eyes" };
  assert(hooks.passesWith(fine[0], filter) && !hooks.passesWith(fine[1], filter) && !hooks.passesWith(fine[4], filter),
    "precise filter admitted another head zone or coarse evidence");
  assert(hooks.passesWith(fine[3], { part: "chest" }), "recorded health-part filtering changed");
  window.__combatLogRender(current, false);
  assert(elements.get("figure").innerHTML.includes('id="mannequin"'), "mannequin canvas not mounted");
  assert(elements.get("anatomy-fallback").hidden === false, "missing canvas context lacks usable fallback");
  const hitTable = elements.get("allhits").innerHTML;
  assert(!hitTable.includes("→") && !hitTable.includes("←"), "hit table still shows ambiguous direction arrows");
  assert(hitTable.includes("Outgoing hit to ") && hitTable.includes("Incoming hit from "),
    "removing visible arrows also removed the accessible hit direction");
  assert(elements.get("anatomy-zones").innerHTML.includes('data-zone="Eyes"'), "accessible fine-zone buttons absent");
  assert(elements.get("anatomy-zones").innerHTML.includes('data-zone="part:head"'), "coarse evidence control absent");
  assert(!elements.get("anatomy-zones").innerHTML.includes('data-zone="Ears"'),
    "zero-count fine zones are visible before the reader asks for the complete mannequin");
  const zoneToggle = document.querySelector("[data-show-all-zones]");
  assert(zoneToggle && zoneToggle.events.click, "Show all zones control is not wired");
  zoneToggle.events.click();
  assert(elements.get("anatomy-zones").innerHTML.includes('data-zone="Ears"') &&
    zoneToggle.getAttribute("aria-pressed") === "true",
    "Show all zones does not reveal zero-count zones or expose its pressed state");
  zoneToggle.events.click();
  assert(!elements.get("anatomy-zones").innerHTML.includes('data-zone="Ears"'),
    "zero-count zones remain visible after restoring the focused evidence view");
  assert(!elements.get("allhits").innerHTML.includes("FutureCollider<script>"), "unknown collider label was not escaped");
  hooks.selectAnatomyZone("Eyes");
  assert(elements.get("fcount").textContent === "1 of 6 hits", "zone button does not narrow the hit table");
  assert(elements.get("anatomy-zones").innerHTML.includes('data-zone="Jaw"'), "filter hides neighbouring zones");
  assert(elements.get("allhits").innerHTML.includes("Eyes") && !elements.get("allhits").innerHTML.includes("Jaws"),
    "zone filtered table shows wrong anatomy");
  hooks.selectAnatomyZone("Eyes");
  assert(elements.get("fcount").textContent === "6 of 6 hits", "second zone click does not clear filter");
  hooks.selectAnatomyZone("part:head");
  assert(elements.get("fcount").textContent === "2 of 6 hits", "coarse filter includes precise head hits");
  window.__combatLogRender(fixture(1), true);
  assert(elements.get("fcount").textContent === "5 of 5 hits", "new raid inherited selected zone");
  assert(elements.get("anatomy-note").innerHTML.includes("5 events have no precise subzone"), "legacy evidence lacks precision notice");
  assert(elements.get("allhits").innerHTML.includes("coarse / unavailable"), "legacy rows pretend to know a fine zone");
  const empty = fixture(2);
  empty.engagements = [];
  window.__combatLogRender(empty, false);
  assert(elements.get("anatomy-readout").innerHTML.includes("0 hits in context"), "empty raid anatomy has stale hits");
  assert(elements.get("fcount").textContent === "0 of 0 hits", "empty hit table retains old selection");

  let canvasHooks;
  const highlights = [], updates = [];
  const interactive = runtime({ mannequinCreate(_canvas, options) {
    canvasHooks = options;
    return {
      update(next) { updates.push(next); },
      highlight(id) { highlights.push(id || ""); },
      view() {}, rotate() {}, zoom() {}, destroy() {},
    };
  } });
  const hoverRaid = fixture(2);
  hoverRaid.engagements = [{ start: 0, duration: 5, hits: fine, opponents: [] }];
  interactive.window.__combatLogRender(hoverRaid, false);
  const hoverList = interactive.elements.get("anatomy-zones");
  function zoneButton(id) { return hoverList.querySelectorAll("[data-zone]").find(button => button.getAttribute("data-zone") === id); }
  const eyes = zoneButton("Eyes");
  assert(eyes && eyes.events.mouseenter && eyes.events.focus && canvasHooks && canvasHooks.onHover,
    "zone hover is not wired for pointer, keyboard and canvas interaction");
  const unfilteredCount = interactive.elements.get("fcount").textContent;
  eyes.events.mouseenter();
  assert(highlights.at(-1) === "Eyes" && eyes.classList.values.has("hover") &&
    interactive.elements.get("anatomy-readout").innerHTML.includes("Eyes"),
    "hovering a zone button did not highlight its 3D region and readout");
  assert(interactive.elements.get("fcount").textContent === unfilteredCount,
    "hovering a zone button activated a hit filter");
  eyes.events.focus();
  eyes.events.mouseleave();
  assert(highlights.at(-1) === "Eyes" && eyes.classList.values.has("hover"),
    "pointer leave cleared the same button's persistent keyboard focus highlight");

  canvasHooks.onHover("Jaw");
  assert(highlights.at(-1) === "Jaw" && zoneButton("Jaw").classList.values.has("hover") &&
    !eyes.classList.values.has("hover") && interactive.elements.get("anatomy-readout").innerHTML.includes("Jaws"),
    "canvas hover did not consistently override an existing keyboard focus highlight");
  canvasHooks.onHover(null);
  assert(highlights.at(-1) === "Eyes" && eyes.classList.values.has("hover") && !zoneButton("Jaw").classList.values.has("hover"),
    "leaving the canvas did not restore the still-focused zone");
  eyes.events.blur();
  assert(highlights.at(-1) === "" && !eyes.classList.values.has("hover"),
    "keyboard blur did not clear the final highlight");

  const beforeCanvasHover = highlights.length;
  canvasHooks.onHover("Jaw");
  assert(highlights.length === beforeCanvasHover + 1 && highlights.at(-1) === "Jaw" && zoneButton("Jaw").classList.values.has("hover"),
    "standalone canvas hover did not highlight the matching button and renderer region");
  canvasHooks.onHover(null);
  assert(highlights.at(-1) === "" && !zoneButton("Jaw").classList.values.has("hover"),
    "canvas hover left a stale external highlight after pointer exit");

  const viewHooks = interactive.window.__combatLogTest;
  viewHooks.setReportView("hits");
  viewHooks.setHitView("anatomy");
  zoneButton("Eyes").events.focus();
  viewHooks.setHitView("table");
  assert(highlights.at(-1) === "Eyes" && activeHitView(interactive.elements) === "split",
    "legacy table call hid the mannequin or cleared its persistent keyboard highlight");
  viewHooks.setHitView("anatomy");
  assert(highlights.at(-1) === "Eyes", "legacy anatomy call discarded a visible zone's keyboard highlight");
  canvasHooks.onHover("Jaw");
  viewHooks.setReportView("overview");
  assert(highlights.at(-1) === "", "leaving Combat retained a canvas highlight");
  viewHooks.setReportView("hits");
  assert(highlights.at(-1) === "" && !interactive.elements.get("anatomy-readout").innerHTML.includes("Jaws"),
    "returning to Combat restored a stale canvas highlight");

  interactive.document.querySelector("[data-show-all-zones]").events.click();
  const ears = zoneButton("Ears"), coarseHead = zoneButton("part:head");
  assert(ears && coarseHead, "complete zone list lacks zero-count or coarse hover controls");
  ears.events.mouseenter();
  assert(highlights.at(-1) === "Ears", "zero-count precise zone cannot be previewed on the mannequin");
  ears.events.mouseleave();
  coarseHead.events.mouseenter();
  assert(highlights.at(-1) === "part:head", "coarse body-region button does not request a broad 3D outline");
  coarseHead.events.mouseleave();
  assert(updates.length > 0, "interactive mannequin never received its hit-density data");

  assert(html.includes('<script src="mannequin.js"></script>') && panel.includes('GetManifestResourceStream("CombatLog.mannequin.js")'),
    "offline renderer resource is not linked to document loader");
  const moduleSource = readFileSync("web/mannequin.js", "utf8");
  assert(!/<\/script/i.test(moduleSource), "module cannot be safely inlined into the embedded document");
  const embedded = html.replace('<script src="mannequin.js"></script>', '<script>' + moduleSource + '</script>');
  assert(!embedded.includes('src="mannequin.js"'), "overlay document still needs an external mannequin script");
  for (const script of embedded.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  console.log("COMBATLOG ZONES VERIFIED");
}

function verifyAccuracy() {
  const { window, elements } = runtime();
  let raidId = 100;
  function renderAmmo(overrides = {}, version = 2) {
    const raid = fixture(version);
    raid.ts = ++raidId;
    raid.loadout = [{
      id: "ammo-a", ammo: "M855", fired: 3, shotsHit: 1, hits: 5,
      kills: 0, cost: 300, classes: [], ...overrides,
    }];
    window.__combatLogRender(raid, true);
    return elements.get("loadout").innerHTML;
  }
  const multipleContacts = renderAmmo();
  const hasProjectilePercent = markup => /Projectile \/ pellet accuracy: \d+(?:\.\d+)?%/.test(markup);
  assert(hasProjectilePercent(multipleContacts) && multipleContacts.includes('Projectile / pellet accuracy: 33.3%') && multipleContacts.includes('1 / 3 projectiles hit'),
    "ammunition accuracy still uses contact count instead of unique projectile hits");
  assert(multipleContacts.includes('<span class="r num">5</span>'),
    "correcting accuracy discarded the raw contact count");
  assert(!multipleContacts.includes("167%"), "multiple contacts inflated accuracy above 100 percent");
  assert(renderAmmo({ shotsHit: 0 }).includes('Projectile / pellet accuracy: 0%'), "recorded zero was treated as unknown");
  assert(renderAmmo({ shotsHit: 3 }).includes('Projectile / pellet accuracy: 100%'), "all projectiles hitting lost its full accuracy");

  for (const version of [1, 2]) {
    const oldRaid = renderAmmo({ shotsHit: undefined }, version);
    assert(!hasProjectilePercent(oldRaid),
      "old raid without saved projectile hits invented an ammunition accuracy");
    assert(oldRaid.includes("not recorded"), "old raid does not explain unavailable accuracy");
    assert(oldRaid.includes('<span class="r num">5</span>'), "old raid lost its captured hit count");
  }
  for (const invalid of [
    { fired: 0, shotsHit: 0 }, { fired: -3 }, { fired: 1.5 }, { fired: null },
    { shotsHit: null }, { shotsHit: "1" }, { shotsHit: -1 }, { shotsHit: 4 },
    { shotsHit: 0.5 }, { shotsHit: NaN }, { shotsHit: Infinity },
  ]) {
    assert(!hasProjectilePercent(renderAmmo(invalid)),
      "missing or inconsistent projectile counters produced a plausible accuracy");
  }

  const loadoutWriter = panel.slice(panel.indexOf("private static void AppendLoadout("),
    panel.indexOf("private static void AppendDeathReport("));
  assert(loadoutWriter.includes('Num(sb, "shotsHit", acc.Hits)'),
    "loadout payload does not preserve the optional deduplicated hit counter");
  assert(loadoutWriter.includes('Num(sb, "hits", hits.Count)'),
    "backend changed hit-event semantics instead of adding projectile hits");
  function retainsProjectileDeduplication(source) {
    const countFired = source.slice(source.indexOf("public static void CountFired("), source.indexOf("internal static bool WasFired("));
    const countHit = source.slice(source.indexOf("public static void CountHit("), source.indexOf("private static AmmoAccuracy GetEntry("));
    return /if\s*\([^\r\n]*CountedFired\.ContainsKey\(bulletId\)\)\s*return;/.test(countFired) &&
      countFired.includes("CountedFired.Add(bulletId, cartridge)") &&
      /if\s*\(!WasFired\(bulletId\)\s*\|\|\s*!CountedHits\.Add\(bulletId\)\)\s*return;/.test(countHit);
  }
  assert(retainsProjectileDeduplication(analytics), "projectile registration or hit deduplication was removed");
  assert(!retainsProjectileDeduplication(analytics.replace("|| CountedFired.ContainsKey(bulletId)", "")) &&
    !retainsProjectileDeduplication(analytics.replace("|| !CountedHits.Add(bulletId)", "")),
    "projectile deduplication oracle accepted a removed fired or hit guard");
  console.log("COMBATLOG ACCURACY VERIFIED");
}

function imageTarget(key) {
  const target = new FakeElement("image-" + key);
  const img = new FakeElement("img"), status = new FakeElement("status");
  target.setAttribute("data-local-image", key);
  target.querySelector = (selector) => selector === "img" ? img : selector === ".image-status" ? status : null;
  return { target, img, status };
}

function fakeTimers() {
  let id = 0, now = 0;
  const pending = new Map();
  return {
    set: (callback, delay) => { pending.set(++id, { callback, time: now + delay }); return id; },
    clear: (key) => pending.delete(key),
    next() {
      if (!pending.size) return false;
      const [key, timer] = [...pending].sort((a, b) => a[1].time - b[1].time)[0];
      pending.delete(key); now = timer.time; timer.callback(); return true;
    },
    get size() { return pending.size; },
    get elapsed() { return now; },
  };
}

async function flushPromises() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

async function verifyEquipment() {
  const { window, elements } = runtime();
  const hooks = window.__combatLogTest;
  const current = fixture();
  current.raid.outcome = "KILLED IN ACTION";
  assert(readFileSync("Analytics/RaidMeta.cs", "utf8").includes('case ExitStatus.Killed: return "' + current.raid.outcome + '"'), "killer fixture does not use the backend death outcome label");
  current.killer = {
    profileId: "killer-a", name: 'Killer <script> & "name"', level: 42, side: "BEAR", portraitImage: "100001",
    equipment: [
      { slot: "Headwear", name: "Helmet", image: "100002", armorClass: 4, durability: 0, maxDurability: 45 },
      { slot: "FirstPrimaryWeapon", name: "AK-74", image: "http://bad.example/icon.png", templateId: "weapon-template" },
    ],
  };
  current.weapons = [
    { id: "weapon-a", name: "Same rifle", image: "100003", fired: 3, shotsHit: 1, cartridgesFired: 3, cartridgesHit: 1, hits: 5, damage: 120, armorDamage: 30, kills: 1, killLinks: 2 },
    { id: "weapon-b", name: "Same rifle", image: "100004", fired: 7, shotsHit: 0, cartridgesFired: 7, cartridgesHit: 0, hits: 0, damage: 0, armorDamage: 0, kills: 0, killLinks: 0 },
  ];
  current.engagements[1].hits[0].weaponId = "weapon-a";
  current.engagements[1].hits[0].weapon = "Same rifle";
  window.__combatLogRender(current, false);
  let markup = elements.get("weapons").innerHTML;
  assert((markup.match(/class="weapon-card"/g) || []).length === 2, "same-name weapon instances were merged");
  assert(markup.includes('data-weapon-id="weapon-a"') && markup.includes('data-weapon-id="weapon-b"'), "weapon cards lost stable instance ids");
  assert(markup.includes('>33%</div>') && markup.includes('>1 / 3</span>'), "weapon precision used contacts as unique hits");
  assert(markup.includes('<dt>Contacts</dt><dd class="num">5</dd>') && !markup.includes("167%"), "raw contacts were discarded or inflated precision");
  assert(markup.includes('>0%</div>') && markup.includes('>0 / 7</span>') && markup.includes("No recorded contacts"), "all-miss weapon row was absent or unknown");
  assert(markup.includes('data-weapon-filter="id:weapon-b" disabled'), "zero-hit weapon offers a misleading contact drilldown");
  assert(markup.includes('data-weapon-filter="id:weapon-a">View hit events'), "recorded instance contacts are not inspectable");
  assert(markup.includes('<dt>Direct kills</dt><dd class="num">1</dd>') && markup.includes('<dt>Kill links</dt><dd class="num">2</dd>'), "direct kills and later kill links were conflated");
  assert(markup.includes('<dt>Body damage prevented</dt><dd class="num">13</dd>') &&
    !markup.includes('<dt>Body damage prevented</dt><dd class="num">30</dd>'),
    "weapon armour effect trusted the legacy aggregate instead of its hit evidence");
  const a = hit({ weapon: "Twin", weaponId: "a" }), b = hit({ weapon: "Twin", weaponId: "b" });
  assert(hooks.weaponIdentity(a) !== hooks.weaponIdentity(b), "same-name weapons share a filter key");
  assert(hooks.passesWith(a, { weapon: hooks.weaponIdentity(a) }) && !hooks.passesWith(b, { weapon: hooks.weaponIdentity(a) }), "weapon filter leaked contacts from another instance");
  assert(hooks.passesWith(a, { weapon: "name:Twin" }), "legacy name grouping cannot inspect its contact evidence");
  const dossier = elements.get("killer").innerHTML;
  assert(dossier.includes("Credited killer") && dossier.includes("Level 42") && dossier.includes("Class 4") && dossier.includes("0 / 45 durability"), "killer identity or visible condition was lost");
  assert(dossier.includes('data-local-image="100001"') && dossier.includes('data-local-image="100002"'), "local killer portrait or equipment icon was not requested");
  assert(!dossier.includes("http://bad.example") && !dossier.includes("Killer <script>"), "killer snapshot introduced an unescaped label or remote image URL");
  assert(dossier.includes('role="img" aria-label="Schematic') && dossier.includes("image unavailable"), "schematic image fallback lacks accessible identity or provenance");
  assert(dossier.includes("Primary weapon") && dossier.includes("AK-74"), "equipment cards do not identify visible slots");
  const weaponButton = elements.get("weapons").querySelectorAll("[data-weapon-filter]")
    .find((button) => button.getAttribute("data-weapon-filter") === "id:weapon-a");
  assert(weaponButton && weaponButton.events.click, "weapon contact drilldown is not wired");
  weaponButton.events.click();
  const weaponFilters = hooks.recordState().filters;
  const weaponHits = hooks.allHits(current).filter((h) => hooks.passesWith(h, weaponFilters));
  assert(activeReportView(elements) === "combat" && activeHitView(elements) === "split" &&
    weaponFilters.dir === "dealt" && weaponFilters.weapon === "id:weapon-a" &&
    weaponHits.length === 1 && weaponHits[0] === current.engagements[1].hits[0],
    "weapon drilldown did not open its exact outgoing evidence in the combat workspace");

  let invalidRaidId = 500;
  for (const invalid of [
    { fired: 0, shotsHit: 0 }, { fired: null }, { fired: "3" }, { fired: 1.5 }, { fired: -1 },
    { shotsHit: undefined }, { shotsHit: "1" }, { shotsHit: NaN }, { shotsHit: Infinity }, { shotsHit: -1 }, { shotsHit: 4 },
  ]) {
    const raid = { ...current, ts: ++invalidRaidId, weapons: [{ ...current.weapons[0],
      cartridgesFired: undefined, cartridgesHit: undefined, ...invalid }] };
    window.__combatLogRender(raid, true);
    assert(!/>\d+%<|>\d+ \/ \d+</.test(elements.get("weapons").innerHTML), "invalid weapon projectile counters invented precision");
  }
  for (const version of [1, 2]) {
    const legacy = fixture(version);
    legacy.ts = "legacy-" + version;
    legacy.raid.outcome = "KILLED IN ACTION";
    const rows = hooks.weaponRows(legacy);
    assert(rows.length === 1 && rows[0].hits === 3 && rows[0].damage === 142, "legacy contact grouping did not conserve captured data");
    assert(rows[0].fired === undefined && rows[0].shotsHit === undefined && rows[0].kills === undefined && rows[0].killLinks === undefined, "legacy contacts invented projectile counters or weapon kill attribution");
    window.__combatLogRender(legacy, true);
    markup = elements.get("weapons").innerHTML;
    assert(markup.includes("instance identity, fired shots, accuracy and weapon kills were not recorded") && !/>\d+%<|>\d+ \/ \d+</.test(markup), "old archive lacks honest weapon limitations");
    assert(elements.get("killer").innerHTML.includes("no snapshot was saved") && !elements.get("killer").innerHTML.includes("Original game image:"), "legacy death invented a portrait or killer inventory");
  }
  const unknown = { ...current, ts: "unknown", weapons: [{ name: "Unknown instance", hits: 2, damage: 10 }] };
  window.__combatLogRender(unknown, true);
  assert(elements.get("weapons").innerHTML.includes("Weapon instance unavailable") && !elements.get("weapons").innerHTML.includes("data-weapon-id"), "missing identity was replaced by an invented instance");
  window.__combatLogRender({ ...unknown, ts: "unknown-bucket", weapons: [{ id: "unknown", name: "Not an exact weapon", hits: 2, damage: 10 }] }, true);
  assert(elements.get("weapons").innerHTML.includes("Unidentified weapon activity") && elements.get("weapons").innerHTML.includes("May combine multiple weapons") && !elements.get("weapons").innerHTML.includes('data-weapon-id="unknown"'), "backend unknown-identity bucket was presented as one exact instance");
  assert(hooks.passesWith(hit(), { weapon: "unknown:" }) && !hooks.passesWith(a, { weapon: "unknown:" }), "unknown-identity drilldown included a known weapon");
  const empty = { ...current, ts: "empty", weapons: [], engagements: [], raid: { outcome: "SURVIVED", finished: true } };
  window.__combatLogRender(empty, false);
  assert(elements.get("weapons").innerHTML.includes("No weapon activity") && elements.get("killer").innerHTML === "", "empty or survived raid retained stale killer/weapon data");
  window.__combatLogRender({ ...current, ts: "active", raid: { outcome: "KILLED IN ACTION", finished: false } }, false);
  assert(elements.get("killer").innerHTML === "", "active raid revealed the killer snapshot");

  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU4cAAAAASUVORK5CYII=";
  assert(hooks.validPngData(png), "image validator rejected the valid local PNG control");
  const backendLimit = Number(presentation.match(/MaxImageBytes\s*=\s*(\d+)\s*\*\s*1024/)[1]) * 1024;
  const browserLimit = Number(html.match(/data\.length\s*>\s*(\d+)/)[1]);
  assert(22 + 4 * Math.ceil(backendLimit / 3) <= browserLimit,
    "backend PNG allowance can expand beyond the browser data-URL boundary");
  for (const bad of ["https://example.test/a.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,PHN2Zz4=", png + "\" onerror=\"alert(1)", png.replace("AAAABCAQ", "/////CAQ"), png + "A".repeat(400001)]) {
    assert(!hooks.validPngData(bad), "image validator accepted non-PNG, oversized, or malformed data");
  }
  for (const key of ["0", "000", "../100001", "100-001", "1.5", "https://example.test", "1".repeat(20), 123]) assert(!hooks.validImageKey(key), "opaque key validation admitted a path or malformed key");
  assert(hooks.validImageKey("100001"), "numeric image key positive control failed");

  const transitionTimers = fakeTimers(); let transitionCalls = 0;
  const transition = runtime({ timers: transitionTimers, request: () => { transitionCalls++; return { state: "ready", data: png }; } });
  const transitionTarget = imageTarget("100003"); transition.document.imageTargets = [transitionTarget.target];
  const activeRaid = { ...current, ts: 777, raid: { ...current.raid, finished: false } };
  transition.window.__combatLogRender(activeRaid, false); await flushPromises();
  assert(transitionCalls === 0 && transitionTimers.size === 0 && transition.elements.get("weapons").innerHTML.includes("available after raid"), "in-raid image polling could exhaust its retry budget before rendering starts");
  transition.document.hidden = true; transition.document.events.visibilitychange();
  transition.document.hidden = false; transition.document.events.visibilitychange();
  transition.window.events.pageshow({ persisted: true }); await flushPromises();
  assert(transitionCalls === 0 && transitionTimers.size === 0, "visibility or page restore started image requests during the raid");
  transition.window.__combatLogRender({ ...activeRaid, raid: { ...activeRaid.raid, finished: true } }, false); await flushPromises();
  assert(transitionCalls === 1 && transitionTarget.img.src === png, "same-timestamp raid end did not start local images without reloading");
  async function assertScopeImageRecovery(returnMethod, archive) {
    const clock = fakeTimers(); let imageCalls = 0, archiveCalls = 0;
    const latest = {...current,ts:780,history:[{ts:780,weapons:current.weapons},{ts:779,weapons:current.weapons}]};
    const older = {...current,ts:779,raid:{...current.raid,location:"Archived image fixture"}};
    const run = runtime({timers:clock,request(channel,key) {
      if(channel === "loadRaid") {
        assert(key === "779", "scope image fixture requested an unexpected archive");
        archiveCalls++; return JSON.stringify(older);
      }
      assert(channel === "loadImage" && key === "100003", "scope image recovery changed the original image identity");
      imageCalls++; return {state:"ready",data:png};
    }});
    const controls=run.window.__combatLogTest, original=imageTarget("100003");
    run.document.imageTargets=[original.target];run.window.__combatLogRender(latest,false);await flushPromises();
    if(archive) {
      const selector=run.elements.get("raid-selector");selector.value="779";selector.onchange();await flushPromises();
      assert(controls.viewState().historyScope.kind === "archive", "image fixture did not establish its positive archived-raid control");
    }
    assert(original.img.src === png && typeof original.img.onload === "function", "scope image positive control never loaded its original");
    original.img.onload();
    assert(original.target.classList.values.has("ready") && original.status.textContent === "", "scope image positive control never decoded");
    const before=imageCalls;
    assert(controls.showOverall(), "image fixture could not enter Overall");
    controls.mountImages();await flushPromises();
    assert(imageCalls === before && !original.img.onload && clock.size === 0,
      "Overall continued image requests, decode callbacks or retry timers");
    const replacement=imageTarget("100003");run.document.imageTargets=[replacement.target];
    controls[returnMethod]();await flushPromises();
    const scenario=(archive ? "archived" : "latest")+" raid via "+returnMethod;
    assert(imageCalls === before + 1 && replacement.img.src === png && typeof replacement.img.onload === "function",
      scenario+" did not resume original image loading after Overall");
    assert(!replacement.target.classList.values.has("ready"), scenario+" revealed an image before its fresh DOM target decoded");
    replacement.img.onload();
    assert(replacement.target.classList.values.has("ready") && replacement.status.textContent === "" && clock.size === 0,
      scenario+" did not restore the decoded original over its fallback");
    assert(archiveCalls === (archive ? 1 : 0) && controls.viewState().historyScope.kind === (archive && returnMethod === "showRaidReport" ? "archive" : "latest"),
      scenario+" refetched the retained archive or restored the wrong report scope");
  }
  const scopeImageFailures=[];
  for(const archive of [false,true]) for(const returnMethod of ["showRaidReport","showLive"]) {
    try {await assertScopeImageRecovery(returnMethod,archive);} catch(error) {scopeImageFailures.push(error.message);}
  }
  assert(!scopeImageFailures.length,scopeImageFailures.join("; "));

  const timers = fakeTimers();
  let calls = 0;
  const bridged = runtime({ timers, request: (channel, key) => {
    assert(channel === "loadImage" && key === "100001", "image bridge changed channel or interpreted the opaque key");
    return Promise.resolve(++calls === 1 ? '{"state":"pending"}' : JSON.stringify({ state: "ready", data: png }));
  } });
  const node = imageTarget("100001"), duplicate = imageTarget("100001");
  bridged.document.imageTargets = [node.target, duplicate.target];
  bridged.window.__combatLogTest.mountImages();
  await flushPromises();
  assert(calls === 1 && timers.size === 1 && node.status.textContent === "Loading local image", "duplicate image keys did not share bounded pending state");
  timers.next(); await flushPromises();
  assert(calls === 2 && node.img.src === png && duplicate.img.src === png && timers.size === 0, "pending image did not settle to both consumers");
  assert(!node.target.classList.values.has("ready"), "original image was exposed before browser decode succeeded");
  node.img.onload();
  assert(node.target.classList.values.has("ready") && node.status.textContent === "", "decoded original retained a visible provenance caption");
  duplicate.img.onerror();
  assert(!node.target.classList.values.has("ready") && node.status.textContent.includes("unavailable"), "decode failure removed the readable fallback");
  const remountTimers = fakeTimers(); let remountResolve, remountCalls = 0;
  const remount = runtime({ timers: remountTimers, request: () => { remountCalls++; return new Promise(resolve => { remountResolve = resolve; }); } });
  const discarded = imageTarget("100010"), replacement = imageTarget("100010");
  remount.document.imageTargets = [discarded.target]; remount.window.__combatLogTest.mountImages();
  remount.document.imageTargets = [replacement.target]; remount.window.__combatLogTest.mountImages();
  remountResolve({ state: "ready", data: png }); await flushPromises();
  assert(remountCalls === 1 && !discarded.img.src && replacement.img.src === png, "stable-raid rerender lost deduplication or repainted detached nodes");
  replacement.img.onload();
  remount.document.hidden = true; remount.document.events.visibilitychange();
  assert(remountTimers.size === 0 && !replacement.img.onload, "hidden page kept decode callbacks or retry timers alive");
  remount.window.__combatLogTest.mountImages();
  assert(remountCalls === 1, "hidden page requested local images");
  remount.document.hidden = false; remount.document.events.visibilitychange();
  remountResolve({ state: "ready", data: png }); await flushPromises();
  assert(remountCalls === 2 && replacement.img.src === png, "visible page could not recover local image loading");

  for (const response of [() => Promise.reject(new Error("offline")), () => { throw new Error("bridge absent"); }, () => "not json", () => ({ state: "ready", data: "https://bad.test/icon.png" }), () => ({ state: "unavailable" })]) {
    const clock = fakeTimers(), run = runtime({ timers: clock, request: response }), target = imageTarget("100002");
    run.document.imageTargets = [target.target]; run.window.__combatLogTest.mountImages(); await flushPromises();
    assert(target.status.textContent.includes("unavailable") && !target.img.src && clock.size === 0, "failed bridge left a loading image or untrusted src");
  }

  const pendingTimers = fakeTimers(); let pendingCalls = 0;
  const pendingRun = runtime({ timers: pendingTimers, request: () => { pendingCalls++; return { state: "pending" }; } });
  const pendingTarget = imageTarget("100003"); pendingRun.document.imageTargets = [pendingTarget.target];
  pendingRun.window.__combatLogTest.mountImages(); await flushPromises();
  for (let i = 0; pendingTimers.size && i < 100; i++) { pendingTimers.next(); await flushPromises(); }
  assert(pendingCalls === 30 && pendingTimers.size === 0 && pendingTarget.status.textContent.includes("unavailable"), "pending images retry forever or abandon the render queue too early");
  assert(pendingTimers.elapsed >= 90000 && pendingTimers.elapsed <= 150000, "pending backoff cannot cover the bounded post-raid renderer window");

  const limitedTimers = fakeTimers(), resolvers = []; let active = 0, highWater = 0, total = 0;
  const limited = runtime({ timers: limitedTimers, request: () => { total++; active++; highWater = Math.max(highWater, active); return new Promise(resolve => resolvers.push(value => { active--; resolve(value); })); } });
  const targets = Array.from({ length: 70 }, (_, i) => imageTarget(String(200000 + i)));
  limited.document.imageTargets = targets.map(x => x.target); limited.window.__combatLogTest.mountImages();
  assert(total === 4, "image loader started more than four bridge requests concurrently");
  for (let i = 0; resolvers.length && i < 100; i++) { resolvers.shift()({ state: "unavailable" }); await flushPromises(); }
  assert(total === 64 && highWater === 4 && limitedTimers.size === 0, "per-raid image or concurrency bound failed");
  assert(targets[69].status.textContent.includes("unavailable"), "over-limit images lack a labelled fallback");

  const staleTimers = fakeTimers(); let resolveOld;
  const stale = runtime({ timers: staleTimers, request: () => new Promise(resolve => { resolveOld = resolve; }) });
  const oldTarget = imageTarget("100005"); stale.document.imageTargets = [oldTarget.target]; stale.window.__combatLogTest.mountImages();
  stale.window.__combatLogTest.resetImages(false);
  assert(staleTimers.size === 0, "raid switch left an old image timer armed");
  resolveOld({ state: "ready", data: png }); await flushPromises();
  assert(!oldTarget.img.src && !oldTarget.target.classList.values.has("ready"), "stale bridge response repainted an old raid");
  const nextTarget = imageTarget("100005"); stale.document.imageTargets = [nextTarget.target]; stale.window.__combatLogTest.mountImages();
  stale.window.events.pagehide();
  resolveOld({ state: "ready", data: png }); await flushPromises();
  assert(staleTimers.size === 0 && !nextTarget.img.src, "page disposal accepted late original images");

  const stalledTimers = fakeTimers(); let stalledCalls = 0;
  const stalled = runtime({ timers: stalledTimers, request: () => { stalledCalls++; return new Promise(() => {}); } });
  const stalledNodes = Array.from({ length: 6 }, (_, i) => imageTarget(String(300000 + i)));
  stalled.document.imageTargets = stalledNodes.map(x => x.target); stalled.window.__combatLogTest.mountImages();
  for (let i = 0; stalledTimers.size && i < 20; i++) stalledTimers.next();
  assert(stalledCalls === 4 && stalledNodes.every(x => x.status.textContent.includes("unavailable")), "never-settling image requests hung UI or exceeded the concurrency cap");
  stalled.window.__combatLogTest.resetImages(false); stalled.window.__combatLogTest.mountImages();
  for (let i = 0; stalledTimers.size && i < 20; i++) stalledTimers.next();
  assert(stalledCalls === 4, "raid switching accumulated never-settling bridge promises");
  const preview = execFileSync(process.execPath, ["tests/preview-mannequin.mjs", "--verify"], { encoding: "utf8" });
  assert(preview.includes("COMBATLOG EQUIPMENT PREVIEW VERIFIED"), "local preview does not agree with its recorded contacts");
  console.log("COMBATLOG EQUIPMENT UI VERIFIED");
}

async function verifyPolish() {
  const { window, elements } = runtime(), hooks = window.__combatLogTest;
  const scenarios = [
    { dealt: true, fatal: false, fatalInferred: false, label: "" },
    { dealt: false, fatal: false, fatalInferred: false, label: "" },
    { dealt: true, fatal: true, fatalInferred: false, label: "KILL" },
    { dealt: false, fatal: true, fatalInferred: false, label: "KIA" },
    { dealt: true, fatal: true, fatalInferred: true, label: "KILL LINK" },
    { dealt: false, fatal: true, fatalInferred: true, label: "DEATH LINK" },
    { dealt: true, fatal: false, fatalInferred: true, label: "" },
    { dealt: false, fatal: false, fatalInferred: true, label: "" },
  ];
  const maliciousName = 'Target <img src=x onerror="bad()"> & "name"';
  const current = fixture();
  current.engagements = [{ start: 0, duration: scenarios.length - 1, opponents: [], hits: scenarios.map((scenario, t) => {
    const { label, ...flags } = scenario;
    return hit({ ...flags, t, who: maliciousName, weapon: 'Rifle <script>bad()</script>', ammo: 'Ammo <b>' });
  }) }];

  function rows(markup) {
    return [...markup.matchAll(/<tr class="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/g)].map(match => ({ className: match[1], body: match[2] }));
  }
  function assertRows(markup, version) {
    const rendered = rows(markup);
    assert(rendered.length === scenarios.length, "hit-list polish dropped or duplicated a contact");
    assert(!/[\u2020\u2021]|&#(?:8224|x2020);/i.test(markup), "fatal events still rely on a dagger mark");
    rendered.forEach((row, index) => {
      const scenario = scenarios[index], legacy = !version || version < 2;
      const linked = scenario.fatal && (legacy || scenario.fatalInferred);
      const certainty = linked ? "linked" : "direct";
      const direction = scenario.dealt ? "dealt" : "taken";
      const expectedClass = direction + (scenario.fatal ? " fatal " + certainty : "");
      assert(row.className === expectedClass, "fatal row certainty or direction changed: " + index);
      assert(row.body.includes('Target &lt;img src=x onerror=&quot;bad()&quot;&gt; &amp; &quot;name&quot;') &&
        row.body.includes('Rifle &lt;script&gt;bad()&lt;/script&gt;') && row.body.includes('Ammo &lt;b&gt;'),
        "hit-list outcome markup introduced unescaped payload text");
      assert(!row.body.includes('<img') && !row.body.includes('<script>'), "hit-list badge accepted payload markup");
      const badges = [...row.body.matchAll(/<span class="fatal-badge (direct|linked)" title="([^"]+)">([^<]+)<span class="hit-outcome-detail">([^<]+)<\/span><\/span>/g)];
      if (!scenario.fatal) {
        assert(badges.length === 0 && !row.body.includes('fatal-badge'), "ordinary contact acquired a fatal badge");
        return;
      }
      const label = linked ? (scenario.dealt ? "KILL LINK" : "DEATH LINK") : scenario.label;
      assert(badges.length === 1 && badges[0][1] === certainty && badges[0][3] === label,
        "fatal badge is missing, duplicated or makes the wrong claim: " + index);
      const title = badges[0][2];
      assert(badges[0][4] === " — " + title, "screen-reader outcome detail differs from the visible badge tooltip");
      assert(linked
        ? (legacy ? title.includes("Legacy") && title.includes("provenance was not recorded")
          : title.includes("Inferred") && title.includes("not confirmed as the fatal hit"))
        : (scenario.dealt ? title === "Direct fatal hit dealt by you."
          : title === "Killed in action: direct fatal hit received by you."),
        "fatal badge hides or invents its certainty: " + index);
    });
    return rendered;
  }
  for (const version of [2, 1, undefined]) {
    current.v = version; current.ts = "polish-" + version;
    const before = JSON.stringify(current);
    window.__combatLogRender(current, true);
    const allMarkup = elements.get("allhits").innerHTML;
    const engagementMarkup = elements.get("log").innerHTML;
    const allRows = assertRows(allMarkup, version);
    assert(!/<table\b|fatal-badge/.test(engagementMarkup) &&
      (engagementMarkup.match(/data-engagement-hits=/g) || []).length === current.engagements.length,
      "engagement summaries duplicate hit rows instead of linking to the canonical Hit Explorer");
    assert(JSON.stringify(current) === before, "visual polish mutated captured hit data");
    for (const corrupted of [
      allMarkup.replace('class="fatal-badge ', 'class="removed-badge '),
      allMarkup.replace('class="dealt"', 'class="dealt fatal direct"'),
      allMarkup.replace('>KILL LINK<', '>KILL<'),
      allMarkup.replace('<tbody>', '<tbody>\u2020'),
    ]) {
      let rejected = false;
      try { assertRows(corrupted, version); } catch (_) { rejected = true; }
      assert(rejected, "outcome oracle accepted missing, invented, dagger-only or overconfident presentation");
    }
  }

  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, "");
  function rule(selector) {
    return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(match => match[1].split(',').map(x => x.trim()).includes(selector))
      .map(match => match[2]).join(" ");
  }
  const list = ".allhits";
  assert(/background:\s*var\(--hit-wash\)/.test(rule(list + " tr.fatal td")), "fatal row has no shared background emphasis");
  assert(/inset 4px 0 0 var\(--hit-mark\)/.test(rule(list + " tr.fatal td:first-child")), "fatal row has no prominent leading edge");
  assert(rule(list + " tr.taken.fatal").includes("var(--blood)"), "incoming fatalities lost the incoming colour vocabulary");
  assert(rule(list + " tr.fatal").includes("var(--bone)"), "outgoing fatalities lost the outgoing colour vocabulary");
  assert(rule(list + " tr.dealt.fatal.linked").includes("--hit-wash:") &&
    rule(list + " tr.taken.fatal.linked").includes("--hit-wash:"), "links do not have a separate softer row treatment");
  assert(/display:\s*inline-block/.test(rule('.fatal-badge')) && /background:\s*var\(--hit-mark\)/.test(rule('.fatal-badge')),
    "direct fatal badges no longer have a solid, sized treatment");
  assert(/border-style:\s*dashed/.test(rule('.fatal-badge.linked')) && /background:\s*transparent/.test(rule('.fatal-badge.linked')),
    "linked badges are not visibly distinct from confirmed fatal hits");
  assert(!/display:\s*none|visibility:\s*hidden/.test(rule('.hit-outcome-detail')),
    "fatal provenance text is hidden from assistive technology");
  assert(rule('.local-image.ready svg').includes('visibility: hidden') &&
    /display:\s*block/.test(rule('.local-image.ready img')) && /inset:\s*0/.test(rule('.local-image.ready img')) && /height:\s*100%/.test(rule('.local-image.ready img')),
    "decoded original images do not replace the fallback silhouette or fill the released caption area");
  assert(/display:\s*none/.test(rule('.local-image.ready .image-status')),
    "decoded original images still display the Original game image caption");
  assert(/border-color:\s*var\(--bone\)/.test(rule('.anatomy .zone-button.hover')),
    "canvas-linked zone hover has no visible button treatment");

  const weaponLabel = 'Unknown <img src=x onerror="bad()"> & "rifle"';
  current.v = 2; current.ts = "polish-silhouette";
  current.weapons = [{ id: "polish-weapon", name: weaponLabel, image: "", fired: 0, shotsHit: 0, hits: 0, damage: 0, armorDamage: 0, kills: 0, killLinks: 0 }];
  window.__combatLogRender(current, true);
  const weaponMarkup = elements.get("weapons").innerHTML;
  const svg = weaponMarkup.match(/<svg class="weapon-schematic"[\s\S]*?<\/svg>/)?.[0];
  assert(svg && svg.includes('viewBox="0 12 240 88"') && svg.includes('role="img" aria-label="Schematic'),
    "weapon fallback is not the accessible native side-profile silhouette");
  for (const part of ['stock', 'receiver', 'grip', 'magazine', 'handguard', 'barrel', 'trigger-guard', 'sights']) {
    assert(new RegExp('<path data-weapon-part="' + part + '" d="[^"]{15,}"').test(svg), "rifle silhouette lacks recognizable " + part + " geometry");
  }
  assert(svg.includes('fill="currentColor"') && !svg.includes('M8 61 24 50'), "schematic retained the old ambiguous outline");
  assert(svg.includes('not an original game image') && weaponMarkup.includes('Schematic · image unavailable'), "fallback lost its honest provenance caption");
  assert(svg.includes('&lt;img') && !/<image\b|<img\b|<script\b|\bhref\s*=|url\(/i.test(svg), "native silhouette contains an external image or unescaped label");
  assert(!/function\s+hitRows\b|hitRows\s*\(/.test(html) &&
    (html.match(/hitRowPresentation\(d, h\)/g) || []).length === 2,
    "a duplicate engagement hit renderer returned or the canonical table bypassed outcome presentation");

  const slotKinds = {
    Headwear: "headwear", FaceCover: "face-cover", Eyewear: "eyewear", Earpiece: "headset",
    ArmBand: "armband", ArmorVest: "body-armour", TacticalVest: "tactical-rig", Backpack: "backpack",
    FirstPrimaryWeapon: "weapon", SecondPrimaryWeapon: "weapon", Holster: "sidearm", Scabbard: "melee",
  };
  for (const [slot, kind] of Object.entries(slotKinds))
    assert(hooks.equipmentKind(slot) === kind, "equipment slot uses the wrong schematic: " + slot);
  assert(hooks.equipmentKind("UnknownSlot") === "item" && hooks.slotLabel("ArmBand") === "Armband",
    "unknown equipment lost its neutral fallback or ArmBand kept its raw enum label");
  const distinctiveParts = {
    headwear: ["shell", "ear-guards", "chin-strap"],
    "face-cover": ["hood", "eye-slit", "mask-panel"],
    eyewear: ["left-lens", "right-lens", "bridge"],
    headset: ["headband", "ear-cups", "microphone"],
    armband: ["band", "patch", "fastener"],
    "body-armour": ["shoulders", "plate", "cummerbund"],
    "tactical-rig": ["harness", "belt", "mag-pouches"],
    backpack: ["pack", "handle", "front-pocket", "straps"],
    sidearm: ["slide", "trigger-guard", "grip"],
    melee: ["blade", "guard", "wrapped-grip"],
  };
  const iconMarkup = [];
  for (const [kind, parts] of Object.entries(distinctiveParts)) {
    const icon = hooks.schematic(kind, maliciousName);
    iconMarkup.push(icon);
    assert(icon.includes('data-schematic-kind="' + kind + '"') && icon.includes('role="img" aria-label="Schematic') && icon.includes("<title>"),
      "equipment fallback lacks kind identity or accessible labelling: " + kind);
    for (const part of parts)
      assert(icon.includes('data-equipment-part="' + part + '"'), "equipment fallback lacks recognizable " + part + ": " + kind);
    assert(icon.includes('&lt;img') && !/<image\b|<img\b|<script\b|\bhref\s*=|url\(/i.test(icon),
      "equipment fallback contains an external image or unescaped label: " + kind);
  }
  assert(new Set(iconMarkup).size === iconMarkup.length, "different equipment families still share one schematic silhouette");
  await verifyEquipment();
  console.log("COMBATLOG VISUAL UI VERIFIED");
}

function verifyRecords() {
  const { window, elements } = runtime(), hooks = window.__combatLogTest;
  const strongestOut = hit({ t: 11, who: 'Twin <b>', opponentId: 'b', after: 160, before: 190, dist: 99, weapon: 'AK & rifle', ammo: 'BP' });
  const strongestIn = hit({ t: 11, dealt: false, who: 'Attacker', opponentId: 'c', after: 195, before: 240, dist: 800, weapon: 'Enemy rifle' });
  const farthest = hit({ t: 20, who: 'Twin <b>', opponentId: 'b', after: 40, dist: 290 });
  const first = hit({ t: 0, who: 'Twin <b>', opponentId: 'a', after: 50, dist: 50 });
  const current = { ...fixture(), ts: 1000, engagements: [{ hits: [strongestIn, farthest, strongestOut, first,
    hit({ t: 5, who: 'Twin <b>', opponentId: 'a', dist: 50 }), hit({ t: 7, who: 'Twin <b>', opponentId: 'a', weapon: 'Glock', ammo: 'Pst', dist: 50 })] }] };
  window.__combatLogRender(current, false);
  const markup = elements.get('records').innerHTML;
  assert((markup.match(/class="record-card/g) || []).length === 4, 'fixed record overview did not retain all four cards');
  assert(markup.includes('290') && markup.includes('160') && markup.includes('195') && markup.includes('3 <small>contacts'), 'record values confuse directions, distance or damage');
  assert(markup.includes('Twin &lt;b&gt;') && markup.includes('AK &amp; rifle') && !markup.includes('Twin <b>'), 'record labels are not escaped');
  assert(markup.includes('shown contact; other contacts may differ'), 'opponent record implies one weapon for every contact');
  hooks.focusTapeRange(0, 6, 'Earlier moment');
  const buttons = elements.get('records').querySelectorAll('[data-record-tape]');
  assert(buttons.length === 4 && buttons.every(b => b.events.click), 'record buttons have no functional click handler');
  buttons.find(b => b.getAttribute('data-record-tape') === 'strongest-taken').events.click();
  assert(activeReportView(elements) === 'combat' && hooks.recordState().hit === strongestIn &&
    hooks.recordState().focus === null,
    'record action did not open Combat, clear old focus or select exact equal-time incoming event');
  buttons.find(b => b.getAttribute('data-record-tape') === 'strongest-dealt').events.click();
  assert(activeReportView(elements) === 'combat' && hooks.recordState().hit === strongestOut,
    'equal-time record navigation selected a different hit or left the tape view');
  assert(elements.get('selected-hit-detail').innerHTML.includes('AK &amp; rifle'), 'visible selected-event detail does not show record weapon');
  elements.get('records').querySelectorAll('[data-record-contacts]')[0].events.click();
  const filters = hooks.recordState().filters;
  assert(activeReportView(elements) === 'combat' && activeHitView(elements) === 'split' &&
    filters.dir === 'dealt' && filters.opponent === 'id:a',
    'opponent record does not open Combat or scope outgoing contacts to stable identity');
  assert(hooks.allHits(current).filter(h => hooks.passesWith(h, filters)).length === 3, 'same-name opponents contaminated record contact evidence');
  assert(!hooks.openRecord('bogus', false) && !hooks.openRecord('strongest-taken', true), 'unknown or wrong record action accepted');
  const malformedIds = { ...fixture(), ts:1005, engagements:[{hits:[
    hit({opponentId:' ',who:' Legacy ',cls:' PMC ',dist:0.01,after:0.01}),
    hit({opponentId:7,who:'legacy',cls:'pmc',dist:0.01,after:0.01}),
    hit({opponentId:null,who:'LEGACY',cls:'PMC',dist:0.01,after:0.01}),
    hit({opponentId:null,who:'LEGACY',cls:'PMC',dealt:'true',dist:9999,after:9999})]}] };
  window.__combatLogRender(malformedIds, true);
  hooks.openRecord('most-hit-opponent', true);
  assert(hooks.allHits(malformedIds).filter(h=>hooks.passesWith(h,hooks.recordState().filters)).length === 3,
    'malformed IDs split legacy record and contact filter semantics');
  assert(elements.get('records').innerHTML.includes('&lt;1'), 'positive tiny record was rounded to a misleading zero');
  const legacy = fixture(1); legacy.ts = 1001;
  window.__combatLogRender(legacy, true);
  const legacyMarkup = elements.get('records').innerHTML;
  assert(legacyMarkup.includes('Legacy clock') && legacyMarkup.includes('Legacy name/class group') && legacyMarkup.includes('share this record'), 'legacy time, identity or tie limitation not visible');
  assert(!legacyMarkup.includes('290'), 'archived raid retained prior record value');
  const oldButton = buttons[0]; oldButton.events.click();
  assert(hooks.recordState().hit === hooks.raidRecords(legacy)[0].hit, 'stale card callback navigated to the previous raid');
  const missingClock = { ...fixture(), ts: 1002, engagements: [{hits:[hit({t:null, dist:25})]}] };
  window.__combatLogRender(missingClock, true);
  assert(elements.get('records').innerHTML.includes('Event time unavailable') && !hooks.openRecord('farthest-hit'), 'missing time invented a tape location');
  const timedRecord = hit({t:10, dist:200, after:20}), untimed = hit({t:undefined,dist:1,after:80});
  const mixedClock = {...fixture(),ts:1006,engagements:[{hits:[timedRecord,untimed]}]};
  window.__combatLogRender(mixedClock, true);
  assert(hooks.openRecord('farthest-hit') && hooks.recordState().hit === timedRecord, 'valid record failed when another event has no time');
  assert(!/NaN|Infinity/.test(elements.get('tape').innerHTML) && (elements.get('tape').innerHTML.match(/class="tape-hit /g)||[]).length === 1,
    'untimed event broke the axis or was given an invented tape position');
  assert(hooks.raidRecords(mixedClock)[1].hit === untimed && !hooks.openRecord('strongest-dealt'), 'untimed record was discarded or placed on tape');
  hooks.openRecord('most-hit-opponent',true);
  assert(hooks.allHits(mixedClock).filter(h=>hooks.passesWith(h,hooks.recordState().filters)).length === 2,
    'untimed record contact was removed from hit log evidence');
  assert(elements.get('tape').innerHTML.includes('1 contacts lack recorded times'), 'timeline omission is not explained');
  const earlyTimed = hit({t:2,dist:10,after:2});
  const legacyMixedClock = {...mixedClock,v:1,ts:1007,engagements:[{hits:[timedRecord,untimed,earlyTimed]}]};
  window.__combatLogRender(legacyMixedClock,true);
  assert(hooks.openRecord('farthest-hit') && hooks.recordState().hit === timedRecord, 'legacy range omitted valid record after sorting across an untimed event');
  assert(hooks.allHits(legacyMixedClock)[0] === earlyTimed && hooks.allHits(legacyMixedClock)[1] === timedRecord,
    'untimed event blocked chronological ordering of valid events');
  assert((elements.get('tape').innerHTML.match(/class="tape-hit /g)||[]).length === 2 && !/NaN|Infinity/.test(elements.get('tape').innerHTML),
    'legacy tape range lost a valid marker around an unclocked event');
  window.__combatLogRender({ ...fixture(), ts:1003, engagements:[] }, false);
  assert((elements.get('records').innerHTML.match(/No record available/g) || []).length === 4, 'empty raid retained records');
  assert(elements.get('records').querySelectorAll('[data-record-tape]').every(b => b.disabled), 'empty record buttons still active');
  assert(!hooks.openRecord('farthest-hit'), 'empty record can navigate to old evidence');
  const directory = 'D:/SPT41/BepInEx/config/CombatLog/raids';
  let captured = 0;
  if (existsSync(directory)) for (const filename of readdirSync(directory).filter(n => /^\d+\.json$/.test(n))) {
    const raid = JSON.parse(readFileSync(directory + '/' + filename, 'utf8'));
    window.__combatLogRender(raid, true);
    const hits = hooks.allHits(raid), records = hooks.raidRecords(raid);
    for (const [index, direction, field] of [[0, true, 'dist'], [1, true, 'after'], [2, false, 'after']]) {
      const values = hits.filter(h => h.dealt === direction && typeof h[field] === 'number' && Number.isFinite(h[field]) && h[field] > 0).map(h => h[field]);
      assert(records[index].value === (values.length ? Math.max(...values) : null), 'captured record differs from independently computed maximum');
    }
    for (const record of records) if (record.hit && Number.isFinite(record.hit.t) && record.hit.t >= 0) {
      assert(hooks.openRecord(record.id) && hooks.recordState().hit === record.hit, 'captured record does not select its exact event');
    }
    captured++;
  }
  assert(html.includes('<script src="records.js"></script>') && panel.includes('GetManifestResourceStream("CombatLog.records.js")'), 'record module is not wired into the packaged page');
  const embedded = html.replace('<script src="mannequin.js"></script>', '<script>' + readFileSync('web/mannequin.js','utf8') + '</script>')
    .replace('<script src="records.js"></script>', '<script>' + readFileSync('web/records.js','utf8') + '</script>');
  assert(!embedded.includes('src="records.js"'), 'overlay still requires an external record script');
  for (const script of embedded.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  console.log('CAPTURED RECORD RAIDS VERIFIED: ' + captured);
  console.log('COMBATLOG RECORD UI VERIFIED');
}

function verifyOverall() {
  const { window, elements } = runtime();
  const hooks = window.__combatLogTest;
  const rows = [
    { ts: 100, date: "2026-01-01 10:00", location: "Factory", outcome: "RAN THROUGH",
      duration: 60, kills: 1, hitsDealt: 4, hitsReceived: 2, damageDealt: 100.5, damageReceived: 40 },
    { ts: 200, date: "2026-01-02 10:00", location: "Factory", outcome: "KIA",
      duration: 120, kills: 2, hitsDealt: 8, hitsReceived: 6, damageDealt: 300, damageReceived: 150,
      shotsFired: 10, shotsHit: 1, cartridgesFired: 10, cartridgesHit: 1, ammoCost: 1000, costBasis: "cartridge" },
    { ts: 200, location: "Wrong duplicate", shotsFired: "10", shotsHit: 99, ammoCost: -5 },
    { ts: 300, date: "2026-01-03 10:00", location: "Customs <img src=x onerror=alert(1)>", outcome: "SURVIVED",
      duration: 180, kills: 0, hitsDealt: 2, hitsReceived: 0, damageDealt: 49.5, damageReceived: 0,
      shotsFired: 90, shotsHit: 45, cartridgesFired: 90, cartridgesHit: 45, ammoCost: 2000, costBasis: "cartridge" },
    { ts: 0, location: "startup placeholder", kills: 999 },
    { ts: "400", location: "string timestamp", kills: 999 },
    { ts: 500, location: "invalid numerics", kills: Infinity, damageDealt: NaN, shotsFired: 2, shotsHit: 3 },
  ];
  const live = {
    v: 2, ts: 300, history: rows,
    raid: { outcome: "SURVIVED", location: "Current duplicate", duration: 180, finished: true },
    findings: [], engagements: [], weapons: [], loadout: [], hitsDealt: 2, hitsReceived: 0,
    damageDealt: 49.5, damageReceived: 0, shotsFired: 90, shotsHit: 45,
    cartridgesFired: 90, cartridgesHit: 45, kills: 0, ammoCost: 2000, costBasis: "cartridge",
  };
  const canonical = hooks.canonicalHistoryRows(live);
  assert(canonical.length === 4 && canonical.map((row) => row.ts).join(",") === "500,300,200,100",
    "Overall history did not reject placeholders or deduplicate finished raids");
  assert(!Object.hasOwn(canonical.find((row) => row.ts === 100), "shotsFired"),
    "missing legacy shot totals were silently converted to zero");
  const allowed = new Set(["ts", "date", "location", "outcome", "duration", "kills", "hitsDealt", "hitsReceived",
    "damageDealt", "damageReceived", "shotsFired", "shotsHit", "cartridgesFired", "cartridgesHit", "ammoCost", "costBasis", "weapons"]);
  assert(canonical.every((row) => Object.keys(row).every((key) => allowed.has(key))),
    "Overall retained fields outside the summary whitelist");
  const unindexed = { ...live, ts: 400, history: rows.filter((row) => [100, 200, 300].includes(row.ts)),
    raid: { outcome: "SURVIVED", location: "Unindexed latest", duration: 15, finished: true } };
  assert(hooks.canonicalHistoryRows(unindexed).map((row) => row.ts).join(",") === "400,300,200,100",
    "finished current raid was omitted when its index write was absent");
  unindexed.raid.finished = false;
  assert(hooks.canonicalHistoryRows(unindexed).map((row) => row.ts).join(",") === "300,200,100",
    "unfinished current raid contaminated Overall totals");

  const overall = hooks.deriveOverall(canonical);
  assert(overall.raidCount === 4, "Overall raid count is not based on unique valid timestamps");
  assert(overall.dateCoverage === 3 && overall.dateRange.includes("3 of 4 dated summaries"),
    "Overall date range hides partial legacy coverage");
  assert(overall.metrics.duration.sum === 360 && overall.metrics.duration.count === 3,
    "Overall duration total or legacy coverage is wrong");
  assert(overall.metrics.kills.sum === 3 && overall.metrics.kills.count === 3,
    "Overall kills total or malformed-value coverage is wrong");
  assert(overall.metrics.hitsDealt.sum === 14 && overall.metrics.hitsReceived.sum === 8,
    "Overall contact totals are wrong");
  assert(overall.metrics.damageDealt.sum === 450 && overall.metrics.damageReceived.sum === 190,
    "Overall damage totals are wrong");
  assert(overall.accuracy.hit === 46 && overall.accuracy.fired === 100 && overall.accuracy.coverage === 2 && overall.accuracy.percent === 46,
    "Overall accuracy is not the weighted ratio of valid cartridge totals");
  assert(overall.metrics.ammoCost.sum === 3000 && overall.metrics.ammoCost.count === 2,
    "Overall priced ammo spend or its coverage is wrong");
  assert(overall.outcomes.find((item) => item.name === "SURVIVED")?.count === 1 &&
    overall.outcomes.find((item) => item.name === "RAN THROUGH")?.count === 1 &&
    overall.outcomes.find((item) => item.name === "KIA")?.count === 1 &&
    overall.outcomes.find((item) => item.name === "Unknown outcome")?.count === 1,
    "Overall outcome distribution omitted exact or unknown labels");
  assert(overall.outcomeCoverage === 3 && overall.extracted === 2,
    "Overall extraction numerator or outcome coverage is wrong");
  assert(overall.locations.find((item) => item.name === "Factory")?.raidCount === 2 &&
    overall.locations.find((item) => item.name.startsWith("Customs"))?.raidCount === 1,
    "Overall location grouping is wrong");

  window.__combatLogRender(live, false);
  assert(hooks.showOverall(), "Overall could not be opened for a multi-raid history");
  assert(hooks.viewState().historyScope.kind === "overall", "Overall did not become the active history scope");
  assert(elements.get("view-overall-history").hidden === false && activeReportView(elements) === undefined,
    "Overall exposed a per-raid evidence panel");
  assert(elements.get("overall-locations").innerHTML.includes("Customs &lt;img src=x onerror=alert(1)&gt;") &&
    !elements.get("overall-locations").innerHTML.includes("Customs <img"),
    "Overall rendered a stored location without escaping it");
  assert(elements.get("overall-headlines").innerHTML.includes("66.7% of 3 recorded outcomes") &&
    elements.get("raid-kpis").innerHTML.includes("Kills · partial") &&
    elements.get("raid-kpis").innerHTML.includes("Damage dealt · partial"),
    "Overall presented missing outcome or headline coverage as exact data");
  assert(elements.get("overall-note").textContent.includes("never invents hit zones") &&
    !/position|route/i.test(elements.get("overall-headlines").innerHTML),
    "Overall blurred the boundary between summaries and unavailable raid evidence");
  console.log("COMBATLOG OVERALL AGGREGATION VERIFIED");
}

async function verifyOverallWeapons() {
  const { window, elements } = runtime();
  const hooks = window.__combatLogTest;
  const weapon = (id, templateId, fired, shotsHit, extras = {}) => ({id, templateId, name:'Same name', fired, shotsHit,
    cartridgesFired:fired, cartridgesHit:shotsHit,
    hits:0, damage:0, kills:0, killLinks:0, ...extras});
  const rows = [
    {ts:100, weapons:[weapon('a1','model-a',10,2,{hits:1,damage:100,kills:1,killLinks:3}),
      weapon('a2','model-a',20,10,{hits:5,damage:200,kills:2}), weapon('b','model-b',60,0)]},
    {ts:200, weapons:[weapon('a3','model-a',70,28,{hits:10,damage:700,killLinks:undefined}),
      {id:'contact-only',templateId:'model-b',name:'Same name',hits:2,damage:30},
      weapon('unknown','',80,70), weapon('c','model-c',25,30,{name:'<img src=x onerror=alert(1)>',image:'123456'})]},
    {ts:300, weapons:[]}, {ts:400}, {ts:100, weapons:[weapon('duplicate','model-a',99999,99999)]}
  ];
  const result = hooks.deriveOverallWeapons(rows);
  const a = result.models.find(w => w.templateId === 'model-a'), b = result.models.find(w => w.templateId === 'model-b');
  assert(result.coverage === 3 && result.unidentified === 1, 'missing and empty weapon arrays or unidentified models have dishonest coverage');
  assert(result.models.map(w=>w.templateId).join(',') === 'model-a,model-b,model-c', 'ranking mixes same-name models or ignores misses');
  assert(a.raids === 2 && a.samples === 3 && a.fired.sum === 100 && a.accuracy.hit === 40 && a.accuracy.percent === 40,
    'instances/raids were double-counted or accuracy was averaged instead of weighted');
  assert(a.damage.sum === 1000 && a.hits.sum === 16 && a.kills.sum === 3 && a.killLinks.sum === 3,
    'projectile hits, damage contacts and linked deaths were conflated');
  assert(b.fired.sum === 60 && b.fired.count === 1 && b.accuracy.percent === 0 && b.damage.sum === 30,
    'miss-only model or partial counter coverage was lost');
  assert(result.models[2].accuracy.percent === null, 'inconsistent counters invented precision');
  const malformed = hooks.deriveOverallWeapons([{ts:1,weapons:[null]}, {ts:2,weapons:[weapon('a','A','99',3,{kills:-1,damage:Infinity})]}]);
  assert(malformed.coverage === 1 && !malformed.models.length, 'invalid arrays, string or non-finite counters were accepted');
  const dupeInstance = hooks.deriveOverallWeapons([{ts:1,weapons:[weapon('same','A',5,2),weapon('same','A',5,2)]}]);
  assert(dupeInstance.models[0].fired.sum === 5, 'duplicate weapon instance multiplied stats');
  const live = {v:2,ts:300,history:rows,raid:{finished:true,outcome:'SURVIVED',location:'Fixture',duration:0},
    weapons:[],engagements:[],findings:[],loadout:[]};
  window.__combatLogRender(live,false); hooks.showOverall();
  const markup = elements.get('overall-weapons').innerHTML;
  assert(markup.includes('model-a') && markup.includes('model-b') && markup.includes('&lt;img') && !markup.includes('<img src=x'),
    'ranking did not preserve model identity or escape stored names');
  assert(markup.includes('3* later deaths linked') && markup.includes('Partial counter coverage') && markup.includes('40 / 100 shots hit'),
    'display lost exact numerator, linked deaths or unavailable counters');
  assert(elements.get('overall-weapons-coverage').textContent.includes('3 of 4 raids'), 'weapon coverage inherits overall raid totals incorrectly');
  const seven = Array.from({length:7},(_,i)=>weapon('i'+i,'model-'+i,10+i,i,{name:'Weapon '+i}));
  window.__combatLogRender({...live,ts:600,weapons:seven,history:[{ts:500,weapons:[]}]},false); hooks.showOverall();
  assert((elements.get('overall-weapons').innerHTML.match(/data-overall-weapon=/g)||[]).length === 5 &&
    !elements.get('overall-weapons').innerHTML.includes('data-overall-weapon="model-0"'), 'top-five limit is missing or truncates before sorting');
  const timers = fakeTimers(), calls = [];
  let listener;
  const run = runtime({timers,on(channel, callback) {if(channel==='stats') listener=callback;},request(channel,key) {
    assert(channel === 'loadRaid', 'Overall attempted a non-history request');
    let resolve; const promise = new Promise(done=>{resolve=done;}); calls.push({key,resolve}); return promise;
  }});
  const test = run.window.__combatLogTest;
  const history = [160,150,140,130,120,110,100].map(ts=>ts===160 ? {ts,weapons:[]} : {ts});
  const frame = {...live,ts:160,history,historyDetailLimit:5,weapons:[]};
  listener(JSON.stringify(frame)); test.showOverall();
  assert(calls.map(c=>c.key).join(',') === '150,140,130', 'legacy loading is unbounded or not newest-first');
  calls[0].resolve(JSON.stringify({ts:150,weapons:[weapon('a','A',10,2)]})); await flushPromises();
  assert(calls.length === 4 && calls[3].key === '120', 'completed request did not release one slot');
  const detailKeys = Object.keys(test.overallWeaponRows([{ts:150}])[0].weapons[0]);
  assert(!detailKeys.includes('image') && !detailKeys.includes('engagements'), 'backfill retained payload or image data');
  test.showLive();
  const currentHeader = run.elements.get('where').textContent;
  calls[1].resolve(JSON.stringify({ts:999,weapons:[weapon('bad','BAD',9999,9999)]}));
  calls[2].resolve('{malformed');
  calls[3].resolve(null);
  await flushPromises();
  assert(run.elements.get('where').textContent === currentHeader && test.viewState().historyScope.kind === 'latest' && calls.length === 4,
    'late completion replaced the current raid or continued hidden loading');
  test.showOverall();
  assert(calls.length === 7 && calls.slice(4).map(c=>c.key).join(',') === '140,130,120',
    'successful backfill was retried, or unavailable reports were never retried');
  calls.slice(4).forEach(c=>c.resolve(JSON.stringify({ts:Number(c.key),weapons:[]}))); await flushPromises();
  assert(run.elements.get('overall-weapons-coverage').textContent.includes('5 of 7 raids') && !calls.some(c=>c.key==='110'||c.key==='100'),
    'pruned history was probed beyond retention or empty reports excluded from coverage');
  const initialRequests=calls.length;
  listener(JSON.stringify({...frame,ts:170,history:[{ts:170,weapons:[weapon('new','A',30,18)]},...history]}));
  assert(calls.length === initialRequests && run.elements.get('overall-weapons').innerHTML.includes('20 / 40 shots hit'),
    'live refresh discarded cached weapons or failed to add the newer summary');
  const clock = fakeTimers(); let stalledCalls=0;
  const stalled = runtime({timers:clock,request(){stalledCalls++;return new Promise(()=>{});}});
  stalled.window.__combatLogRender(frame,false); stalled.window.__combatLogTest.showOverall();
  while(clock.next()) {} await flushPromises();
  assert(stalledCalls===3 && !stalled.elements.get('overall-weapons-coverage').textContent.includes('Loading'), 'stalled queue never left loading state');
  stalled.window.__combatLogTest.showLive(); stalled.window.__combatLogTest.showOverall();
  while(clock.next()) {} await flushPromises();
  assert(stalledCalls===3, 'timeout/re-entry accumulated unbounded unresolved transports');
  const directory='D:/SPT41/BepInEx/config/CombatLog/raids';
  if(existsSync(directory)) {
    const captured=readdirSync(directory).filter(name=>/^\d+\.json$/.test(name)).map(name=>JSON.parse(readFileSync(directory+'/'+name,'utf8')));
    const expected=new Map();
    for(const raid of captured) for(const w of raid.weapons||[]) {
      if(!w.templateId || !Number.isSafeInteger(w.cartridgesFired) || w.cartridgesFired<0) continue;
      expected.set(w.templateId,(expected.get(w.templateId)||0)+w.cartridgesFired);
    }
    const actual=hooks.deriveOverallWeapons(captured).models;
    for(const w of actual) assert(w.fired.sum===(expected.get(w.templateId)||0), 'captured weapon ranking differs from independent saved cartridge sum');
  }
  console.log('COMBATLOG OVERALL WEAPONS VERIFIED');
}

async function verifyCartridges() {
  const { window, elements } = runtime();
  const hooks = window.__combatLogTest;
  const plain = value => String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const markup = id => elements.get(id)?.innerHTML || "";
  const approximately = (actual, expected) => Math.abs(actual - expected) < 1e-9;
  const weapon = (id, cartridgesFired, cartridgesHit, fired, shotsHit, extra = {}) => ({
    id, templateId: id, name: id, cartridgesFired, cartridgesHit, fired, shotsHit,
    hits: shotsHit + 2, damage: 120, kills: 1, killLinks: 0, ...extra,
  });
  const shotgun = weapon("Shotgun", 8, 6, 64, 18);
  const rifle = weapon("Rifle", 20, 10, 20, 10);
  const legacyWeapon = { id: "AA-12", templateId: "AA-12", name: "Legacy AA-12", fired: 734,
    shotsHit: 120, hits: 130, damage: 700, kills: 3, killLinks: 0 };
  const modern = (ts, w, cost) => ({ ts, cartridgesFired: w.cartridgesFired, cartridgesHit: w.cartridgesHit,
    shotsFired: w.fired, shotsHit: w.shotsHit, ammoCost: cost, costBasis: "cartridge", weapons: [w] });
  const rows = [modern(300, shotgun, 800), modern(200, rifle, 2000),
    { ts: 100, shotsFired: 734, shotsHit: 120, ammoCost: 73400, weapons: [legacyWeapon], damageDealt: 700 }];
  const original = JSON.stringify(rows);
  const overall = hooks.deriveOverall(rows);
  assert(overall.accuracy.fired === 28 && overall.accuracy.hit === 16 && overall.accuracy.coverage === 2 &&
    approximately(overall.accuracy.percent, 16 / 28 * 100),
    "mixed history averaged percentages or counted legacy pellets as fired cartridges");
  assert(overall.projectileAccuracy.fired === 818 && overall.projectileAccuracy.hit === 148 &&
    overall.projectileAccuracy.coverage === 3 && approximately(overall.projectileAccuracy.percent, 148 / 818 * 100),
    "supplementary projectile accuracy lost the preserved old projectile evidence");
  assert(overall.metrics.ammoCost.sum === 2800 && overall.metrics.ammoCost.count === 2 &&
    overall.metrics.damageDealt.sum === 700,
    "old projectile-priced costs contributed to spend or old damage evidence was lost");
  const ranked = hooks.deriveOverallWeapons(rows);
  assert(ranked.models.map(w => w.templateId).join(",") === "Rifle,Shotgun" && ranked.unranked === 1,
    "pellet counts gave shotgun or legacy AA-12 an unfair weapon ranking");
  const shotgunModel = ranked.models.find(w => w.templateId === "Shotgun");
  assert(shotgunModel.fired.sum === 8 && shotgunModel.accuracy.fired === 8 && shotgunModel.accuracy.hit === 6 &&
    shotgunModel.accuracy.percent === 75 && shotgunModel.projectileAccuracy.fired === 64 &&
    shotgunModel.projectileAccuracy.hit === 18 && shotgunModel.projectileAccuracy.percent === 28.125,
    "weapon aggregation merged the cartridge and projectile numerators");
  const sameModel = hooks.deriveOverallWeapons([rows[0], {ts:99,weapons:[{...legacyWeapon,templateId:"Shotgun"}]}]).models[0];
  assert(sameModel.fired.sum === 8 && sameModel.fired.count === 1 && sameModel.samples === 2 &&
    sameModel.accuracy.fired === 8 && sameModel.accuracy.hit === 6 && sameModel.accuracy.coverage === 1 &&
    sameModel.projectileAccuracy.fired === 798 && sameModel.projectileAccuracy.hit === 138 &&
    sameModel.damage.sum === 820,
    "older instance of a modern ranked model inflated its cartridge sample or lost legacy damage/projectiles");
  assert(JSON.stringify(rows) === original, "cartridge derivation rewrote the supplied archive data");

  const live = { ...fixture(), ...modern(300, shotgun, 800), history: rows,
    weapons: [shotgun], loadout: [{ id: "buckshot", ammo: "8-pellet buckshot", fired: 64, shotsHit: 18,
      cartridgesFired: 8, cartridgesHit: 6, hits: 20, kills: 1, cost: 800, costBasis: "cartridge", classes: [] }] };
  window.__combatLogRender(live, false);
  assert(plain(markup("raid-kpis")).includes("Shot accuracy") && plain(markup("raid-kpis")).includes("75%") &&
    !plain(markup("raid-kpis")).includes("28%"), "main headline is still pellet precision");
  assert(plain(markup("weapons")).includes("6 / 8 shots hit") && plain(markup("weapons")).includes("Shot accuracy") &&
    plain(markup("weapons")).includes("18 / 64 projectiles hit"), "weapon display lost the distinct shot and pellet samples");
  assert(plain(markup("loadout")).includes("6/8") && plain(markup("loadout")).includes("75%") &&
    plain(markup("loadout")).includes("18 / 64 projectiles hit"), "ammunition display uses projectile counts as its shot sample");
  assert(hooks.showOverall(), "mixed cartridge history could not open Overall");
  assert(plain(markup("overall-weapons")).includes("Shots") && plain(markup("overall-weapons")).includes("6 / 8 shots hit") &&
    !markup("overall-weapons").includes('data-overall-weapon="AA-12"'), "Overall ranking mislabeled pellets or included the old AA-12");
  const supplementary = elements.get("overall-projectiles");
  assert(plain(supplementary?.textContent || supplementary?.innerHTML).includes("148 / 818 projectiles hit"),
    "Overall omitted the separately labelled projectile numerator");
  assert(/partial/i.test(markup("raid-kpis") + markup("overall-headlines")),
    "mixed Overall headline concealed its partial cartridge coverage");
  const singleShell = weapon("single-shell", 1, 1, 8, 3, { hits: 7 });
  const single = { ...live, ...modern(301, singleShell, 100), weapons: [singleShell], history: [],
    loadout: [{ ...live.loadout[0], cartridgesFired: 1, cartridgesHit: 1, fired: 8, shotsHit: 3, hits: 7, cost: 100 }] };
  window.__combatLogRender(single, false);
  assert(plain(markup("raid-kpis")).includes("100%") && plain(markup("weapons")).includes("1 / 1 shots hit") &&
    plain(markup("loadout")).includes("1/1") && plain(markup("weapons")).includes("3 / 8 projectiles hit") &&
    !/300%|700%/.test(markup("raid-kpis") + markup("weapons") + markup("loadout")),
    "multi-pellet or multi-contact cartridge inflated the shot numerator");

  const old = { ...fixture(1), ts: 302, shotsFired: 734, shotsHit: 120, ammoCost: 73400,
    weapons: [legacyWeapon], loadout: [{id: "old-ammo", ammo: "Old buckshot", fired: 734, shotsHit: 120,
      hits: 130, kills: 3, cost: 73400, classes: []}], history: [{...rows[2],ts:303}] };
  window.__combatLogRender(old, false);
  assert(plain(markup("raid-kpis")).includes("Shot accuracy") && !/\d+%/.test(plain(markup("raid-kpis"))),
    "old raid advertised projectile accuracy as main shot accuracy");
  assert(plain(markup("weapons")).includes("120 / 734 projectiles hit") &&
    !/120\s*\/\s*734\s+shots hit/.test(plain(markup("weapons"))), "old weapon lost pellets or relabeled them as cartridges");
  assert(/Cartridge counters unavailable/.test(markup("weapons") + markup("loadout")) &&
    !/73,400|73400/.test(markup("loadout") + (elements.get("baseline")?.textContent || "") + markup("raid-kpis")),
    "old uncorrected ammunition spend is displayed as trusted cost");
  hooks.showOverall();
  const allOld = hooks.deriveOverall(hooks.canonicalHistoryRows(old));
  assert(allOld.accuracy.coverage === 0 && allOld.accuracy.percent === null && allOld.metrics.ammoCost.count === 0 &&
    !hooks.deriveOverallWeapons(hooks.canonicalHistoryRows(old)).models.length &&
    /cartridge|shot/i.test(plain(markup("overall-weapons"))), "all-old history invented cartridge precision, spend or rankings");
  const invalidPairs = [ {}, {cartridgesFired:3}, {cartridgesHit:1}, {cartridgesFired:3,cartridgesHit:4},
    {cartridgesFired:0,cartridgesHit:1}, ...[null,"3",-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER + 1]
      .flatMap(value => [{cartridgesFired:value,cartridgesHit:0},{cartridgesFired:3,cartridgesHit:value}]) ];
  let invalidTs = 1000;
  for (const pair of invalidPairs) {
    const entry = {ts:++invalidTs,shotsFired:8,shotsHit:3,...pair};
    const invalid = hooks.deriveOverall([entry]);
    assert(invalid.accuracy.coverage === 0 && invalid.accuracy.percent === null && invalid.projectileAccuracy.hit === 3,
      "malformed cartridge pair produced precision or suppressed valid projectile detail: " + JSON.stringify(pair));
    const invalidWeapon = {id:"invalid",templateId:"invalid",name:"Invalid cartridge counters",fired:8,shotsHit:3,hits:5,...pair};
    const model = hooks.deriveOverallWeapons([{ts:entry.ts,weapons:[invalidWeapon]}]).models[0];
    assert(!model || model.accuracy.percent === null, "invalid weapon cartridge pair became a plausible precision");
    window.__combatLogRender({...single, ...entry, cartridgesFired:pair.cartridgesFired,cartridgesHit:pair.cartridgesHit,
      weapons:[invalidWeapon],loadout:[{...invalidWeapon,ammo:"Invalid cartridge counters",classes:[]}]}, false);
    assert(!/\d+%/.test(plain(markup("raid-kpis"))) &&
      !/>\d+%<|>\d+\s*\/\s*\d+<|>\d+%<\/div>/.test(markup("weapons") + markup("loadout")),
      "invalid cartridge pair generated a visible main shot ratio or precision");
  }
  const zero = hooks.deriveOverall([{ts:500,cartridgesFired:0,cartridgesHit:0,ammoCost:0,costBasis:"cartridge"}]);
  assert(zero.accuracy.coverage === 1 && zero.accuracy.fired === 0 && zero.accuracy.hit === 0 &&
    zero.accuracy.percent === null && zero.metrics.ammoCost.count === 1 && zero.metrics.ammoCost.sum === 0,
    "known zero cartridge activity or confirmed zero spend was treated as legacy missing data");
  const allMiss = weapon("all-miss", 9, 0, 72, 0, {hits:0});
  window.__combatLogRender({...single,...modern(501,allMiss,900),weapons:[allMiss],
    loadout:[{...live.loadout[0],cartridgesFired:9,cartridgesHit:0,fired:72,shotsHit:0,hits:0,cost:900}]},false);
  assert(plain(markup("raid-kpis")).includes("0%") && plain(markup("weapons")).includes("0 / 9 shots hit") &&
    plain(markup("loadout")).includes("0/9"), "known miss-only cartridge data was rendered as unavailable");
  const costRows = [undefined,"projectile","CARTRIDGE",null].map((costBasis,i)=>({ts:700+i,costBasis,ammoCost:100}));
  assert(hooks.deriveOverall(costRows).metrics.ammoCost.count === 0,
    "an absent or malformed cost marker certified old projectile-priced cost");

  const cleaned = hooks.canonicalHistoryRows({history:rows});
  assert(JSON.stringify(hooks.canonicalHistoryRows({history:cleaned})) === JSON.stringify(cleaned) &&
    cleaned[0].costBasis === "cartridge" && cleaned[0].cartridgesFired === 8 && cleaned[0].cartridgesHit === 6 &&
    !Object.hasOwn(cleaned[2],"ammoCost"), "summary cleaning discarded new fields or resurrected an old cost");
  const timers = fakeTimers(), requests = [];
  const run = runtime({timers,request(channel,key) {
    assert(channel === "loadRaid", "cartridge archive backfill requested a non-history channel");
    requests.push(key);
    return JSON.stringify({ts:Number(key),weapons:[{...shotgun,image:"123456",engagements:[{}],unexpected:true}]});
  }});
  run.window.__combatLogRender({...single,ts:800,weapons:[],history:[{ts:800,weapons:[]},{ts:799}]},false);
  run.window.__combatLogTest.showOverall(); await flushPromises();
  const hydrated = run.window.__combatLogTest.overallWeaponRows([{ts:799}])[0].weapons[0];
  assert(requests.join(",") === "799" && hydrated.cartridgesFired === 8 && hydrated.cartridgesHit === 6 &&
    hydrated.fired === 64 && hydrated.shotsHit === 18 && !Object.hasOwn(hydrated,"image") &&
    !Object.hasOwn(hydrated,"engagements") && !Object.hasOwn(hydrated,"unexpected"),
    "archive backfill cleaning lost the new cartridge pair or retained non-summary data");
  const hydratedModel = run.window.__combatLogTest.deriveOverallWeapons([{ts:799,weapons:[hydrated]}]).models[0];
  assert(hydratedModel.fired.sum === 8 && hydratedModel.accuracy.percent === 75 && hydratedModel.projectileAccuracy.hit === 18,
    "hydrated legacy index used pellets instead of its newly saved cartridge detail");
  console.log("COMBATLOG CARTRIDGES VERIFIED");
}

function verifyScope() {
  const positiveControl = "+ var mapReplay = collectWorldPosition();\n";
  assert(forbiddenAddedCode(positiveControl), "scope oracle failed its positive control");
  const diff = execFileSync("git", ["diff", "master", "--", "Analytics", "UI", "web"], { encoding: "utf8" });
  assert(!forbiddenAddedCode(diff), "implementation added map/world-position reconstruction code");
  const modelCode = readFileSync("web/mannequin.js", "utf8").split(/\r?\n/).map(line => "+" + line).join("\n");
  assert(!forbiddenAddedCode(modelCode), "mannequin added raid-space reconstruction code");
  assert(projectNotes.includes("RaidReview already owns") && projectNotes.includes("must not sample movement"),
    "project scope does not preserve the RaidReview ownership boundary");
  console.log("COMBATLOG SCOPE VERIFIED");
}

if (mode === "--debrief") verifyDebrief();
else if (mode === "--armor") verifyArmor();
else if (mode === "--tape") verifyTape();
else if (mode === "--zones") verifyZones();
else if (mode === "--accuracy") verifyAccuracy();
else if (mode === "--equipment") await verifyEquipment();
else if (mode === "--polish") await verifyPolish();
else if (mode === "--records") verifyRecords();
else if (mode === "--overall") verifyOverall();
else if (mode === "--overall-weapons") await verifyOverallWeapons();
else if (mode === "--cartridges") await verifyCartridges();
else verifyScope();
