# Third-party notices

## Included in the CombatLog archive

The archive contains the CombatLog plugin and its accompanying documentation and MIT license. Its web page, procedural mannequin, schematic equipment icons and menu icon are embedded in the plugin. It does not include third-party dependency DLLs, font files or game-generated images.

## Separately installed dependencies

CombatLog runs as a BepInEx client plugin and uses Harmony and SPT's client libraries from the installed SPT environment. Anvil-WebOverlay 1.11.0 or newer is a separate required dependency. WebOverlay supplies the browser integration and has its own dependency and license notices. The Microsoft WebView2 Runtime is also installed separately. These components are not redistributed in the CombatLog ZIP; consult their own distributions for applicable notices.

## Optional runtime fonts

The embedded page requests **Barlow Condensed** and **JetBrains Mono** through Google Fonts at runtime. The stylesheet request uses `fonts.googleapis.com`, and font files may be loaded from Google's font-hosting services. This creates an external request when the page loads; CombatLog uses local fallback fonts if the fonts are unavailable.

No font files or downloaded Google Fonts stylesheets are bundled in the CombatLog archive. This notice describes the runtime dependency; it does not grant permission to redistribute those fonts under CombatLog's MIT license.

## Game-generated images and data

Weapon, equipment and killer images are generated at runtime from the user's installed game and may be cached under `BepInEx/config/CombatLog/images/`. Item names and other game-derived information also come from the installed game. No Escape from Tarkov models, textures, item-image library or captured user images are shipped in the CombatLog archive.

The MIT license for CombatLog does not relicense third-party game content or dependencies.
