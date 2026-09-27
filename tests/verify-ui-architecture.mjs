import { readFileSync } from "node:fs";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

const page = readFileSync("web/combatlog.html", "utf8");
const views = ["overview", "combat", "arsenal"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function inlineScript(source) {
  const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  assert(scripts.length > 0, "embedded report page has no inline script");
  return scripts[scripts.length - 1][1];
}

function decodeText(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

class FakeClassList {
  constructor(element) { this.element = element; }
  values() { return new Set(String(this.element.className || "").split(/\s+/).filter(Boolean)); }
  contains(value) { return this.values().has(value); }
  add(...values) {
    const next = this.values();
    values.forEach((value) => next.add(value));
    this.element.className = [...next].join(" ");
  }
  remove(...values) {
    const next = this.values();
    values.forEach((value) => next.delete(value));
    this.element.className = [...next].join(" ");
  }
  toggle(value, force) {
    const next = force === undefined ? !this.contains(value) : !!force;
    next ? this.add(value) : this.remove(value);
    return next;
  }
}

class FakeElement {
  constructor(tagName, attributes, ownerDocument) {
    this.tagName = String(tagName || "div").toUpperCase();
    this.ownerDocument = ownerDocument;
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.events = Object.create(null);
    this.style = {};
    this._innerHTML = "";
    this.textContent = "";
    this._value = "";
    this.disabled = false;
    this.scrollTop = 0;
    this.scrollCount = 0;
    this._className = "";
    this.classList = new FakeClassList(this);
    Object.entries(attributes || {}).forEach(([name, value]) => this.setAttribute(name, value));
  }
  get id() { return this.getAttribute("id") || ""; }
  set id(value) { this.setAttribute("id", value); }
  get className() { return this._className; }
  set className(value) {
    this._className = String(value || "");
    if (this._className) this.attributes.set("class", this._className);
    else this.attributes.delete("class");
  }
  get hidden() { return this.hasAttribute("hidden"); }
  set hidden(value) { value ? this.attributes.set("hidden", "") : this.attributes.delete("hidden"); }
  get open() { return this.hasAttribute("open"); }
  set open(value) { value ? this.attributes.set("open", "") : this.attributes.delete("open"); }
  get tabIndex() { return Number(this.getAttribute("tabindex") || 0); }
  set tabIndex(value) { this.setAttribute("tabindex", value); }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) {
    this._innerHTML = String(value || "");
    if (this.tagName !== "SELECT") {
      this.children = [];
      this.ownerDocument.parseFragment(this._innerHTML, this);
      return;
    }
    this.children = [];
    for (const match of this._innerHTML.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)) {
      const option = new FakeElement("option", parseAttributes(match[1]), this.ownerDocument);
      option.textContent = decodeText(match[2]);
      this.appendChild(option);
    }
    this._value = this.options[0]?.value || "";
  }
  get value() { return this._value; }
  set value(value) { this._value = String(value == null ? "" : value); }
  get options() { return this.tagName === "SELECT" ? this.children.filter((child) => child.tagName === "OPTION") : undefined; }
  get selectedIndex() {
    if (this.tagName !== "SELECT") return -1;
    return this.options.findIndex((option) => option.value === this._value);
  }
  set selectedIndex(index) {
    if (this.tagName === "SELECT" && this.options[index]) this._value = this.options[index].value;
  }
  get dataset() {
    const element = this;
    return new Proxy({}, {
      get(_target, key) {
        const attr = "data-" + String(key).replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
        return element.getAttribute(attr) ?? undefined;
      },
      set(_target, key, value) {
        const attr = "data-" + String(key).replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
        element.setAttribute(attr, value);
        return true;
      },
    });
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  setAttribute(name, value) {
    name = String(name);
    value = value == null ? "" : String(value);
    if (name === "class") this.className = value;
    else this.attributes.set(name, value);
    if (name === "value") this.value = value;
    if (name === "disabled") this.disabled = true;
  }
  removeAttribute(name) {
    if (name === "class") this.className = "";
    else this.attributes.delete(name);
    if (name === "disabled") this.disabled = false;
  }
  toggleAttribute(name, force) {
    const next = force === undefined ? !this.hasAttribute(name) : !!force;
    next ? this.setAttribute(name, "") : this.removeAttribute(name);
    return next;
  }
  addEventListener(name, callback) {
    (this.events[name] ||= []).push(callback);
  }
  removeEventListener(name, callback) {
    if (this.events[name]) this.events[name] = this.events[name].filter((item) => item !== callback);
  }
  dispatchEvent(event) {
    const normalized = typeof event === "string" ? { type: event } : event;
    normalized.target ||= this;
    normalized.currentTarget = this;
    normalized.preventDefault ||= function () {};
    normalized.stopPropagation ||= function () { this.cancelBubble = true; };
    (this.events[normalized.type] || []).forEach((callback) => callback.call(this, normalized));
    const propertyHandler = this["on" + normalized.type];
    if (typeof propertyHandler === "function") propertyHandler.call(this, normalized);
    if (normalized.bubbles && !normalized.cancelBubble && this.parentNode) this.parentNode.dispatchEvent(normalized);
    return true;
  }
  click() { this.dispatchEvent({ type: "click", bubbles: true }); }
  querySelectorAll(selector) { return this.ownerDocument.querySelectorAll(selector, this); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    let node = this;
    while (node) {
      if (matchesSelector(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  scrollIntoView(options) { this.scrollCount += 1; this.scrollOptions = options; }
  focus() { this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return { top: 0, left: 0, width: 800, height: 600 }; }
}

function parseAttributes(source) {
  const result = Object.create(null);
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    result[name] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return result;
}

function descendants(root) {
  const result = [];
  const visit = (element) => element.children.forEach((child) => {
    result.push(child);
    visit(child);
  });
  visit(root);
  return result;
}

function matchesSimple(element, selector) {
  selector = selector.trim();
  if (!selector || selector === "*") return true;
  const tag = selector.match(/^[a-z][\w-]*/i);
  if (tag && element.tagName !== tag[0].toUpperCase()) return false;
  for (const match of selector.matchAll(/#([\w-]+)/g)) if (element.id !== match[1]) return false;
  for (const match of selector.matchAll(/\.([\w-]+)/g)) if (!element.classList.contains(match[1])) return false;
  for (const match of selector.matchAll(/\[([^\]\s~|^$*!=]+)(?:\s*(\^=|\$=|\*=|=)\s*["']?([^\]"']*)["']?)?\]/g)) {
    const actual = element.getAttribute(match[1]);
    if (actual === null) return false;
    if (!match[2]) continue;
    const expected = match[3];
    if (match[2] === "=" && actual !== expected) return false;
    if (match[2] === "^=" && !actual.startsWith(expected)) return false;
    if (match[2] === "$=" && !actual.endsWith(expected)) return false;
    if (match[2] === "*=" && !actual.includes(expected)) return false;
  }
  return true;
}

function matchesSelector(element, selector) {
  const parts = selector.trim().split(/\s+/);
  let node = element;
  if (!matchesSimple(node, parts.pop())) return false;
  while (parts.length) {
    const wanted = parts.pop();
    node = node.parentNode;
    while (node && !matchesSimple(node, wanted)) node = node.parentNode;
    if (!node) return false;
  }
  return true;
}

class FakeDocument {
  constructor(markup) {
    this.hidden = false;
    this.activeElement = null;
    this.autoCreate = false;
    this.events = Object.create(null);
    this.root = new FakeElement("document", {}, this);
    this.defaultView = null;
    this.parse(markup);
  }
  parse(markup) {
    const bodyMarkup = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(markup)?.[1] || markup;
    const body = bodyMarkup.split(/<script\b/i)[0];
    this.parseFragment(body, this.root);
  }
  parseFragment(body, root) {
    const tokens = body.match(/<!--[\s\S]*?-->|<\/?[a-z][^>]*>/gi) || [];
    const stack = [root];
    const voidTags = new Set(["AREA", "BASE", "BR", "COL", "EMBED", "HR", "IMG", "INPUT", "LINK", "META", "PARAM", "SOURCE", "TRACK", "WBR"]);
    for (const token of tokens) {
      if (token.startsWith("<!--")) continue;
      const closing = /^<\//.test(token);
      const name = /^<\/?\s*([a-z][\w-]*)/i.exec(token)?.[1];
      if (!name) continue;
      if (closing) {
        for (let index = stack.length - 1; index > 0; index--) {
          if (stack[index].tagName === name.toUpperCase()) { stack.length = index; break; }
        }
        continue;
      }
      const attrText = token
        .replace(/^<\s*[a-z][\w-]*/i, "")
        .replace(/\/?>$/, "");
      const element = new FakeElement(name, parseAttributes(attrText), this);
      stack[stack.length - 1].appendChild(element);
      if (!voidTags.has(element.tagName) && !/\/>$/.test(token)) stack.push(element);
    }
  }
  getElementById(id) {
    const existing = descendants(this.root).find((element) => element.id === id);
    if (existing || !this.autoCreate) return existing || null;
    const element = new FakeElement("div", { id }, this);
    this.root.appendChild(element);
    return element;
  }
  querySelectorAll(selector, within = this.root) {
    const candidates = descendants(within);
    const selectors = selector.split(",").map((part) => part.trim()).filter(Boolean);
    return candidates.filter((element) => selectors.some((part) => matchesSelector(element, part)));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
  removeEventListener(name, callback) {
    if (this.events[name]) this.events[name] = this.events[name].filter((item) => item !== callback);
  }
}

function requiredDescendant(panel, selectors, description) {
  const match = selectors.map((selector) => panel.querySelector(selector)).find(Boolean);
  assert(match, `${panel.getAttribute("data-report-view")} view does not own ${description}`);
  return match;
}

function staticContract(document, source = page) {
  const tabs = document.querySelectorAll("[data-view-target]");
  const panels = document.querySelectorAll("[data-report-view]");
  for (const [elements, attribute] of [[tabs,"data-view-target"],[panels,"data-report-view"]]) {
    assert(elements.length === views.length, "desktop report must have exactly three raid views");
    assert(elements.map(element=>element.getAttribute(attribute)).join(",") === views.join(","),
      "desktop report views are missing, duplicated or reordered");
  }
  const labels = {overview:"Overview",combat:"Combat",arsenal:"Weapons & ammo"};
  for (const tab of tabs) {
    const target=tab.getAttribute("data-view-target");
    const opening=new RegExp('<button\\b[^>]*data-view-target=["\']'+target+'["\'][^>]*>([\\s\\S]*?)<\\/button>',"i").exec(source);
    assert(opening && decodeText(opening[1])===labels[target], target+" tab lost its visible label");
    assert(tab.getAttribute("role")==="tab" && tab.hasAttribute("aria-controls") && tab.hasAttribute("aria-selected"),
      target+" tab lost its accessible role or relationship");
    assert(tab.tabIndex===(target==="overview"?0:-1),target+" tab lost its initial roving focus");
  }
  assert(document.getElementById("report-nav")?.getAttribute("role")==="tablist","raid navigation is not a tablist");
  panels.forEach(panel=>assert(panel.getAttribute("role")==="tabpanel","raid view is not a tabpanel"));
  const mainIndex=source.search(/<main\b/i);
  for(const id of ["scope-raid","scope-overall","history-control","raid-selector"]) {
    const element=document.getElementById(id);
    assert(element && source.indexOf('id="'+id+'"')<mainIndex,id+" is missing from the global header");
  }
  assert(!document.getElementById("scope-raid").hidden && !document.getElementById("scope-overall").hidden,
    "Raid and Overall must both be discoverable without opening the archive selector");
  const overallNav=document.getElementById("overall-nav");
  assert(overallNav && overallNav.querySelectorAll("[data-overall-target]").map(e=>e.getAttribute("data-overall-target")).join(",")==="overview,weapons,locations",
    "Overall requires its own Overview, Weapons and Locations navigation");
  assert(!document.querySelectorAll("#raid-selector option").some(option=>option.value==="overall"),
    "Overall was added to the individual raid selector");
  const overall=document.getElementById("view-overall-history");
  assert(overall && overall.hidden && !overall.hasAttribute("data-report-view"),"Overall must be a separate initially hidden report scope");
  for(const id of ["overall-headlines","overall-outcomes","overall-locations","overall-weapons"])
    assert(overall.querySelector("#"+id),"Overall lost "+id);
  const projectiles=overall.querySelector("#overall-projectiles");
  assert(projectiles?.closest("details") && !projectiles.closest("details").open,"Overall projectile evidence is no longer progressively disclosed");

  const byView=Object.fromEntries(panels.map(panel=>[panel.getAttribute("data-report-view"),panel]));
  for(const id of ["death","killer-summary","debrief","findings","records"])
    requiredDescendant(byView.overview,["#"+id],id);
  const killer=requiredDescendant(byView.overview,["#killer-loadout-section"],"the collapsed killer dossier");
  assert(killer.tagName==="DETAILS" && !killer.open && killer.querySelector("#killer"),
    "full killer loadout must start collapsed beside its death report");
  assert(!byView.arsenal.querySelector("#killer"),"own weapons/ammo still contains the killer's equipment");
  for(const id of ["tape","log","armour-impact","filters","figure","allhits","combat-context","combat-reset","combat-opponents"])
    requiredDescendant(byView.combat,["#"+id],id);
  for(const id of ["weapons","loadout"]) requiredDescendant(byView.arsenal,["#"+id],id);
  assert(document.querySelectorAll("#allhits").length===1,"desktop report duplicated its canonical hit table");
  const hitPanels=byView.combat.querySelectorAll("[data-hit-subview]");
  assert(hitPanels.length===2 && hitPanels.map(p=>p.getAttribute("data-hit-subview")).join(",")==="anatomy,table" && hitPanels.every(p=>!p.hidden),
    "Anatomy and Table must both be visible inside Combat");
  assert(!document.querySelector("[data-hit-view-target]"),"exclusive hit subview tabs survived the desktop split");
  assert(!document.querySelector("[data-anatomy-mode]"),"anatomy still requires a separate tape/density mode");
  assert(document.querySelector("details.distance-summary")?.open,"distance bands no longer start expanded");
  assert(document.getElementById("advanced-filters") && document.getElementById("active-filter-chips"),
    "advanced filters or visible context chips were removed");
  assert(document.querySelector("[data-show-all-zones]") && /(?:var|let|const)\s+showAllZones\s*=\s*false\b/.test(source),
    "anatomy lost its explicit initially-off zero-zone toggle");
  assert(/function\s+renderFindings\b[\s\S]{0,900}\bhidden\b/i.test(source),"empty findings are not hidden");
  assert(/function\s+openHitExplorer\s*\([^)]*(?:filter|patch)/i.test(source) &&
    (source.match(/\bopenHitExplorer\s*\(/g)||[]).length>=3,"evidence links bypass the shared combat workspace");
}

function raidFixture(ts, location, history = [], combat = false) {
  const sample = (t,dealt,opponentId,who,part,collider,after,extra={})=>({
    t,dealt,opponentId,who,part,collider,after,before:after+12,armorDamage:12,
    cls:"PMC",weapon:dealt?"M4A1":"AK-74N",weaponId:dealt?"player-rifle":"enemy-rifle",
    ammo:dealt?"M855":"BP",ammoId:dealt?"player-ammo":"enemy-ammo",
    fatal:false,fatalInferred:false,blocked:false,deflected:false,dist:35,...extra,
  });
  const hits=combat ? [
    sample(5,true,"op-a","Twin target","head","Eyes",35),
    sample(6,false,"op-a","Twin target","left arm","LeftUpperArm",20),
    sample(7,true,"op-b","Twin target","chest","RibcageUp",48,{fatal:true}),
    sample(18,true,"op-c","Third target","head","Jaw",32,{fatal:true,fatalInferred:true}),
    sample(19,false,"op-c","Third target","chest","RibcageUp",62,{fatal:true}),
    sample(20,true,"op-b","Twin target","stomach","",15),
  ] : [];
  const dealt=hits.filter(h=>h.dealt),taken=hits.filter(h=>!h.dealt);
  return {
    v:2,ts,history,raid:{outcome:combat?"KILLED IN ACTION":"SURVIVED",location,duration:60,finished:true},
    findings:[],engagements:combat?[{start:5,duration:15,hitsDealt:dealt.length,hitsReceived:taken.length,
      damageDealt:130,damageReceived:82,kills:1,killLinks:1,
      opponents:[{id:"op-a",name:"Twin target"},{id:"op-b",name:"Twin target"},{id:"op-c",name:"Third target"}],hits}]:[],
    weapons:[],loadout:[],hitsDealt:dealt.length,hitsReceived:taken.length,
    damageDealt:dealt.reduce((sum,h)=>sum+h.after,0),damageReceived:taken.reduce((sum,h)=>sum+h.after,0),
    armorSavedYou:12*taken.length,shotsFired:8,shotsHit:dealt.length,kills:2,ammoCost:800,
    cartridgesFired:8,cartridgesHit:dealt.length,costBasis:"cartridge",
  };
}
function historyRow(ts, location) {
  return {ts,date:"Raid "+ts,location,outcome:"SURVIVED",kills:ts%3,damageDealt:ts,weapons:[]};
}
function deferredRequest(channel,key) {
  let resolve,reject;
  const promise=new Promise((accept,decline)=>{resolve=accept;reject=decline;});
  return {channel,key,promise,resolve,reject};
}
function expectRejected(run, message) {
  let rejected=false;
  try {run();} catch {rejected=true;}
  assert(rejected,"negative control was accepted: "+message);
}

async function runtimeContract(document, source = page) {
  const windowEvents=Object.create(null),requests=[],modelUpdates=[];
  let statsListener=null;
  const overlay={
    on(channel,callback){if(channel==="stats")statsListener=callback;},send(){},
    request(channel,key){const pending=deferredRequest(channel,key);requests.push(pending);return pending.promise;},
  };
  const window={
    document,overlay,location:{hash:""},history:{replaceState(){}},
    requestAnimationFrame(){return 1;},cancelAnimationFrame(){},setTimeout,clearTimeout,
    addEventListener(name,callback){(windowEvents[name]||=[]).push(callback);},
    removeEventListener(name,callback){if(windowEvents[name])windowEvents[name]=windowEvents[name].filter(fn=>fn!==callback);},
    atob(value){return Buffer.from(value,"base64").toString("binary");},
  };
  document.defaultView=window;
  const context=vm.createContext({window,document,console:{log(){},info(){},warn(){},error(){}},setTimeout,clearTimeout,
    requestAnimationFrame:window.requestAnimationFrame,cancelAnimationFrame:window.cancelAnimationFrame});
  new vm.Script(readFileSync("web/mannequin.js","utf8"),{filename:"mannequin.js"}).runInContext(context);
  const model=window.CombatMannequin;
  window.CombatMannequin={...model,create(){return {
    update(data){modelUpdates.push(data);},highlight(){},view(){},rotate(){},zoom(){},destroy(){},
  };}};
  new vm.Script(readFileSync("web/records.js","utf8"),{filename:"records.js"}).runInContext(context);
  new vm.Script(inlineScript(source),{filename:"combatlog.inline.js"}).runInContext(context);
  assert(typeof statsListener==="function","runtime did not subscribe to retained live reports");
  const hooks=window.__combatLogTest;
  for(const name of ["selectCombatHit","clearCombatSelection","setOverallView","showRaidReport","showLive","showOverall",
    "setReportView","setHitView","selectAnatomyZone","openHitExplorer","recordState","viewState"])
    assert(typeof hooks[name]==="function","missing public workspace verification hook "+name);
  document.autoCreate=true;
  const element=id=>document.getElementById(id);
  const selector=element("raid-selector"),where=element("where"),pastbar=element("pastbar"),overallPanel=element("view-overall-history");
  const settle=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
  const pushLive=payload=>statsListener(JSON.stringify(payload));
  const text=id=>decodeText(element(id).textContent+" "+element(id).innerHTML);
  const rows=()=>element("allhits").querySelectorAll("[data-hit-index]");
  const activeRows=()=>rows().filter(row=>row.classList.contains("selected-hit"));
  function assertRaidNavigation(chosen) {
    assert(!element("report-nav").hidden && element("overall-nav").hidden && !element("history-control").hidden,
      "raid scope does not show its own navigation and selector");
    document.querySelectorAll("[data-report-view]").forEach(panel=>assert(panel.hidden===(panel.getAttribute("data-report-view")!==chosen),
      "raid view visibility disagrees with selected "+chosen));
  }
  for(const name of views) {
    document.querySelector('[data-view-target="'+name+'"]').click();
    assertRaidNavigation(name);
    document.querySelectorAll("[data-view-target]").forEach(button=>{
      const active=button.getAttribute("data-view-target")===name;
      assert(button.getAttribute("aria-selected")===String(active)&&button.tabIndex===(active?0:-1),
        "raid tab selection/focus state is stale");
    });
  }
  hooks.setReportView("hits");
  assert(hooks.viewState().reportView==="combat","legacy hits navigation no longer resolves to Combat");
  for(const mode of ["anatomy","table"]) {
    hooks.setHitView(mode);
    assert(hooks.viewState().hitView==="split" && document.querySelectorAll("[data-hit-subview]").every(panel=>!panel.hidden) &&
      !document.querySelector("[data-show-all-zones]").hidden,"legacy subview call hid half of the desktop split");
  }

  const selectRaid=ts=>{
    const before=requests.length;
    selector.value=String(ts);selector.dispatchEvent({type:"change"});
    assert(requests.length===before+1,"archive selection did not issue exactly one request");
    const pending=requests.at(-1);
    assert(pending.channel==="loadRaid"&&pending.key===String(ts)&&selector.disabled,
      "archive selection did not use an exact timestamp and disable the busy selector");
    return pending;
  };
  assert(readFileSync("UI/CombatLogPanel.cs","utf8").includes('sb.Append("\\"started\\":").Append(RaidMeta.Started ? "true" : "false")'),
    "native payload does not carry explicit raid-start lifecycle evidence");
  const startup=raidFixture(0,"Unknown location");
  startup.raid={started:false,finished:false,outcome:"SURVIVED",location:"Unknown location",duration:0};
  pushLive(startup);
  const assertStartup=()=>{
    assert(element("stamp").textContent==="NO RAID YET"&&where.textContent==="Waiting for the first raid"&&
      !element("session-empty").hidden&&element("report-nav").hidden&&element("raid-kpis").innerHTML===""&&
      document.querySelectorAll("[data-report-view]").every(panel=>panel.hidden),
      "pre-raid bootstrap is presented as a survived raid or a zero-filled combat report");
    assert(selector.options[0].textContent==="Current session · no raid yet",
      "startup raid selector still implies a completed raid");
  };
  assertStartup();
  assert(element("session-history-hint").hidden,"fresh installation claims to contain previous reports");
  element("scope-overall").click();
  assert(!overallPanel.hidden&&element("session-empty").hidden&&element("where").textContent==="0 recorded raid summaries",
    "Overall counts the startup placeholder as a raid");
  element("scope-raid").click();assertStartup();
  pushLive({...startup,history:[historyRow(100,"Stored Customs")]});
  assertStartup();assert(!element("session-history-hint").hidden&&!selector.disabled,
    "startup placeholder hides available archive access");
  const startupArchive=selectRaid(100);startupArchive.resolve(JSON.stringify(raidFixture(100,"Stored Customs")));await settle();
  assert(element("session-empty").hidden&&!element("report-nav").hidden&&where.textContent==="Stored Customs",
    "legacy archive without a started flag is hidden by the startup placeholder");
  element("back-live").click();assertStartup();
  const quietRaid={...startup,ts:1,raid:{...startup.raid,started:true,finished:true,location:"Quiet Factory"}};
  element("scope-overall").click();
  pushLive(quietRaid);
  assert(!overallPanel.hidden&&element("session-empty").hidden,"first completed raid interrupted Overall");
  element("scope-raid").click();
  assert(element("session-empty").hidden&&!element("report-nav").hidden&&element("stamp").textContent==="SURVIVED"&&
    where.textContent==="Quiet Factory"&&element("raid-kpis").innerHTML.includes("Kills"),
    "a completed zero-hit raid is mistaken for the pre-raid startup state");
  pushLive({...quietRaid,ts:2,raid:{...quietRaid.raid,started:false}});
  assert(element("session-empty").hidden&&element("stamp").textContent==="SURVIVED",
    "a completed raid with a missed start hook is mistaken for startup");
  pushLive(raidFixture(50,"Only recorded raid"));
  assert(!element("history-control").hidden && selector.disabled && selector.options.map(o=>o.value).join(",")==="latest",
    "single-raid scope must keep a visible disabled history selector");
  assert(!element("scope-overall").hidden && !selector.options.some(o=>o.value==="overall"),
    "single-raid scope hid Overall or inserted it as a raid");
  const progress=raidFixture(0,"Current raid in progress",[historyRow(100,"Older A"),historyRow(50,"Older B")]);
  progress.raid.finished=false;pushLive(progress);
  assert(element("session-empty").hidden,"legacy unfinished report without an explicit started flag became startup");
  assert(selector.value==="latest"&&selector.options.map(o=>o.value).join(",")==="latest,100,50",
    "unfinished Latest disappeared or Overall entered the raid list");
  const liveRows=[500,450,400,350,300,250,200,150,100].map(ts=>historyRow(ts,"History "+ts));
  const live=raidFixture(500,"Live Factory",liveRows,true);pushLive(live);
  assert(where.textContent==="Live Factory"&&selector.options.map(o=>o.value).join(",")===
    ["latest",...liveRows.slice(1).map(row=>String(row.ts))].join(","),"history selector lost sorted exact raid identities");
  assert(selector.options[1].textContent.includes("Raid 450")&&selector.options[1].textContent.includes("History 450"),
    "history options lost their visible archive identity");
  const canonical=hooks.canonicalHistoryRows(live).find(row=>row.ts===500);
  assert(canonical.cartridgesFired===8&&canonical.cartridgesHit===4&&canonical.costBasis==="cartridge",
    "raid navigation lost cartridge counters or corrected cost provenance");
  hooks.openHitExplorer({},"table");
  assertRaidNavigation("combat");
  assert(rows().length===6 && new Set(rows().map(row=>row.getAttribute("data-hit-index"))).size===6,
    "canonical table rows do not map one-to-one to the full ordered hit stream");
  assert(element("combat-opponents").querySelectorAll("button").length>=3 &&
    text("combat-opponents").includes("Twin target")&&text("combat-opponents").includes("Third target"),
    "opponent rail collapsed identities or omitted recorded contacts");
  const row=rows().find(row=>row.getAttribute("data-hit-index")==="2");
  assert(row.querySelector(".hit-select"),"event row has no accessible selection control");
  row.querySelector(".hit-select").click();
  assert(hooks.recordState().hit?.t===7 && activeRows().length===1&&activeRows()[0].getAttribute("data-hit-index")==="2",
    "table event selection did not update the single shared selected hit and row highlight");
  assert(text("anatomy-readout").includes("Twin target")&&text("selected-hit-detail").includes("Twin target")&&
    element("tape").querySelectorAll(".tape-hit").some(marker=>marker.getAttribute("data-hit")==="2"&&marker.classList.contains("active")),
    "selected table event did not coordinate the mannequin, selected-event detail and timeline marker");
  assert(modelUpdates.at(-1)?.active==="RibcageUp"&&modelUpdates.at(-1)?.direction==="dealt",
    "table selection did not send the exact active region and outgoing direction to the mannequin");
  const selectedMarker=element("tape").querySelectorAll(".tape-hit").find(marker=>marker.classList.contains("active"));
  assert(selectedMarker.getAttribute("cx").endsWith("%")&&
    element("tape-cursor").getAttribute("x1")===selectedMarker.getAttribute("cx")&&
    element("tape-cursor").getAttribute("x2")===selectedMarker.getAttribute("cx"),
    "responsive tape cursor and selected marker do not share the same proportional time coordinate");
  const previous=hooks.recordState().hit;
  hooks.selectCombatHit(-1);hooks.selectCombatHit(9999);
  assert(hooks.recordState().hit===previous,"invalid selected hit index changed the valid selection");
  const marker=element("tape").querySelectorAll("[data-hit]").find(item=>item.getAttribute("data-hit")==="4");
  element("allhits").querySelector("thead").getBoundingClientRect=()=>({height:36});
  assert(marker,"positive timeline selection control is missing");marker.click();
  assert(hooks.recordState().hit?.t===19&&activeRows().length===1&&activeRows()[0].getAttribute("data-hit-index")==="4" &&
    text("anatomy-readout").includes("Third target"),"timeline event did not coordinate its adjacent table and anatomy");
  assert(modelUpdates.at(-1)?.active==="RibcageUp"&&modelUpdates.at(-1)?.direction==="taken",
    "timeline selection left the mannequin highlighting an outgoing contact");
  const revealed=activeRows()[0];
  assert(revealed.scrollCount===1 && revealed.scrollOptions.block==="nearest" &&
    revealed.scrollOptions.inline==="nearest" && revealed.scrollOptions.behavior==="instant" &&
    element("allhits").style.scrollPaddingTop==="44px",
    "tape selection did not reveal its exact event below the sticky table header");
  marker.click();
  assert(revealed.scrollCount===2,"reselecting the same tape hit did not reveal it again");
  marker.dispatchEvent({type:"keydown",key:"Enter"});
  marker.dispatchEvent({type:"keydown",key:" "});
  assert(revealed.scrollCount===4,"keyboard tape activation did not reveal the event");
  element("tape").querySelector('[data-tape="next"]').click();
  assert(activeRows()[0].getAttribute("data-hit-index")==="5"&&activeRows()[0].scrollCount===1,
    "Next hit did not reveal its event");
  element("tape").querySelector('[data-tape="prev"]').click();
  assert(activeRows()[0]===revealed&&revealed.scrollCount===5,"Previous hit did not reveal its event");
  const scrollCalls=()=>rows().reduce((sum,item)=>sum+item.scrollCount,0);
  const beforePassive=scrollCalls();
  const passiveScrub=element("tape-scrub");passiveScrub.value=5;passiveScrub.dispatchEvent("input");
  rows()[0].querySelector(".hit-select").click();
  assert(scrollCalls()===beforePassive,"scrubbing or table selection unexpectedly forced event scrolling");
  hooks.focusTapeRange(4,8,"Opening exchange");
  hooks.selectCombatHit(4);
  assert(hooks.recordState().focus===null&&hooks.recordState().hit?.t===19,
    "selecting a table event outside the timeline range did not reveal its actual time");
  hooks.selectAnatomyZone("Eyes");
  assert(hooks.viewState().hitView==="split"&&!element("hit-anatomy-panel").hidden&&!element("hit-table-panel").hidden,
    "clicking a body zone navigated away from the mannequin");
  assert(rows().length===1&&rows()[0].getAttribute("data-hit-index")==="0"&&!hooks.recordState().hit&&activeRows().length===0,
    "zone selection did not filter the adjacent table or clear its excluded event");
  assert(modelUpdates.at(-1)?.active===""&&modelUpdates.at(-1)?.selected==="Eyes",
    "excluded selected event survived on the mannequin or hid the chosen zone filter");
  assert(hooks.recordState().filters.zone==="Eyes"&&text("active-filter-chips").includes("Eyes"),
    "zone filter is not explicit in the shared workspace context");
  hooks.selectAnatomyZone("Eyes");
  assert(rows().length===6&&hooks.recordState().filters.zone==="","second zone selection did not restore all contacts");
  const allHits=element("allhits"),zones=element("anatomy-zones");
  allHits.scrollTop=91;zones.scrollTop=73;
  const opponentButton=element("combat-opponents").querySelector('[data-combat-opponent="id:op-a"]');
  assert(opponentButton,"opponent rail lacks its exact stable-identity control");opponentButton.click();
  assert(allHits.scrollTop===0&&zones.scrollTop===0&&rows().length===2&&
    rows().every(row=>["0","1"].includes(row.getAttribute("data-hit-index"))),
    "opponent evidence link failed to retain stable row indices or reset internal scroll");
  assert(text("combat-context").includes("Twin target"),"evidence link hid its opponent context");
  hooks.selectCombatHit(0);
  const retainedMarkup=element("allhits").innerHTML;
  document.hidden=true;(document.events.visibilitychange||[]).forEach(fn=>fn());
  document.hidden=false;(document.events.visibilitychange||[]).forEach(fn=>fn());
  pushLive(live);
  assert(hooks.recordState().hit?.t===5&&hooks.recordState().filters.opponent==="id:op-a"&&element("allhits").innerHTML===retainedMarkup,
    "hide/re-show or an unchanged retained frame discarded the reader's selection/context");
  element("combat-reset").click();
  assert(rows().length===6&&!hooks.recordState().hit&&!hooks.recordState().focus&&
    hooks.recordState().filters.dir==="all"&&!hooks.recordState().filters.opponent&&!hooks.recordState().filters.zone,
    "Whole raid reset left an event, range or opponent/zone filter active");
  assert(modelUpdates.at(-1)?.active===""&&modelUpdates.at(-1)?.selected==="",
    "Whole raid reset left an event or region highlighted on the mannequin");
  const changeFilter=(key,value)=>{
    const control=element("filters").querySelector('[data-f="'+key+'"]');
    assert(control,"advanced filter control is missing: "+key);
    control.value=value;control.dispatchEvent({type:"change"});
  };
  changeFilter("opponent","id:op-b");
  assert(rows().length===2&&rows().every(row=>["2","5"].includes(row.getAttribute("data-hit-index"))),
    "opponent select lost its exact identity binding after moving into advanced filters");
  element("tape").querySelector('.tape-hit-target[data-hit="5"]').click();
  assert(activeRows().length===1&&activeRows()[0].getAttribute("data-hit-index")==="5"&&
    activeRows()[0].scrollCount===1,"filtered tape selection scrolled by visible position instead of exact event identity");
  changeFilter("armour","none");
  assert(rows().length===0,"negative armour filter still exposes armour contacts");
  changeFilter("armour","contact");
  assert(rows().length===2,"positive armour filter no longer restores its exact opponent contacts");
  changeFilter("opponent","");
  assert(rows().length===6,"clearing the advanced opponent select did not restore the full armour sample");
  element("combat-reset").click();
  hooks.openHitExplorer({dir:"taken"});
  const scrub=element("tape-scrub");scrub.value=18;scrub.dispatchEvent({type:"input"});
  assert(hooks.recordState().hit?.t===6&&hooks.recordState().hit.dealt===false,
    "timeline scrubbing selected a filtered-out or future contact");
  element("combat-reset").click();

  const beforeOverall=requests.length;element("scope-overall").click();
  assert(requests.length===beforeOverall&&!overallPanel.hidden&&element("report-nav").hidden&&
    !element("overall-nav").hidden&&element("history-control").hidden&&
    document.querySelectorAll("[data-report-view]").every(panel=>panel.hidden),"Overall did not replace raid controls with its own scope");
  assert(element("raid-kpis").getAttribute("aria-label")==="Overall headline statistics"&&
    element("past-label").textContent.includes("9 recorded raid summaries"),"Overall does not identify the scope of its statistics");
  for(const name of ["weapons","locations","overview"]) {
    document.querySelector('[data-overall-target="'+name+'"]').click();
    const button=document.querySelector('[data-overall-target="'+name+'"]');
    assert(button.getAttribute("aria-selected")==="true"&&hooks.viewState().historyScope.kind==="overall",
      "Overall "+name+" navigation failed or leaked into a raid view");
    document.querySelectorAll("[data-overall-view]").forEach(panel=>assert(
      panel.hidden===(panel.getAttribute("data-overall-view")!==name),"Overall tab did not expose only its selected evidence panel"));
  }
  assert(text("overall-headlines").includes("Recorded raids")&&element("overall-note").textContent.includes("Older detail files may already be pruned"),
    "Overall lost its summary retention limitation");
  element("scope-raid").click();
  assert(where.textContent==="Live Factory"&&selector.value==="latest"&&overallPanel.hidden,"Raid scope did not restore Latest");
  assertRaidNavigation("combat");
  assert(element("raid-kpis").getAttribute("aria-label")==="Raid headline statistics","Raid scope left the Overall accessible headline label");

  hooks.openHitExplorer({dir:"taken"});hooks.selectCombatHit(1);
  element("scope-overall").click();
  pushLive({...live, history:[...liveRows,historyRow(99,"Older indexed raid")]});
  element("scope-raid").click();
  assert(hooks.recordState().hit?.t===6&&hooks.recordState().activeIndex===1&&activeRows().length===1,
    "same-raid live refresh left selection pointing at the old payload's hit object");

  const archived=selectRaid(400);archived.resolve(JSON.stringify(raidFixture(400,"Archived Customs",[],true)));await settle();
  assert(where.textContent==="Archived Customs"&&selector.value==="400"&&!selector.disabled,"valid archive did not become the individual report");
  hooks.openHitExplorer({dir:"taken"});hooks.selectCombatHit(1);
  element("scope-overall").click();const beforeRestore=requests.length;element("scope-raid").click();
  assert(where.textContent==="Archived Customs"&&selector.value==="400"&&requests.length===beforeRestore,
    "Raid/Overall switch forgot the selected archive or unnecessarily loaded it again");
  assert(hooks.recordState().hit?.t===6&&hooks.recordState().filters.dir==="taken",
    "Overall round trip discarded the saved individual raid's event/filter context");
  const missingFromArchive=selectRaid(350);missingFromArchive.resolve(null);await settle();
  assert(where.textContent==="Archived Customs"&&selector.value==="400"&&!selector.disabled&&
    hooks.recordState().hit?.t===6&&hooks.recordState().filters.dir==="taken",
    "failed archive choice discarded the prior archive's selected-event/filter context");
  element("back-live").click();
  assert(where.textContent==="Live Factory"&&selector.value==="latest"&&pastbar.style.display==="none",
    "Back to latest did not explicitly return from the saved archive");

  async function rejectArchive(ts,response,label,reject=false) {
    const beforeLocation=where.textContent,pending=selectRaid(ts);
    reject?pending.reject(response):pending.resolve(response);await settle();
    assert(where.textContent===beforeLocation&&selector.value==="latest"&&!selector.disabled,
      label+" archive response overwrote the report or left the selector busy/stale");
  }
  await rejectArchive(350,null,"empty");
  assert(!element("history-notice").hidden && element("history-notice").textContent.includes("previous report"),
    "failed archive did not explain the retained previous report");
  assert(!selector.options.find(option=>option.value==="350")?.disabled,
    "unknown availability was permanently disabled after a possibly transient bridge failure");
  await rejectArchive(300,"{ malformed json","malformed");
  await rejectArchive(250,JSON.stringify(raidFixture(249,"Wrong archive")),"mismatched");
  await rejectArchive(200,new Error("load failed"),"rejected",true);

  const labelRace=selectRaid(150);
  const refreshedRows=[501,450,400,350,300,250,200,150,100].map(ts=>historyRow(ts,"History "+ts));
  const refreshed=raidFixture(501,"Refreshed live Factory",refreshedRows,true);pushLive(refreshed);
  assert(selector.disabled&&selector.value==="150"&&where.textContent==="Live Factory","live refresh disturbed a pending archive choice");
  labelRace.resolve(JSON.stringify(raidFixture(150,"Archive after refresh")));await settle();
  assert(where.textContent==="Archive after refresh"&&element("past-label").textContent==="Archived raid — Raid 150",
    "archive response after refresh lost its captured request identity");
  element("back-live").click();
  assert(where.textContent==="Refreshed live Factory"&&selector.value==="latest"&&document.activeElement===selector,
    "Back to latest lost the retained refresh or left focus in the hidden archive bar");

  const stale=selectRaid(450);hooks.showOverall();stale.resolve(JSON.stringify(raidFixture(450,"Stale archive response")));await settle();
  assert(!overallPanel.hidden&&hooks.viewState().historyScope.kind==="overall"&&where.textContent.includes("recorded raid summaries"),
    "late archive response overwrote Overall");
  const main=document.querySelector("main");main.scrollTop=137;
  const newestRows=[502,501,450,400,350,300,250,200,150,100].map(ts=>historyRow(ts,"History "+ts));
  const newest=raidFixture(502,"Newest live Factory",newestRows,true);pushLive(newest);
  assert(!overallPanel.hidden&&where.textContent==="10 recorded raid summaries"&&main.scrollTop===137&&
    !selector.options.some(option=>option.value==="overall"),"live refresh lost Overall, its scroll position or raid-only selector");
  element("scope-raid").click();
  assert(where.textContent==="Newest live Factory"&&selector.value==="latest","Raid scope failed to return to the refreshed retained Latest");
  const older=selectRaid(400);older.resolve(JSON.stringify(raidFixture(400,"Newer archive choice")));await settle();
  assert(where.textContent==="Newer archive choice"&&selector.value==="400"&&overallPanel.hidden,"archive could not reopen after Overall");
  const beforeBack=requests.length;element("back-live").click();
  assert(where.textContent==="Newest live Factory"&&selector.value==="latest"&&requests.length===beforeBack,"final Back to latest issued an unnecessary request");
  const legacy=raidFixture(503,"Legacy clock",[],true);legacy.v=1;
  delete legacy.cartridgesFired;delete legacy.cartridgesHit;delete legacy.costBasis;
  legacy.engagements[0].hits[0].t=null;delete legacy.engagements[0].hits[0].collider;
  pushLive(legacy);hooks.setReportView("combat");hooks.selectCombatHit(0);
  const beforeUntimed=hooks.recordState().cursor;
  const untimedIndex=hooks.allHits(legacy).findIndex(hit=>hit.t===null);
  assert(untimedIndex>=0&&hooks.selectCombatHit(untimedIndex),"untimed legacy contact could not be selected");
  assert(hooks.recordState().hit?.t===null&&hooks.recordState().activeIndex===-1&&hooks.recordState().cursor===beforeUntimed&&
    text("selected-hit-detail").includes("Time not recorded")&&!/\d+%/.test(text("raid-kpis")),
    "untimed legacy selection invented a clock position or trusted cartridge precision");
  assert(activeRows().length===1&&Number(activeRows()[0].getAttribute("data-hit-index"))===untimedIndex,
    "untimed contact highlighted the wrong canonical table row");
  hooks.setReportView("combat");hooks.selectCombatHit(0);hooks.selectAnatomyZone("Eyes");
  pushLive(raidFixture(504,"Next raid",newestRows));
  assert(!hooks.recordState().hit&&!hooks.recordState().filters.zone&&rows().length===0&&
    hooks.viewState().reportView==="combat","new raid inherited a selected event/zone or discarded the chosen task view");
}

export { FakeDocument, inlineScript, raidFixture };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const document=new FakeDocument(page);
staticContract(document);
expectRejected(()=>staticContract(new FakeDocument(page.replace('data-report-view="arsenal"','data-report-view="combat"'))),
  "duplicate raid view");
expectRejected(()=>staticContract(new FakeDocument(page.replace('id="scope-overall"','id="removed-scope-overall"'))),
  "missing visible Overall scope");
await runtimeContract(document);
const noReveal=page.replace('    revealSelectedEvent();', '    /* reveal removed for negative control */');
assert(noReveal!==page,"scroll negative control was not applied");
let scrollRejected=false;
try { await runtimeContract(new FakeDocument(noReveal),noReveal); }
catch(error) { scrollRejected=error.message.includes("tape selection did not reveal"); }
assert(scrollRejected,"removing tape-to-event scrolling did not fail the interaction test");
console.log("COMBATLOG UI ARCHITECTURE VERIFIED");
}
