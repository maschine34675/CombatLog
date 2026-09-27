import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (p) => readFileSync(path.join(root, p), "utf8");

const failures = [];
function check(label, condition, detail) {
  if (!condition) failures.push(label + (detail ? " — " + detail : ""));
}

const patch = read("Patches/CombatLogTaskBarButtonPatch.cs");
const plugin = read("Plugin.cs");
const panel = read("UI/CombatLogPanel.cs");
const csproj = read("CombatLog.csproj");
const className = /internal class (\w+) : ModulePatch/.exec(patch)?.[1];
check("patch class is mod-prefixed", className?.startsWith("CombatLog"), "got " + className);
const inPatch = /IconResource = "([^"]+)"/.exec(patch)?.[1];
const inCsproj = /<LogicalName>(CombatLog\.task-bar-icon\.png)<\/LogicalName>/.exec(csproj)?.[1];
check("icon resource name matches csproj", inPatch && inPatch === inCsproj,
  `patch=${inPatch} csproj=${inCsproj}`);
check("icon is included as an embedded resource",
  /<EmbeddedResource Include="assets\\task-bar-icon\.png">/.test(csproj));
for (const asm of ["UnityEngine.UI", "UnityEngine.UIModule", "UnityEngine.AnimationModule",
                   "UnityEngine.TextRenderingModule", "Unity.TextMeshPro"]) {
  check("csproj references " + asm, csproj.includes(`<Reference Include="${asm}">`));
}
check("plugin exposes Instance", /internal static Plugin Instance/.test(plugin));
check("plugin assigns Instance in Awake", /Instance = this;/.test(plugin));
check("plugin always exposes the sole menu entry", /internal bool ShowTaskBarButton => true;/.test(plugin));
check("plugin exposes RunDelayed", /internal void RunDelayed\(float seconds, Action action\)/.test(plugin));
check("plugin enables the patch", /new Patches\.CombatLogTaskBarButtonPatch\(\)\.Enable\(\)/.test(plugin));
check("enabling the patch handles installation failure",
  /try\s*\{\s*new Patches\.CombatLogTaskBarButtonPatch\(\)\.Enable\(\);\s*\}\s*catch/.test(plugin));
check("patch calls OpenFromTaskBar", /plugin\.OpenFromTaskBar\(\)/.test(patch));
check("plugin routes to the panel", /_panel\.ToggleFromMenu\(\)/.test(plugin));
check("panel exposes ToggleFromMenu", /internal void ToggleFromMenu\(\)/.test(panel));
check("click null-guards a reloaded plugin", /Plugin plugin = Plugin\.Instance;\s*if \(plugin != null\)/.test(patch));
check("postfix swallows its own failure", /catch \(Exception ex\)[\s\S]{0,200}could not be added/.test(patch));
const icon = path.join(root, "assets", "task-bar-icon.png");
check("icon exists", existsSync(icon));
if (existsSync(icon)) {
  const png = readFileSync(icon);
  check("icon is a PNG", png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const colourType = png[25];
  check("icon is 64x64", width === 64 && height === 64, `${width}x${height}`);
  check("icon carries alpha", colourType === 6, "colour type " + colourType);
  check("icon generator is kept with it", existsSync(path.join(root, "tools", "build-icon.py")));
  const gen = read("tools/build-icon.py");
  check("icon uses the bar's gold", /GOLD = \(194, 174, 110, 255\)/.test(gen));
  check("icon is a hexagon like the family's", /def draw_hexagon_outline/.test(gen));
}

if (failures.length) {
  for (const f of failures) console.error("FAIL " + f);
  process.exit(1);
}
console.log("COMBATLOG MENU BUTTON VERIFIED");
