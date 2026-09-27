# Changelog

## [Unreleased]

## [1.0.0]

### Forge version notes

- Review your raids in a wide post-raid report with linked opponents, hit events, a rotatable body-zone mannequin and per-raid records.
- Compare weapon and ammunition performance, armour protection and ricochets. Shot accuracy counts cartridges correctly, including one shot per shotgun shell.
- Search saved raids by location, outcome or date and distinguish full reports from retained summaries. Overall includes your five most-used weapon models.
- See available killer equipment and fuller details on the game's kill list, death screen and treatment screen. Remove KillAndDamageInfo if you previously installed it.
- Requires Anvil-WebOverlay 1.11.0 or newer and windowed or borderless windowed mode. Intended for solo SPT 4.1.6; Fika is incompatible.

### Added

- Client-side post-raid workspace with Overview, Combat and Weapons & ammo views, opponent filters, a zoomable and pannable combat timeline, distance bands and linked event selection.
- Procedural, rotatable mannequin with 25 detailed body zones, heat contrast and matching zone-button highlights.
- Outgoing and incoming hit evidence, pre-armour and post-armour body damage, blocked hits and ricochets.
- Per-weapon and per-ammunition cartridge accuracy, separate projectile statistics and handbook-priced ammunition estimates. Repeated weapon models show individual instance labels.
- Killer details, full-body imagery, visible equipment and game-generated item images with labelled schematic fallbacks.
- Evidence-linked raid records and a distinction between direct fatal hits and later deaths linked to earlier hits.
- Persistent raid history with 50 detailed reports and retained summaries; Overall totals, outcomes, location statistics and model-based top-five weapon rankings with explicit coverage.
- Native post-raid kill-list, death-screen and treatment-tooltip additions with independent configuration controls. Unidentified non-scav kill-list entries do not reveal ammunition.
- Menu-bar access without an opening hotkey, Escape and close-button dismissal, remembered window placement and an explicit pre-first-raid state.
- Release documentation and an installable client package containing the mod and notices without bundled dependencies or game assets.

### Changed

- Capture accounting separates cartridges, projectiles and damage contacts; older reports retain their recorded evidence without inventing missing counters.
- Post-raid work is deferred out of raid-stop handling, and equipment rendering, image caching and history detail retention are bounded.
- Full-body captures use an isolated camera and dedicated key/fill lighting, with guarded restoration of model, shader, lighting and render state after success or failure.
- Release-document checks cover required content, source-backed configuration and dependency facts, version consistency and malformed release notes.

### Fixed

- Shotgun pellets no longer inflate the displayed cartridge count or cartridge-priced ammunition estimate.
- Kill-list ammunition follows the game's victim-identification rule instead of revealing unidentified non-scav details.
- The initial session state no longer presents a nonexistent raid as survived at an unknown location.
- Selecting a combat timeline marker automatically brings its matching event into view without forcing scrolling during playback.
- Newly generated killer images have more even upper-body lighting. Images already saved in the raid archive are unchanged.
