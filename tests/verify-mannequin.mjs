import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const source = fs.readFileSync(fileURLToPath(new URL("../web/mannequin.js", import.meta.url)), "utf8");
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "mannequin.js" });
const mannequin = sandbox.CombatMannequin;
const densityLevel = mannequin._test.densityLevel;
const densityColor = mannequin._test.densityColor;
const lowDensity = densityLevel(1, 1, 16);
const midDensity = densityLevel(4, 1, 16);
const highDensity = densityLevel(16, 1, 16);
assert.ok(lowDensity > 0 && lowDensity < midDensity && midDensity < highDensity,
  "density scale is not strictly monotonic across 1/4/16 hits");
assert.ok(highDensity - lowDensity >= .75, "density scale still compresses low and high hit counts");
assert.ok(densityLevel(1, 1, 2) > lowDensity, "density is not relative to the current maximum");
assert.equal(densityLevel(2, 1, 2), 1);
assert.equal(densityLevel(5, 5, 5), .62, "equal positive counts lack a stable visible level");
assert.ok(highDensity - densityLevel(15, 1, 16) < .06,
  "near-equal high counts are misleadingly stretched across the palette");
for (const invalid of [0, -1, NaN, Infinity]) assert.equal(densityLevel(invalid, 1, 16), 0);
function luminance(color) { return color[0] * .2126 + color[1] * .7152 + color[2] * .0722; }
for (const direction of ["dealt", "taken"]) {
  const low = Array.from(densityColor(direction, lowDensity));
  const mid = Array.from(densityColor(direction, midDensity));
  const high = Array.from(densityColor(direction, highDensity));
  assert.ok(luminance(low) < luminance(mid) && luminance(mid) < luminance(high),
    `${direction} density palette does not grow in luminance`);
}
const expectedPrecise = [
  "RibcageUp", "Pelvis", "LeftUpperArm", "LeftForearm", "RightUpperArm", "RightForearm",
  "LeftThigh", "LeftCalf", "RightThigh", "RightCalf", "ParietalHead", "BackHead", "Ears", "Eyes",
  "Jaw", "NeckFront", "NeckBack", "RightSideChestUp", "LeftSideChestUp", "SpineTop", "SpineDown",
  "PelvisBack", "RightSideChestDown", "LeftSideChestDown", "RibcageLow"
];
assert.deepEqual(Array.from(mannequin.zones.filter(z => z.precise), z => z.id).sort(), expectedPrecise.slice().sort());
assert.equal(new Set(mannequin.zones.map(z => z.id)).size, mannequin.zones.length);
assert.ok(Object.isFrozen(mannequin.zones));
for (const id of expectedPrecise) {
  const zone = mannequin.classify({ collider: id });
  assert.equal(zone.id, id);
  assert.equal(zone.precise, true);
  assert.ok(zone.part);
}
for (const collider of [undefined, null, "", "None", "FutureCollider", "15", 15, "constructor", "__proto__", "Eyes<script>"]) {
  const zone = mannequin.classify({ part: "Head", collider });
  assert.equal(zone.id, "part:head");
  assert.equal(zone.precise, false);
}
assert.equal(mannequin.classify({ collider: "FutureCollider", part: "Head" }).collider, "FutureCollider");
assert.equal(mannequin.classify({ collider: "HeadCommon" }).id, "part:head");
assert.equal(mannequin.classify({ collider: "HeadCommon", part: "Head" }).precise, false);
assert.equal(mannequin.classify({ collider: "NeckBack" }).part, "chest");
assert.equal(mannequin.classify({ collider: "NeckFront" }).part, "chest");
assert.equal(mannequin.classify({ collider: "Eyes", part: "Chest" }).part, "chest", "captured health-pool identity is retained");
assert.equal(mannequin.classify({ collider: "None", part: "LeftArm" }).id, "part:left arm");
assert.equal(mannequin.classify({ collider: "None", part: "THORAX" }).id, "part:chest");
assert.equal(mannequin.classify({ collider: "BackHead" }).label, "Nape");
assert.equal(mannequin.classify({ collider: "Jaw" }).label, "Jaws");
assert.equal(mannequin.classify({ collider: "None", part: "unknown" }).id, "unknown");
assert.equal(mannequin.classify(null).id, "unknown");

const mesh = mannequin._test.buildMesh();
assert.ok(mesh.faces.length > 1000 && mesh.faces.length < 10000, "an actual bounded 3D triangle model exists");
assert.ok(mesh.boundaries.length > 10 && mesh.boundaries.length < mesh.faces.length);
for (const id of expectedPrecise) assert.ok(mesh.faces.some(f => f.zone === id), `mesh has ${id}`);
for (const face of mesh.faces) {
  assert.ok(expectedPrecise.includes(face.zone));
  assert.ok(Math.abs(Math.hypot(...face.normal) - 1) < 1e-8);
  assert.ok(Math.abs(Math.hypot(...face.shadingNormal) - 1) < 1e-8, 'finite unit lighting normal');
  for (const point of face.vertices) {
    assert.equal(point.length, 3);
    assert.ok(point.every(Number.isFinite));
    assert.ok(Math.abs(point[0]) < .4 && point[1] >= 0 && point[1] < 1.9 && Math.abs(point[2]) < .2);
  }
  if (face.zone.startsWith("Left")) assert.ok(face.center[0] > 0, `${face.zone} anatomical left`);
  if (face.zone.startsWith("Right")) assert.ok(face.center[0] < 0, `${face.zone} anatomical right`);
}
assert.ok(mesh.faces.some(f => f.center[2] < -.09) && mesh.faces.some(f => f.center[2] > .1), "genuine front/back depth");
function assertSmoothCheeks(faces) {
  for (const sign of [-1, 1]) {
    const points = faces.flatMap(face => face.vertices).filter(([x, y, z]) =>
      x * sign >= .025 && x * sign <= .09 && y >= 1.62 && y <= 1.66 && z > 0);
    assert.ok(points.length > 0, "both cheek surfaces exist");
    const headEnvelope = points.map(([x, y, z]) =>
      (x / .111) ** 2 + ((y - 1.679) / .151) ** 2 + ((z - .006) / .111) ** 2);
    assert.ok(headEnvelope.every(value => value <= 1 + 1e-8), "cheek relief outside head surface");
    assert.ok(faces.some(face => face.surface === "head" && face.vertices.some(([x, y, z]) =>
      x * sign >= .025 && x * sign <= .09 && y >= 1.62 && y <= 1.66 && z > 0)),
    "both cheeks belong to the continuous head surface");
  }
}
assertSmoothCheeks(mesh.faces);
for (const sign of [-1, 1]) {
  const raisedCheek = { vertices: [[2, 0], [3, 0], [2, 1]].map(([row, col]) => {
    const phi = row / 5 * Math.PI, angle = col / 10 * Math.PI * 2;
    return [sign * (.046 + .034 * Math.sin(angle) * Math.sin(phi)),
      1.636 + .023 * Math.cos(phi), .096 + .019 * Math.cos(angle) * Math.sin(phi)];
  }) };
  assert.throws(() => assertSmoothCheeks([...mesh.faces, raisedCheek]), /cheek relief outside head surface/);
}
function assertConnectedSurface(faces, surface) {
  const selected = faces.filter(face => face.surface === surface);
  assert.ok(selected.length > 0, `${surface} surface exists`);
  const key = p => p.map(n => n.toFixed(7)).join(',');
  const neighbours = new Map();
  for (const face of selected) {
    const keys = face.vertices.map(key);
    for (const a of keys) {
      if (!neighbours.has(a)) neighbours.set(a, new Set());
      for (const b of keys) neighbours.get(a).add(b);
    }
  }
  const visited = new Set(), queue = [neighbours.keys().next().value];
  while (queue.length) {
    const current = queue.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of neighbours.get(current)) if (!visited.has(next)) queue.push(next);
  }
  assert.equal(visited.size, neighbours.size, `${surface} has no disconnected joint pieces`);
}
for (const surface of ['head', 'LeftArm', 'RightArm', 'LeftLeg', 'RightLeg'])
  assertConnectedSurface(mesh.faces, surface);
const lowerBody = mesh.faces.filter(f => ['trunk', 'LeftLeg', 'RightLeg'].includes(f.surface));
assertConnectedSurface(lowerBody.map(f => ({ ...f, surface: 'joined pelvis' })), 'joined pelvis');
function assertJoinedPelvis(faces) {
  const edgeOwners = new Map();
  for (const face of faces) for (let i = 0; i < 3; i++) {
    const p = face.vertices[i], q = face.vertices[(i + 1) % 3];
    const key = [p, q].map(v => v.map(n => n.toFixed(7)).join(',')).sort().join('/');
    const edge = edgeOwners.get(key) || { count: 0, y: Math.min(p[1], q[1]) };
    edge.count++; edgeOwners.set(key, edge);
  }
  for (const edge of edgeOwners.values())
    assert.ok(edge.count === 2 || (edge.count === 1 && edge.y >= 1.64),
      'trunk and legs form a closed surface below the neck opening');
}
assertJoinedPelvis(lowerBody);
assert.throws(() => assertJoinedPelvis(lowerBody.filter((f, i) => i !== lowerBody.length - 1)), /closed surface/);
assert.throws(() => assertConnectedSurface([...mesh.faces, {
  surface: 'head', vertices: [[.3, 1.7, .1], [.31, 1.7, .1], [.3, 1.71, .1]]
}], 'head'), /disconnected joint pieces/);
const headPoints = mesh.faces.filter(f => f.surface === 'head').flatMap(f => f.vertices);
const bodyPoints = mesh.faces.flatMap(f => f.vertices);
const headHeight = Math.max(...headPoints.map(p => p[1])) - Math.min(...headPoints.map(p => p[1]));
const bodyHeight = Math.max(...bodyPoints.map(p => p[1])) - Math.min(...bodyPoints.map(p => p[1]));
assert.ok(bodyHeight / headHeight > 7 && bodyHeight / headHeight < 8, 'adult head-to-body proportion');
function widthAt(surface, y) {
  const points = mesh.faces.filter(f => f.surface === surface).flatMap(f => f.vertices).filter(p => Math.abs(p[1] - y) < .001);
  assert.ok(points.length, `profile ring exists at ${surface} ${y}`);
  return Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0]));
}
for (const side of ['Left', 'Right']) {
  assert.ok(widthAt(side + 'Arm', 1.17) > .06, 'elbow connects upper and lower arm');
  assert.ok(widthAt(side + 'Arm', .940) < widthAt(side + 'Arm', 1.075) * .7, 'forearm tapers into wrist');
  assert.ok(widthAt(side + 'Leg', .565) > .075, 'continuous knee');
  assert.ok(widthAt(side + 'Leg', .184) < widthAt(side + 'Leg', .452) * .6, 'calf tapers into ankle');
}
const dims = [350, 400];
const front = { ...mannequin._test.freshCamera(), yaw: 0, pitch: 0 };
const back = { ...front, yaw: Math.PI };
const frontFaces = mannequin._test.projectScene(front, ...dims);
const backFaces = mannequin._test.projectScene(back, ...dims);
function at(camera, point) { return mannequin._test.projection(point, camera, ...dims); }
function pickPoint(camera, projected, point) { const p = at(camera, point); return mannequin._test.pick(projected, p.x, p.y); }
assert.equal(pickPoint(front, frontFaces, [0, 1.691, .13]), "Eyes");
assert.equal(pickPoint(front, frontFaces, [0, 1.598, .10]), "Jaw");
for (const yaw of [-.5, 0, .5]) {
  const camera = { ...front, yaw, pitch: .1, target: 1.62, zoom: 4, focus: "head" };
  const projected = mannequin._test.projectScene(camera, ...dims);
  for (const sign of [-1, 1]) {
    const cheek = mesh.faces.filter(face => face.surface === 'head' && face.zone === 'Jaw' && face.center[2] > 0)
      .sort((a, b) => Math.hypot(a.center[0] - sign * .046, a.center[1] - 1.636) -
        Math.hypot(b.center[0] - sign * .046, b.center[1] - 1.636))[0];
    assert.equal(pickPoint(camera, projected, cheek.center), "Jaw",
      "the smooth cheeks remain selectable as Jaw after rotation and head zoom");
  }
}
assert.equal(pickPoint(back, backFaces, [0, 1.67, -.11]), "BackHead");
assert.equal(pickPoint(front, frontFaces, [0, 1.501, .065]), "NeckFront");
assert.equal(pickPoint(back, backFaces, [0, 1.501, -.065]), "NeckBack");
assert.equal(pickPoint(front, frontFaces, [.1, .75, .09]), "LeftThigh");
assert.equal(pickPoint(front, frontFaces, [-.1, .75, .09]), "RightThigh");
assert.ok(at(front, [.2, .94, 0]).x > at(front, [-.2, .94, 0]).x, "front anatomical left is viewer-right");
assert.ok(at(back, [.2, .94, 0]).x < at(back, [-.2, .94, 0]).x, "back anatomical left is viewer-left");
assert.equal(mannequin._test.pick(frontFaces, 0, 0), null);
assert.equal(mannequin._test.pick([], 175, 200), null);
assert.notDeepEqual(frontFaces.map(f => f.index), backFaces.map(f => f.index));
const selectableZones = new Set();
for (const yaw of [0, -.65, .65, -Math.PI / 2, Math.PI / 2, Math.PI]) {
  const scene = mannequin._test.projectScene({ ...front, yaw }, ...dims);
  for (const face of scene) {
    if (selectableZones.has(face.zone)) continue;
    const x = face.points.reduce((sum, p) => sum + p.x, 0) / 3;
    const y = face.points.reduce((sum, p) => sum + p.y, 0) / 3;
    if (mannequin._test.pick(scene, x, y) === face.zone) selectableZones.add(face.zone);
  }
}
assert.deepEqual([...selectableZones].sort(), expectedPrecise.slice().sort(),
  'every precise zone has a visible pickable surface, including sides and rear');
assert.throws(() => assert.ok(mesh.faces.filter(f => f.zone !== "Eyes").some(f => f.zone === "Eyes")));

function events(target = {}) {
  const handlers = new Map();
  return Object.assign(target, {
    addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); },
    removeEventListener(type, fn) { handlers.get(type)?.delete(fn); },
    emit(type, event = {}) {
      event.preventDefault ||= () => { event.prevented = true; };
      for (const handler of [...(handlers.get(type) || [])]) handler(event);
      return event;
    },
    listeners() { return [...handlers.values()].reduce((sum, set) => sum + set.size, 0); }
  });
}
function fixture() {
  const frames = new Map();
  let frameId = 0, disconnected = false;
  const paints = [], fillStyles = [], dashPatterns = [];
  const context = {
    setTransform() {}, fillRect() { paints.push(1); }, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    fill() { fillStyles.push(this.fillStyle); }, stroke() {}, ellipse() {}, fillText() {},
    setLineDash(value) { dashPatterns.push(Array.from(value)); },
    createRadialGradient() { return { addColorStop() {} }; }
  };
  const host = events({ devicePixelRatio: 3,
    requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
    ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() {} disconnect() { disconnected = true; } }
  });
  const doc = events({ defaultView: host, hidden: false });
  const box = { left: 7, top: 11, width: 350, height: 400 };
  const captures = new Set(), attributes = new Map([["aria-label", "Original schematic viewer"]]);
  const canvas = events({ ownerDocument: doc, style: { touchAction: "auto", cursor: "crosshair" },
    getContext(type) { assert.equal(type, "2d"); return context; }, getBoundingClientRect() { return box; },
    setAttribute(key, value) { attributes.set(key, value); }, getAttribute(key) { return attributes.get(key) ?? null; }, removeAttribute(key) { attributes.delete(key); },
    setPointerCapture(id) { captures.add(id); }, hasPointerCapture(id) { return captures.has(id); }, releasePointerCapture(id) { captures.delete(id); },
    focus() {}
  });
  function flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); }
  return { host, doc, canvas, box, frames, paints, fillStyles, dashPatterns, captures, flush,
    get disconnected() { return disconnected; } };
}
const f = fixture(), selected = [], hovered = [];
const viewer = mannequin.create(f.canvas, { onSelect: id => selected.push(id), onHover: id => hovered.push(id) });
assert.ok(viewer);
assert.equal(f.frames.size, 1, "one initial paint");
f.flush();
assert.equal(f.frames.size, 0, "no idle animation");
assert.equal(f.canvas.width, 700, "DPR capped at two");
assert.equal(f.canvas.height, 800);
assert.ok(viewer._test.state().faceCount > 100);
assert.match(f.canvas.getAttribute("aria-label"), /FRONT, BODY/);
const renderedDensity = fixture();
const renderedViewer = mannequin.create(renderedDensity.canvas);
renderedDensity.flush();
function rgbLuminance(value) {
  const match = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(value);
  assert.ok(match, `expected rendered RGB colour, got ${value}`);
  return luminance(match.slice(1).map(Number));
}
for (const direction of ["dealt", "taken"]) {
  renderedViewer.update({ counts: { Eyes: 1, Jaw: 16 }, direction });
  renderedDensity.flush();
  const state = renderedViewer._test.state();
  const faces = mannequin._test.projectScene(state.camera, renderedDensity.box.width, renderedDensity.box.height);
  const fills = renderedDensity.fillStyles.slice(-state.faceCount);
  function average(zone) {
    const values = fills.flatMap((fill, index) => faces[index].zone === zone ? [rgbLuminance(fill)] : []);
    assert.ok(values.length > 0, `${zone} has no rendered surface in the density test`);
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  assert.ok(average("Jaw") > average("Eyes") + 15,
    `${direction} surface lighting obscures the low/high density ordering`);
}
renderedViewer.destroy();
const originalCamera = viewer._test.state().camera;
viewer.update({ counts: { Eyes: 4 }, active: "Eyes", direction: "taken" });
viewer.update({ counts: { Eyes: 7 } });
assert.equal(f.frames.size, 1, "data bursts coalesce into one paint");
assert.deepEqual(viewer._test.state().camera, originalCamera, "data updates preserve view");
f.flush();
viewer.update({ counts: { Eyes: 7 } });
assert.equal(f.frames.size, 0, "unchanged normalized data does not repaint");
const beforeHighlightCamera = viewer._test.state().camera;
const beforeHighlightCallbacks = hovered.length;
viewer.update({ counts: { Eyes: 1, Jaw: 16 }, selected: "Jaw", direction: "dealt" });
f.flush();
const dashCount = f.dashPatterns.length;
viewer.highlight("Eyes");
assert.equal(viewer._test.state().externalHighlight, "Eyes");
assert.equal(viewer._test.state().selected, "Jaw", "external highlight replaced the selected zone");
assert.deepEqual(viewer._test.state().camera, beforeHighlightCamera, "external highlight moved the camera");
assert.equal(hovered.length, beforeHighlightCallbacks, "external highlight leaked into canvas hover callbacks");
assert.equal(f.frames.size, 1, "external highlight did not schedule a repaint");
viewer.highlight("Eyes");
assert.equal(f.frames.size, 1, "repeated external highlight queued duplicate paints");
f.flush();
viewer.highlight("part:head");
f.flush();
assert.equal(viewer._test.state().externalHighlight, "part:head");
assert.ok(f.dashPatterns.slice(dashCount).some(pattern => pattern.join() === "4,4"),
  "coarse external highlight did not draw the broad dashed body-region outline");
viewer.highlight("not-a-zone");
assert.equal(viewer._test.state().externalHighlight, null, "invalid highlight did not clear safely");
assert.equal(viewer._test.state().selected, "Jaw", "clearing hover also cleared selection");
f.flush();
viewer.highlight("");
assert.equal(f.frames.size, 0, "repeated cleared highlight queued a paint");
const coloured = f.fillStyles.slice(-viewer._test.state().faceCount);
viewer.update({ counts: { "part:head": 7 } });
f.flush();
const coarse = f.fillStyles.slice(-viewer._test.state().faceCount);
assert.notDeepEqual(coloured, coarse, "coarse hits do not inherit exact colour fills");
assert.ok(f.dashPatterns.some(pattern => pattern.join() === "4,4"), "coarse health pool is a dashed outline");
viewer.update({ counts: {} }); f.flush();
const neutral = f.fillStyles.slice(-viewer._test.state().faceCount);
assert.deepEqual(coarse, neutral, "coarse data never paints a fabricated precise zone");
viewer.view("back"); viewer.view("head");
f.flush();
assert.match(f.canvas.getAttribute("aria-label"), /BACK, HEAD \/ NECK/);
assert.equal(viewer._test.state().camera.yaw, Math.PI);
assert.equal(viewer._test.state().camera.focus, "head");
const headZoom = viewer._test.state().camera.zoom;
viewer.view("front");
assert.equal(viewer._test.state().camera.zoom, headZoom, "orientation presets preserve focus");
assert.equal(viewer._test.state().camera.focus, "head");
viewer.view("left"); assert.equal(viewer._test.state().camera.yaw, -Math.PI / 2);
viewer.view("right"); assert.equal(viewer._test.state().camera.yaw, Math.PI / 2);
viewer.view("bogus"); assert.equal(viewer._test.state().camera.yaw, Math.PI / 2);
viewer.rotate(NaN, Infinity); assert.ok(Number.isFinite(viewer._test.state().camera.yaw));
viewer.zoom(Infinity); assert.ok(Number.isFinite(viewer._test.state().camera.zoom));
viewer.rotate(0, 100); assert.equal(viewer._test.state().camera.pitch, .65);
viewer.rotate(0, -100); assert.equal(viewer._test.state().camera.pitch, -.65);
viewer.zoom(100); assert.ok(viewer._test.state().camera.zoom <= 6);
viewer.zoom(-100); assert.ok(viewer._test.state().camera.zoom >= 2);
viewer.view("body"); viewer.view("front"); f.flush();
function eventAt(point, extra = {}) { const p = at(front, point); return { pointerId: 4, button: 0, clientX: p.x + f.box.left, clientY: p.y + f.box.top, ...extra }; }
f.canvas.emit("pointermove", eventAt([0, 1.691, .13]));
assert.equal(hovered.at(-1), "Eyes");
f.canvas.emit("pointerdown", eventAt([0, 1.691, .13]));
assert.equal(f.captures.size, 1);
f.canvas.emit("pointerup", eventAt([0, 1.691, .13]));
assert.equal(selected.at(-1), "Eyes");
assert.equal(f.captures.size, 0);
const selections = selected.length;
f.canvas.emit("pointerdown", eventAt([0, 1.691, .13]));
f.canvas.emit("pointermove", eventAt([0, 1.691, .13], { clientX: 245, clientY: 140 }));
f.canvas.emit("pointerup", eventAt([0, 1.691, .13], { clientX: 245, clientY: 140 }));
assert.equal(selected.length, selections, "drag never selects the release patch");
assert.notEqual(viewer._test.state().camera.yaw, 0);
f.canvas.emit("pointerdown", eventAt([0, 1.691, .13]));
f.canvas.emit("pointercancel", { pointerId: 4 });
assert.equal(f.captures.size, 0);
assert.equal(selected.length, selections);
const oldZoom = viewer._test.state().camera.zoom;
const normalWheel = f.canvas.emit("wheel", { deltaY: -40 });
assert.ok(!normalWheel.prevented);
assert.equal(viewer._test.state().camera.zoom, oldZoom, "page-scroll wheel does not steal focus");
const zoomWheel = f.canvas.emit("wheel", { deltaY: -40, shiftKey: true });
assert.equal(zoomWheel.prevented, true);
assert.ok(viewer._test.state().camera.zoom > oldZoom);
const beforeKey = viewer._test.state().camera.yaw;
const arrow = f.canvas.emit("keydown", { key: "ArrowLeft" });
assert.equal(arrow.prevented, true);
assert.notEqual(viewer._test.state().camera.yaw, beforeKey);
assert.ok(!f.canvas.emit("keydown", { key: "x" }).prevented);
f.canvas.emit("keydown", { key: "Home" });
assert.equal(viewer._test.state().camera.yaw, 0);
assert.equal(viewer._test.state().camera.focus, "body");
assert.equal(viewer._test.state().camera.zoom, 1);
f.flush();
f.box.width = 500; f.host.emit("resize"); f.flush();
assert.equal(f.canvas.width, 1000);
assert.equal(f.frames.size, 0);
f.canvas.emit("contextlost");
viewer.update({ counts: { Jaw: 9 } });
assert.equal(f.frames.size, 0, "lost rendering context has no paint queue");
assert.equal(viewer._test.pick(175, 200), null, "lost context has no visible picking target");
f.canvas.emit("contextrestored");
assert.equal(f.frames.size, 1, "context restoration requests one repaint");
f.flush();
assert.ok(viewer._test.state().faceCount > 100);
f.doc.hidden = true; f.doc.emit("visibilitychange");
viewer.update({ active: "BackHead", counts: { Eyes: NaN, Jaw: Infinity, None: 7, Eyes2: 7, "__proto__": 10 } });
assert.equal(f.frames.size, 0, "hidden document has no paint queue");
f.doc.hidden = false; f.doc.emit("visibilitychange");
assert.equal(f.frames.size, 1);
f.flush();
f.box.width = 0; f.box.height = 0; f.host.emit("resize"); f.flush();
assert.equal(viewer._test.pick(175, 200), null, "hidden zero-size canvas cannot pick stale geometry");
f.box.width = 350; f.box.height = 400; f.host.emit("resize"); f.flush();
assert.equal(f.canvas.width, 700);
viewer.rotate(.2, 0);
assert.equal(f.frames.size, 1);
viewer.destroy();
assert.equal(f.frames.size, 0, "destroy cancels pending work");
assert.equal(f.canvas.listeners() + f.host.listeners() + f.doc.listeners(), 0);
assert.equal(f.disconnected, true);
assert.equal(f.canvas.style.touchAction, "auto");
assert.equal(f.canvas.style.cursor, "crosshair");
assert.equal(f.canvas.getAttribute("aria-label"), "Original schematic viewer");
viewer.update({ counts: { Eyes: 99 } }); viewer.highlight("Eyes"); viewer.rotate(1, 1); viewer.zoom(1); viewer.view("head"); viewer.destroy();
assert.equal(f.frames.size, 0);
assert.equal(viewer._test.pick(175, 200), null);
assert.equal(mannequin.create(null), null);
assert.equal(mannequin.create({ getContext: () => null }), null);
assert.equal(mannequin.create({ getContext() { throw new Error("unavailable"); } }), null);
const bench = fixture(), performanceViewer = mannequin.create(bench.canvas);
bench.flush();
const began = performance.now();
for (let i = 0; i < 12; i++) { performanceViewer.rotate(.17, 0); bench.flush(); }
const elapsed = performance.now() - began;
performanceViewer.destroy();
assert.ok(elapsed < 2000, "bounded paint work must not freeze the UI");
console.log(`COMBATLOG MANNEQUIN VERIFIED (${mesh.faces.length} triangles, ${expectedPrecise.length} exact zones, ${Math.round(elapsed / 12)}ms mock paint)`);
