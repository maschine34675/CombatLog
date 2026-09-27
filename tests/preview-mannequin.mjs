import http from "node:http";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const choices = {
  head: ["Eyes", "Jaw", "BackHead", "Ears", "ParietalHead"],
  chest: ["NeckFront", "NeckBack", "RibcageUp", "LeftSideChestUp", "RightSideChestUp", "SpineTop"],
  stomach: ["RibcageLow", "SpineDown", "Pelvis", "PelvisBack", "LeftSideChestDown", "RightSideChestDown"],
  "left arm": ["LeftUpperArm", "LeftForearm"], "right arm": ["RightUpperArm", "RightForearm"],
  "left leg": ["LeftThigh", "LeftCalf"], "right leg": ["RightThigh", "RightCalf"],
};
const hits = Object.entries(choices).flatMap(([part, colliders]) => colliders.map((collider) => ({
  part, collider, t: 0, dealt: true, opponentId: "fixture-a", who: "Training target", cls: "PMC",
  before: 48, after: 32, armorDamage: 16, blocked: false, deflected: false,
  weapon: "M4A1", ammo: "M855", ammoId: "fixture-ammo", fatal: false, fatalInferred: false, dist: 25,
})));
hits.push({ ...hits[0], dealt: false }, { ...hits[0] }, { ...hits[1], collider: "HeadCommon" });
hits.forEach((h, i) => { h.t = 5 + i * 2; });
const payload = {
  v: 2, ts: 100, history: [], raid: { outcome: "SURVIVED", location: "Anatomy fixture", duration: 80, finished: true },
  findings: [], hitsDealt: hits.length - 1, hitsReceived: 1, damageDealt: (hits.length - 1) * 32,
  damageReceived: 32, armorSavedYou: 16, shotsFired: 60, shotsHit: hits.length - 1, kills: 0, loadout: [],
  engagements: [{ start: 5, duration: 54, hitsDealt: hits.length - 1, hitsReceived: 1,
    damageDealt: (hits.length - 1) * 32, damageReceived: 32, kills: 0, killLinks: 0,
    opponents: [{ id: "fixture-a", name: "Training target" }], hits }],
};
const densityPayload = JSON.parse(JSON.stringify(payload));
const densityHits = [["LeftForearm", "left arm", 1], ["Jaw", "head", 4], ["Eyes", "head", 16]]
  .flatMap(([collider, part, count]) => Array.from({ length: count }, (_, index) => ({
    ...hits[0], collider, part, t: 5 + densityHitsLength(collider, index), before: 48, after: 32,
  })));
function densityHitsLength(collider, index) {
  return ({ LeftForearm: 0, Jaw: 1, Eyes: 5 }[collider] + index) * 1.5;
}
densityPayload.ts = 108;
densityPayload.raid = { outcome: "SURVIVED", location: "Density scale fixture · not a captured raid", duration: 45, finished: true };
densityPayload.hitsDealt = densityHits.length; densityPayload.hitsReceived = 0;
densityPayload.damageDealt = densityHits.reduce((sum, hit) => sum + hit.after, 0); densityPayload.damageReceived = 0;
densityPayload.shotsFired = 30; densityPayload.shotsHit = densityHits.length;
densityPayload.engagements = [{ start: 5, duration: 30, hitsDealt: densityHits.length, hitsReceived: 0,
  damageDealt: densityPayload.damageDealt, damageReceived: 0, kills: 0, killLinks: 0,
  opponents: [{ id: "fixture-a", name: "Training target" }], hits: densityHits }];
const equipmentPayload = JSON.parse(JSON.stringify(payload));
equipmentPayload.ts = 103;
equipmentPayload.raid = { outcome: "KILLED IN ACTION", location: "Equipment fixture · not a captured raid", duration: 80, finished: true };
let outgoingIndex = 0;
equipmentPayload.engagements[0].hits.forEach((hit) => {
  hit.weaponId = hit.dealt ? (outgoingIndex++ >= 23 ? "fixture-glock-c" : "fixture-m4-a") : "fixture-enemy";
  hit.weapon = hit.weaponId === "fixture-glock-c" ? "Glock 17" : hit.dealt ? "M4A1" : "AK-74N";
  if (hit.weaponId === "fixture-glock-c") { hit.ammo = "9×19 Pst gzh"; hit.ammoId = "fixture-9mm"; }
  if (!hit.dealt) {
    hit.who = "Viktor Sokolov"; hit.opponentId = "fixture-killer"; hit.part = "chest"; hit.collider = "RibcageUp";
    hit.ammo = "5.45×39 BP"; hit.ammoId = "fixture-bp"; hit.t = 75; hit.fatal = true;
  }
});
equipmentPayload.engagements[0].duration = 70;
equipmentPayload.engagements[0].opponents.push({ id: "fixture-killer", name: "Viktor Sokolov" });
equipmentPayload.shotsFired = 68;
equipmentPayload.shotsHit = 23;
equipmentPayload.death = { killer: "Viktor Sokolov", weapon: "AK-74N", ammo: "5.45×39 BP", part: "chest", damage: 32, absorbed: 16, distance: 25, hitsFromKiller: 1, damageFromKiller: 32 };
equipmentPayload.killer = {
  profileId: "fixture-killer", name: "Viktor Sokolov", level: 38, side: "BEAR", portraitImage: "103001",
  equipment: [
    { slot: "FirstPrimaryWeapon", name: "AK-74N", templateId: "fixture-ak", image: "103002" },
    { slot: "Headwear", name: "6B47 Ratnik-BSh helmet", templateId: "fixture-helmet", image: "103003", armorClass: 3, durability: 18, maxDurability: 25 },
    { slot: "ArmorVest", name: "6B13 assault armour", templateId: "fixture-armour", image: "103004", armorClass: 4, durability: 31, maxDurability: 47 },
    { slot: "TacticalVest", name: "BlackRock chest rig", templateId: "fixture-rig", image: "103005" },
    { slot: "Earpiece", name: "GSSH-01 headset", templateId: "fixture-headset", image: "103006" },
    { slot: "Backpack", name: "Berkut backpack", templateId: "fixture-bag", image: "" },
    { slot: "FaceCover", name: "Smoke balaclava", templateId: "fixture-mask", image: "103010" },
    { slot: "Eyewear", name: "RayBench sunglasses", templateId: "fixture-glasses", image: "103011" },
    { slot: "ArmBand", name: "BEAR armband", templateId: "fixture-armband", image: "103012" },
    { slot: "SecondPrimaryWeapon", name: "SV-98", templateId: "fixture-sv98", image: "103013" },
    { slot: "Holster", name: "Glock 17", templateId: "fixture-glock", image: "103014" },
    { slot: "Scabbard", name: "ER Fulcrum Bayonet", templateId: "fixture-knife", image: "103015" },
  ],
};
equipmentPayload.weapons = [
  { id: "fixture-m4-a", templateId: "fixture-m4", name: "M4A1", image: "103007", fired: 42, shotsHit: 19, hits: 23, damage: 736, armorDamage: 368, kills: 0, killLinks: 0 },
  { id: "fixture-m4-b", templateId: "fixture-m4", name: "M4A1", image: "103008", fired: 8, shotsHit: 0, hits: 0, damage: 0, armorDamage: 0, kills: 0, killLinks: 0 },
  { id: "fixture-glock-c", templateId: "fixture-glock", name: "Glock 17", image: "103009", fired: 18, shotsHit: 4, hits: 4, damage: 128, armorDamage: 64, kills: 0, killLinks: 0 },
];
for (const weapon of equipmentPayload.weapons) {
  const contacts = equipmentPayload.engagements.flatMap(e => e.hits).filter(h => h.dealt && h.weaponId === weapon.id);
  weapon.hits = contacts.length;
  weapon.damage = contacts.reduce((sum, h) => sum + h.after, 0);
  weapon.armorDamage = contacts.reduce((sum, h) => sum + h.armorDamage, 0);
  if (weapon.shotsHit > weapon.hits) throw new Error("Equipment fixture has more projectile hits than contacts: " + weapon.id);
}
equipmentPayload.loadout = [
  { id: "fixture-ammo", ammo: "M855", fired: 50, shotsHit: 19, hits: 23, kills: 0, cost: 10500, classes: [] },
  { id: "fixture-9mm", ammo: "9×19 Pst gzh", fired: 18, shotsHit: 4, hits: 4, kills: 0, cost: 3600, classes: [] },
];
const recordsPayload = JSON.parse(JSON.stringify(payload));
recordsPayload.ts = 105;
recordsPayload.raid = {outcome:'SURVIVED', location:'Records fixture · not a captured raid', duration:80, finished:true};
const recordHits = [
  {t:8, opponentId:'records-a', who:'Twin target', after:47, dist:320, part:'head', collider:'Eyes'},
  {t:12, opponentId:'records-b', who:'Twin target', after:83, dist:40, part:'chest', collider:'RibcageUp'},
  {t:24.5, opponentId:'records-a', who:'Twin target', after:212.5, dist:65, part:'head', collider:'Jaw'},
  {t:24.5, opponentId:'records-attacker', who:'Attacker', dealt:false, after:195, dist:110, part:'chest', collider:'SpineTop', weapon:'AK-74N', ammo:'5.45 BP'},
  {t:42, opponentId:'records-a', who:'Twin target', after:42, dist:30, part:'left leg', collider:'LeftThigh', weapon:'Glock 17', ammo:'9×19 Pst gzh'},
  {t:43, opponentId:'records-b', who:'Twin target', after:33, dist:320, part:'right arm', collider:'RightForearm'},
  {t:45, opponentId:'records-b', who:'Twin target', after:55, dist:55, part:'chest', collider:'RibcageUp'},
].map(h => ({...hits[0], ...h, before:h.after + 16}));
recordsPayload.hitsDealt = 6; recordsPayload.hitsReceived = 1;
recordsPayload.damageDealt = recordHits.filter(h => h.dealt).reduce((sum,h) => sum+h.after,0);
recordsPayload.damageReceived = 195; recordsPayload.shotsFired = 30; recordsPayload.shotsHit = 6;
recordsPayload.engagements = [{start:8,duration:37,hitsDealt:6,hitsReceived:1,damageDealt:recordsPayload.damageDealt,damageReceived:195,kills:0,killLinks:0,
  opponents:[{id:'records-a',name:'Twin target'},{id:'records-b',name:'Twin target'},{id:'records-attacker',name:'Attacker'}],hits:recordHits}];
const armourPayload = JSON.parse(JSON.stringify(payload));
armourPayload.ts = 107;
armourPayload.raid = {outcome:'SURVIVED', location:'Armour fixture · not a captured raid', duration:48, finished:true};
const armourHits = [
  {t:5, before:50, after:50, armorDamage:0, blocked:false, deflected:false, part:'chest', collider:'RibcageUp'},
  {t:8, before:60, after:35, armorDamage:0, blocked:false, deflected:false, part:'chest', collider:'RibcageUp'},
  {t:12, before:50, after:4, armorDamage:0, blocked:true, deflected:false, part:'chest', collider:'RibcageUp'},
  {t:16, before:45, after:5, armorDamage:0, blocked:true, deflected:true, part:'head', collider:'Eyes'},
  {t:28, dealt:false, before:80, after:30, armorDamage:0, blocked:false, deflected:false, part:'chest', collider:'RibcageUp'},
  {t:35, dealt:false, before:90, after:10, armorDamage:0, blocked:true, deflected:false, part:'chest', collider:'RibcageUp'},
  {t:42, dealt:false, before:70, after:5, armorDamage:0, blocked:true, deflected:true, part:'head', collider:'Jaw'},
].map((h) => ({...hits[0], who:h.dealt === false ? 'Armour tester' : 'Armoured target', opponentId:'armour-target', ...h}));
const armourDealt = armourHits.filter(h => h.dealt), armourTaken = armourHits.filter(h => !h.dealt);
armourPayload.hitsDealt = armourDealt.length; armourPayload.hitsReceived = armourTaken.length;
armourPayload.damageDealt = armourDealt.reduce((sum,h)=>sum+h.after,0);
armourPayload.damageReceived = armourTaken.reduce((sum,h)=>sum+h.after,0);
armourPayload.shotsFired = 8; armourPayload.shotsHit = armourDealt.length;
armourPayload.engagements = [{start:5,duration:37,hitsDealt:armourDealt.length,hitsReceived:armourTaken.length,
  damageDealt:armourPayload.damageDealt,damageReceived:armourPayload.damageReceived,kills:0,killLinks:0,
  opponents:[{id:'armour-target',name:'Armoured target'}],hits:armourHits}];
armourPayload.loadout = [{id:'fixture-ammo',ammo:'M855',fired:8,shotsHit:4,hits:4,kills:0,cost:1680,
  classes:[{cls:'PMC',hits:4,armorHits:3,through:1,blocked:1,deflected:1,avgBefore:51.25,avgAfter:23.5,absorbed:111,kills:0}]}];
const polishPayload = JSON.parse(JSON.stringify(equipmentPayload));
polishPayload.ts = 106;
polishPayload.raid = {outcome:'KILLED IN ACTION', location:'Visual polish fixture · not a captured raid', duration:34, finished:true};
const polishHits = [
  {t:8, opponentId:'polish-a', who:'Dmitri Volkov', after:28, part:'chest', collider:'RibcageUp'},
  {t:8.8, opponentId:'polish-a', who:'Dmitri Volkov', after:44, part:'head', collider:'Eyes', fatal:true},
  {t:19, opponentId:'polish-b', who:'Pavel Morozov', after:38, part:'chest', collider:'RibcageUp'},
  {t:19.9, opponentId:'polish-b', who:'Pavel Morozov', after:35, part:'head', collider:'Jaw', fatal:true, fatalInferred:true},
  {t:32, opponentId:'fixture-killer', who:'Viktor Sokolov', after:22, dealt:false, part:'left arm', collider:'LeftUpperArm'},
  {t:33, opponentId:'fixture-killer', who:'Viktor Sokolov', after:25, part:'chest', collider:'RibcageUp', weaponId:'fixture-glock-c'},
  {t:34, opponentId:'fixture-killer', who:'Viktor Sokolov', after:58, dealt:false, part:'chest', collider:'RibcageUp', fatal:true},
].map(h => {
  const weaponId = h.dealt === false ? 'fixture-enemy' : h.weaponId || 'fixture-m4-a';
  const pistol = weaponId === 'fixture-glock-c';
  return {...hits[0], ...h, before:h.after + 16, dist:38, weaponId,
    weapon:h.dealt === false ? 'AK-74N' : pistol ? 'Glock 17' : 'M4A1',
    ammo:h.dealt === false ? '5.45×39 BP' : pistol ? '9×19 Pst gzh' : 'M855',
    ammoId:h.dealt === false ? 'fixture-bp' : pistol ? 'fixture-9mm' : 'fixture-ammo'};
});
const total = (items, key) => items.reduce((sum, item) => sum + item[key], 0);
const polishDealt = polishHits.filter(h => h.dealt), polishTaken = polishHits.filter(h => !h.dealt);
polishPayload.hitsDealt = polishDealt.length; polishPayload.hitsReceived = polishTaken.length;
polishPayload.damageDealt = total(polishDealt, 'after'); polishPayload.damageReceived = total(polishTaken, 'after');
polishPayload.armorSavedYou = total(polishTaken, 'armorDamage');
polishPayload.shotsFired = 16; polishPayload.shotsHit = polishDealt.length;
polishPayload.kills = new Set(polishDealt.filter(h => h.fatal).map(h => h.opponentId)).size;
polishPayload.weapons = [equipmentPayload.weapons[0], equipmentPayload.weapons[2]].map((weapon, index) => {
  const contacts = polishDealt.filter(h => h.weaponId === weapon.id);
  return {...weapon, fired:index === 0 ? 12 : 4, shotsHit:contacts.length, hits:contacts.length,
    damage:total(contacts, 'after'), armorDamage:total(contacts, 'armorDamage'),
    kills:contacts.filter(h => h.fatal && !h.fatalInferred).length,
    killLinks:contacts.filter(h => h.fatal && h.fatalInferred).length};
});
polishPayload.loadout = equipmentPayload.loadout.map((ammo, index) => {
  const contacts = polishDealt.filter(h => h.ammoId === ammo.id), weapon = polishPayload.weapons[index];
  return {...ammo, fired:weapon.fired, shotsHit:contacts.length, hits:contacts.length,
    kills:contacts.filter(h => h.fatal && !h.fatalInferred).length, cost:weapon.fired * (index === 0 ? 210 : 200)};
});
polishPayload.ammoCost = total(polishPayload.loadout, 'cost');
polishPayload.engagements = [{start:8, duration:26, hitsDealt:polishDealt.length, hitsReceived:polishTaken.length,
  damageDealt:polishPayload.damageDealt, damageReceived:polishPayload.damageReceived,
  kills:polishDealt.filter(h => h.fatal && !h.fatalInferred).length,
  killLinks:polishDealt.filter(h => h.fatal && h.fatalInferred).length,
  opponents:Array.from(new Map(polishHits.map(h => [h.opponentId, {id:h.opponentId, name:h.who}])).values()), hits:polishHits}];
polishPayload.death = {...polishPayload.death, damage:58, absorbed:16, distance:38,
  hitsFromKiller:polishTaken.length, damageFromKiller:polishPayload.damageReceived, fatalInferred:false};
const overallHistory = [
  [112, '2026-09-03 22:18', 'Factory', 'SURVIVED', 640, 31, 13, 6, 742, 210, 54, 21, 11880],
  [111, '2026-09-03 20:42', 'Laboratory', 'KIA', 905, 18, 9, 14, 498, 516, 82, 17, 20140],
  [110, '2026-09-02 23:05', 'Factory', 'LEFT', 314, 7, 4, 3, 186, 98, 29, 8, 5220],
  [109, '2026-09-02 21:37', 'Labyrinth', 'SURVIVED', 1180, 24, 16, 7, 903, 264, 96, 29, 24960],
  [108, '2026-09-01 19:16', 'Factory', 'RAN THROUGH', 178, 1, 1, 0, 44, 0, 8, 1, 720],
  [107, '2026-08-31 22:51', 'Laboratory', 'MIA', 1210, 12, 8, 9, 391, 442, 63, 14, 15120],
  [106, '2026-08-31 18:09', 'Factory', 'SURVIVED', 786, 20, 11, 5, 615, 155, 71, 22, 13490],
  [105, '2026-08-30 23:44', 'Factory', 'KIA', 522, 9, 5, 8, 272, 381, 44, 9, 8960],
  [104, '2026-08-30 20:13', 'Laboratory', 'SURVIVED', 1016, 28, 15, 10, 824, 309, 88, 26, 22560],
  [103, '2026-08-29 21:26', 'Factory', 'LEFT', 436, 6, 3, 4, 143, 188, 36, 6, 6480],
  [102, '2026-08-28 19:02', 'Labyrinth', 'SURVIVED', 870, 17, 10, 4, 566, 124, 67, 18, 12060],
  [101, '2026-08-27 17:38', 'Factory', 'KIA', 263, 4, 2, 5, 96, 231, null, null, null],
].map(([ts,date,location,outcome,duration,kills,hitsDealt,hitsReceived,damageDealt,damageReceived,shotsFired,shotsHit,ammoCost]) => {
  const row = {ts,date,location,outcome,duration,kills,hitsDealt,hitsReceived,damageDealt,damageReceived};
  if (shotsFired !== null) Object.assign(row,{shotsFired,shotsHit,cartridgesFired:shotsFired,cartridgesHit:shotsHit,ammoCost,costBasis:'cartridge'});
  return row;
});
const overallPayload = JSON.parse(JSON.stringify(payload));
const overallWeaponModels = ['ASh-12','HK 416A5','SPEAR 6.8','MCX .300 BLK','MPX','SR-25'];
const overallDetails = {};
overallHistory.forEach((row, index) => {
  if (!Object.hasOwn(row, 'shotsFired')) return;
  const model = index % overallWeaponModels.length;
  const weapons = [{id:'fixture-instance-'+index,templateId:'fixture-model-'+model,name:overallWeaponModels[model],
    fired:row.shotsFired,shotsHit:row.shotsHit,cartridgesFired:row.cartridgesFired,cartridgesHit:row.cartridgesHit,
    hits:row.hitsDealt,damage:row.damageDealt,kills:row.kills,killLinks:index===0?2:0}];
  overallDetails[String(row.ts)] = {v:2,ts:row.ts,weapons,raid:{finished:true,outcome:row.outcome,location:row.location,duration:row.duration},
    engagements:[],findings:[],loadout:[]};
  if (index < 9) row.weapons = weapons;
});
overallPayload.ts = 112;
overallPayload.history = overallHistory;
overallPayload.weapons = overallHistory[0].weapons;
overallPayload.historyDetailLimit = 50;
overallPayload.raid = { outcome:'SURVIVED', location:'Overall fixture latest raid', duration:640, finished:true };
Object.assign(overallPayload, {kills:31,hitsDealt:13,hitsReceived:6,damageDealt:742,damageReceived:210,shotsFired:54,shotsHit:21,ammoCost:11880});
for (const authored of [payload,densityPayload,equipmentPayload,recordsPayload,armourPayload,polishPayload,overallPayload]) {
  authored.cartridgesFired = authored.shotsFired;
  authored.cartridgesHit = authored.shotsHit;
  if (Number.isFinite(authored.ammoCost)) authored.costBasis = 'cartridge';
  for (const weapon of authored.weapons || []) {
    weapon.cartridgesFired = weapon.fired; weapon.cartridgesHit = weapon.shotsHit;
  }
  for (const ammo of authored.loadout || []) {
    ammo.cartridgesFired = ammo.fired; ammo.cartridgesHit = ammo.shotsHit;
    if (Number.isFinite(ammo.cost)) ammo.costBasis = 'cartridge';
  }
}

const cartridgeWeapons = [
  {id:'cartridge-shotgun',templateId:'cartridge-shotgun',name:'MP-153 · 8-pellet buckshot',
    fired:64,shotsHit:18,cartridgesFired:8,cartridgesHit:6,hits:20,damage:640,kills:2,killLinks:0},
  {id:'cartridge-rifle',templateId:'cartridge-rifle',name:'M4A1 · single projectile',
    fired:20,shotsHit:10,cartridgesFired:20,cartridgesHit:10,hits:12,damage:480,kills:1,killLinks:0},
];
const cartridgeLoadout = [
  {id:'cartridge-buckshot',ammo:'12/70 8-pellet buckshot',fired:64,shotsHit:18,cartridgesFired:8,cartridgesHit:6,
    hits:20,kills:2,cost:800,costBasis:'cartridge',classes:[]},
  {id:'cartridge-m855',ammo:'5.56×45 M855',fired:20,shotsHit:10,cartridgesFired:20,cartridgesHit:10,
    hits:12,kills:1,cost:4000,costBasis:'cartridge',classes:[]},
];
const cartridgeHits = cartridgeWeapons.flatMap((weapon,index) => Array.from({length:weapon.hits},(_,i)=>({
  ...hits[0], t:5 + index * 45 + i, weaponId:weapon.id, weapon:weapon.name,
  ammoId:cartridgeLoadout[index].id,ammo:cartridgeLoadout[index].ammo,
  before:index === 0 ? 32 : 40,after:index === 0 ? 32 : 40,armorDamage:0,
  fatal:i < weapon.kills,opponentId:'cartridge-target-'+index+'-'+(i < weapon.kills ? i : 0),
  who:index === 0 ? 'Shotgun target' : 'Rifle target',
})));
const cartridgePayload = {
  v:2,ts:903,historyDetailLimit:50,
  raid:{outcome:'SURVIVED',location:'Shots vs pellets · 8 shells / 20 rifle rounds',duration:90,finished:true},
  shotsFired:84,shotsHit:28,cartridgesFired:28,cartridgesHit:16,ammoCost:4800,costBasis:'cartridge',
  hitsDealt:32,hitsReceived:0,damageDealt:1120,damageReceived:0,armorSavedYou:0,kills:3,
  weapons:cartridgeWeapons,loadout:cartridgeLoadout,findings:[],
  engagements:[{start:5,duration:56,hitsDealt:32,hitsReceived:0,damageDealt:1120,damageReceived:0,kills:3,killLinks:0,
    opponents:Array.from(new Map(cartridgeHits.map(h=>[h.opponentId,{id:h.opponentId,name:h.who}])).values()),hits:cartridgeHits}],
};
const cartridgeLegacy = {
  v:2,ts:901,raid:{outcome:'SURVIVED',location:'Legacy AA-12 · 734 projectiles, shots unknown',duration:120,finished:true},
  shotsFired:734,shotsHit:120,ammoCost:73400,hitsDealt:130,hitsReceived:0,damageDealt:2600,damageReceived:0,kills:4,
  weapons:[{id:'legacy-aa12',templateId:'legacy-aa12',name:'AA-12 · legacy projectile counters',fired:734,shotsHit:120,hits:130,damage:2600,kills:4,killLinks:0}],
  loadout:[{id:'legacy-buckshot',ammo:'Legacy buckshot',fired:734,shotsHit:120,hits:130,kills:4,cost:73400,classes:[]}],
  findings:[],engagements:[],
};
cartridgePayload.history = [
  {ts:903,date:'2026-09-05 20:00',location:cartridgePayload.raid.location,outcome:'SURVIVED',duration:90,
    shotsFired:84,shotsHit:28,cartridgesFired:28,cartridgesHit:16,ammoCost:4800,costBasis:'cartridge',
    hitsDealt:32,hitsReceived:0,damageDealt:1120,damageReceived:0,kills:3,weapons:cartridgeWeapons},
  {ts:901,date:'2026-09-04 20:00',location:cartridgeLegacy.raid.location,outcome:'SURVIVED',duration:120,
    shotsFired:734,shotsHit:120,ammoCost:73400,hitsDealt:130,hitsReceived:0,damageDealt:2600,damageReceived:0,kills:4,
    weapons:cartridgeLegacy.weapons},
];
overallDetails['901'] = cartridgeLegacy;
const workspacePayload = JSON.parse(JSON.stringify(equipmentPayload));
workspacePayload.ts = 1900;
workspacePayload.raid = {outcome:'KILLED IN ACTION',location:'Customs · desktop workspace fixture',duration:769,finished:true};
const workspaceOpponents = [
  ['workspace-a','Dmitri Volkov','PMC',32], ['workspace-b','Pavel Morozov','Scav',76],
  ['workspace-c','Dmitri Volkov','PMC',146], ['workspace-d','Alexei Sidorov','Scav',19],
  ['workspace-e','Mikhail Andreev','PMC',208], ['workspace-f','Nikita Lebedev','Scav',53],
  ['fixture-killer','Viktor Sokolov','PMC',38],
];
const workspaceParts = [['chest','RibcageUp'],['left arm','LeftUpperArm'],['stomach','Pelvis'],['right leg','RightThigh'],['head','Jaw']];
workspacePayload.engagements = workspaceOpponents.map(([id,name,cls,distance], index) => {
  const start = [48,126,221,345,472,601,755][index];
  const incoming = index === 6 ? 4 : index % 2 + 1;
  const outgoing = index === 6 ? 3 : 5;
  const contact = (dealt, offset) => {
    const pistol = dealt && index >= 5;
    const [part,collider] = workspaceParts[(offset + index) % workspaceParts.length];
    const blocked = offset === 1 && index % 2 === 0;
    const deflected = offset === 4 && index === 2;
    const after = blocked || deflected ? 3 : 25 + (index * 9 + offset * 7) % 47;
    return {...hits[0],t:start + (dealt ? offset * 1.1 : 1.5 + offset * 2.2),
      dealt,opponentId:id,who:name,cls,part,collider,dist:distance + offset * .7,
      weaponId:dealt ? pistol ? 'fixture-glock-c' : 'fixture-m4-a' : 'enemy-'+id,
      weapon:dealt ? pistol ? 'Glock 17' : 'M4A1' : 'AK-74N',
      ammoId:dealt ? pistol ? 'fixture-9mm' : 'fixture-ammo' : 'fixture-bp',
      ammo:dealt ? pistol ? '9×19 Pst gzh' : 'M855' : '5.45×39 BP',
      before:after + (blocked ? 49 : deflected ? 41 : offset % 3 * 8),
      armorDamage:blocked ? 49 : deflected ? 41 : offset % 3 * 8,blocked,deflected,
      fatal:dealt && index < 6 && offset === outgoing - 1,
      fatalInferred:dealt && index === 4 && offset === outgoing - 1};
  };
  const contacts = [...Array.from({length:outgoing},(_,i)=>contact(true,i)),
    ...Array.from({length:incoming},(_,i)=>contact(false,i))].sort((a,b)=>a.t-b.t);
  if(index===6) Object.assign(contacts[contacts.length-1],{t:769,fatal:true,fatalInferred:false,
    part:'chest',collider:'RibcageUp',before:87,after:62,armorDamage:25,blocked:false,deflected:false});
  const dealt = contacts.filter(h=>h.dealt), taken=contacts.filter(h=>!h.dealt);
  return {start,duration:contacts.at(-1).t-start,opponents:[{id,name}],hits:contacts,
    hitsDealt:dealt.length,hitsReceived:taken.length,damageDealt:total(dealt,'after'),damageReceived:total(taken,'after'),
    kills:dealt.filter(h=>h.fatal&&!h.fatalInferred).length,killLinks:dealt.filter(h=>h.fatalInferred).length};
});
const workspaceHits = workspacePayload.engagements.flatMap(e=>e.hits);
const workspaceDealt = workspaceHits.filter(h=>h.dealt), workspaceTaken=workspaceHits.filter(h=>!h.dealt);
workspacePayload.hitsDealt=workspaceDealt.length;workspacePayload.hitsReceived=workspaceTaken.length;
workspacePayload.damageDealt=total(workspaceDealt,'after');workspacePayload.damageReceived=total(workspaceTaken,'after');
workspacePayload.armorSavedYou=total(workspaceTaken,'armorDamage');
workspacePayload.kills=workspaceDealt.filter(h=>h.fatal).length;
workspacePayload.weapons=equipmentPayload.weapons.map((weapon,index)=>{
  const contacts=workspaceDealt.filter(h=>h.weaponId===weapon.id), fired=contacts.length+[34,8,10][index];
  return {...weapon,fired,shotsHit:contacts.length,cartridgesFired:fired,cartridgesHit:contacts.length,
    hits:contacts.length,damage:total(contacts,'after'),armorDamage:total(contacts,'armorDamage'),
    kills:contacts.filter(h=>h.fatal&&!h.fatalInferred).length,killLinks:contacts.filter(h=>h.fatalInferred).length};
});
workspacePayload.loadout=equipmentPayload.loadout.map((ammo,index)=>{
  const contacts=workspaceDealt.filter(h=>h.ammoId===ammo.id);
  const fired=total(workspacePayload.weapons.filter(w=>index===0?w.id!=='fixture-glock-c':w.id==='fixture-glock-c'),'fired');
  return {...ammo,fired,shotsHit:contacts.length,cartridgesFired:fired,cartridgesHit:contacts.length,hits:contacts.length,
    kills:contacts.filter(h=>h.fatal&&!h.fatalInferred).length,cost:fired*(index===0?210:200),costBasis:'cartridge'};
});
workspacePayload.shotsFired=workspacePayload.cartridgesFired=total(workspacePayload.weapons,'fired');
workspacePayload.shotsHit=workspacePayload.cartridgesHit=workspaceDealt.length;
workspacePayload.ammoCost=total(workspacePayload.loadout,'cost');workspacePayload.costBasis='cartridge';
const workspaceKillerHits=workspaceTaken.filter(h=>h.opponentId==='fixture-killer');
workspacePayload.death={...equipmentPayload.death,damage:62,absorbed:25,distance:40.1,
  hitsFromKiller:workspaceKillerHits.length,damageFromKiller:total(workspaceKillerHits,'after'),fatalInferred:false};
workspacePayload.history=[{ts:1900,date:'2026-09-11 21:40',location:'Customs',outcome:'KIA',duration:769,
  kills:workspacePayload.kills,hitsDealt:workspaceDealt.length,hitsReceived:workspaceTaken.length,
  damageDealt:workspacePayload.damageDealt,damageReceived:workspacePayload.damageReceived,
  shotsFired:workspacePayload.shotsFired,shotsHit:workspacePayload.shotsHit,
  cartridgesFired:workspacePayload.cartridgesFired,cartridgesHit:workspacePayload.cartridgesHit,
  ammoCost:workspacePayload.ammoCost,costBasis:'cartridge',weapons:workspacePayload.weapons},...cartridgePayload.history];
overallDetails[String(cartridgePayload.ts)]=cartridgePayload;
const archivePayload = JSON.parse(JSON.stringify(workspacePayload));
archivePayload.ts = 2000;
archivePayload.raid.location = 'Archive navigation fixture · synthetic';
archivePayload.history = Array.from({length:400}, (_,i) => ({ts:10000+i,
  date:'2026-09-'+String(i%20+1).padStart(2,'0')+' 18:24',
  location:i%2?'Customs':'Factory',outcome:i%3?'SURVIVED':'KILLED IN ACTION',
  kills:i%5,damageDealt:i*13,damageReceived:i*3,duration:480+i,weapons:[]}));
archivePayload.historyDetailIds = archivePayload.history.slice(-50).map(row=>row.ts);
archivePayload.historyDetailLimit = 50;

const harness = `<script>
window.addEventListener('error', function(e) { document.getElementById('preview-errors').textContent += e.message; });
var previewFixture = ${JSON.stringify(payload)};
var previewDensity = ${JSON.stringify(densityPayload)};
var previewEquipment = ${JSON.stringify(equipmentPayload)};
var previewRecords = ${JSON.stringify(recordsPayload)};
var previewArmour = ${JSON.stringify(armourPayload)};
var previewPolish = ${JSON.stringify(polishPayload)};
var previewOverall = ${JSON.stringify(overallPayload)};
var previewCartridges = ${JSON.stringify(cartridgePayload)};
var previewWorkspace = ${JSON.stringify(workspacePayload)};
var previewArchive = ${JSON.stringify(archivePayload)};
var previewOverallDetails = ${JSON.stringify(overallDetails)};
previewOverallDetails[String(previewWorkspace.ts)] = previewWorkspace;
function legacyCounters(source) {
  var copy=Object.assign({},source);
  delete copy.cartridgesFired;delete copy.cartridgesHit;delete copy.costBasis;
  if (copy.weapons) copy.weapons=copy.weapons.map(legacyCounters);
  if (copy.loadout) copy.loadout=copy.loadout.map(legacyCounters);
  return copy;
}
var previewModes = {
  startup: {v:2,ts:0,raid:{started:false,finished:false,outcome:'SURVIVED',location:'Unknown location',duration:0},
    history:previewWorkspace.history,engagements:[],weapons:[],loadout:[],findings:[],kills:0,
    damageDealt:0,damageReceived:0,hitsDealt:0,hitsReceived:0,shotsFired:0,shotsHit:0,cartridgesFired:0,cartridgesHit:0},
  precise: previewFixture,
  density: previewDensity,
  legacy: legacyCounters(Object.assign({}, previewFixture, {v:1,ts:101,engagements:previewFixture.engagements.map(function(e){return Object.assign({},e,{hits:e.hits.map(function(h){var c=Object.assign({},h); delete c.collider; return c;})});})})),
  legacydeath: legacyCounters(Object.assign({}, previewEquipment, {v:1,ts:104,killer:null,weapons:undefined,loadout:previewEquipment.loadout.map(function(a){var c=Object.assign({},a);delete c.shotsHit;return c;}),engagements:previewEquipment.engagements.map(function(e){return Object.assign({},e,{hits:e.hits.map(function(h){var c=Object.assign({},h);delete c.weaponId;delete c.collider;delete c.ammoId;delete c.opponentId;delete c.fatalInferred;return c;})});})})),
  empty: Object.assign({}, previewFixture, {ts:102,engagements:[],weapons:[],hitsDealt:0,hitsReceived:0,damageDealt:0,damageReceived:0,armorSavedYou:0,shotsFired:0,shotsHit:0,cartridgesFired:0,cartridgesHit:0}),
  equipment: previewEquipment,
  records: previewRecords,
  armour: previewArmour,
  polish: previewPolish,
  overall: previewOverall,
  cartridges: previewCartridges,
  workspace: previewWorkspace,
  archive: previewArchive,
  pending: previewEquipment,
  unavailable: previewEquipment
};
var previewImageMode = 'equipment', previewGeneration = 200, previewAttempts = {};
function fixturePng(key) {
  var portrait = key === '103001', canvas = document.createElement('canvas');
  canvas.width = portrait ? 240 : 360; canvas.height = portrait ? 320 : 140;
  var ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#191d19'; ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.strokeStyle = '#424a3d'; ctx.lineWidth = 1;
  for (var i = 20; i < canvas.width; i += 20) { ctx.beginPath(); ctx.moveTo(i,0); ctx.lineTo(i,canvas.height); ctx.stroke(); }
  for (var j = 20; j < canvas.height; j += 20) { ctx.beginPath(); ctx.moveTo(0,j); ctx.lineTo(canvas.width,j); ctx.stroke(); }
  ctx.fillStyle = '#a7ad92'; ctx.textAlign = 'center';
  if (portrait) {
    ctx.font = 'bold 15px monospace'; ctx.fillText('FULL BODY FIXTURE', canvas.width/2, 24);
    ctx.fillStyle = '#343c32'; ctx.strokeStyle = '#a7ad92'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(120,58,17,0,Math.PI*2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#535d49'; ctx.beginPath(); ctx.arc(120,54,19,Math.PI,Math.PI*2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#343c32'; ctx.beginPath();
    ctx.moveTo(94,84); ctx.lineTo(146,84); ctx.lineTo(153,169); ctx.lineTo(87,169); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#535d49'; ctx.fillRect(99,101,42,52); ctx.strokeRect(99,101,42,52);
    ctx.lineCap = 'round'; ctx.lineWidth = 12; ctx.beginPath(); ctx.moveTo(93,94); ctx.lineTo(73,157); ctx.lineTo(85,198); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(147,94); ctx.lineTo(164,151); ctx.lineTo(153,192); ctx.stroke();
    ctx.lineWidth = 15; ctx.beginPath(); ctx.moveTo(105,168); ctx.lineTo(101,247); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(135,168); ctx.lineTo(141,247); ctx.stroke();
    ctx.lineWidth = 8; ctx.beginPath(); ctx.moveTo(91,250); ctx.lineTo(108,250); ctx.moveTo(134,250); ctx.lineTo(153,250); ctx.stroke();
    ctx.strokeStyle = '#c8a96a'; ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(70,124); ctx.lineTo(176,180); ctx.stroke();
    ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(62,117); ctx.lineTo(84,129); ctx.moveTo(174,180); ctx.lineTo(190,188); ctx.stroke();
    ctx.fillStyle = '#818c75'; ctx.font = '12px monospace'; ctx.fillText(key, canvas.width/2, 278);
  } else {
    ctx.font = 'bold 18px monospace'; ctx.fillText('ITEM IMAGE FIXTURE', canvas.width/2, canvas.height/2 - 8);
    ctx.fillStyle = '#818c75'; ctx.font = '12px monospace'; ctx.fillText(key, canvas.width/2, canvas.height/2 + 18);
  }
  ctx.fillText('NOT A GAME CAPTURE', canvas.width/2, canvas.height - 20);
  return canvas.toDataURL('image/png');
}
window.overlay = { request: function(channel,key) {
  if (channel === 'loadRaid') {
    if (previewArchive.historyDetailIds.includes(Number(key))) {
      var row = previewArchive.history.find(function(r){return String(r.ts)===String(key);});
      var saved = JSON.parse(JSON.stringify(previewWorkspace));
      saved.ts = row.ts; saved.raid.location = row.location + ' · synthetic archive';
      delete saved.history; delete saved.historyDetailIds;
      return Promise.resolve(JSON.stringify(saved));
    }
    return Promise.resolve(previewOverallDetails[key] ? JSON.stringify(previewOverallDetails[key]) : null);
  }
  if (channel !== 'loadImage') return Promise.resolve(null);
  if (previewImageMode === 'unavailable' || (previewImageMode === 'polish' && key !== '103001') || key === '103006') return Promise.resolve({state:'unavailable'});
  if (previewImageMode === 'pending') return Promise.resolve({state:'pending'});
  previewAttempts[key] = (previewAttempts[key] || 0) + 1;
  if (previewAttempts[key] === 1) return Promise.resolve({state:'pending'});
  var png = fixturePng(key);
  return Promise.resolve(png ? {state:'ready',data:png} : {state:'unavailable'});
}, send: function(){}, on: function(){} };
document.getElementById('preview-fixture').addEventListener('change',function(){
  previewImageMode = this.value; previewAttempts = {};
  var next = ['startup','overall','cartridges','workspace','archive'].includes(this.value) ? previewModes[this.value] : Object.assign({},previewModes[this.value],{ts:++previewGeneration});
  window.__combatLogRender(next,false);
  if (this.value === 'overall') window.__combatLogTest.showOverall();
  if (this.value === 'workspace' || this.value === 'archive') window.__combatLogTest.setReportView('combat');
});
var initialMode = new URLSearchParams(location.search).get('fixture');
if (!previewModes[initialMode]) initialMode = 'precise';
previewImageMode = initialMode; document.getElementById('preview-fixture').value = initialMode;
window.__combatLogRender(previewModes[initialMode],false);
if (initialMode === 'overall') window.__combatLogTest.showOverall();
if (initialMode === 'workspace' || initialMode === 'archive') window.__combatLogTest.setReportView('combat');
</script>`;

function verifyCompactUiMarkers(source) {
  const values = (attribute) => [...source.matchAll(new RegExp(attribute + '="([^"]+)"', "g"))]
    .map(match => match[1]);
  const sameValues = (actual, expected) => actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
  const reportViews = ["overview", "combat", "arsenal"];
  const hitViews = ["anatomy", "table"];

  if (!sameValues(values("data-report-view"), reportViews) ||
      !sameValues(values("data-view-target"), reportViews))
    throw new Error("Preview page must expose exactly the three desktop report views and their tabs");
  if (!sameValues(values("data-hit-subview"), hitViews) ||
      values("data-hit-view-target").length || /data-anatomy-mode=/.test(source))
    throw new Error("Preview page must keep Anatomy and Table together without exclusive subview or mode buttons");
  if (!sameValues(values("data-overall-target"), ["overview","weapons","locations"]) ||
      !source.includes('id="scope-raid"') || !source.includes('id="scope-overall"'))
    throw new Error("Preview page lost the visible report scopes or Overall navigation");
  if (!/data-show-all-zones\b[^>]*aria-pressed="false"[^>]*>Show all zones<\/button>/i.test(source) ||
      !/(?:var|let|const)\s+showAllZones\s*=\s*false\b/.test(source))
    throw new Error("Preview page no longer starts with zero-count anatomy zones hidden behind Show all zones");

  for (const marker of [
    '<details class="data-guide">', '<details id="advanced-filters">',
    '<details class="distance-summary" open>', 'class="weapon-more"', 'class="hit-detail"'
  ]) {
    if (!source.includes(marker))
      throw new Error("Preview page lost progressive disclosure marker: " + marker);
  }

  if ((source.match(/id="allhits"/g) || []).length !== 1)
    throw new Error("Preview page must have exactly one canonical full hit table host");
  const combatPanel = source.match(/data-report-view="combat"[\s\S]*?data-report-view="arsenal"/i)?.[0] || "";
  if (!combatPanel || !/id="allhits"/.test(combatPanel) || !/id="combat-opponents"/.test(combatPanel))
    throw new Error("Combat workspace does not contain its canonical table and opponents");
  const renderLog = source.match(/function renderLog\s*\([^)]*\)\s*\{[\s\S]*?\r?\n  \}\r?\n\r?\n  function render\s*\(/)?.[0] || "";
  if (!renderLog || /\bhitRows\s*\(/.test(renderLog) || !/data-engagement-hits/.test(renderLog))
    throw new Error("Engagements must focus the shared combat table without rendering another full hit table");
}

const server = http.createServer((req, res) => {
  if (req.url === "/records.js") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
    res.end(readFileSync("web/records.js"));
  } else if (req.url === "/mannequin.js") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
    res.end(readFileSync("web/mannequin.js"));
  } else if (req.url.split("?")[0] === "/" || req.url.split("?")[0] === "/fallback") {
    let page = readFileSync("web/combatlog.html", "utf8");
    const fallback = req.url.split("?")[0] === "/fallback" ? '<script>HTMLCanvasElement.prototype.getContext=function(){return null;};</script>' : '';
    page = page.replace('<script src="mannequin.js"></script>', fallback + '<script src="mannequin.js"></script>');
    page = page.replace('</body>', '<div style="position:fixed;bottom:0;right:14px;background:#171511;font:11px monospace;color:#d8d2c4;z-index:20;padding:4px 8px;border:1px solid #514a37">Synthetic fixture · not game capture: <select id="preview-fixture" aria-label="Test fixture"><option value="precise">Precise zones</option><option value="density">Density contrast 1 / 4 / 16</option><option value="legacy">Legacy raid</option><option value="legacydeath">Legacy death / no snapshot</option><option value="empty">Empty raid</option><option value="equipment">Equipment / ready images</option><option value="records">Raid records</option><option value="armour">Armour &amp; ricochets</option><option value="polish">Visual polish / portrait and fallbacks</option><option value="overall">Overall history</option><option value="cartridges">Shots vs pellets / mixed legacy</option><option value="pending">Equipment / pending images</option><option value="unavailable">Equipment / image failure</option></select><span id="preview-errors" role="status"></span></div>' + harness + '</body>');
    page = page.replace('<option value="precise">', '<option value="archive">Large archive / search and retention</option><option value="startup">Startup / before first raid</option><option value="workspace">Desktop workspace / varied exchanges</option><option value="precise">');
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(page);
  } else { res.writeHead(404); res.end(); }
});
if (process.argv.includes("--verify")) {
  if (archivePayload.history.length !== 400 || archivePayload.historyDetailIds.length !== 50 ||
      archivePayload.historyDetailIds.some(id => !archivePayload.history.some(row => row.ts === id)))
    throw new Error('Large archive fixture lost its retention contract');
  verifyCompactUiMarkers(readFileSync("web/combatlog.html", "utf8"));
  new vm.Script(harness.slice("<script>".length, -"</script>".length), { filename: "equipment-preview.inline.js" });
  const densityCounts = densityHits.reduce((counts, hit) => ((counts[hit.collider] = (counts[hit.collider] || 0) + 1), counts), {});
  if (densityCounts.LeftForearm !== 1 || densityCounts.Jaw !== 4 || densityCounts.Eyes !== 16)
    throw new Error("Density fixture must preserve the visible 1 / 4 / 16 contrast ladder");
  const outgoing = equipmentPayload.engagements.flatMap(e => e.hits).filter(h => h.dealt);
  const sum = (list, key) => list.reduce((total, item) => total + item[key], 0);
  if (sum(equipmentPayload.weapons, "hits") !== outgoing.length || sum(equipmentPayload.weapons, "damage") !== sum(outgoing, "after") ||
      sum(equipmentPayload.weapons, "shotsHit") !== equipmentPayload.shotsHit || sum(equipmentPayload.weapons, "fired") !== equipmentPayload.shotsFired)
    throw new Error("Equipment fixture weapon totals disagree with its contact stream or raid totals");
  for (const ammo of equipmentPayload.loadout) {
    if (outgoing.filter(h => h.ammoId === ammo.id).length !== ammo.hits)
      throw new Error("Equipment fixture ammunition row disagrees with its contacts: " + ammo.id);
  }
  console.log("COMBATLOG EQUIPMENT PREVIEW VERIFIED");
  if (total(polishPayload.weapons, 'hits') !== polishDealt.length ||
      total(polishPayload.weapons, 'damage') !== polishPayload.damageDealt ||
      total(polishPayload.weapons, 'shotsHit') !== polishPayload.shotsHit ||
      total(polishPayload.weapons, 'fired') !== polishPayload.shotsFired ||
      total(polishPayload.loadout, 'fired') !== polishPayload.shotsFired)
    throw new Error('Polish fixture weapon/ammunition totals disagree with the raid');
  const exchange = polishPayload.engagements[0];
  if (exchange.kills !== 1 || exchange.killLinks !== 1 || polishPayload.kills !== 2 ||
      polishTaken.filter(h => h.fatal && !h.fatalInferred).length !== 1 || !polishHits.some(h => !h.fatal))
    throw new Error('Polish fixture must exercise distinct confirmed, linked, incoming-fatal and ordinary contacts');
  for (const ammo of polishPayload.loadout) {
    if (polishDealt.filter(h => h.ammoId === ammo.id).length !== ammo.hits)
      throw new Error('Polish fixture ammunition contacts disagree: ' + ammo.id);
  }
  if (overallPayload.history.length !== 12 || overallPayload.history.filter(row => row.location === 'Factory').length !== 7 ||
      Object.hasOwn(overallPayload.history[11], 'shotsFired'))
    throw new Error('Overall fixture must cover multiple outcomes and locations plus one partial legacy summary');
  for (const key of ['cartridgesFired','cartridgesHit','shotsHit']) {
    if (total(cartridgePayload.weapons,key) !== cartridgePayload[key] || total(cartridgePayload.loadout,key) !== cartridgePayload[key])
      throw new Error('Cartridge fixture weapon/ammunition counters disagree with its raid: '+key);
  }
  if (total(cartridgePayload.weapons,'fired') !== cartridgePayload.shotsFired ||
      total(cartridgePayload.loadout,'cost') !== cartridgePayload.ammoCost ||
      total(cartridgeHits,'after') !== cartridgePayload.damageDealt || cartridgeHits.length !== cartridgePayload.hitsDealt ||
      cartridgePayload.weapons[0].fired !== cartridgePayload.weapons[0].cartridgesFired * 8 ||
      cartridgePayload.weapons[0].cartridgesHit !== 6 || cartridgePayload.weapons[0].shotsHit !== 18)
    throw new Error('Cartridge fixture no longer proves distinct shell/pellet accounting and ammunition spend');
  for (const row of [cartridgeLegacy,...cartridgeLegacy.weapons,...cartridgeLegacy.loadout]) {
    if (['cartridgesFired','cartridgesHit','costBasis'].some(key=>Object.hasOwn(row,key)))
      throw new Error('Legacy AA-12 fixture acquired invented cartridge counters or corrected costs');
  }
  if (cartridgeLegacy.shotsFired !== 734 || cartridgePayload.history[1].weapons !== cartridgeLegacy.weapons ||
      !overallDetails['901'] || !harness.includes('cartridges: previewCartridges'))
    throw new Error('Mixed cartridge preview lost its old projectile-only archive or navigation');
  console.log('COMBATLOG CARTRIDGE PREVIEW VERIFIED');
  if (workspaceHits.length < 40 || new Set(workspaceHits.map(h=>h.opponentId)).size !== 7 ||
      workspacePayload.engagements.length !== 7 || new Set(workspaceHits.map(h=>h.part)).size < 5 ||
      !workspaceDealt.some(h=>h.fatalInferred) || !workspaceHits.some(h=>h.blocked) || !workspaceHits.some(h=>h.deflected))
    throw new Error('Desktop fixture lost its varied exchanges, regions or distinct combat outcomes');
  if (workspaceOpponents.filter(o=>o[1]==='Dmitri Volkov').length !== 2 ||
      workspacePayload.weapons.filter(w=>w.name==='M4A1').length !== 2 ||
      !workspacePayload.weapons.some(w=>w.cartridgesFired>0&&w.hits===0))
    throw new Error('Desktop fixture no longer exercises same-name identities or miss-only weapon activity');
  for (const key of ['cartridgesFired','cartridgesHit','shotsHit']) {
    if (total(workspacePayload.weapons,key)!==workspacePayload[key] || total(workspacePayload.loadout,key)!==workspacePayload[key])
      throw new Error('Desktop fixture cartridge/weapon/ammunition totals disagree: '+key);
  }
  if (total(workspacePayload.weapons,'fired')!==workspacePayload.shotsFired ||
      total(workspacePayload.weapons,'damage')!==workspacePayload.damageDealt ||
      total(workspacePayload.loadout,'cost')!==workspacePayload.ammoCost ||
      workspaceHits.at(-1).dealt || !workspaceHits.at(-1).fatal || workspaceHits.at(-1).after!==workspacePayload.death.damage ||
      workspacePayload.death.damageFromKiller!==total(workspaceKillerHits,'after') ||
      workspacePayload.history.at(-1).weapons!==cartridgeLegacy.weapons ||
      workspacePayload.history.slice(1).some(row=>overallDetails[String(row.ts)]?.ts!==row.ts) ||
      !harness.includes('workspace: previewWorkspace'))
    throw new Error('Desktop fixture lost conserved damage/cost, final death evidence or mixed legacy history');
  console.log('COMBATLOG DESKTOP WORKSPACE PREVIEW VERIFIED');
  console.log('COMBATLOG VISUAL PREVIEW VERIFIED');
  console.log('COMBATLOG PREVIEW FIXTURES VERIFIED');
} else {
  const portArgument = process.argv.indexOf('--port');
  const port = portArgument < 0 ? 8765 : Number(process.argv[portArgument + 1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local fixture port');
  server.listen(port, "127.0.0.1", () => console.log('CombatLog local fixture: http://127.0.0.1:' + port));
}
