using System;
using System.Threading.Tasks;
using EFT.PlayerIcons;
using UnityEngine;

namespace CombatLog.Analytics;
internal sealed class FullBodyPortraitRenderer : PlayerIconCreator
{
    private const float FrameMargin = 1.08f;
    private const float FallbackHalfHeight = 1.05f;
    private readonly IShaderReplacer _combatLogShaderReplacer = new ShaderReplacer();
    private float _captureAspect = 0.75f;
    private Light _keyLight;
    private Light _fillLight;

    public override string Folder => "CombatLogFullBody";
    public override IShaderReplacer ShaderReplacer => _combatLogShaderReplacer;

    internal async Task<bool> PrepareAsync()
    {
        try
        {
            await PrepareCameraAsync();
            if (camera_0 == null) return false;
            PrepareLighting();
            return true;
        }
        catch (Exception ex)
        {
            _isCameraLoading = false;
            try { Dispose(); } catch (Exception) { }
            try { Plugin.Log?.LogWarning("CombatLog full-body camera could not be prepared: " + ex.Message); }
            catch (Exception) { /* supplementary rendering must never escape */ }
            return false;
        }
    }

    private void PrepareLighting()
    {
        if (_keyLight != null && _fillLight != null) return;
        camera_0.gameObject.SetActive(false);
        light_0 = camera_0.GetComponentsInChildren<Light>(true);
        int previewLayer = LayersMaskController.WeaponPreview;
        if (previewLayer < 0 || previewLayer > 31)
            throw new InvalidOperationException("Weapon preview layer is unavailable.");
        int mask = camera_0.cullingMask & (1 << previewLayer);
        _keyLight = CreateLight("CombatLog portrait key", new Vector3(15f, -25f, 0f), 1f, mask);
        _fillLight = CreateLight("CombatLog portrait fill", new Vector3(-5f, 30f, 0f), 0.55f, mask);
    }

    private Light CreateLight(string name, Vector3 angles, float intensity, int mask)
    {
        var host = new GameObject(name);
        host.SetActive(false);
        host.transform.SetParent(camera_0.transform, false);
        host.transform.localPosition = Vector3.zero;
        host.transform.localRotation = Quaternion.Euler(angles);
        var light = host.AddComponent<Light>();
        light.enabled = false;
        light.type = LightType.Directional;
        light.color = Color.white;
        light.intensity = intensity;
        light.shadows = LightShadows.None;
        light.renderMode = LightRenderMode.ForcePixel;
        light.cullingMask = mask;
        host.SetActive(true);
        return light;
    }

    public override void Dispose()
    {
        try { base.Dispose(); }
        finally { _keyLight = null; _fillLight = null; }
    }
    internal Sprite Capture(GameObject model, IntVec2 size)
    {
        try
        {
            if (model == null || camera_0 == null || _keyLight == null || _fillLight == null ||
                size.X <= 0 || size.Y <= 0)
                return null;
            _captureAspect = size.X / (float)size.Y;
            return CaptureOwnedSprite(model, in size);
        }
        catch (Exception ex)
        {
            try { Plugin.Log?.LogWarning("CombatLog full-body capture failed: " + ex.Message); }
            catch (Exception) { /* supplementary rendering must never escape */ }
            return null;
        }
    }

    public override void PoseModelByBounds(GameObject model, Camera camera, in Bounds ignored)
    {
        model.transform.localPosition = new Vector3(0f, 0f, 3f);
        model.transform.rotation = _settings.Rotation;
        Bounds bounds = GetBounds(model);
        Vector3 centre = camera.transform.InverseTransformPoint(bounds.center);
        Vector3 local = model.transform.localPosition;
        model.transform.localPosition = new Vector3(local.x - centre.x, local.y - centre.y, 3f);

        float aspect = _captureAspect > 0f ? _captureAspect : 0.75f;
        float halfHeight = Math.Max(bounds.extents.y, bounds.extents.x / aspect) * FrameMargin;
        if (float.IsNaN(halfHeight) || float.IsInfinity(halfHeight) || halfHeight <= 0f)
            halfHeight = FallbackHalfHeight;

        camera.orthographic = true;
        camera.orthographicSize = Math.Max(FallbackHalfHeight, halfHeight);
        camera.fieldOfView = _settings.fieldOfView;
        camera.nearClipPlane = _settings.nearClipPlane;
        camera.farClipPlane = _settings.farClipPlane;
        camera.renderingPath = _settings.RenderingPath;
    }

    private Sprite CaptureOwnedSprite(GameObject model, in IntVec2 size)
    {
        var previousRenderSettings =
            IconCreatorBase<PlayerIconRequest, ItemIcon>.IconRenderSettings.Store();
        bool shaderTouched = false;
        bool[] previousLights = light_0 == null ? Array.Empty<bool>() : new bool[light_0.Length];
        for (int i = 0; i < previousLights.Length; i++)
            previousLights[i] = light_0[i] != null && light_0[i].enabled;
        Texture2D texture = null;
        Transform originalParent = model.transform.parent;
        Vector3 originalPosition = model.transform.localPosition;
        Quaternion originalRotation = model.transform.localRotation;
        Vector3 originalScale = model.transform.localScale;
        bool originallyActive = model.activeSelf;
        try
        {
            IconCreatorBase<PlayerIconRequest, ItemIcon>.IconRenderSettings.Reset();
            shaderTouched = true;
            ShaderReplacer.Replace(model);
            SetupScene(model, in size, null);

            if (light_0 != null)
            {
                for (int i = 0; i < light_0.Length; i++)
                {
                    if (light_0[i] != null) light_0[i].enabled = false;
                }
            }

            _keyLight.enabled = true;
            _fillLight.enabled = true;
            model.SetActive(true);
            texture = RenderToTexture(in size);
            if (texture == null) return null;
            Sprite sprite = CreateSprite(texture);
            if (sprite == null) return null;
            texture = null;
            return sprite;
        }
        finally
        {
            try { if (_keyLight != null) _keyLight.enabled = false; } catch (Exception) { }
            try { if (_fillLight != null) _fillLight.enabled = false; } catch (Exception) { }
            try
            {
                model.SetActive(originallyActive);
                model.transform.SetParent(originalParent, false);
                model.transform.localPosition = originalPosition;
                model.transform.localRotation = originalRotation;
                model.transform.localScale = originalScale;
            }
            catch (Exception) { }
            if (shaderTouched)
            {
                try { ShaderReplacer.Restore(); } catch (Exception) { }
            }
            if (light_0 != null)
            {
                for (int i = 0; i < light_0.Length && i < previousLights.Length; i++)
                {
                    try { if (light_0[i] != null) light_0[i].enabled = previousLights[i]; }
                    catch (Exception) { }
                }
            }
            try { if (texture != null) UnityEngine.Object.Destroy(texture); }
            catch (Exception) { }
            try { previousRenderSettings.Restore(); } catch (Exception) { }
        }
    }

    private Texture2D RenderToTexture(in IntVec2 size)
    {
        RenderTexture supersampled = null;
        RenderTexture target = null;
        Texture2D result = null;
        RenderTexture previous = RenderTexture.active;
        try
        {
            supersampled = RenderTexture.GetTemporary(size.X * 2, size.Y * 2, 16,
                RenderTextureFormat.ARGB32, RenderTextureReadWrite.Default, 8);
            target = RenderTexture.GetTemporary(size.X, size.Y, 0, RenderTextureFormat.ARGB32);
            camera_0.gameObject.SetActive(true);
            camera_0.targetTexture = supersampled;
            camera_0.clearFlags = CameraClearFlags.Color;
            camera_0.backgroundColor = new Color(0f, 0f, 0f, 0f);
            camera_0.useOcclusionCulling = false;
            iconShadow_0?.SetTexDimension(size.X * 2, size.Y * 2);
            camera_0.Render();
            Graphics.Blit(supersampled, target);

            RenderTexture.active = target;
            result = GetTexture(size.X, size.Y);
            result.ReadPixels(new Rect(0f, 0f, size.X, size.Y), 0, 0, false);
            result.Apply(false, false);
            Texture2D completed = result;
            result = null;
            return completed;
        }
        finally
        {
            try { RenderTexture.active = previous; } catch (Exception) { }
            try
            {
                if (camera_0 != null)
                {
                    camera_0.targetTexture = null;
                    camera_0.gameObject.SetActive(false);
                }
            }
            catch (Exception) { }
            try { if (supersampled != null) RenderTexture.ReleaseTemporary(supersampled); }
            catch (Exception) { }
            try { if (target != null) RenderTexture.ReleaseTemporary(target); }
            catch (Exception) { }
            try { if (result != null) UnityEngine.Object.Destroy(result); }
            catch (Exception) { }
        }
    }
}
