# Release verification

## 1.0.4

80 automated checks pass, including canonical data-directory selection, explicit overrides and product-name consistency across the README and five translated guide catalogs. Installer validation uses WolfMCPanel.exe and checks obsolete-launcher cleanup while preserving passwords, preferences, recovery and server data. The creator’s separate personal Minecraft installation is not moved or renamed.

## 1.0.3

77 automated checks pass. Eight recovery regression checks cover local confirmation, temporary-key rotation, old-password rejection, session revocation, preservation of world/RCON data, managed child keys, invalid paths/configuration, maintenance refusal and unexpected local services. Installer validation includes recovery of an isolated test installation. The creator’s personal login screen was updated without changing its existing password, hosting settings or Minecraft process. Screenshots use a separate demo profile.

## 1.0.2

69 automated checks pass, including translated tooltip variants, duplicate labels across mods, colliding mod display names, registry refresh, stable ordering and identifier lookup. A real 5,787-item server catalog retained every entry and went from 93 duplicate-name groups to zero. Installer lifecycle validation and SHA-256 receipts are attached to the release. The book update was also verified against the private live server: 128 generated book variants, six language searches, exact level matching, and a valid Protection IV give-command parse using a non-matching player selector (no items delivered). The owner confirmed the panel worked before publication. Resource definitions provide enchantments on older snapshots; an exported live enchantment registry takes precedence when present. These checks do not establish compatibility with every custom datapack. No Minecraft world lifecycle test was repeated for this panel change.

## 1.0.1

64 automated checks pass on Windows, including regression coverage for tutorial persistence, guide acknowledgement, branding changes, new browsers, blocked browser storage, repeated authentication events, cancelled timers and arrow placement on desktop/narrow screens. The actual browser review covered opening the guide, returning to the panel, another login, the updated arrow and a 620-pixel responsive viewport. Installer validation also checks that the completion flags survive a reinstall.

The 1.0.1 release attaches its own installer checksum and validation receipt. The real Minecraft world lifecycle test below was performed for 1.0.0; 1.0.1 changes onboarding/UI state and does not claim that this world test was repeated.

## 1.0.0

Prepared on 2026-11-14 for Windows x64. Test evidence is specific to the checked configuration, not a guarantee for every Minecraft version, modpack or network.

| Check | Evidence / scope |
| --- | --- |
| Automated suite | 55 passing tests, zero failures and zero skips in the Windows source/build checks. Includes authentication and session revocation, origin/host validation, ZIP safety, staging, server isolation/recovery, MOTD round trips and five translation catalogs. |
| Real Minecraft lifecycle | Official vanilla Minecraft 26.3, Java 25, isolated flat world and separate loopback game port. Created and started the server, placed and saved a diamond block, backed up while online, changed it to gold, restored the backup, restarted and confirmed the diamond block returned. No existing user world was used. |
| Real HTTPS transport | Started the official Caddy runtime and connected through TLS using an isolated test certificate explicitly trusted by that request. Verified certificate validation, HTTPS login, Secure/HttpOnly/SameSite cookies, rejection of the bootstrap key after password setup, backend/origin restrictions and authenticated requests. No system certificate-store change or TLS bypass. |
| Installer lifecycle | Per-user Windows install, EXE launch, empty initial server list, personal password creation, reinstall preserving password/preferences/data, EXE stop and uninstall preserving data. A release attachment records the actual installer SHA-256 and results. |
| UI review | Real in-app-browser review of overview, creation wizard, appearance, performance, initial tour and home; switching English, German, French, Turkish and Portuguese controls, then returning to Spanish. Screenshots use isolated demonstration data. |
| Existing installation | Applied the shared UI/auth/hosting improvements to the creator's separate personal panel. Its protected configuration files were verified byte-for-byte unchanged; the original Minecraft Java process stayed running. No private data from that installation is included here. |
| Distribution check | Source syntax, excluded generated/private state and local-profile/private-key pattern checks. Runtime downloads have pinned or official checksum checks. These checks are not a full secret-detection or penetration-test certification. |

The supplied GitHub Actions workflow repeats source/build checks and installer install/reinstall/uninstall on a fresh hosted Windows runner. Its current status is shown in the repository's Actions tab; a workflow definition alone is not evidence that a run passed.

Not claimed: an independent security audit, code signing, tests of every historical loader/Minecraft/mod combination, public certificate issuance on every operator network, full mod/world conversion across versions, or worldwide legal certification. External provider quotas and author download restrictions remain outside the panel's control.
