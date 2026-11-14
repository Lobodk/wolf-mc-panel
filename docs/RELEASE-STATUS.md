# Release scope

Wolf MC Panel 1.0 targets Windows x64, local Minecraft Java processes, and browser administration through local-only, trusted-LAN or HTTPS-domain access. The installer includes Node and Caddy and keeps application data separate from program files.

Version catalogs are dynamic. A listed version or loader is a provider-supported installation choice, not a claim that every historical Minecraft version, modpack or combination has been manually tested. Forge, NeoForge and Fabric mods are not interchangeable. Some live telemetry and modded item features require a compatible bridge.

Minecraft platform changes make a backup first and reject downgrades of existing worlds. This release does not automatically convert mods, guarantee all mod updates for a future Minecraft release, or merge world progress across restores. Linux, Docker, multi-host worker agents, cloud-hosted accounts, multi-user role management and automatic installer updates are outside this release's supported scope.

The installer is unsigned. HTTPS certificate issuance depends on the operator's real DNS/network; isolated TLS validation tests are not a test of every ISP or public domain. There is no claim of a clean-VM test, independent penetration test, global legal certification or guaranteed uptime unless explicitly documented with evidence.

See TEST-RESULTS.md for the actual checks and their limits.
