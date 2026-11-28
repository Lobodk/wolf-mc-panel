# Changelog

## 1.1.2 — 2026-11-28

- Rename servers from their cards and see the current server name in Overview.
- Clone servers with a fresh world or regenerate a stopped server after two confirmations, archiving its previous world.
- Select a single server to start at Windows sign-in.
- Refresh the English server-management screenshots.

## 1.1.1 — 2026-11-26

- Refresh the panel with the stone theme and an updated English screenshot gallery.
- Give the sidebar larger labels, more room between entries, and clearer navigation groups.

## 1.1.0 — 2026-11-26

- Download a single setup tool from the panel to pair another Windows PC on your local network.
- Move a managed Minecraft server between the two PCs from the panel, with incremental transfer, file verification, and live progress. Each move transfers the world, mods, and settings together.
- Manage the active server through the same panel from either PC. Remote hosting uses Windows OpenSSH, encrypted SMB, and Task Scheduler.

## 1.0.8 — 2026-11-25

- Group server sections in a single scrollable navigation area and separate panel help and recovery.
- Improve the sign-in layout and place teleport controls next to the other player actions on wide screens.
- Isolate static file serving from game and mod management. Reuse unchanged assets and their checksums, with automatic refresh after edits.
- Read the desktop panel version from package metadata so the installer and the running panel report the same version.

## 1.0.7 — 2026-11-15

- Fix optional CurseForge dependencies so they can be selected and installed with a mod.
- Keep required libraries automatic and validate selected optional dependencies before installation.

## 1.0.6

- CurseForge errors now explain the cause, suggested action, operation and HTTP/error code instead of treating every 403 as an invalid API key.
- When a download is forbidden, the panel checks the project distribution setting. Confirmed author restrictions recommend downloading from CurseForge and uploading the JAR manually, without bypassing distribution restrictions.
- Added distinct errors for rejected keys, request limits (including Retry-After seconds), missing files, provider failures, connection timeouts and unreadable responses. Error text excludes credentials and raw provider responses.


## 1.0.5

- Added Relevance as the default CurseForge search order, separate from download counts. Search sorting now applies at the API before pagination, with server version and loader filters preserved.
- Changing the search-order selector runs a new compatible search. Added translations in all six interface languages.
- Removed automatic restart dialogs after mod installations and updates. Pending changes and the explicit restart control remain available.


## 1.0.4 — 2026-11-15

- Use Wolf MC Panel consistently in the launcher, installer shortcuts, documentation and all six guide languages. The launcher is WolfMCPanel.exe and the default data directory is %LOCALAPPDATA%/WolfMCPanel/data.
- Remove the obsolete alternate data-folder description and automatic selection of an earlier test-build folder. Explicit data-directory overrides still work.
- Clean up the obsolete launcher during installation updates without deleting user data.

## 1.0.3 — 2026-11-15

- Add a Forgot password guide to the sign-in screen in six languages.
- Add a locally confirmed Windows password-reset shortcut and a source-distribution recovery script. Recovery stops only the panel, revokes sessions, rotates temporary keys for all managed servers and temporarily restricts panel access to loopback.
- Preserve a backup of previous access settings and keep Minecraft processes, worlds, mods, RCON passwords and server data unchanged. Busy maintenance blocks recovery.
- Expand the English and Spanish README galleries with item/book search, settings, player access and built-in help screenshots using demonstration data.

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
