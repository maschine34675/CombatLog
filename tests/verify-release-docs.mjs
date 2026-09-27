import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const paths = ["README.md", "CHANGELOG.md", "docs/forge/teaser.txt",
  "docs/forge/description.md", "THIRD-PARTY-NOTICES.md", "LICENSE"];
const read = path => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const docs = Object.fromEntries(paths.map(path => [path, read(path)]));
const source = Object.fromEntries([
  "Plugin.cs", "CombatLog.csproj", "UI/WebOverlayGate.cs", "Analytics/RaidHistory.cs",
  "PostRaidScreens/PostRaidScreensFeature.cs", "web/mannequin.js", "web/combatlog.html"
].map(path => [path, read(path)]));
const version = source["Plugin.cs"].match(/PluginVersion = "([^"]+)"/)?.[1];
const assemblyVersion = source["CombatLog.csproj"].match(/<AssemblyVersion>([^<]+)</)?.[1];
const minimum = source["UI/WebOverlayGate.cs"].match(/MinimumVersionText = "([^"]+)"/)?.[1];
const guid = source["Plugin.cs"].match(/PluginGuid = "([^"]+)"/)?.[1];
const historyLimit = source["Analytics/RaidHistory.cs"].match(/MaxStoredRaids = (\d+)/)?.[1];
const definitions = source["web/mannequin.js"].match(/var definitions = \[([\s\S]*?)\n  \];/)?.[1];
const zoneCount = [...(definitions || "").matchAll(/\["[^"]+", "[^"]+", "[^"]+"\]/g)].length;

assert.ok(version && minimum && guid && historyLimit && zoneCount,
  "Unable to extract public requirements from current source");
assert.equal(version, assemblyVersion, "Plugin and assembly versions disagree");

const headings = ["Features", "Requirements and compatibility", "Installation", "Updating",
  "Usage", "Configuration", "Known limitations", "Support", "License and credits"];

function failures(candidate) {
  const result = [];
  const check = (condition, label) => { if (!condition) result.push(label); };
  for (const path of paths) check(typeof candidate[path] === "string" && candidate[path].trim(), `missing: ${path}`);
  const readme = candidate["README.md"] || "";
  const changelog = candidate["CHANGELOG.md"] || "";
  const forge = candidate["docs/forge/description.md"] || "";
  const notices = candidate["THIRD-PARTY-NOTICES.md"] || "";
  const teaser = (candidate["docs/forge/teaser.txt"] || "").trim();
  check(teaser.length > 0 && [...teaser].length <= 100 && !/[\r\n]/.test(teaser) && !/^[#*-]|^v?\d+\./.test(teaser),
    "teaser: one plain-text benefit of at most 100 characters");
  const actualHeadings = [...readme.matchAll(/^## (.+)$/gm)].map(match => match[1]);
  check(JSON.stringify(actualHeadings) === JSON.stringify(headings), "README: canonical headings and order");
  check(readme.startsWith("# CombatLog\n"), "README: product title");

  const changelogSections = [...changelog.matchAll(/^## (.+)$/gm)].map(match => match[1]);
  check(changelog.startsWith("# Changelog\n") && changelogSections[0] === "[Unreleased]" &&
    changelogSections.filter(heading => heading === "[Unreleased]").length === 1,
    "changelog: one leading Unreleased section");
  check(changelogSections.filter(heading => heading === `[${version}]`).length === 1,
    "changelog: exact unique current-version section");
  check(changelogSections.every(heading => heading === "[Unreleased]" || /^\[\d+\.\d+\.\d+(?:\+[\w.-]+)?\]$/.test(heading)),
    "changelog: version-only headings");
  check(/^## \[Unreleased\]\s*(?=## )/m.test(changelog), "changelog: empty Unreleased");
  const current = changelog.split(`## [${version}]\n`)[1]?.split(/^## /m)[0] || "";
  check(current.trimStart().startsWith("### Forge version notes\n") &&
    [...current.matchAll(/^### Forge version notes$/gm)].length === 1,
    "changelog: first subsection is unique Forge version notes");
  const notes = current.match(/^### Forge version notes\n([\s\S]*?)(?=^### |(?![\s\S]))/m)?.[1] || "";
  check(notes.trim().length > 0 && /^- /m.test(notes), "changelog: nonempty player-facing version notes");
  check(/^### Added$/m.test(current), "changelog: durable detailed record");

  for (const [name, text] of [["README", readme], ["Forge", forge]]) {
    check(text.includes(`Anvil-WebOverlay ${minimum} or newer`), `${name}: dependency matches source`);
    check(text.includes(`BepInEx/plugins/maschine-CombatLog.dll`) &&
      text.includes(`BepInEx/plugins/CombatLog/`), `${name}: flat plugin and separate documentation paths`);
    check(text.includes(`BepInEx/config/${guid}.cfg`), `${name}: config path matches plugin identity`);
    check(text.includes('COMBAT LOG') && text.includes('There is no opening hotkey.') && text.includes('Escape') &&
      !/\bF8\b/.test(text), `${name}: menu-only access matches source`);
    check(text.includes(`newest ${historyLimit} detailed`) &&
      (text.includes("older summaries") || text.includes("raid summaries remain")),
      `${name}: detail retention and retained summaries`);
    check(/installation-wide/.test(text) && /not (?:a particular SPT profile|per profile)/.test(text),
      `${name}: history is not profile-separated`);
    check(text.includes(`${zoneCount} detailed`) && /schematic/.test(text) && /not actual impact points|does not show actual impact points/.test(text),
      `${name}: body-zone count and schematic limit`);
    check(text.includes("Fika is incompatible") && !/Fika (?:is )?(?:compatible|supported)/i.test(text),
      `${name}: explicit Fika incompatibility`);
    check(/client-only/.test(text) && /solo SPT 4\.1\.6/.test(text) &&
      /Solo features have been tested on SPT 4\.1\.6\./.test(text) && /Other SPT versions are not verified\./.test(text),
      `${name}: compatibility target distinguished from verified range`);
    check(!/exact packaged build|final in-game check|every build has been fully tested/i.test(text),
      `${name}: no internal package status or blanket gameplay claims`);
    check(text.includes("https://github.com/maschine34675/WebOverlay/releases"), `${name}: public dependency download`);
    check(/automatically scrolls it into view/.test(text), `${name}: timeline selection reveals its event`);
    check(/Windows/.test(text) && /Microsoft WebView2 Runtime/.test(text) && /borderless windowed/.test(text) &&
      /[Ee]xclusive fullscreen/.test(text), `${name}: operating system and display requirements`);
    check(/(?:cannot be opened|unavailable) during an active raid/.test(text), `${name}: post-raid-only access`);
    check(/one shotgun shell counts once|One shotgun shell counts as one shot/.test(text) &&
      /projectile\s*\/\s*pellet/i.test(text) && /handbook base prices/.test(text),
      `${name}: cartridge, projectile and cost meanings`);
    check(/Unidentified non-scav/.test(text) && /ammunition hidden/.test(text),
      `${name}: kill-list identification limit`);
    check(text.includes("KillAndDamageInfo") && /[Rr]emove/.test(text), `${name}: predecessor removal`);
    check(/LogOutput\.log/.test(text) && /versions/.test(text) && /expected and actual behavior/.test(text) &&
      /reproduction steps/.test(text) && /[Ii]nspect/.test(text) && /credentials/.test(text),
      `${name}: support evidence and privacy`);
  }
  for (const [name, text] of Object.entries(candidate)) {
    check(!/(?:[A-Z]:[\\/](?:Users|SPT|SPT41)|\.unlazy\b|CLAUDE\.md|AGENTS\.md|CODE-REVIEW|Co-authored-by|\bCodex\b|\bTODO\b|\bFIXME\b|fixture=|127\.0\.0\.1|localhost|github\.com\/[^\s)]+-dev\b)/i.test(text),
      `${name}: no internal or private residue`);
    check(!/\b(?:kompatibel|Treffererfassung|Veröffentlichung|Änderungen|Einstellungen)\b/.test(text),
      `${name}: no known non-English prose residue`);
    check(!/compatible with every mod|zero performance impact|completely safe/i.test(text),
      `${name}: no unsupported universal claims`);
  }
  check(notices.includes("Barlow Condensed") && notices.includes("JetBrains Mono") &&
    notices.includes("No font files") && notices.includes("not redistributed") &&
    notices.includes("No Escape from Tarkov") && notices.includes("does not relicense"),
    "notices: dependency, font and game-asset boundaries");
  check((candidate.LICENSE || "").startsWith("MIT License\n") &&
    (candidate.LICENSE || "").includes("Copyright (c) 2026 maschine"), "license: MIT attribution present");
  const configNames = [...source["PostRaidScreens/PostRaidScreensFeature.cs"].matchAll(/config\.Bind\(Section, "([^"]+)", true,/g)].map(match => match[1]);
  check(configNames.length > 0 && configNames.every(name => readme.includes(`| ${name} | Enabled |`)),
    "README: all native-screen switches and defaults");
  check(!source["Plugin.cs"].includes('new KeyboardShortcut') && !readme.includes('| Toggle combat log |') &&
    !readme.includes('| Menu bar button |') && readme.includes('Legacy hotkey and menu-button settings are ignored.'),
    "README: obsolete general settings removed");
  check(source["web/combatlog.html"].includes("fonts.googleapis.com") && notices.includes("fonts.googleapis.com"),
    "notices: actual external font request disclosed");
  return result;
}

assert.deepEqual(failures(docs), [], "Release-document checks failed");
const negativeControls = [
  ["missing README", "README.md", "", "missing: README.md"],
  ["oversized teaser", "docs/forge/teaser.txt", "x".repeat(101), "teaser:"],
  ["Markdown teaser", "docs/forge/teaser.txt", "# Great report", "teaser:"],
  ["wrong dependency", "README.md", docs["README.md"].replaceAll(`Anvil-WebOverlay ${minimum}`, "Anvil-WebOverlay 0.0.1"), "README: dependency"],
  ["wrong version", "CHANGELOG.md", docs["CHANGELOG.md"].replace(`## [${version}]`, "## [99.99.99]"), "changelog: exact"],
  ["dated version", "CHANGELOG.md", docs["CHANGELOG.md"].replace(`## [${version}]`, `## [${version}] - 2026-01-01`), "changelog: version-only"],
  ["empty Forge notes", "CHANGELOG.md", docs["CHANGELOG.md"].replace(/(### Forge version notes\n)[\s\S]*?(?=### Added)/, "$1\n"), "changelog: nonempty"],
  ["duplicate Forge notes", "CHANGELOG.md", docs["CHANGELOG.md"] + "\n### Forge version notes\n\n- Duplicate.\n", "changelog: first subsection"],
  ["unshipped entries", "CHANGELOG.md", docs["CHANGELOG.md"].replace("## [Unreleased]\n", "## [Unreleased]\n\n- Pending work.\n"), "changelog: empty"],
  ["private link", "README.md", docs["README.md"] + "\nhttps://github.com/example/CombatLog-dev\n", "README.md: no internal"],
  ["Fika overclaim", "docs/forge/description.md", docs["docs/forge/description.md"].replace("Fika is incompatible", "Fika is compatible"), "Forge: explicit Fika"],
  ["unearned gameplay claim", "README.md", docs["README.md"].replace("Solo features have been tested on SPT 4.1.6.", "Every build has been fully tested."), "README: compatibility target"],
  ["internal package status", "README.md", docs["README.md"] + "\nThe exact packaged build awaits its final in-game check.\n", "README: no internal package status"],
  ["unsupported SPT range", "docs/forge/description.md", docs["docs/forge/description.md"].replace("Other SPT versions are not verified.", "All SPT versions are supported."), "Forge: compatibility target"],
  ["missing dependency link", "README.md", docs["README.md"].replace("https://github.com/maschine34675/WebOverlay/releases", "#download"), "README: public dependency download"],
  ["missing event navigation", "README.md", docs["README.md"].replace("automatically scrolls it into view", "leaves the list in place"), "README: timeline selection"],
  ["wrong history limit", "README.md", docs["README.md"].replace(`newest ${historyLimit} detailed`, "newest 5000 detailed"), "README: detail retention"],
  ["obsolete hotkey", "README.md", docs["README.md"] + '\nPress F8 to open.\n', "README: menu-only access"],
  ["missing notices", "THIRD-PARTY-NOTICES.md", "", "notices: dependency"],
  ["missing identification rule", "README.md", docs["README.md"].replace("Unidentified non-scav victims keep their ammunition hidden.", "All victims reveal ammunition."), "README: kill-list identification"],
];
for (const [label, path, replacement, expected] of negativeControls) {
  assert.ok(failures({ ...docs, [path]: replacement }).some(failure => failure.startsWith(expected)),
    `Negative control was not rejected for the intended reason: ${label}`);
}
console.log(`Verified ${paths.length} public files and ${negativeControls.length} negative controls; mod ${version}, WebOverlay >= ${minimum}, ${historyLimit} detailed raids, ${zoneCount} precise zones.`);
console.log("COMBATLOG RELEASE DOCUMENTS VERIFIED");
