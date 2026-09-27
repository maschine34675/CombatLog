/* CombatLog anatomical viewer. Procedural schematic surfaces, NOT a game model,
   hit position, bullet path or replica of EFT collider geometry. No dependencies. */
(function (root) {
  "use strict";

  var definitions = [
    ["ParietalHead", "Top of head", "head"], ["BackHead", "Nape", "head"],
    ["Ears", "Ears", "head"], ["Eyes", "Eyes", "head"], ["Jaw", "Jaws", "head"],
    ["NeckFront", "Throat", "chest"], ["NeckBack", "Back of neck", "chest"],
    ["RibcageUp", "Thorax", "chest"],
    ["LeftSideChestUp", "Left armpit", "chest"], ["RightSideChestUp", "Right armpit", "chest"],
    ["SpineTop", "Upper back", "chest"], ["RibcageLow", "Abdomen", "stomach"],
    ["LeftSideChestDown", "Left side", "stomach"], ["RightSideChestDown", "Right side", "stomach"],
    ["SpineDown", "Lower back", "stomach"], ["Pelvis", "Groin", "stomach"],
    ["PelvisBack", "Buttocks", "stomach"],
    ["LeftUpperArm", "Left shoulder / upper arm", "left arm"], ["LeftForearm", "Left forearm", "left arm"],
    ["RightUpperArm", "Right shoulder / upper arm", "right arm"], ["RightForearm", "Right forearm", "right arm"],
    ["LeftThigh", "Left thigh", "left leg"], ["LeftCalf", "Left calf", "left leg"],
    ["RightThigh", "Right thigh", "right leg"], ["RightCalf", "Right calf", "right leg"]
  ];
  var partNames = ["head", "chest", "stomach", "left arm", "right arm", "left leg", "right leg"];
  var byId = Object.create(null);
  var zones = definitions.map(function (d) {
    return Object.freeze({ id: d[0], label: d[1], part: d[2], precise: true });
  });
  partNames.forEach(function (part) {
    zones.push(Object.freeze({ id: "part:" + part,
      label: part.charAt(0).toUpperCase() + part.slice(1) + " · unspecified", part: part, precise: false }));
  });
  zones.push(Object.freeze({ id: "unknown", label: "Unknown body zone", part: "", precise: false }));
  zones.forEach(function (zone) { byId[zone.id] = zone; });
  Object.freeze(zones);

  function canonicalPart(part) {
    if (typeof part !== "string") return "";
    var key = part.trim().replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    if (key === "thorax") key = "chest";
    return partNames.indexOf(key) >= 0 ? key : "";
  }
  function classify(hit) {
    hit = hit || {};
    var collider = typeof hit.collider === "string" ? hit.collider.trim() : "";
    var zone = byId[collider];
    var part = canonicalPart(hit.part);
    if (zone && zone.precise) {
      return { id: zone.id, label: zone.label, part: part || zone.part, precise: true, collider: collider };
    }
    if (collider === "HeadCommon") part = "head";
    zone = byId[part ? "part:" + part : "unknown"];
    return { id: zone.id, label: zone.label, part: zone.part, precise: false, collider: collider };
  }

  var TAU = Math.PI * 2;
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function finite(v, fallback) { return typeof v === "number" && isFinite(v) ? v : fallback; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function mul(a, b) { return [a[0] * b, a[1] * b, a[2] * b]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function unit(a) { var length = Math.sqrt(dot(a, a)); return length > 1e-10 ? mul(a, 1 / length) : [0, 0, 0]; }
  function centroid(vertices) { return mul(add(add(vertices[0], vertices[1]), vertices[2]), 1 / 3); }

  function buildMesh() {
    var faces = [];
    function triangle(a, b, c, zone, outward, tone) {
      var normal = unit(cross(sub(b, a), sub(c, a)));
      if (dot(normal, normal) < .5) return;
      if (dot(normal, outward) < 0) { var swap = b; b = c; c = swap; normal = mul(normal, -1); }
      faces.push({ vertices: [a, b, c], center: centroid([a, b, c]), normal: normal,
        zone: zone, part: byId[zone].part, tone: tone || 1 });
    }
    function ellipsoid(center, radii, zoneAt, lat, lon, axis, tone) {
      var up = axis ? unit(axis) : [0, 1, 0];
      var side = unit(cross(up, [0, 0, 1]));
      var forward = unit(cross(side, up));
      function localPoint(v) { return add(center, add(add(mul(side, v[0] * radii[0]), mul(up, v[1] * radii[1])), mul(forward, v[2] * radii[2]))); }
      var rings = [];
      for (var j = 0; j <= lat; j++) {
        var phi = j / lat * Math.PI;
        var ring = [];
        for (var i = 0; i <= lon; i++) {
          var angle = i / lon * TAU;
          var v = [Math.sin(angle) * Math.sin(phi), Math.cos(phi), Math.cos(angle) * Math.sin(phi)];
          ring.push({ local: v, world: localPoint(v) });
        }
        rings.push(ring);
      }
      function cell(a, b, c) {
        var mid = centroid([a.local, b.local, c.local]);
        var zone = typeof zoneAt === "function" ? zoneAt(mid) : zoneAt;
        triangle(a.world, b.world, c.world, zone, sub(localPoint(mid), center), tone);
      }
      for (var row = 0; row < lat; row++) for (var col = 0; col < lon; col++) {
        cell(rings[row][col], rings[row + 1][col], rings[row + 1][col + 1]);
        cell(rings[row][col], rings[row + 1][col + 1], rings[row][col + 1]);
      }
    }
    function loft(profile, sectors, zoneAt, deform, subdivisions, toneAt) {
      var rings = [], centres = [];
      function sample(row, t) {
        return profile[row].map(function (value, axis) {
          var next = profile[row + 1][axis];
          var before = profile[Math.max(0, row - 1)][axis];
          var after = profile[Math.min(profile.length - 1, row + 2)][axis];
          var t2 = t * t, t3 = t2 * t;
          var result = (2 * t3 - 3 * t2 + 1) * value + (t3 - 2 * t2 + t) * (next - before) * .5 +
            (-2 * t3 + 3 * t2) * next + (t3 - t2) * (after - value) * .5;
          return clamp(result, Math.min(value, next), Math.max(value, next));
        });
      }
      function ring(r) {
        var points = [];
        for (var k = 0; k < sectors; k++) {
          var theta = k / sectors * TAU, cosine = Math.cos(theta);
          var p = [r[1] + Math.sin(theta) * r[3], r[0], r[2] + cosine * (cosine >= 0 ? r[4] : r[5])];
          points.push(deform ? deform(p, theta, r) : p);
        }
        points.push(points[0]); rings.push(points); centres.push([r[1], r[0], r[2]]);
      }
      for (var row = 0; row < profile.length - 1; row++) {
        for (var step = 0; step < subdivisions; step++) ring(sample(row, step / subdivisions));
      }
      ring(profile[profile.length - 1]);
      for (var band = 0; band < rings.length - 1; band++) for (var sector = 0; sector < sectors; sector++) {
        var centre = mul(add(centres[band], centres[band + 1]), .5);
        var quadMid = mul(add(add(rings[band][sector], rings[band + 1][sector]),
          add(rings[band + 1][sector + 1], rings[band][sector + 1])), .25);
        var zone = typeof zoneAt === "function" ? zoneAt(quadMid, (sector + .5) / sectors * TAU) : zoneAt;
        [[rings[band][sector], rings[band + 1][sector], rings[band + 1][sector + 1]],
          [rings[band][sector], rings[band + 1][sector + 1], rings[band][sector + 1]]].forEach(function (v) {
          var mid = centroid(v);
          triangle(v[0], v[1], v[2], zone, sub(mid, centre), toneAt ? toneAt(mid) : 1);
        });
      }
      return rings;
    }
    function bump(value, centre, width) { return Math.exp(-Math.pow((value - centre) / width, 2)); }
    var torsoProfile = [
      [1.645, 0, -.014, .054, .055, .057], [1.585, 0, -.016, .050, .058, .057],
      [1.530, 0, -.008, .050, .058, .057], [1.490, 0, -.004, .070, .063, .062],
      [1.470, 0, -.004, .113, .070, .072],
      [1.450, 0, -.004, .159, .078, .080], [1.408, 0, -.004, .194, .102, .096],
      [1.350, 0, 0, .192, .115, .105], [1.285, 0, 0, .177, .112, .099],
      [1.220, 0, -.003, .157, .099, .088], [1.155, 0, -.006, .142, .092, .078],
      [1.090, 0, -.003, .151, .098, .087], [1.030, 0, -.006, .162, .105, .110],
      [1.010, 0, -.008, .161, .104, .112]
    ];
    function torsoZone(point, theta) {
      var y = point[1], angle = Math.atan2(Math.sin(theta), Math.cos(theta));
      if (y >= 1.49) return point[2] >= -.01 ? "NeckFront" : "NeckBack";
      if (y < 1.01) return point[2] >= 0 ? "Pelvis" : "PelvisBack";
      if (Math.abs(angle) > 2.23) return y >= 1.22 ? "SpineTop" : "SpineDown";
      if (Math.abs(angle) > 1.01) return (point[0] > 0 ? "Left" : "Right") + (y >= 1.22 ? "SideChestUp" : "SideChestDown");
      return y >= 1.22 ? "RibcageUp" : "RibcageLow";
    }
    var torso = loft(torsoProfile, 24, torsoZone, function (p, theta) {
      var front = Math.max(0, Math.cos(theta)), rear = Math.max(0, -Math.cos(theta));
      p[2] += front * (.012 * bump(Math.abs(p[0]), .089, .060) * bump(p[1], 1.355, .062) -
        .005 * bump(p[0], 0, .022) * bump(p[1], 1.32, .11));
      p[2] += rear * .006 * bump(p[0], 0, .023) * bump(p[1], 1.27, .20);
      return p;
    }, 2);
    faces.forEach(function (face) { face.surface = "trunk"; });
    var headStart = faces.length;
    loft([
      [1.835, 0, -.005, 0, 0, 0], [1.823, 0, -.005, .037, .043, .043],
      [1.795, 0, -.008, .073, .077, .081], [1.760, 0, -.010, .090, .097, .102],
      [1.723, 0, -.009, .095, .108, .105], [1.707, 0, -.007, .093, .105, .103],
      [1.697, 0, -.006, .091, .105, .100], [1.689, 0, -.005, .090, .104, .098],
      [1.669, 0, -.003, .088, .102, .090], [1.642, 0, 0, .080, .093, .077],
      [1.630, 0, .003, .074, .088, .065], [1.618, 0, .005, .067, .083, .055], [1.599, 0, .019, .041, .071, .040],
      [1.588, 0, .046, .020, .034, .022], [1.585, 0, .055, 0, 0, 0]
    ], 36, function (p, theta) {
      if (p[1] > 1.73) return "ParietalHead";
      if (Math.cos(theta) < -.24) return "BackHead";
      if (Math.abs(Math.sin(theta)) > .94 && p[1] > 1.653) return "Ears";
      return p[1] > 1.666 ? "Eyes" : "Jaw";
    }, function (p, theta, r) {
      var front = Math.max(0, Math.cos(theta));
      if (front > 0) {
        p[2] = r[2] + r[4] * Math.pow(front, .65);
        p[2] += front * (.041 * bump(p[0], 0, .015) * bump(p[1], 1.674, .031) -
          .010 * bump(Math.abs(p[0]), .038, .022) * bump(p[1], 1.699, .011) -
          .004 * bump(p[0], 0, .032) * bump(p[1], 1.630, .004));
      }
      return p;
    }, 2, function (p) {
      if (p[2] > .065) return 1 - .30 * bump(Math.abs(p[0]), .038, .020) * bump(p[1], 1.699, .005) -
        .24 * bump(p[0], 0, .031) * bump(p[1], 1.630, .003);
      return 1;
    });
    faces.slice(headStart).forEach(function (face) { face.surface = "head"; });
    [-1, 1].forEach(function (sign) {
      var prefix = sign > 0 ? "Left" : "Right";
      ellipsoid([sign * .096, 1.682, -.013], [.016, .031, .019], "Ears", 8, 12);
      function mirrored(rows) { return rows.map(function (r) { var copy = r.slice(); copy[1] *= sign; return copy; }); }
      var armStart = faces.length;
      loft(mirrored([
        [1.457, .188, 0, 0, 0, 0], [1.433, .205, 0, .047, .054, .055],
        [1.390, .221, 0, .063, .070, .066], [1.335, .235, .002, .059, .062, .060],
        [1.270, .253, .006, .050, .054, .054], [1.205, .268, .008, .038, .042, .045],
        [1.170, .277, .005, .036, .036, .041], [1.128, .287, .007, .044, .044, .043],
        [1.075, .301, .017, .041, .041, .039], [1.010, .318, .025, .032, .030, .029],
        [.966, .328, .030, .023, .022, .023], [.940, .332, .031, .022, .020, .022],
        [.907, .338, .033, .034, .020, .021], [.875, .343, .034, .032, .018, .019],
        [.861, .345, .034, .028, .016, .017]
      ]), 16, function (p) { return prefix + (p[1] >= 1.17 ? "UpperArm" : "Forearm"); }, null, 2);
      faces.slice(armStart).forEach(function (face) { face.surface = prefix + "Arm"; });
      [-.023, -.008, .007, .022].forEach(function (offset, finger) {
        var length = [.050, .067, .063, .048][finger];
        loft(mirrored([[.884, .343 + offset, .033, .009, .016, .014],
          [.849, .349 + offset, .038, .008, .012, .011],
          [.872 - length, .352 + offset, .043, .006, .008, .008],
          [.866 - length, .352 + offset, .043, 0, 0, 0]]), 8, prefix + "Forearm", null, 1);
      });
      loft(mirrored([[.924, .312, .035, 0, 0, 0], [.907, .306, .044, .013, .014, .014],
        [.877, .294, .055, .010, .011, .011], [.858, .291, .061, 0, 0, 0]]),
      10, prefix + "Forearm", null, 2);
      var legStart = faces.length;
      var leg = loft(mirrored([
        [.955, .080, -.008, .079, .097, .103],
        [.890, .094, -.002, .084, .097, .095], [.793, .100, .005, .074, .084, .081],
        [.691, .105, .010, .060, .065, .062], [.602, .110, .014, .047, .053, .048],
        [.565, .112, .017, .045, .047, .043], [.520, .114, .002, .048, .045, .061],
        [.452, .115, -.013, .058, .052, .071], [.369, .116, -.015, .051, .045, .062],
        [.273, .118, -.005, .037, .033, .041], [.184, .119, 0, .027, .028, .030],
        [.133, .119, .005, .029, .041, .037], [.096, .119, .034, .040, .072, .061],
        [.065, .120, .063, .046, .105, .081], [.029, .120, .062, .046, .106, .079],
        [.019, .120, .060, .033, .093, .067], [.018, .120, .060, 0, 0, 0]
      ]), 24, function (p) { return prefix + (p[1] >= .565 ? "Thigh" : "Calf"); }, null, 2);
      faces.slice(legStart).forEach(function (face) { face.surface = prefix + "Leg"; });
      var waist = torso[torso.length - 1], rootRing = leg[0];
      function hipQuad(a, b, c, d, outward) {
        var zone = (a[2] + b[2] + c[2] + d[2]) / 4 >= -.008 ? "Pelvis" : "PelvisBack";
        var start = faces.length;
        triangle(a, b, c, zone, outward); triangle(a, c, d, zone, outward);
        faces.slice(start).forEach(function (face) { face.surface = "trunk"; });
      }
      for (var hip = 0; hip < 12; hip++) {
        var outer = sign > 0 ? hip : 24 - hip;
        var nextOuter = sign > 0 ? hip + 1 : 23 - hip;
        var angle = (hip + .5) / 24 * TAU;
        hipQuad(waist[outer], rootRing[outer], rootRing[nextOuter], waist[nextOuter],
          [sign * Math.sin(angle), 0, Math.cos(angle)]);
      }
      function crotchPoint(k) {
        if (k === 0 || k === 24) return waist[0];
        if (k === 12) return waist[12];
        var theta = k / 24 * TAU, cosine = Math.cos(theta);
        return [0, 1.01 - Math.abs(Math.sin(theta)) * .08, -.008 + cosine * (cosine >= 0 ? .104 : .112)];
      }
      for (var inner = 0; inner < 12; inner++) {
        var index = sign > 0 ? 12 + inner : 12 - inner;
        var next = sign > 0 ? index + 1 : index - 1;
        var theta = (index + next) / 2 / 24 * TAU;
        hipQuad(crotchPoint(index), rootRing[index], rootRing[next], crotchPoint(next),
          [-sign * .3, -1, Math.cos(theta) * .6]);
      }
    });
    var edges = Object.create(null);
    function vertexKey(v) { return v.map(function (n) { return n.toFixed(5); }).join(","); }
    faces.forEach(function (face, index) {
      for (var edge = 0; edge < 3; edge++) {
        var p = face.vertices[edge], q = face.vertices[(edge + 1) % 3];
        var pKey = vertexKey(p), qKey = vertexKey(q);
        var key = pKey < qKey ? pKey + "/" + qKey : qKey + "/" + pKey;
        if (!edges[key]) edges[key] = { a: p, b: q, faces: [] };
        edges[key].faces.push(index);
      }
    });
    var boundaries = Object.keys(edges).map(function (key) { return edges[key]; }).filter(function (edge) {
      return edge.faces.length === 1 || edge.faces.some(function (i) { return faces[i].zone !== faces[edge.faces[0]].zone; });
    });
    var normalSums = Object.create(null);
    faces.forEach(function (face) {
      face.vertices.forEach(function (p) {
        var key = vertexKey(p);
        normalSums[key] = add(normalSums[key] || [0, 0, 0], face.normal);
      });
    });
    faces.forEach(function (face) {
      face.shadingNormal = unit(face.vertices.reduce(function (sum, p) {
        return add(sum, unit(normalSums[vertexKey(p)]));
      }, [0, 0, 0]));
    });
    return { faces: faces, boundaries: boundaries };
  }

  var mesh = buildMesh();
  function projector(camera, width, height) {
    var cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw), cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
    var scale = Math.min(width * 1.04, height * .485) * camera.zoom * 4.8;
    function transform(point, isNormal) {
      var x = point[0], y = point[1] - (isNormal ? 0 : camera.target), z = point[2];
      var x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
      return [x1, y * cp - z1 * sp, y * sp + z1 * cp];
    }
    return { transform: transform, project: function (point) {
      var v = transform(point, false), zoomed = scale / (4.8 - v[2]);
      return { x: width * .5 + v[0] * zoomed, y: height * .5 - v[1] * zoomed, z: v[2] };
    } };
  }
  function projection(point, camera, width, height) {
    return projector(camera, width, height).project(point);
  }
  function projectScene(camera, width, height) {
    var light = unit([-.6, .75, 1]), project = projector(camera, width, height);
    var vertexCache = new Map();
    function vertex(point) {
      if (!vertexCache.has(point)) vertexCache.set(point, project.project(point));
      return vertexCache.get(point);
    }
    return mesh.faces.map(function (face, index) {
      var normal = project.transform(face.normal, true);
      var shadingNormal = project.transform(face.shadingNormal, true);
      var center = project.transform(face.center, false);
      if (dot(normal, [-center[0], -center[1], 4.8 - center[2]]) <= 0) return null;
      var points = face.vertices.map(vertex);
      var area = (points[1].x - points[0].x) * (points[2].y - points[0].y) - (points[2].x - points[0].x) * (points[1].y - points[0].y);
      if (Math.abs(area) < .002) return null;
      return { points: points, minX: Math.min(points[0].x, points[1].x, points[2].x), maxX: Math.max(points[0].x, points[1].x, points[2].x),
        minY: Math.min(points[0].y, points[1].y, points[2].y), maxY: Math.max(points[0].y, points[1].y, points[2].y),
        zone: face.zone, part: face.part, depth: center[2], index: index,
        light: .36 + Math.max(0, dot(shadingNormal, light)) * .59, tone: face.tone };
    }).filter(Boolean).sort(function (a, b) { return a.depth - b.depth; });
  }
  function contains(point, points) {
    function side(a, b) { return (point.x - b.x) * (a.y - b.y) - (a.x - b.x) * (point.y - b.y); }
    var a = side(points[0], points[1]), b = side(points[1], points[2]), c = side(points[2], points[0]);
    return !((a < -.001 || b < -.001 || c < -.001) && (a > .001 || b > .001 || c > .001));
  }
  function pick(projected, x, y) {
    for (var i = projected.length - 1; i >= 0; i--) {
      var face = projected[i];
      if (x < face.minX || x > face.maxX || y < face.minY || y > face.maxY) continue;
      if (contains({ x: x, y: y }, face.points)) return face.zone;
    }
    return null;
  }
  function hull(points) {
    points = points.slice().sort(function (a, b) { return a.x - b.x || a.y - b.y; });
    function turn(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }
    var lower = [], upper = [];
    points.forEach(function (p) { while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); });
    points.slice().reverse().forEach(function (p) { while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); });
    lower.pop(); upper.pop(); return lower.concat(upper);
  }
  function path(ctx, points) {
    ctx.beginPath();
    points.forEach(function (p, i) { if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
    ctx.closePath();
  }
  function rgb(color, light) { return "rgb(" + color.map(function (channel) { return Math.round(clamp(channel * light, 0, 255)); }).join(",") + ")"; }
  function blend(a, b, amount) { return a.map(function (channel, i) { return channel + (b[i] - channel) * amount; }); }
  function densityLevel(count, minPositive, max) {
    count = finite(count, 0); minPositive = finite(minPositive, 0); max = finite(max, 0);
    if (count <= 0 || max <= 0) return 0;
    if (max <= minPositive) return .62;
    var relative = clamp(count / max, 0, 1);
    return .12 + .88 * Math.pow(relative, .8);
  }
  function densityColor(direction, level) {
    level = clamp(finite(level, 0), 0, 1);
    return direction === "taken"
      ? blend([145, 80, 68], [245, 132, 108], level)
      : blend([126, 123, 110], [244, 232, 203], level);
  }
  function freshCamera() { return { yaw: -.16, pitch: .025, zoom: 1, target: .94, focus: "body" }; }

  function create(canvas, options) {
    if (!canvas || typeof canvas.getContext !== "function") return null;
    var ctx;
    try { ctx = canvas.getContext("2d", { alpha: false }); } catch (_) { return null; }
    if (!ctx) return null;
    options = options || {};
    var doc = canvas.ownerDocument || root.document;
    var host = doc && doc.defaultView || root;
    var camera = freshCamera(), projected = [], projectedEdges = [], partOutlines = Object.create(null);
    var data = { counts: Object.create(null), selected: null, active: null, direction: "all" };
    var width = 0, height = 0, dpr = 1, raf = null, destroyed = false, geometryDirty = true, contextLost = false;
    var drag = null, hover = null, externalHighlight = null, resizeObserver = null;
    var originalTouchAction = canvas.style.touchAction, originalCursor = canvas.style.cursor;
    var originalAria = canvas.getAttribute ? canvas.getAttribute("aria-label") : null, lastAria = originalAria;
    var listeners = [];
    var requestFrame = host.requestAnimationFrame ? host.requestAnimationFrame.bind(host) : function (fn) { return host.setTimeout(fn, 16); };
    var cancelFrame = host.cancelAnimationFrame ? host.cancelAnimationFrame.bind(host) : host.clearTimeout.bind(host);
    function listen(target, type, fn, settings) {
      if (!target || !target.addEventListener) return;
      target.addEventListener(type, fn, settings);
      listeners.push(function () { target.removeEventListener(type, fn, settings); });
    }
    function hidden() { return doc && doc.hidden; }
    function schedule() {
      if (destroyed || raf !== null || hidden() || contextLost) return;
      raf = requestFrame(function () { raf = null; if (!destroyed) paint(); });
    }
    function size() {
      var rect = canvas.getBoundingClientRect();
      var nextWidth = Math.max(0, finite(rect.width, 0)), nextHeight = Math.max(0, finite(rect.height, 0));
      var nextDpr = clamp(finite(host.devicePixelRatio, 1), 1, 2);
      if (width !== nextWidth || height !== nextHeight || dpr !== nextDpr) {
        width = nextWidth; height = nextHeight; dpr = nextDpr;
        canvas.width = Math.max(1, Math.round(width * dpr));
        canvas.height = Math.max(1, Math.round(height * dpr));
        geometryDirty = true;
      }
      return width > 0 && height > 0;
    }
    function ensureProjection() {
      if (!size() || contextLost) { projected = []; return false; }
      if (geometryDirty) {
        projected = projectScene(camera, width, height);
        var visible = Object.create(null), pointsByPart = Object.create(null), project = projector(camera, width, height);
        projected.forEach(function (face) {
          visible[face.index] = true;
          if (!pointsByPart[face.part]) pointsByPart[face.part] = [];
          pointsByPart[face.part].push.apply(pointsByPart[face.part], face.points);
        });
        partOutlines = Object.create(null);
        Object.keys(pointsByPart).forEach(function (part) { partOutlines[part] = hull(pointsByPart[part]); });
        projectedEdges = [];
        mesh.boundaries.forEach(function (edge) {
          var owners = edge.faces.filter(function (i) { return visible[i]; });
          if (!owners.length) return;
          var p = project.project(edge.a), q = project.project(edge.b);
          var id = pick(projected, (p.x + q.x) * .5, (p.y + q.y) * .5);
          if (owners.some(function (i) { return mesh.faces[i].zone === id; })) {
            projectedEdges.push({ a: p, b: q, zones: owners.map(function (i) { return mesh.faces[i].zone; }) });
          }
        });
        geometryDirty = false;
      }
      return true;
    }
    function paint() {
      if (hidden() || contextLost || !ensureProjection()) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#171614"; ctx.fillRect(0, 0, width, height);
      var glow = ctx.createRadialGradient(width * .5, height * .39, 5, width * .5, height * .43, height * .69);
      glow.addColorStop(0, "#282720"); glow.addColorStop(1, "#171614");
      ctx.fillStyle = glow; ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = "rgba(222,215,198,.075)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(width * .5, 18); ctx.lineTo(width * .5, height - 18); ctx.stroke();
      if (camera.focus === "body") {
        var floor = projection([0, .035, 0], camera, width, height);
        ctx.beginPath(); ctx.ellipse(floor.x, floor.y, width * .23 * camera.zoom, 9 * camera.zoom, 0, 0, TAU);
        ctx.fillStyle = "rgba(0,0,0,.2)"; ctx.fill(); ctx.stroke();
      }
      var positive = Object.keys(data.counts).filter(function (id) {
        return byId[id] && byId[id].precise && data.counts[id] > 0;
      }).map(function (id) { return data.counts[id]; });
      var minPositive = positive.length ? Math.min.apply(Math, positive) : 0;
      var max = positive.length ? Math.max.apply(Math, positive) : 0;
      var levels = Object.create(null), highlightedZone = externalHighlight || hover;
      Object.keys(data.counts).forEach(function (id) {
        if (byId[id] && byId[id].precise) levels[id] = densityLevel(data.counts[id], minPositive, max);
      });
      projected.forEach(function (face) {
        var count = data.counts[face.zone] || 0, active = data.active === face.zone, selected = data.selected === face.zone;
        var highlighted = highlightedZone === face.zone, level = levels[face.zone] || 0;
        var base = count > 0 ? densityColor(data.direction, level) : [103, 104, 93];
        if (active) base = densityColor(data.direction, 1);
        else if (selected) base = blend(base, [239, 222, 181], .32);
        else if (highlighted) base = blend(base, [239, 222, 181], .2);
        var shade = (.74 + .3 * clamp(face.light, 0, 1)) * face.tone;
        if (active || selected || highlighted) shade *= 1.08;
        ctx.fillStyle = rgb(base, shade);
        path(ctx, face.points); ctx.fill();
        ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = .8; ctx.stroke();
      });
      projectedEdges.forEach(function (edge) {
        var p = edge.a, q = edge.b;
        var edgeLevel = edge.zones.reduce(function (value, zone) { return Math.max(value, levels[zone] || 0); }, 0);
        var emphasis = edge.zones.some(function (zone) { return zone === data.active || zone === data.selected || zone === highlightedZone; });
        ctx.strokeStyle = emphasis ? "rgba(239,222,181,.86)" : "rgba(209,204,185," + (.14 + edgeLevel * .34) + ")";
        ctx.lineWidth = emphasis ? 1.25 : .5 + edgeLevel * .7;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      });
      partNames.forEach(function (part) {
        var id = "part:" + part;
        if (!(data.counts[id] > 0) && data.active !== id && data.selected !== id && highlightedZone !== id) return;
        var points = partOutlines[part];
        if (!points || points.length < 3) return;
        path(ctx, points); ctx.setLineDash([4, 4]);
        var emphasis = data.active === id || data.selected === id || highlightedZone === id;
        ctx.strokeStyle = emphasis ? "rgba(234,218,176,.92)" : "rgba(193,178,145,.5)";
        ctx.lineWidth = emphasis ? 1.8 : 1; ctx.stroke(); ctx.setLineDash([]);
      });
      drawOrientation();
    }
    function drawOrientation() {
      var left = projection([.27, camera.target, 0], camera, width, height);
      var right = projection([-.27, camera.target, 0], camera, width, height);
      var front = Math.cos(camera.yaw), side = Math.sin(camera.yaw);
      var name = Math.abs(front) > .72 ? (front > 0 ? "FRONT" : "BACK") : (side < 0 ? "LEFT SIDE" : "RIGHT SIDE");
      var aria = "Rotatable schematic human hit zones: " + name + ", " + (camera.focus === "head" ? "HEAD / NECK" : "BODY") + ". Drag or arrow keys to rotate; plus/minus to zoom.";
      if (lastAria !== aria && canvas.setAttribute) { canvas.setAttribute("aria-label", aria); lastAria = aria; }
      ctx.font = "10px ui-monospace, Consolas, monospace"; ctx.fillStyle = "#8a857a";
      ctx.textAlign = "left"; ctx.fillText(name, 15, 23);
      ctx.textAlign = "right"; ctx.fillText(camera.focus === "head" ? "HEAD / NECK" : "BODY", width - 15, 23);
      if (Math.abs(front) > .42) {
        ctx.textAlign = "center"; ctx.fillStyle = "#a29a87";
        ctx.fillText("L", clamp(left.x, 24, width - 24), height - 16);
        ctx.fillText("R", clamp(right.x, 24, width - 24), height - 16);
      }
    }
    function hoverAt(event) {
      if (!ensureProjection()) return null;
      var rect = canvas.getBoundingClientRect();
      return pick(projected, event.clientX - rect.left, event.clientY - rect.top);
    }
    function setHover(id) {
      if (hover === id) return;
      hover = id;
      canvas.style.cursor = drag ? "grabbing" : id ? "pointer" : "grab";
      if (typeof options.onHover === "function") options.onHover(id);
      schedule();
    }
    function rotate(yawDelta, pitchDelta) {
      if (destroyed) return;
      camera.yaw = (camera.yaw + finite(yawDelta, 0)) % TAU;
      camera.pitch = clamp(camera.pitch + finite(pitchDelta, 0), -.65, .65);
      geometryDirty = true; schedule();
    }
    function zoom(delta) {
      if (destroyed) return;
      camera.zoom = clamp(camera.zoom * Math.exp(clamp(finite(delta, 0), -2, 2)), camera.focus === "head" ? 2 : .7, camera.focus === "head" ? 6 : 2.6);
      geometryDirty = true; schedule();
    }
    function view(name) {
      if (destroyed) return;
      if (name === "head" || name === "body") {
        camera.focus = name; camera.target = name === "head" ? 1.62 : .94;
        camera.zoom = name === "head" ? 4 : 1;
      } else {
        var angles = { front: 0, back: Math.PI, left: -Math.PI / 2, right: Math.PI / 2 };
        if (!Object.prototype.hasOwnProperty.call(angles, name)) return;
        camera.yaw = angles[name]; camera.pitch = 0;
      }
      geometryDirty = true; setHover(null); schedule();
    }
    function releaseDrag(event, select) {
      if (!drag || event && event.pointerId !== undefined && event.pointerId !== drag.id) return;
      var ended = drag; drag = null;
      try { if (canvas.hasPointerCapture && canvas.hasPointerCapture(ended.id)) canvas.releasePointerCapture(ended.id); } catch (_) { /* Detached canvas. */ }
      canvas.style.cursor = hover ? "pointer" : "grab";
      if (select && !ended.moved && event) {
        var id = hoverAt(event);
        if (id && typeof options.onSelect === "function") options.onSelect(id);
      }
    }
    canvas.style.touchAction = "none"; canvas.style.cursor = "grab";
    listen(canvas, "pointerdown", function (event) {
      if (drag || event.button !== 0 || event.isPrimary === false) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false };
      try { if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId); } catch (_) { /* Pointer already released. */ }
      canvas.style.cursor = "grabbing";
      if (canvas.focus) canvas.focus({ preventScroll: true });
      event.preventDefault();
    });
    listen(canvas, "pointermove", function (event) {
      if (drag && event.pointerId === drag.id) {
        var dx = event.clientX - drag.x, dy = event.clientY - drag.y;
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 5) drag.moved = true;
        drag.x = event.clientX; drag.y = event.clientY;
        if (drag.moved) { rotate(dx * .01, dy * .008); setHover(null); }
        event.preventDefault();
      } else if (!drag) setHover(hoverAt(event));
    });
    listen(canvas, "pointerup", function (event) { releaseDrag(event, true); });
    listen(canvas, "pointercancel", function (event) { releaseDrag(event, false); });
    listen(canvas, "lostpointercapture", function (event) { releaseDrag(event, false); });
    listen(canvas, "pointerleave", function () { if (!drag) setHover(null); });
    listen(host, "blur", function () { releaseDrag(null, false); setHover(null); });
    listen(canvas, "wheel", function (event) {
      if (!event.ctrlKey && !event.shiftKey) return;
      event.preventDefault(); zoom(-clamp(finite(event.deltaY, 0), -240, 240) * .003);
    }, { passive: false });
    listen(canvas, "keydown", function (event) {
      if (event.altKey || event.metaKey || event.ctrlKey) return;
      var key = event.key, handled = true;
      if (key === "ArrowLeft") rotate(-Math.PI / 24, 0);
      else if (key === "ArrowRight") rotate(Math.PI / 24, 0);
      else if (key === "ArrowUp") rotate(0, -Math.PI / 30);
      else if (key === "ArrowDown") rotate(0, Math.PI / 30);
      else if (key === "+" || key === "=") zoom(.15);
      else if (key === "-") zoom(-.15);
      else if (key === "Home") { view("body"); view("front"); }
      else if (key === "Escape") setHover(null);
      else handled = false;
      if (handled) event.preventDefault();
    });
    listen(host, "resize", function () { geometryDirty = true; schedule(); });
    listen(canvas, "contextlost", function (event) {
      event.preventDefault(); contextLost = true; if (raf !== null) cancelFrame(raf); raf = null; releaseDrag(null, false);
    });
    listen(canvas, "contextrestored", function () { contextLost = false; geometryDirty = true; schedule(); });
    listen(doc, "visibilitychange", function () {
      if (hidden()) { if (raf !== null) cancelFrame(raf); raf = null; releaseDrag(null, false); }
      else schedule();
    });
    if (typeof host.ResizeObserver === "function") {
      resizeObserver = new host.ResizeObserver(function () { geometryDirty = true; schedule(); });
      resizeObserver.observe(canvas);
    }
    schedule();
    return {
      update: function (next) {
        if (destroyed) return;
        next = next || {};
        var counts = Object.create(null);
        Object.keys(next.counts || {}).forEach(function (id) {
          var value = next.counts[id];
          if (byId[id] && typeof value === "number" && isFinite(value) && value > 0) counts[id] = value;
        });
        var updated = { counts: counts, selected: byId[next.selected] ? next.selected : null,
          active: byId[next.active] ? next.active : null,
          direction: next.direction === "taken" || next.direction === "dealt" ? next.direction : "all" };
        if (updated.selected === data.selected && updated.active === data.active && updated.direction === data.direction &&
          zones.every(function (zone) { return (updated.counts[zone.id] || 0) === (data.counts[zone.id] || 0); })) return;
        data = updated;
        schedule();
      },
      highlight: function (id) {
        if (destroyed) return;
        var next = byId[id] && id !== "unknown" ? id : null;
        if (externalHighlight === next) return;
        externalHighlight = next;
        schedule();
      },
      view: view, rotate: rotate, zoom: zoom,
      destroy: function () {
        if (destroyed) return;
        destroyed = true; if (raf !== null) cancelFrame(raf); raf = null;
        releaseDrag(null, false); listeners.forEach(function (remove) { remove(); });
        if (resizeObserver) resizeObserver.disconnect();
        canvas.style.touchAction = originalTouchAction; canvas.style.cursor = originalCursor;
        if (canvas.setAttribute && originalAria !== null) canvas.setAttribute("aria-label", originalAria);
        else if (canvas.removeAttribute) canvas.removeAttribute("aria-label");
        projected = []; projectedEdges = []; partOutlines = Object.create(null); hover = null; externalHighlight = null;
      },
      _test: {
        state: function () { return { camera: Object.assign({}, camera), pending: raf !== null, destroyed: destroyed,
          hover: hover, externalHighlight: externalHighlight, selected: data.selected, active: data.active, faceCount: projected.length }; },
        pick: function (x, y) { if (destroyed || !ensureProjection()) return null; return pick(projected, x, y); }
      }
    };
  }

  root.CombatMannequin = Object.freeze({ zones: zones, classify: classify, create: create,
    _test: Object.freeze({ buildMesh: buildMesh, projectScene: projectScene, projection: projection, pick: pick,
      freshCamera: freshCamera, densityLevel: densityLevel, densityColor: densityColor }) });
})(typeof window !== "undefined" ? window : globalThis);
