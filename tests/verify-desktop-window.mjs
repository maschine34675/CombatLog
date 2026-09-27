import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../UI/CombatLogPanel.cs", import.meta.url), "utf8");
const gate = readFileSync(new URL("../UI/WebOverlayGate.cs", import.meta.url), "utf8");

function extractMethod(text, name) {
  const signature = new RegExp(`(?:private|internal)\\s+(?:static\\s+)?[\\w<>]+\\s+${name}\\s*\\(`);
  const start = text.search(signature);
  assert.notEqual(start, -1, `${name} method exists`);
  const opening = text.indexOf("{", start);
  let depth = 1, closing = opening + 1;
  for (; closing < text.length && depth; closing++) {
    if (text[closing] === "{") depth++;
    else if (text[closing] === "}") depth--;
  }
  assert.equal(depth, 0, `${name} body closes`);
  return text.slice(opening + 1, closing - 1);
}
function compileSizing(text) {
  const body = extractMethod(text, "TryGetWindowSize")
    .replace(/\/\/[^\r\n]*/g, "")
    .replace(/\bSystem\.Math\.(Min|Max)\b/g, (_, method) => `Math.${method.toLowerCase()}`)
    .replace(/\(int\)(Math\.(?:min|max)\([^()]+\))/g, "toInt32($1)")
    .replace(/\(int\)\(([^()]+)\)/g, "toInt32($1)")
    .replace(/\bint\s+/g, "let ")
    .replace(/return (true|false);/g, "return { usable: $1, width, height };");
  assert.doesNotMatch(body, /\bSystem\b|\(int\)|\bout\b/, "untranslated C# fails closed");
  const toInt32 = value => {
    assert.ok(Number.isFinite(value) && value >= -2147483648 && value <= 2147483647,
      "every C# integer conversion stays in range");
    return Math.trunc(value);
  };
  return vm.runInNewContext(`(screenWidth, screenHeight) => { let width, height; ${body} }`, { toInt32 }, { timeout: 1000 });
}

function verifySizing(size) {
  const desktopCases = [
    [1920, 1080], [2560, 1440], [3840, 2160], [7680, 4320],
    [1600, 900], [1366, 768], [1280, 720], [1024, 768],
    [3440, 1440], [5120, 1440], [1920, 1200], [1080, 1920],
    [200, 150], [201, 151], [240, 1000], [1000, 150],
    [2147483647, 2147483647], [2147483647, 1080], [1920, 2147483647],
  ];
  for (const width of [199, 200, 201, 222, 223, 267, 800, 1919, 1920, 1921, 50000])
    for (const height of [149, 150, 151, 166, 167, 480, 1079, 1080, 1081, 50000])
      desktopCases.push([width, height]);

  for (const [screenWidth, screenHeight] of desktopCases) {
    const actual = size(screenWidth, screenHeight);
    const label = `${screenWidth}x${screenHeight}`;
    if (screenWidth < 200 || screenHeight < 150) {
      assert.equal(actual.usable, false, `${label}: cannot fit native minimum`);
      assert.equal(actual.width, 0, `${label}: no invalid width sent to native API`);
      assert.equal(actual.height, 0, `${label}: no invalid height sent to native API`);
      continue;
    }
    assert.equal(actual.usable, true, `${label}: valid display accepted`);
    assert.ok(Number.isInteger(actual.width) && Number.isInteger(actual.height), `${label}: whole pixels`);
    assert.ok(actual.width >= 200 && actual.height >= 150, `${label}: respects native minimum`);
    assert.ok(actual.width <= screenWidth && actual.height <= screenHeight, `${label}: fits display`);
    if (screenWidth >= 300 && screenHeight >= 200) {
      assert.ok(actual.width <= screenWidth * 0.9 && actual.height <= screenHeight * 0.9, `${label}: leaves margin`);
      assert.ok(Math.abs(actual.width - actual.height * 16 / 9) < 2, `${label}: fits widescreen within pixel rounding`);
      assert.ok(Math.max(actual.width / screenWidth, actual.height / screenHeight) >= 0.89, `${label}: uses available desktop area`);
    }
  }

  for (const [width, height] of [[0, 0], [0, 1080], [1920, 0], [-1, 1080], [1920, -1], [-2147483648, 1080]]) {
    const result = size(width, height);
    assert.equal(result.usable, false, "unknown/negative display defers creation");
    assert.equal(result.width, 0);
    assert.equal(result.height, 0);
  }
  const target = size(1920, 1080);
  assert.ok(target.width >= 1700 && target.width <= 1730 && target.height >= 950 && target.height <= 980,
    "1080p target provides the approved generous desktop workspace");
  assert.equal(target.usable, true, "a valid display recovers immediately after unknown/negative dimensions");
  return desktopCases.length + 6;
}

function verifyIntegration(text) {
  const toggle = extractMethod(text, "Toggle");
  assert.match(toggle, /TryGetWindowSize\(Screen\.width, Screen\.height, out int windowWidth, out int windowHeight\)/,
    "creation sizes against the game client, not the desktop display mode");
  assert.match(toggle, /if \(!WebOverlayGate\.IsCreated && !hasWindowSize\)\s*\{[^}]*return;/,
    "invalid dimensions defer only initial creation; existing windows still toggle");
  const deferredCreation = toggle.match(/if \(!WebOverlayGate\.IsCreated && !hasWindowSize\)\s*\{([^}]*)\}/)[1];
  assert.doesNotMatch(deferredCreation, /(?:_failed|HasFailed)\s*=|Dispose\(|throw\b/,
    "transient display dimensions cannot latch an overlay failure");
  assert.match(toggle, /EnsureCreated\(_html, windowWidth, windowHeight,\s*OnChannelMessage/,
    "calculated dimensions reach the existing gate");
  assert.ok(toggle.indexOf("!hasWindowSize") < toggle.indexOf("EnsureCreated("), "invalid dimensions never reach initial creation");
  assert.equal((toggle.match(/EnsureCreated\(/g) || []).length, 1, "single overlay creation path");
  assert.doesNotMatch(toggle, /SetBounds|Dispose\(/, "toggling preserves user bounds and window lifetime");
  assert.doesNotMatch(text, /\bWindow(?:Width|Height)\s*=\s*(?:1100|720)\b/, "obsolete fixed default removed");
  assert.match(gate, /Width = width,\s*Height = height,/, "gate forwards native pixel dimensions unchanged");
  assert.doesNotMatch(gate, /RememberBounds\s*=\s*false/, "player's saved window bounds remain enabled");
}

const sizing = compileSizing(source);
const caseCount = verifySizing(sizing);
verifyIntegration(source);
const negativePolicies = [
  ["old fixed window", () => ({ usable: true, width: 1100, height: 720 })],
  ["unbounded 1080p target", () => ({ usable: true, width: 1728, height: 972 })],
  ["small window", () => ({ usable: true, width: 200, height: 150 })],
  ["zero-size accepted", (w, h) => w === 0 ? { usable: true, width: 0, height: 0 } : sizing(w, h)],
  ["integer overflow", (w, h) => w > 1000000 ? { usable: true, width: -1, height: 972 } : sizing(w, h)],
  ["distorted aspect", (w, h) => w === 3440 ? { usable: true, width: 3096, height: 1296 } : sizing(w, h)],
];
for (const [label, policy] of negativePolicies)
  assert.throws(() => verifySizing(policy), { name: "AssertionError" }, `negative control rejected: ${label}`);
assert.throws(() => verifyIntegration(source.replace("!WebOverlayGate.IsCreated && !hasWindowSize", "!hasWindowSize")),
  { name: "AssertionError" }, "negative control: invalid dimensions must not block existing windows");
assert.throws(() => verifyIntegration(source.replace("EnsureCreated(_html, windowWidth, windowHeight", "EnsureCreated(_html, 1100, 720")),
  { name: "AssertionError" }, "negative control: calculated size must reach native creation");
const overflowingSource = source.replace(
  "width = (int)System.Math.Min(availableWidth, availableHeight * 16.0 / 9.0);",
  "width = System.Math.Min(availableWidth, (int)(availableHeight * 16.0 / 9.0));");
assert.notEqual(overflowingSource, source, "integer overflow mutation was applied");
assert.throws(() => verifySizing(compileSizing(overflowingSource)), { name: "AssertionError" },
  "negative control: an intermediate cast before bounding would overflow C# int");

console.log(`COMBATLOG DESKTOP WINDOW VERIFIED (${caseCount} dimensions, ${negativePolicies.length + 3} negative controls; 1080p ${sizing(1920, 1080).width}x${sizing(1920, 1080).height})`);
