# CombatLog

Understand what happened in a raid with a detailed post-raid combat report, weapon statistics and clearer result screens.

## Features

- A wide desktop report with separate Overview, Combat and Weapons & ammo views.
- Connected opponent selection, combat timeline, hit-event list and a rotatable 3D mannequin with 25 detailed body zones, including eyes, jaws and nape.
- Damage before and after armour, blocked hits, ricochets, distance bands and per-raid records linked to their recorded events.
- Per-weapon and per-ammunition shot accuracy, separate projectile/pellet statistics and estimated ammunition spend.
- Killer details, a full-body image and visible equipment with game-generated images when available, plus labelled schematic fallbacks.
- Saved raid reports and an Overall view with totals, outcomes, location summaries and the five most-used weapon models.
- Additions to the game's kill list, death screen and post-raid treatment tooltips.

## Requirements and compatibility

- SPT: solo SPT 4.1.6 is the build/reference target. Solo features have been tested on SPT 4.1.6. Other SPT versions are not verified.
- Components: client-only BepInEx plugin. No SPT server mod is included or required.
- Required dependency: [Anvil-WebOverlay 1.11.0 or newer](https://github.com/maschine34675/WebOverlay/releases), installed separately with its own dependencies. It is not bundled with CombatLog.
- Windows with the Microsoft WebView2 Runtime, as required by WebOverlay.
- Use borderless windowed or windowed mode. Exclusive fullscreen cannot display the report window.
- The report is designed for a wide desktop display, preferably 1920 x 1080 or larger, rather than a phone or a narrow side panel.
- Fika is incompatible: its damage-processing paths bypass CombatLog's detailed hit capture. Do not install this package as a Fika client or headless-host integration.

## Installation

1. Close the game and install Anvil-WebOverlay 1.11.0 or newer according to its instructions.
2. Extract the CombatLog ZIP into your SPT installation directory, the folder containing `EscapeFromTarkov.exe`.
3. Verify that `BepInEx/plugins/maschine-CombatLog.dll` exists. The accompanying documentation belongs in `BepInEx/plugins/CombatLog/`.
4. If you previously used KillAndDamageInfo, remove `maschine-KillAndDamageInfo.dll` from `BepInEx/plugins/`, including any nested copy. CombatLog replaces its three post-raid screen additions; leaving it loaded disables those additions in CombatLog to avoid duplicate patches.
5. Start the game in borderless windowed or windowed mode.

The ZIP contains the CombatLog DLL, this README, the changelog, the MIT license and third-party notices. The report's page, mannequin and icons are embedded in the DLL. WebOverlay, game files, saved reports and cached game images are not included.

## Updating

Close the game, then extract the new ZIP over the existing installation. Keep only one copy of `maschine-CombatLog.dll`: remove an older nested copy from `BepInEx/plugins/maschine-CombatLog/` if present. Keep the flat DLL at `BepInEx/plugins/maschine-CombatLog.dll`.

Settings and history are stored under `BepInEx/config/` and survive replacing the plugin. Back up `BepInEx/config/CombatLog/` if you want to preserve your reports before changing installations.

To uninstall, close the game and remove `BepInEx/plugins/maschine-CombatLog.dll` and the documentation folder `BepInEx/plugins/CombatLog/`. Optionally remove `BepInEx/config/com.maschine.CombatLog.cfg` and `BepInEx/config/CombatLog/` to delete settings, raid history and cached images. Leave WebOverlay installed if other mods use it.

## Usage

After a raid, click **COMBAT LOG** beside **HIDEOUT** in the bottom menu bar. There is no opening hotkey. Close the report with `Escape` or its close button. The report cannot be opened during an active raid and closes when a new raid starts.

Before your first raid of a session, **NO RAID YET** is expected. Previously saved reports and Overall remain available.

- **Overview:** review the immediate debrief, findings, raid records and, after a death, available killer details and equipment.
- **Combat:** choose an opponent, body region or hit event to inspect the same evidence together. Selecting a timeline marker highlights its matching event and automatically scrolls it into view. Drag the mannequin to rotate it; hover body-region buttons to highlight their areas. Use the timeline's **Zoom in**, **Zoom out**, **Earlier** and **Later** controls to inspect busy exchanges; **Whole raid** restores the full time axis. **Show entire raid** clears the combat filters and selection. Armour impact and engagements expand below the main workspace.
- **Weapons & ammo:** compare your individual weapons and ammunition, including accuracy and armour outcomes. Separate weapons of the same model have visible **Instance 1 of 2** labels; their counters are not combined.
- **Raid selector / Find raid:** open an earlier full report or return to the latest raid. Search by location, outcome or date, filter to a particular day, and choose full reports or all summaries. Summary-only entries are labelled before selection and cannot open a detailed report.
- **Overall:** switch from the raid report to installation-wide Overview, Weapons and Locations tabs. The weapon ranking combines configurations of the same model and ranks the top five by recorded cartridges fired.
- **Data & terms:** explains the report's terminology and evidence limits.

### Reading the statistics

**Shots** count cartridges, not pellets. One shotgun shell counts as one shot. A shot hits when at least one of its projectiles hits a player or bot; shot accuracy is hit cartridges divided by fired cartridges. Separate **projectile / pellet** detail counts individual projectiles. **Contacts** are recorded damage events: one projectile can produce several contacts, so contacts are not an accuracy numerator.

Damage absorbed by armour means the recorded difference between pre-armour and post-armour body damage. It is not a measurement of armour durability loss. Ammunition spend uses known handbook base prices per fired cartridge, not the amount you actually paid at a trader or on the flea market.

Direct fatal hits and later deaths linked to an earlier hit are shown separately. A linked death is not proof that the earlier bullet was the final cause of death.

The mannequin is a schematic display of recorded body-zone categories, not the game's collider geometry. It does not show actual impact points, bullet paths or a reconstruction of a player model.

### History and Overall

Raid data is saved locally in `BepInEx/config/CombatLog/raids/`; generated image files are cached in `BepInEx/config/CombatLog/images/`.

The newest 50 detailed raid reports are retained. Older detail files and their associated images are pruned, but raid summaries remain in the history index for Overall. The history belongs to the installation, not a particular SPT profile: switching profiles does not create a separate history.

Overall uses available recorded values and displays coverage where data is partial. Older reports may lack cartridge counters, weapon identities or other fields. Missing values are not reconstructed or treated as measured zeroes. Old reports without cartridge counters cannot provide corrected shot accuracy or cartridge-priced ammunition costs. Weapon rankings show their own coverage, which can differ from overall totals.

## Configuration

Settings are created on first launch in `BepInEx/config/com.maschine.CombatLog.cfg`. Edit this file while the game is closed, or use your BepInEx configuration interface if installed.

| Section | Option | Default | Effect |
| --- | --- | --- | --- |
| Post-Raid Screens | Ammo in kill list | Enabled | Adds lethal ammunition where the game's kill details are revealed. Unidentified non-scav victims keep their ammunition hidden. |
| Post-Raid Screens | Damaged targets in kill list | Enabled | Adds display-only rows for targets you damaged but did not kill; these are not extra kills or rewards. |
| Post-Raid Screens | Killer details on death screen | Enabled | Adds available weapon, ammunition, distance and remaining killer health. |
| Post-Raid Screens | Killer 3D model on death screen | Enabled | Shows the killer's native model, equipment and level when a visual snapshot is available. |
| Post-Raid Screens | Weapon and distance in treatment tooltips | Enabled | Adds available weapon and distance information to post-raid body-part damage tooltips. |

The menu button is always available outside raids. Legacy hotkey and menu-button settings are ignored. WebOverlay remembers the report window's size and position separately. The 50-report detail-retention limit is fixed, not a configuration option.

## Known limitations

- Fika is incompatible. No host, joining-client or headless-server support is provided.
- CombatLog is a post-raid analysis tool, not an in-raid information overlay. It does not record loot, movement routes, map positions or map replay.
- Reports cover captured exchanges of fire, not a complete ledger of every possible damage source. Environmental damage and delayed deaths may lack a direct hit event; linked events are labelled accordingly.
- Killer equipment reflects the available visible equipment snapshot at death, not a searchable inventory. Images may be unavailable; a labelled schematic icon is a fallback, not the exact item. Weapon images show the first observed configuration, not later attachment changes.
- Detailed body-zone data depends on what was captured. Unknown or older broad body parts remain unspecified rather than being assigned a precise zone.
- Overall is installation-wide and may have partial legacy coverage. Detail retention does not preserve an unlimited event history.
- The report requests its optional Barlow Condensed and JetBrains Mono typefaces from Google Fonts. Without access, local fallback fonts are used; fonts are not bundled. See [third-party notices](THIRD-PARTY-NOTICES.md).
- Mods that replace the same native post-raid screens may conflict. KillAndDamageInfo must be removed to enable CombatLog's native screen additions.

## Support

Use the comments on CombatLog's Forge mod page. Include the exact CombatLog, SPT and WebOverlay versions, expected and actual behavior, and short reproduction steps. Mention other mods that change post-raid screens, whether Fika is installed, and your display mode if the window does not open.

Attach the complete `BepInEx/LogOutput.log` from the affected session, rather than pasting thousands of lines. A no-registration file-transfer service such as Wormhole is suitable. Inspect logs and screenshots before public sharing and redact personal paths, names and private addresses. Do not upload your SPT profile, credentials or raw configuration files. CombatLog has no built-in support-package generator.

If a logging tool renames or rotates your logs, attach the complete log for the affected session instead; depending on that tool, it may be a timestamped `LogOutput-*.log` in `BepInEx/` or an archived file in `BepInEx/logs/`.

## License and credits

CombatLog is by maschine and is distributed under the [MIT License](LICENSE). It uses Anvil-WebOverlay as a separately installed dependency. Game-generated images are created from the user's installed game and are not distributed in the release ZIP. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the distinction between included files and runtime resources.
