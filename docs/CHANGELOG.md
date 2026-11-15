# Changelog

## 1.0.2 — 2026-11-15

- Distinguish smithing templates by their translated upgrade or armor trim, banner patterns by their design, and music discs by their track.
- Automatically qualify duplicate item names from installed mods without hiding registry entries; searches include both the original label and the distinguishing detail.
- Rebuild these labels when the server item registry or mod languages change. No Minecraft restart is required for this panel-only fix.
- Search and select enchanted books by enchantment and level, including Protection IV, Unbreaking III and Mending. Give commands carry the selected stored enchantment and reject unrecognized variants.
- Match item, enchantment and variant names to the selected panel language: Spanish, English, German, French, Turkish or Brazilian Portuguese, with available-name fallback for untranslated mods.
- Fix exact numeric/Roman level matching and keep book variants separate from base registry items.

## 1.0.1 — 2026-11-14

- Remember completion of the first-run tutorial on the panel host, including new logins, browser changes and panel restarts. Manual replay remains available.
- Hide the guide reminder after the first guide visit, including direct links and opening the guide in another tab.
- Place the tutorial arrow between the nearest card and guide edges, with responsive positioning and no looping line beneath the card.
- Preserve both completion flags when changing the panel name/logo and when reinstalling.
- Refresh the relevant browser assets on upgrade and update the tutorial screenshot.

## 1.0.0 — 2026-11-14

First public Windows x64 release of Wolf MC Panel.

- Independent server home, creation wizard, official version/loader catalogs and separate network settings.
- Console, player access and actions, configuration, performance, diagnostics, tasks and recoverable server removal.
- Manual and optional automatic backups, rotation and restoration with a safety copy. ZIP handling no longer depends on WinRAR.
- CurseForge search and compatible updates with a user-provided API key, dependency review, installed-state detection and changes queued until restart.
- Visual MOTD editor with decorative text styles, colors, gradients, previews and preserved advanced formatting.
- Custom panel name/logo, the new default wolf icon, onboarding tour and built-in hosting/router/API guide.
- Spanish default plus English, German, French, Turkish and Brazilian Portuguese selectors.
- Local-only default; trusted LAN and HTTPS-domain options with the official Caddy runtime, personal passwords, protected cookies and recovery to local access.
- Open-source AGPLv3 distribution, source/build tools, privacy/third-party/security documentation and optional Ko-fi support.

World/version changes require compatible mods and prior backups; automatic conversion of incompatible mods and multi-host agents are not part of this release.
