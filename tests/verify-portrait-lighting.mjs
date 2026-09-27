import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const source = readFileSync('Analytics/FullBodyPortraitRenderer.cs', 'utf8');
const tempBase = realpathSync(os.tmpdir());
const temporary = mkdtempSync(path.join(tempBase, 'combatlog-portrait-lighting-'));
const harness = String.raw`
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using CombatLog.Analytics;
using UnityEngine;

static class Test
{
    static int assertions;
    public static string Failure;
    public static Action Rendering;
    public static void Check(bool ok, string message) { assertions++; if (!ok) throw new Exception(message); }
    public static void Fail(string stage) { if (Failure == stage) throw new Exception("injected " + stage); }
    static Light[] Owned(FullBodyPortraitRenderer r) => r.camera_0.GetComponentsInChildren<Light>(true)
        .Where(l => l.gameObject.name.StartsWith("CombatLog portrait")).ToArray();
    public static async Task Main()
    {
        var renderer = new FullBodyPortraitRenderer();
        Check(await renderer.PrepareAsync(), "camera prepared");
        var camera = renderer.camera_0;
        var lamps = Owned(renderer);
        Check(lamps.Length == 2 && renderer.light_0.Length == 3, "two private lights; all native root/child lamps captured");
        Check(await renderer.PrepareAsync() && Owned(renderer).Length == 2, "repeated preparation does not accumulate lamps");
        Check(!camera.gameObject.activeSelf && lamps.All(l => !l.enabled), "lamps inactive between captures");
        foreach (var light in lamps)
        {
            Check(light.transform.parent == camera.transform, "light belongs to private camera");
            Check(light.type == LightType.Directional, "directional coverage has no body-height falloff");
            Check(light.color == Color.white && light.intensity > 0 && light.intensity <= 1.2f, "neutral bounded illumination");
            Check(light.shadows == LightShadows.None && light.renderMode == LightRenderMode.ForcePixel,
                "gear cannot cast black self-shadows or lose fill to vertex-light selection");
            Check(light.cullingMask == (1 << LayersMaskController.WeaponPreview), "only camera-visible preview layer is lit");
            var angle = light.transform.localRotation.Angles;
            Check(Math.Abs(angle.x) <= 30 && Math.Abs(angle.y) <= 40 && angle.z == 0, "light rays face model in camera space");
        }
        Check(lamps[0].intensity > lamps[1].intensity &&
            lamps[0].transform.localRotation.Angles.y * lamps[1].transform.localRotation.Angles.y < 0,
            "opposing frontal key/fill preserve shape");
        var nativeStates = renderer.light_0.Select(l => l.enabled).ToArray();
        var parent = new GameObject("native model owner");
        var model = new GameObject("equipped killer");
        model.transform.SetParent(parent.transform, false);
        var position = new Vector3(2, 3, 4);
        var rotation = Quaternion.Euler(new Vector3(0, 185, 0));
        var scale = new Vector3(1.1f, 1.2f, 1.3f);
        model.transform.localPosition = position;
        model.transform.localRotation = rotation;
        model.transform.localScale = scale;
        model.SetActive(false);
        var unrelated = new GameObject("unrelated inventory lamp").AddComponent<Light>();
        unrelated.enabled = true;
        var previousTarget = new RenderTexture();
        RenderTexture.active = previousTarget;
        RenderSettings.Marker = 73;
        var shader = (ShaderReplacer)renderer.ShaderReplacer;
        Rendering = () => {
            Check(model.activeSelf && camera.gameObject.activeSelf, "model and capture camera active during render");
            Check(lamps.All(l => l.enabled), "key and fill enabled during render");
            Check(renderer.light_0.All(l => !l.enabled), "native head rig disabled during capture");
            Check(RenderSettings.Marker == 0 && shader.Touched, "native shader/ambient capture scope preserved");
        };
        foreach (string failure in new[] { "", "shader", "bounds", "render", "readback", "sprite" })
        {
            Failure = failure;
            var sprite = renderer.Capture(model, new IntVec2(360, 480));
            Check((sprite != null) == (failure == ""), "capture success/failure contained: " + failure);
            Check(lamps.All(l => !l.enabled), "private lights disabled after capture: " + failure);
            Check(renderer.light_0.Select(l => l.enabled).SequenceEqual(nativeStates), "native lamp states restored: " + failure);
            Check(model.transform.parent == parent.transform && model.transform.localPosition == position &&
                model.transform.localRotation == rotation && model.transform.localScale == scale && !model.activeSelf,
                "borrowed model pose and activity restored: " + failure);
            Check(RenderSettings.Marker == 73 && !shader.Touched && unrelated.enabled, "shared state preserved: " + failure);
            Check(!camera.gameObject.activeSelf && camera.targetTexture == null && RenderTexture.active == previousTarget,
                "camera/target restored: " + failure);
            Check(RenderTexture.Taken == RenderTexture.Returned, "temporary render textures released: " + failure);
            if (sprite != null) { UnityEngine.Object.Destroy(sprite.texture); UnityEngine.Object.Destroy(sprite); }
            Check(Texture2D.Created.All(t => t.Destroyed), "owned texture released or handed to caller: " + failure);
        }
        Failure = "";
        Check(renderer.Capture(null, new IntVec2(360, 480)) == null &&
            renderer.Capture(model, new IntVec2(0, 480)) == null && lamps.All(l => !l.enabled), "invalid requests leave lights off");
        renderer.Dispose();
        Check(camera.gameObject.Destroyed && lamps.All(l => l.gameObject.Destroyed), "disposal destroys camera and owned lamps");
        Check(await renderer.PrepareAsync() && Owned(renderer).Length == 2, "disposed renderer can prepare a fresh rig");
        renderer.Dispose();
        Failure = "fill creation";
        Check(!await renderer.PrepareAsync() && renderer.camera_0 == null, "partial rig failure is contained");
        Check(GameObject.All.Where(o => o.name.StartsWith("CombatLog portrait")).All(o => o.Destroyed), "no orphan lamps after failed preparation");
        Failure = "";
        Check(await renderer.PrepareAsync() && Owned(renderer).Length == 2, "retry after partial rig failure");
        renderer.Dispose();
        Console.WriteLine("PORTRAIT HARNESS ASSERTIONS " + assertions);
    }
}

public struct IntVec2 { public int X,Y; public IntVec2(int x,int y) { X=x;Y=y; } }
public static class LayersMaskController { public static int WeaponPreview = 23; }
public class PlayerIconRequest { }
public class ItemIcon { }
public interface IShaderReplacer { void Replace(GameObject model); void Restore(); }
public class ShaderReplacer : IShaderReplacer
{
    public bool Touched;
    public void Replace(GameObject model) { Touched=true;Test.Fail("shader"); }
    public void Restore() { Touched=false; }
}
public class IconShadow { public void SetTexDimension(int w,int h) { } }
public class IconCreatorBase<TItem,TIcon>
{
    public struct IconRenderSettings
    {
        int value;
        public static IconRenderSettings Store() => new IconRenderSettings { value=RenderSettings.Marker };
        public static void Reset() { RenderSettings.Marker=0; }
        public void Restore() { RenderSettings.Marker=value; }
    }
}
namespace EFT.PlayerIcons
{
    public class Settings
    {
        public Quaternion Rotation => Quaternion.Euler(new Vector3(0,185,0));
        public float fieldOfView=30,nearClipPlane=.3f,farClipPlane=10;
        public int RenderingPath;
    }
    public class PlayerIconCreator : IconCreatorBase<PlayerIconRequest,ItemIcon>
    {
        public Camera camera_0;
        public Light[] light_0;
        public IconShadow iconShadow_0 = new IconShadow();
        public bool _isCameraLoading;
        public Settings _settings = new Settings();
        public virtual string Folder => "PlayerIcons";
        public virtual IShaderReplacer ShaderReplacer => null;
        public Task PrepareCameraAsync()
        {
            if(camera_0!=null) return Task.CompletedTask;
            var root=new GameObject("private camera");
            camera_0=root.AddComponent<Camera>();camera_0.cullingMask=(1<<23)|(1<<2);
            root.AddComponent<Light>().enabled=true;
            for(int i=0;i<2;i++) {
                var child=new GameObject("native lamp "+i);child.transform.SetParent(root.transform,false);
                child.AddComponent<Light>().enabled=i==0; child.SetActive(i==0);
            }
            light_0=new[]{root.GetComponentsInChildren<Light>(true)[0]};
            return Task.CompletedTask;
        }
        public Bounds GetBounds(GameObject model) { Test.Fail("bounds");return new Bounds { center=new Vector3(0,1,3),extents=new Vector3(.5f,1,.3f) }; }
        public virtual void PoseModelByBounds(GameObject model,Camera camera,in Bounds bounds) { }
        public void SetupScene(GameObject model,in IntVec2 size,object pivot) {
            model.transform.SetParent(camera_0.transform,false);PoseModelByBounds(model,camera_0,GetBounds(model));
        }
        public static Texture2D GetTexture(int w,int h) => new Texture2D(w,h);
        public static Sprite CreateSprite(Texture2D texture) => Test.Failure=="sprite" ? null : new Sprite { texture=texture };
        public virtual void Dispose() { if(camera_0!=null) UnityEngine.Object.Destroy(camera_0.gameObject);camera_0=null; }
    }
}
namespace CombatLog { public static class Plugin { public static Logger Log=new Logger(); } public class Logger { public void LogWarning(string s) { } } }
namespace UnityEngine
{
    public class Object
    {
        public bool Destroyed;
        public static void Destroy(Object obj) {
            obj.Destroyed=true;
            if(obj is GameObject go) foreach(var child in go.transform.Children.ToArray()) Destroy(child.gameObject);
        }
    }
    public class Component : Object { public GameObject gameObject; public Transform transform=>gameObject.transform; }
    public class GameObject : Object
    {
        public static List<GameObject> All=new();
        readonly List<Component> components=new();
        public string name;public bool activeSelf=true;public Transform transform;
        public GameObject(string n) { name=n;transform=new Transform { gameObject=this };All.Add(this); }
        public void SetActive(bool value) { activeSelf=value; }
        public T AddComponent<T>() where T:Component,new() {
            if(name=="CombatLog portrait fill") Test.Fail("fill creation");
            var c=new T { gameObject=this };components.Add(c);return c;
        }
        public T[] GetComponentsInChildren<T>(bool includeInactive) where T:Component =>
            components.OfType<T>().Concat(transform.Children.SelectMany(c=>c.gameObject.GetComponentsInChildren<T>(includeInactive))).ToArray();
    }
    public class Transform
    {
        public GameObject gameObject;public Transform parent;public List<Transform> Children=new();
        public Vector3 localPosition,localScale=Vector3.one;public Quaternion localRotation;
        public Quaternion rotation { get=>localRotation;set=>localRotation=value; }
        public void SetParent(Transform p,bool worldPositionStays) { parent?.Children.Remove(this);parent=p;p?.Children.Add(this); }
        public Vector3 InverseTransformPoint(Vector3 point) => point;
    }
    public record struct Vector3(float x,float y,float z) { public static Vector3 zero=>new(0,0,0);public static Vector3 one=>new(1,1,1); }
    public record struct Quaternion(Vector3 Angles) { public static Quaternion Euler(Vector3 a)=>new(a); }
    public record struct Color(float r,float g,float b,float a=1) { public static Color white=>new(1,1,1); }
    public struct Bounds { public Vector3 center,extents; }
    public struct Rect { public Rect(float a,float b,float c,float d) { } }
    public enum LightType { Spot,Directional }
    public enum LightShadows { None,Hard }
    public enum LightRenderMode { Auto,ForcePixel }
    public class Light : Component { public bool enabled=true;public LightType type;public Color color;public float intensity;public LightShadows shadows;public LightRenderMode renderMode;public int cullingMask=-1; }
    public class Camera : Component
    {
        public bool orthographic,useOcclusionCulling;public float orthographicSize,fieldOfView,nearClipPlane,farClipPlane;
        public int renderingPath,cullingMask;public CameraClearFlags clearFlags;public Color backgroundColor;public RenderTexture targetTexture;
        public T[] GetComponentsInChildren<T>(bool includeInactive) where T:Component=>gameObject.GetComponentsInChildren<T>(includeInactive);
        public void Render() { Test.Rendering?.Invoke();Test.Fail("render"); }
    }
    public enum CameraClearFlags { Color }
    public enum RenderTextureFormat { ARGB32 }
    public enum RenderTextureReadWrite { Default }
    public static class RenderSettings { public static int Marker; }
    public class RenderTexture : Object {
        public static RenderTexture active;public static int Taken,Returned;
        public static RenderTexture GetTemporary(int w,int h,int d,RenderTextureFormat f,RenderTextureReadWrite rw=RenderTextureReadWrite.Default,int aa=1) { Taken++;return new(); }
        public static void ReleaseTemporary(RenderTexture rt) { Returned++; }
    }
    public class Texture2D : Object {
        public static List<Texture2D> Created=new();
        public Texture2D(int w,int h) { Created.Add(this); }
        public void ReadPixels(Rect r,int x,int y,bool mip) { Test.Fail("readback"); }
        public void Apply(bool a,bool b) { }
    }
    public class Sprite : Object { public Texture2D texture; }
    public static class Graphics { public static void Blit(RenderTexture from,RenderTexture to) { } }
}
`;

try {
  writeFileSync(path.join(temporary, 'Program.cs'), harness);
  writeFileSync(path.join(temporary, 'Harness.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><LangVersion>latest</LangVersion><Nullable>disable</Nullable><EnableNETAnalyzers>false</EnableNETAnalyzers></PropertyGroup></Project>');
  const run = candidate => {
    writeFileSync(path.join(temporary, 'FullBodyPortraitRenderer.cs'), candidate);
    return spawnSync('dotnet', ['run', '--project', path.join(temporary, 'Harness.csproj'), '-c', 'Release'], {
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 90_000,
      env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1' },
    });
  };
  const result = run(source);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ''}`);
  assert.match(result.stdout, /PORTRAIT HARNESS ASSERTIONS \d+/);
  console.log(result.stdout.trim());
  for (const [name, before, after, failure] of [
    ['spotlight regression', 'light.type = LightType.Directional;', 'light.type = LightType.Spot;', 'directional coverage'],
    ['leaked fill light', 'try { if (_fillLight != null) _fillLight.enabled = false; } catch (Exception) { }', '', 'private lights disabled after capture'],
    ['native hotspot', 'if (light_0[i] != null) light_0[i].enabled = false;', 'if (light_0[i] != null) light_0[i].enabled = true;', 'capture success/failure contained'],
    ['missing child lights', 'camera_0.GetComponentsInChildren<Light>(true)', 'new[] { camera_0.GetComponentsInChildren<Light>(true)[0] }', 'all native root/child lamps captured'],
  ]) {
    assert(source.includes(before), `negative-control seam missing: ${name}`);
    const negative = run(source.replace(before, after));
    assert.notEqual(negative.status, 0, `${name} escaped the harness`);
    assert((negative.stdout + negative.stderr).includes(failure), `${name} failed for the wrong reason:\n${negative.stdout}\n${negative.stderr}`);
  }
  console.log('COMBATLOG PORTRAIT LIGHTING VERIFIED');
} finally {
  const actual = realpathSync(temporary);
  assert.equal(path.dirname(actual).toLowerCase(), tempBase.toLowerCase());
  assert(path.basename(actual).startsWith('combatlog-portrait-lighting-'));
  rmSync(actual, { recursive: true, force: true });
}
