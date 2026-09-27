using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Comfort.Common;
using EFT;
using EFT.Ballistics;
using EFT.InventoryLogic;
using EFT.PlayerIcons;
using UnityEngine;

namespace CombatLog.Analytics;
public static class RaidPresentation
{
    public sealed class EquipmentEntry
    {
        public string Slot, Name, TemplateId, Image;
        public int? ArmorClass;
        public float? Durability, MaxDurability;
    }

    public sealed class KillerSnapshot
    {
        public string ProfileId, Name, Side, PortraitImage;
        public string KillingAmmoTemplateId, KillingWeaponName;
        public int Level;
        public float KillingDistance, RemainingHp, MaxHp;
        public bool HasHealth;
        public readonly List<EquipmentEntry> Equipment = new();
        internal PlayerVisualRepresentation NativeVisualState;
    }

    private sealed class ImageJob
    {
        public string Key;
        public int Generation;
        public bool IsKiller;
        public Item Item;
        public InventoryEquipment Equipment;
        public BodyCustomization Customization;
        public ItemIcon Icon;
        public Task<Sprite> PortraitTask;
        public double Started;

        public void Release()
        {
            Item = null;
            Equipment = null;
            Customization = null;
            Icon = null;
            PortraitTask = null;
        }
    }

    internal const int MaxImagesPerRaid = 64;
    private const int MaxWeaponImages = 32;
    internal const int MaxImageBytes = 256 * 1024;
    private const int MaxDimension = 512;
    private const int MaxPortraitDimension = 240;
    private static readonly IntVec2 FullBodyPortraitSize = new(360, 480);
    private const int MaxVisibleNodes = 512;
    private const int MaxVisibleDepth = 20;
    private const int MaxCacheFiles = 3200;
    private const int MaxScanFiles = 10000;
    private const long MaxCacheBytes = 64L * 1024 * 1024;
    private const double ImageTimeoutSeconds = 12;
    private const double BatchTimeoutSeconds = 90;
    private const string PendingJson = "{\"state\":\"pending\"}";
    private const string UnavailableJson = "{\"state\":\"unavailable\"}";
    private static readonly object Sync = new();
    private static readonly Queue<ImageJob> Jobs = new();
    private static readonly Dictionary<string, ImageJob> Pending = new(StringComparer.Ordinal);
    private static readonly Dictionary<string, string> WeaponKeys = new(StringComparer.Ordinal);
    private static readonly EquipmentSlot[] VisibleSlots =
    {
        EquipmentSlot.Headwear, EquipmentSlot.FaceCover, EquipmentSlot.Eyewear,
        EquipmentSlot.Earpiece, EquipmentSlot.ArmBand, EquipmentSlot.ArmorVest,
        EquipmentSlot.TacticalVest, EquipmentSlot.Backpack,
        EquipmentSlot.FirstPrimaryWeapon, EquipmentSlot.SecondPrimaryWeapon,
        EquipmentSlot.Holster, EquipmentSlot.Scabbard
    };
    private static readonly EBodyPart[] HealthParts =
    {
        EBodyPart.Head, EBodyPart.Chest, EBodyPart.Stomach,
        EBodyPart.LeftArm, EBodyPart.RightArm,
        EBodyPart.LeftLeg, EBodyPart.RightLeg
    };
    private static long _raidId;
    private static int _sequence, _generation, _mainThread;
    private static bool _recording, _ended, _disposed, _nativeBlocked;
    private static double _endedAt;
    private static ImageJob _active;
    private static Task<Sprite> _retiredPortrait;
    private static FullBodyPortraitRenderer _portraitRenderer;
    private static KillerSnapshot _killer;
    private static string _directory;
    private static bool _storeFailed;
    private static long _cacheBytes;
    private static int _cacheFiles;

    public static KillerSnapshot Killer { get { lock (Sync) return _killer; } }
    private static double Now => Stopwatch.GetTimestamp() / (double)Stopwatch.Frequency;

    public static void BeginRaid(long timestamp)
    {
        lock (Sync)
        {
            if (_disposed) return;
            _mainThread = Thread.CurrentThread.ManagedThreadId;
            CancelPending();
            _generation++;
            _raidId = timestamp > 0 && timestamp <= (long.MaxValue - 999) / 1000 ? timestamp : 0;
            _sequence = 0;
            _recording = true;
            _ended = false;
            _killer = null;
            WeaponKeys.Clear();
        }
    }

    public static void ClearKiller()
    {
        lock (Sync)
        {
            _killer = null;
            var keep = new Queue<ImageJob>();
            while (Jobs.Count > 0)
            {
                ImageJob job = Jobs.Dequeue();
                if (job.IsKiller) Finish(job); else keep.Enqueue(job);
            }
            while (keep.Count > 0) Jobs.Enqueue(keep.Dequeue());
            if (_active != null && _active.IsKiller)
            {
                Finish(_active);
                _active = null;
            }
        }
    }

    public static void CaptureKiller(IPlayer aggressor)
    {
        CaptureKillerCore(aggressor, default, false);
    }

    public static void CaptureKiller(IPlayer aggressor, DamageInfo killingDamage)
    {
        CaptureKillerCore(aggressor, killingDamage, true);
    }

    private static void CaptureKillerCore(IPlayer aggressor, DamageInfo killingDamage,
        bool hasKillingDamage)
    {
        lock (Sync)
        {
            if (_disposed || !_recording || !OnMainThread() || aggressor == null) return;
            ClearKiller();
            try
            {
                Profile profile = aggressor.Profile;
                var snapshot = new KillerSnapshot
                {
                    ProfileId = aggressor.ProfileId ?? string.Empty,
                    Name = BoundedText(profile?.Nickname),
                    Level = Math.Max(0, profile?.Info?.Level ?? 0),
                    Side = aggressor.Side.ToString()
                };
                _killer = snapshot;
                CaptureNativeKillerEvidence(snapshot, aggressor, killingDamage, hasKillingDamage);
                InventoryEquipment source = aggressor.InventoryController?.Inventory?.Equipment ?? profile?.Inventory?.Equipment;
                if (source == null) return;
                foreach (EquipmentSlot slot in VisibleSlots)
                {
                    try
                    {
                        Item item = source.GetSlot(slot)?.ContainedItem;
                        if (item == null) continue;
                        var entry = new EquipmentEntry
                        {
                            Slot = slot.ToString(), Name = ItemName(item),
                            TemplateId = item.TemplateId.ToString()
                        };
                        snapshot.Equipment.Add(entry);
                        var armor = item.GetItemComponent<ArmorComponent>();
                        if (armor != null)
                        {
                            entry.ArmorClass = armor.ArmorClass;
                            entry.Durability = Finite(armor.Repairable?.Durability);
                            entry.MaxDurability = Finite(armor.Repairable?.MaxDurability);
                        }
                        entry.Image = QueueItem(item, true);
                    }
                    catch (Exception) { /* unavailable row details, other slots survive */ }
                }

                if (profile?.Customization != null && IsBoundedVisibleTree(source))
                {
                    try
                    {
                        var job = NewJob(true);
                        if (job == null) return;
                        job.Equipment = source.CloneVisibleItem();
                        job.Customization = new BodyCustomization(profile.Customization);
                        if (job.Equipment == null) { job.Release(); return; }
                        snapshot.PortraitImage = job.Key;
                        var rest = Jobs.ToArray();
                        Jobs.Clear();
                        Enqueue(job);
                        foreach (ImageJob queued in rest) Jobs.Enqueue(queued);
                    }
                    catch (Exception) { /* identity/equipment remain useful */ }
                }
            }
            catch (Exception) { /* capture is supplementary, never breaks OnDead */ }
        }
    }

    private static void CaptureNativeKillerEvidence(KillerSnapshot snapshot, IPlayer aggressor,
        DamageInfo killingDamage, bool hasKillingDamage)
    {
        if (snapshot == null || aggressor == null)
            return;

        if (hasKillingDamage)
        {
            try
            {
                snapshot.KillingAmmoTemplateId = BoundedText(killingDamage.SourceId);
                string weapon = killingDamage.Weapon?.ShortName;
                if (!string.IsNullOrWhiteSpace(weapon))
                {
                    string localized = weapon.Localized(null);
                    snapshot.KillingWeaponName = BoundedText(
                        string.IsNullOrWhiteSpace(localized) ? weapon : localized);
                }
                if (DistanceHelper.TryGetDistance(killingDamage, out float distance))
                    snapshot.KillingDistance = Finite(distance) ?? 0f;
            }
            catch (Exception)
            {
            }
        }

        if (!(aggressor is Player killer) || killer == null)
            return;

        try
        {
            var healthController = killer.HealthController;
            if (healthController != null)
            {
                float remaining = 0f;
                float maximum = 0f;
                foreach (EBodyPart bodyPart in HealthParts)
                {
                    var health = healthController.GetBodyPartHealth(bodyPart);
                    remaining += health.Current;
                    maximum += health.Maximum;
                }

                float? finiteRemaining = Finite(remaining);
                float? finiteMaximum = Finite(maximum);
                if (finiteRemaining.HasValue && finiteMaximum > 0f)
                {
                    snapshot.RemainingHp = finiteRemaining.Value;
                    snapshot.MaxHp = finiteMaximum.Value;
                    snapshot.HasHealth = true;
                }
            }
        }
        catch (Exception)
        {
        }

        try
        {
            PlayerVisualRepresentation visual = killer.Profile?.GetVisualEquipmentState(true);
            if (visual != null && !visual.IsEmpty())
            {
                snapshot.NativeVisualState = new PlayerVisualRepresentation(
                    visual.Info,
                    visual.Customization == null ? null : new BodyCustomization(visual.Customization),
                    visual.Equipment);
            }
        }
        catch (Exception)
        {
        }
    }

    public static string RememberWeapon(Item weapon)
    {
        lock (Sync)
        {
            if (_disposed || !_recording || !OnMainThread() || weapon == null) return null;
            try
            {
                string id = weapon.Id;
                if (string.IsNullOrEmpty(id)) return null;
                if (WeaponKeys.TryGetValue(id, out string key)) return key;
                if (WeaponKeys.Count >= MaxWeaponImages) return null;
                WeaponKeys[id] = null;
                key = QueueItem(weapon, false);
                WeaponKeys[id] = key;
                return key;
            }
            catch (Exception) { return null; }
        }
    }

    public static void EndRaid()
    {
        lock (Sync)
        {
            if (_disposed || !_recording) return;
            _recording = false;
            _ended = true;
            _endedAt = Now;
        }
    }
    public static void Tick()
    {
        lock (Sync)
        {
            if (!OnMainThread()) return;
            DrainRetiredPortrait();
            if (_disposed || !_ended || _recording) return;
            if (_nativeBlocked) { CancelPending(); return; }
            if (Now - _endedAt > BatchTimeoutSeconds) { CancelPending(); return; }
#pragma warning disable CS0618
            if (InGameStatus.InRaid) return;
#pragma warning restore CS0618
            if (_active == null)
            {
                if (Jobs.Count == 0) return;
                _active = Jobs.Dequeue();
                _active.Started = Now;
                try
                {
                    if (_active.Equipment != null)
                    {
                        if (Singleton<PlayerIconCreator>.Instantiated)
                        {
                            _portraitRenderer ??= new FullBodyPortraitRenderer();
                            _active.PortraitTask = RenderFullBodyPortraitAsync(
                                Singleton<PlayerIconCreator>.Instance,
                                new PlayerIconRequest(_active.Equipment, _active.Customization),
                                _portraitRenderer);
                        }
                    }
                    else if (_active.Item != null && Singleton<ItemIconCreator>.Instantiated)
                    {
                        IntVec2 cells = _active.Item.CalculateCellSize();
                        var size = new IntVec2(Math.Max(1, Math.Min(8, cells.X)) * 64,
                            Math.Max(1, Math.Min(8, cells.Y)) * 64);
                        _active.Icon = Singleton<ItemIconCreator>.Instance.GetItemIcon(_active.Item, in size);
                    }
                    if (_active.Icon == null && _active.PortraitTask == null)
                    { Finish(_active); _active = null; }
                }
                catch (Exception)
                {
                    BlockNativeRendering();
                    CancelPending();
                }
                return;
            }

            ImageJob current = _active;
            try
            {
                if (current.Generation != _generation || Now - current.Started > ImageTimeoutSeconds)
                {
                    CancelPending();
                    return;
                }
                Sprite sprite;
                bool ownsSprite = false;
                bool portraitSettled = false;
                if (current.PortraitTask != null)
                {
                    if (!current.PortraitTask.IsCompleted) return;
                    if (current.PortraitTask.IsCanceled || current.PortraitTask.IsFaulted)
                    {
                        _ = current.PortraitTask.Exception;
                        current.PortraitTask = null;
                        BlockNativeRendering();
                        Finish(current);
                        _active = null;
                        return;
                    }
                    sprite = current.PortraitTask.GetAwaiter().GetResult();
                    current.PortraitTask = null;
                    portraitSettled = true;
                    ownsSprite = sprite != null;
                }
                else sprite = current.Icon?.Sprite;
                if (sprite == null)
                {
                    if (portraitSettled) { Finish(current); _active = null; }
                    return;
                }
                try
                {
                    byte[] png = CopyPng(sprite,
                        current.Equipment != null ? MaxPortraitDimension : MaxDimension);
                    if (current.Generation == _generation && !_recording && IsPng(png))
                        SaveImage(current.Key, png);
                }
                finally
                {
                    if (ownsSprite) DestroyOwnedPortrait(sprite);
                    Finish(current);
                    _active = null;
                }
            }
            catch (Exception) { Finish(current); _active = null; }
        }
    }

    public static void Dispose()
    {
        lock (Sync)
        {
            _disposed = true;
            _generation++;
            DrainRetiredPortrait();
            CancelPending();
            DrainRetiredPortrait();
            DisposePortraitRendererIfIdle();
            WeaponKeys.Clear();
            _killer = null;
            _recording = _ended = false;
        }
    }

    public static string LoadImage(string key)
    {
        lock (Sync)
        {
            if (_disposed || !TryParseKey(key, out _)) return UnavailableJson;
            if (Pending.ContainsKey(key)) return PendingJson;
            try
            {
                if (!EnsureStore()) return UnavailableJson;
                string path = Path.Combine(_directory, key + ".png");
                if (!File.Exists(path) || IsLink(path)) return UnavailableJson;
                using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
                if (stream.Length < 33 || stream.Length > MaxImageBytes) return UnavailableJson;
                byte[] bytes = new byte[(int)stream.Length];
                int offset = 0, read;
                while (offset < bytes.Length && (read = stream.Read(bytes, offset, bytes.Length - offset)) > 0)
                    offset += read;
                if (offset != bytes.Length || !IsPng(bytes)) return UnavailableJson;
                return "{\"state\":\"ready\",\"data\":\"data:image/png;base64," + Convert.ToBase64String(bytes) + "\"}";
            }
            catch (Exception) { return UnavailableJson; }
        }
    }
    public static void Prune(IEnumerable<long> retainedRaidIds)
    {
        lock (Sync)
        {
            try
            {
                if (_disposed || retainedRaidIds == null || !EnsureStore()) return;
                var retained = new HashSet<long>(retainedRaidIds);
                if (_raidId > 0) retained.Add(_raidId);
                var owned = new List<(long raid, string path, long size)>();
                int scanned = 0;
                foreach (string path in Directory.EnumerateFiles(_directory))
                {
                    if (++scanned > MaxScanFiles) { _storeFailed = true; return; }
                    if (!TryOwnedFile(path, out long raid) || IsLink(path)) continue;
                    if (!retained.Contains(raid)) { File.Delete(path); continue; }
                    owned.Add((raid, path, new FileInfo(path).Length));
                }
                owned.Sort((a, b) => b.raid.CompareTo(a.raid));
                _cacheBytes = 0;
                _cacheFiles = 0;
                foreach (var file in owned)
                {
                    if (file.size > MaxImageBytes || _cacheFiles >= MaxCacheFiles || _cacheBytes + file.size > MaxCacheBytes)
                    {
                        File.Delete(file.path);
                        continue;
                    }
                    _cacheBytes += file.size;
                    _cacheFiles++;
                }
            }
            catch (Exception)
            {
                _cacheBytes = MaxCacheBytes;
                _cacheFiles = MaxCacheFiles;
            }
        }
    }

    private static bool OnMainThread() => _mainThread != 0 && Thread.CurrentThread.ManagedThreadId == _mainThread;

    private static ImageJob NewJob(bool killer)
    {
        if (_nativeBlocked || _raidId == 0 || _sequence >= MaxImagesPerRaid) return null;
        string key = checked(_raidId * 1000 + ++_sequence).ToString(CultureInfo.InvariantCulture);
        return new ImageJob { Key = key, Generation = _generation, IsKiller = killer };
    }

    private static string QueueItem(Item source, bool killer)
    {
        if (_nativeBlocked || !IsBoundedVisibleTree(source)) return null;
        ImageJob job = NewJob(killer);
        if (job == null) return null;
        job.Item = source.CloneVisibleItem();
        if (job.Item == null) return null;
        Enqueue(job);
        return job.Key;
    }

    private static void Enqueue(ImageJob job) { Pending.Add(job.Key, job); Jobs.Enqueue(job); }
    private static void Finish(ImageJob job)
    {
        if (job == null) return;
        BlockIfUnsettled(job);
        RetirePortrait(job);
        Pending.Remove(job.Key);
        job.Release();
    }

    private static void CancelPending()
    {
        BlockIfUnsettled(_active);
        RetirePortrait(_active);
        foreach (ImageJob job in Pending.Values)
        {
            BlockIfUnsettled(job);
            RetirePortrait(job);
            job.Release();
        }
        Pending.Clear();
        Jobs.Clear();
        _active = null;
    }

    private static void BlockIfUnsettled(ImageJob job)
    {
        if (job?.PortraitTask != null && !job.PortraitTask.IsCompleted) BlockNativeRendering();
        if (job?.Icon != null && ReferenceEquals(job.Icon.Sprite, null)) BlockNativeRendering();
    }

    private static async Task<Sprite> RenderFullBodyPortraitAsync(PlayerIconCreator creator,
        PlayerIconRequest request, FullBodyPortraitRenderer renderer)
    {
        if (!await renderer.PrepareAsync()) return null;
        Sprite captured = null;
        try
        {
            var result = await creator.RenderModel(request, (model, _) =>
            {
                captured = renderer.Capture(model, FullBodyPortraitSize);
                return Task.FromResult(captured);
            });
            Sprite completed = result.sprite;
            if (ReferenceEquals(completed, captured)) captured = null;
            return completed;
        }
        finally
        {
            if (!ReferenceEquals(captured, null)) DestroyOwnedPortrait(captured);
        }
    }

    private static void RetirePortrait(ImageJob job)
    {
        Task<Sprite> task = job?.PortraitTask;
        if (task == null) return;
        job.PortraitTask = null;
        if (task.IsCompleted)
        {
            ConsumeRetiredPortrait(task);
            return;
        }
        if (_retiredPortrait == null) _retiredPortrait = task;
    }

    private static void DrainRetiredPortrait()
    {
        Task<Sprite> task = _retiredPortrait;
        if (task == null || !task.IsCompleted) return;
        _retiredPortrait = null;
        ConsumeRetiredPortrait(task);
        DisposePortraitRendererIfIdle();
    }

    private static void ConsumeRetiredPortrait(Task<Sprite> task)
    {
        if (task.Status == TaskStatus.RanToCompletion)
            DestroyOwnedPortrait(task.Result);
        else
        {
            _ = task.Exception;
            BlockNativeRendering();
        }
    }

    private static void DestroyOwnedPortrait(Sprite sprite)
    {
        if (ReferenceEquals(sprite, null)) return;
        Texture2D texture = sprite.texture;
        if (!ReferenceEquals(texture, null)) UnityEngine.Object.Destroy(texture);
        UnityEngine.Object.Destroy(sprite);
    }

    private static void DisposePortraitRendererIfIdle()
    {
        if (!_disposed || _retiredPortrait != null || _active?.PortraitTask != null || _portraitRenderer == null)
            return;
        _portraitRenderer.Dispose();
        _portraitRenderer = null;
    }

    private static void BlockNativeRendering()
    {
        if (_nativeBlocked) return;
        _nativeBlocked = true;
        try
        {
            Plugin.Log?.LogWarning("CombatLog image rendering paused for this session: a game icon request did not settle. Text statistics and cached images remain available.");
        }
        catch (Exception) { /* logging must not interfere with cancellation */ }
    }

    private static bool IsBoundedVisibleTree(Item source)
    {
        int budget = MaxVisibleNodes;
        return VisitVisible(source, 0, ref budget, new HashSet<Item>());
    }

    private static bool VisitVisible(Item item, int depth, ref int budget, HashSet<Item> seen)
    {
        if (item == null || depth > MaxVisibleDepth || --budget < 0 || !seen.Add(item)) return false;
        if (item.HideEntrails || !(item is ContainerCollection collection)) return true;
        foreach (IContainer container in collection.Containers)
        {
            if (--budget < 0) return false;
            foreach (Item child in container.Items)
                if (!VisitVisible(child, depth + 1, ref budget, seen)) return false;
        }
        return true;
    }

    private static string ItemName(Item item)
    {
        try { return BoundedText(item.ShortName.Localized()); }
        catch (Exception) { return BoundedText(item.TemplateId.ToString()); }
    }
    private static string BoundedText(string value) => value == null ? string.Empty : value.Length > 256 ? value.Substring(0, 256) : value;
    private static float? Finite(float? value) => value.HasValue && !float.IsNaN(value.Value) && !float.IsInfinity(value.Value) ? Math.Max(0, value.Value) : null;

    private static byte[] CopyPng(Sprite sprite, int maxDimension)
    {
        Texture2D source = sprite.texture;
        if (source == null || (sprite.packed && sprite.packingRotation != SpritePackingRotation.None)) return null;
        Rect crop = sprite.textureRect;
        if (crop.width <= 0 || crop.height <= 0 || crop.x < 0 || crop.y < 0 ||
            crop.xMax > source.width || crop.yMax > source.height) return null;
        float factor = Math.Min(1f, maxDimension / Math.Max(crop.width, crop.height));
        int width = Math.Max(1, (int)(crop.width * factor)), height = Math.Max(1, (int)(crop.height * factor));
        RenderTexture previous = RenderTexture.active;
        RenderTexture temporary = null;
        Texture2D copy = null;
        try
        {
            temporary = RenderTexture.GetTemporary(width, height, 0, RenderTextureFormat.ARGB32);
            Graphics.Blit(source, temporary,
                new Vector2(crop.width / source.width, crop.height / source.height),
                new Vector2(crop.x / source.width, crop.y / source.height));
            RenderTexture.active = temporary;
            copy = new Texture2D(width, height, TextureFormat.RGBA32, false);
            copy.ReadPixels(new Rect(0, 0, width, height), 0, 0, false);
            copy.Apply(false, false);
            return ImageConversion.EncodeToPNG(copy);
        }
        finally
        {
            RenderTexture.active = previous;
            if (temporary != null) RenderTexture.ReleaseTemporary(temporary);
            if (copy != null) UnityEngine.Object.Destroy(copy);
        }
    }

    private static bool TryParseKey(string key, out long raid)
    {
        raid = 0;
        if (string.IsNullOrEmpty(key) || key.Length < 4 || key.Length > 19 || key[0] == '0') return false;
        foreach (char c in key) if (c < '0' || c > '9') return false;
        if (!long.TryParse(key, NumberStyles.None, CultureInfo.InvariantCulture, out long value)) return false;
        long sequence = value % 1000;
        raid = value / 1000;
        return raid > 0 && sequence >= 1 && sequence <= MaxImagesPerRaid;
    }

    private static bool TryOwnedFile(string path, out long raid)
    {
        raid = 0;
        return string.Equals(Path.GetExtension(path), ".png", StringComparison.Ordinal) &&
            TryParseKey(Path.GetFileNameWithoutExtension(path), out raid);
    }

    private static bool IsLink(string path) => (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;

    private static bool EnsureStore()
    {
        if (_storeFailed) return false;
        string config = Path.GetFullPath(BepInEx.Paths.ConfigPath);
        string parent = Path.Combine(config, "CombatLog"), directory = Path.Combine(parent, "images");
        foreach (string path in new[] { config, parent, directory })
            if ((Directory.Exists(path) || File.Exists(path)) && IsLink(path)) return false;
        if (_directory != null) return string.Equals(_directory, directory, StringComparison.OrdinalIgnoreCase);
        Directory.CreateDirectory(directory);
        long bytes = 0;
        int files = 0, scanned = 0;
        foreach (string path in Directory.EnumerateFiles(directory))
        {
            if (++scanned > MaxScanFiles) { _storeFailed = true; return false; }
            if (!TryOwnedFile(path, out _) || IsLink(path)) continue;
            bytes += new FileInfo(path).Length;
            files++;
        }
        _cacheBytes = bytes;
        _cacheFiles = files;
        _directory = directory;
        return true;
    }

    private static void SaveImage(string key, byte[] png)
    {
        if (!TryParseKey(key, out _) || !IsPng(png) || !EnsureStore() ||
            _cacheBytes + png.Length > MaxCacheBytes || _cacheFiles >= MaxCacheFiles) return;
        string path = Path.Combine(_directory, key + ".png");
        if (File.Exists(path)) return;
        bool created = false;
        try
        {
            using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                created = true;
                stream.Write(png, 0, png.Length);
                stream.Flush();
            }
            _cacheBytes += png.Length;
            _cacheFiles++;
        }
        catch (Exception)
        {
            if (created && File.Exists(path) && !IsLink(path)) File.Delete(path);
        }
    }

    private static bool IsPng(byte[] bytes)
    {
        if (bytes == null || bytes.Length < 33 || bytes.Length > MaxImageBytes) return false;
        byte[] signature = { 137, 80, 78, 71, 13, 10, 26, 10 };
        for (int i = 0; i < signature.Length; i++) if (bytes[i] != signature[i]) return false;
        if (bytes[8] != 0 || bytes[9] != 0 || bytes[10] != 0 || bytes[11] != 13 ||
            bytes[12] != 73 || bytes[13] != 72 || bytes[14] != 68 || bytes[15] != 82) return false;
        uint width = ReadBigEndian(bytes, 16), height = ReadBigEndian(bytes, 20);
        if (width == 0 || height == 0 || width > MaxDimension || height > MaxDimension) return false;
        bool hasData = false;
        int offset = 8;
        while (offset <= bytes.Length - 12)
        {
            uint length = ReadBigEndian(bytes, offset);
            if (length > (uint)(bytes.Length - offset - 12)) return false;
            bool isData = bytes[offset + 4] == 73 && bytes[offset + 5] == 68 && bytes[offset + 6] == 65 && bytes[offset + 7] == 84;
            bool isEnd = bytes[offset + 4] == 73 && bytes[offset + 5] == 69 && bytes[offset + 6] == 78 && bytes[offset + 7] == 68;
            hasData |= isData && length > 0;
            offset += (int)length + 12;
            if (isEnd) return hasData && length == 0 && offset == bytes.Length;
        }
        return false;
    }
    private static uint ReadBigEndian(byte[] b, int i) => ((uint)b[i] << 24) | ((uint)b[i + 1] << 16) | ((uint)b[i + 2] << 8) | b[i + 3];
}
