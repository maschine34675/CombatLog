# CombatLog

CombatLog turns your recorded exchanges of fire into a readable post-raid report. See where shots landed by body zone, how armour affected the damage and how your weapons performed. Browse earlier raids or switch to Overall to compare your recorded history.

## Features

- A wide desktop workspace with Overview, Combat and Weapons & ammo views.
- Linked opponent selection, a zoomable timeline and hit list, plus a rotatable schematic mannequin with 25 detailed zones, including eyes, jaws and nape.
- Armour protection, blocked hits, ricochets, distance bands and event-linked raid records.
- Weapon and ammunition statistics: shots count cartridges, so one shotgun shell counts once. Individual projectile/pellet accuracy remains available separately.
- Available killer details, full-body imagery and visible equipment with game-generated images or labelled schematic fallbacks.
- Overall totals, outcomes, locations and the top five weapon models by recorded cartridges fired.
- Extra details on the native kill list, death screen and treatment tooltips. Unidentified non-scav kill-list entries keep ammunition hidden.

## Requirements and compatibility

This is a client-only mod targeting solo SPT 4.1.6, the build/reference version. Solo features have been tested on SPT 4.1.6. Other SPT versions are not verified.

[Anvil-WebOverlay 1.11.0 or newer](https://github.com/maschine34675/WebOverlay/releases) is required and must be installed separately. Its Windows and Microsoft WebView2 Runtime requirements also apply. Use windowed or borderless windowed mode; exclusive fullscreen cannot show the report. A wide desktop display of 1920 x 1080 or larger is recommended.

Fika is incompatible: its damage handling bypasses CombatLog's detailed hit capture. No server mod or headless integration is included. Remove KillAndDamageInfo if installed; otherwise CombatLog disables its native post-raid screen additions to avoid duplicate patches.

## Installation and first use

1. Close the game and install Anvil-WebOverlay 1.11.0 or newer.
2. Extract the release ZIP into the SPT folder containing `EscapeFromTarkov.exe`.
3. Check for `BepInEx/plugins/maschine-CombatLog.dll`. Documentation is in `BepInEx/plugins/CombatLog/`.
4. After a raid, click **COMBAT LOG** beside **HIDEOUT**. There is no opening hotkey. Close with Escape or the close button.

The report is unavailable during an active raid. Before the first raid of a session, it shows **NO RAID YET** while saved history and Overall remain accessible. Use **Raid report** and its raid selector for individual reports, or **Overall** for installation-wide statistics.

Use **Find raid** to search by location, outcome or date and filter full reports. Older summary-only entries are labelled and remain included in Overall. Timeline zoom and Earlier/Later controls help separate busy exchanges; selecting a marker highlights its event and automatically scrolls it into view. Repeated weapon models are visibly numbered as separate instances.

Settings are in `BepInEx/config/com.maschine.CombatLog.cfg`. Each native post-raid screen addition has its own toggle; the menu button is always available outside raids. Legacy hotkey and menu-button settings are ignored. For updates, close the game and overwrite the current files, keeping only one copy of the plugin DLL. Remove any older nested DLL from `BepInEx/plugins/maschine-CombatLog/`.

## Data and limitations

The newest 50 detailed reports are retained in `BepInEx/config/CombatLog/raids/`; older summaries remain for Overall. History is installation-wide, not per profile. Overall displays partial coverage when older reports lack counters; it does not reconstruct missing statistics. Game-generated images are cached locally in `BepInEx/config/CombatLog/images/` and are not bundled in the ZIP.

The mannequin shows schematic body-zone categories, not actual impact points or exact game colliders. CombatLog does not provide map reconstruction, movement tracking or a complete history of every damage source. Later linked deaths are distinguished from direct fatal hits. Ammunition spend uses known handbook base prices, not your purchase prices. Equipment images can be unavailable, and weapon images show the first observed configuration.

The page requests optional Barlow Condensed and JetBrains Mono fonts from Google Fonts; local fallback fonts are used when unavailable. Other mods replacing the same post-raid screens may conflict.

## Support and license

Use this mod page's comments with your exact CombatLog, SPT and WebOverlay versions, expected and actual behavior, and short reproduction steps. Attach the complete `BepInEx/LogOutput.log` from the affected session instead of pasted log excerpts; a no-registration transfer link such as Wormhole is suitable. Mention Fika if installed and your display mode for window problems. Inspect and redact private information before sharing; do not upload profiles, credentials or raw configuration files.

If your logging tool renames or rotates logs, attach the affected session's complete log from `BepInEx/` or `BepInEx/logs/` instead.

CombatLog is by maschine and is MIT-licensed. The archive includes the license, full README, changelog and third-party notices. WebOverlay and game assets are not bundled.
