using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using Comfort.Common;
using EFT.UI;
using HarmonyLib;
using SPT.Reflection.Patching;
using TMPro;
using UnityEngine;

namespace CombatLog.Patches;
internal class CombatLogTaskBarButtonPatch : ModulePatch
{
    private const string ButtonName = "CombatLogTaskBarButton";
    private const string Caption = "COMBAT LOG";
    private const string IconResource = "CombatLog.task-bar-icon.png";

    private static Texture2D iconTexture;
    private static Sprite iconSprite;
    private static bool iconUnavailable;

    protected override MethodBase GetTargetMethod()
    {
        return AccessTools.DeclaredMethod(typeof(MenuTaskBar), nameof(MenuTaskBar.Awake));
    }

    [PatchPostfix]
    private static void Postfix(MenuTaskBar __instance)
    {
        try
        {
            AddButton(__instance);
        }
        catch (Exception ex)
        {
            Plugin.Log?.LogWarning("the menu bar button could not be added: " + ex);
        }
    }
    private static Texture2D LoadTexture()
    {
        if (iconTexture != null)
            return iconTexture;
        if (iconUnavailable)
            return null;

        try
        {
            using (Stream stream = typeof(CombatLogTaskBarButtonPatch).Assembly.GetManifestResourceStream(IconResource))
            {
                if (stream == null)
                {
                    iconUnavailable = true;
                    return null;
                }

                var bytes = new byte[stream.Length];
                int read = 0;
                while (read < bytes.Length)
                {
                    int step = stream.Read(bytes, read, bytes.Length - read);
                    if (step <= 0)
                        break;
                    read += step;
                }

                var texture = new Texture2D(2, 2, TextureFormat.RGBA32, true);
                texture.hideFlags = HideFlags.HideAndDontSave;
                if (!texture.LoadImage(bytes))
                {
                    UnityEngine.Object.Destroy(texture);
                    iconUnavailable = true;
                    return null;
                }
                texture.filterMode = FilterMode.Trilinear;
                texture.wrapMode = TextureWrapMode.Clamp;
                texture.Apply(true, false);

                iconTexture = texture;
                return iconTexture;
            }
        }
        catch (Exception ex)
        {
            iconUnavailable = true;
            Plugin.Log?.LogWarning("the menu button icon could not be loaded: " + ex.Message);
            return null;
        }
    }
    private static Sprite SpriteFor(Sprite existing)
    {
        Texture2D texture = LoadTexture();
        if (texture == null)
            return null;

        float pixelsPerUnit = 100f;
        if (existing != null && existing.rect.width > 0.01f && existing.pixelsPerUnit > 0.01f)
            pixelsPerUnit = texture.width * existing.pixelsPerUnit / existing.rect.width;

        if (iconSprite != null && Mathf.Abs(iconSprite.pixelsPerUnit - pixelsPerUnit) < 0.01f)
            return iconSprite;

        Sprite created = Sprite.Create(
            texture,
            new Rect(0f, 0f, texture.width, texture.height),
            new Vector2(0.5f, 0.5f),
            pixelsPerUnit);
        created.hideFlags = HideFlags.HideAndDontSave;
        iconSprite = created;
        return created;
    }
    private static void ApplyIcon(GameObject clone)
    {
        if (clone == null)
            return;

        foreach (UnityEngine.UI.Image image in clone.GetComponentsInChildren<UnityEngine.UI.Image>(true))
        {
            if (image == null || image.gameObject.name.IndexOf("icon", StringComparison.OrdinalIgnoreCase) < 0)
                continue;

            Sprite icon = SpriteFor(image.sprite);
            if (icon == null)
            {
                image.color = new Color(0.76f, 0.68f, 0.43f, image.color.a);
                return;
            }

            if (image.sprite != icon)
            {
                Vector2 size = image.rectTransform.sizeDelta;
                image.sprite = icon;
                image.overrideSprite = null;
                image.type = UnityEngine.UI.Image.Type.Simple;
                image.preserveAspect = true;
                image.rectTransform.sizeDelta = size;
            }
            image.color = new Color(1f, 1f, 1f, image.color.a);
            return;
        }
    }

    private static void UnlockClone(GameObject clone)
    {
        foreach (CanvasGroup group in clone.GetComponentsInChildren<CanvasGroup>(true))
        {
            group.alpha = 1f;
            group.interactable = true;
            group.blocksRaycasts = true;
        }
    }

    private static bool IsInvisible(TextMeshProUGUI label)
    {
        return !label.gameObject.activeInHierarchy
            || !label.enabled
            || label.color.a < 0.9f
            || label.canvasRenderer.GetAlpha() < 0.9f
            || label.rectTransform.rect.width < 5f
            || label.transform.lossyScale.x < 0.01f;
    }
    private static void Heal(TextMeshProUGUI label)
    {
        for (Transform step = label.transform; step != null; step = step.parent)
        {
            if (!step.gameObject.activeSelf)
                step.gameObject.SetActive(true);
            if (step.GetComponent<AnimatedToggle>() != null)
                break;
        }
        label.enabled = true;
        if (label.color.a < 0.9f)
        {
            Color color = label.color;
            color.a = 1f;
            label.color = color;
        }
        if (label.canvasRenderer.GetAlpha() < 0.9f)
            label.canvasRenderer.SetAlpha(1f);
        if (label.text != Caption)
            label.text = Caption;
    }

    private static void AddButton(MenuTaskBar taskBar)
    {
        if (Plugin.Instance == null || !Plugin.Instance.ShowTaskBarButton)
            return;

        var toggles = AccessTools.Field(typeof(MenuTaskBar), "_toggleButtons").GetValue(taskBar)
            as Dictionary<EMenuType, AnimatedToggle>;
        if (toggles == null || !toggles.TryGetValue(EMenuType.Hideout, out AnimatedToggle hideout) || hideout == null)
            return;
        Transform wrapper = hideout.transform;
        while (wrapper.parent != null && wrapper.parent.name != "Tabs")
            wrapper = wrapper.parent;
        if (wrapper.parent == null)
            wrapper = hideout.transform;
        Transform parent = wrapper.parent;
        if (parent == null || parent.Find(ButtonName) != null)
            return;
        GameObject clone = UnityEngine.Object.Instantiate(wrapper.gameObject, parent);
        clone.name = ButtonName;
        clone.transform.SetSiblingIndex(wrapper.GetSiblingIndex() + 1);
        Transform clonedBadges = clone.transform.Find("NewInformation");
        if (clonedBadges != null)
            UnityEngine.Object.Destroy(clonedBadges.gameObject);
        UnlockClone(clone);
        LocalizedText localized = clone.GetComponentInChildren<LocalizedText>(true);
        TextMeshProUGUI label = localized != null
            ? localized.GetComponent<TextMeshProUGUI>()
            : clone.GetComponentInChildren<TextMeshProUGUI>(true);
        if (localized != null)
        {
            localized.enabled = false;
            UnityEngine.Object.Destroy(localized);
        }
        if (label != null)
        {
            for (Transform step = label.transform; step != null && step != clone.transform; step = step.parent)
                step.gameObject.SetActive(true);
            label.enabled = true;
            label.text = Caption;
            label.SetAllDirty();
        }

        ApplyIcon(clone);

        HoverTooltipArea tooltip = clone.GetComponentInChildren<HoverTooltipArea>(true);
        if (tooltip != null)
            tooltip.SetMessageText("Opens the CombatLog raid debrief", true);

        AnimatedToggle toggle = clone.GetComponentInChildren<AnimatedToggle>(true);
        if (toggle == null)
            return;
        Plugin.Instance.RunDelayed(0.2f, () =>
        {
            if (toggle == null || label == null)
                return;
            toggle.ToggleSilent(false);
            Heal(label);
            UnlockClone(clone);
            ApplyIcon(clone);
        });
        Plugin.Instance.RunDelayed(1.5f, () =>
        {
            if (toggle == null || label == null)
                return;
            if (IsInvisible(label))
            {
                Animator animator = toggle.GetComponent<Animator>();
                if (animator != null)
                    animator.enabled = false;
                Plugin.Log?.LogInfo("the menu button caption kept vanishing; animator frozen.");
            }
            Heal(label);
            ApplyIcon(clone);
        });
        toggle.onValueChanged.AddListener(pressed =>
        {
            if (!pressed)
                return;
            try
            {
                Singleton<GUISounds>.Instance.PlayUISound(EUISoundType.ButtonBottomBarClick);
            }
            catch
            {
            }
            toggle.ToggleSilent(false);
            Plugin plugin = Plugin.Instance;
            if (plugin != null)
                plugin.OpenFromTaskBar();
        });
    }
}
