# Third-party components and artwork

The project's own source is licensed AGPL-3.0-only. The following components retain their respective licenses and notices.

| Component | Source / license | Distribution |
| --- | --- | --- |
| Node.js 24.22.3 Windows x64 runtime | [Official Node.js](https://nodejs.org/), MIT and bundled third-party notices | Official runtime, unmodified; complete notices in runtime/LICENSE.node.txt in the installer |
| Caddy 2.11.9 Windows amd64 runtime | [Official Caddy](https://github.com/caddyserver/caddy), Apache-2.0 and upstream dependencies | Official runtime, unmodified; license in runtime/LICENSE.caddy.txt in the installer; pinned archive SHA-256 checked by the build |
| Pixelify Sans font | [Google Fonts upstream](https://github.com/google/fonts/tree/main/ofl/pixelifysans), SIL Open Font License 1.1 | Font and OFL notice under src/panel/public/ |
| Inno Setup | [Official Inno Setup](https://jrsoftware.org/isinfo.php), Inno Setup license | Build tool; the compiler is not bundled. The generated installer includes Inno Setup's standard installer engine |
| Windows launcher / ZIP helper / Java registry bridge | Own source under installer/ and src/panel/tools/ | Source included under the project's AGPL license |

The default blue-and-white wolf logo and the voxel-landscape illustration were generated for this project using image-generation tools. They are illustrative project artwork, not official Minecraft assets or photographs. The wolf replaces the creator's private server icon in the public edition. Screenshots show the actual panel with an isolated demonstration server. No Minecraft textures, player skins, user worlds or third-party mod icons are included as a bundled default mod catalog.

Build tools and dependencies used only to prepare artwork or translations are not installed with the application. The runtime UI translations are ordinary static text files.

Minecraft server binaries, Java/Temurin, loaders and mods are downloaded separately when requested. They are subject to their respective licenses, EULAs and distribution policies. They are not relicensed under this project's AGPL license. No CurseForge API key, modpack, Playit account or paid third-party plan is included.

Minecraft, Mojang, Microsoft, Java, NeoForge, Forge, Fabric, CurseForge, Playit and other names identify compatibility or external services. Their owners do not sponsor or endorse this project.
