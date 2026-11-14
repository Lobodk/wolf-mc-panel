# Usage and risks

These notices explain the software's operation. They do not add restrictions incompatible with AGPLv3, replace the license, or waive rights and obligations that cannot lawfully be excluded.

- **Executable mods:** a mod can execute code with Java's operating-system permissions. Compatibility and download hashes do not prove that a mod is safe.
- **Network exposure:** forwarding a service allows incoming connections to it. Keep authentication, OS/runtime updates and firewall rules appropriate to your environment. A game hostname does not hide its resolved IP. Never forward RCON as a public service. Domain mode is intended for HTTPS through a local reverse proxy.
- **World changes:** Minecraft and mods can convert or remove world content. A backup is a snapshot, not a way to merge later progress or guarantee a downgrade. The platform-change flow backs up first but cannot automatically convert incompatible mods or recover removed blocks.
- **Restore/delete:** restoring replaces current server state. Deleting a server uses a recovery location while those files remain available. Read confirmations and retain independent backups before destructive maintenance.
- **Resources and availability:** several servers share the host's CPU, memory, disk and connection. They run only while the host and required processes are available. A successful port check cannot guarantee access from every network.
- **Third parties:** accounts, quotas, author distribution permissions, prices and availability are controlled by each provider. Mentioning a service is informational and does not imply affiliation or a contract with its provider.

Administrators decide which code to execute and which services to expose. The creator and contributors retain whatever duties apply under law and the software's actual conduct and claims. The AGPL warranty/liability terms apply only to the extent allowed by applicable law. Donations are voluntary support, not a warranty, an individual-support purchase or a blanket tax/legal exemption.

This project is not certified for every country or regulated use. Operators distributing or commercially hosting a modified version must assess their own legal, privacy, consumer and security obligations. These technical documents are not individualized legal advice.

References: [AGPLv3](https://www.gnu.org/licenses/agpl-3.0.html), [Minecraft EULA](https://www.minecraft.net/en-us/eula), [Minecraft usage guidelines](https://www.minecraft.net/en-us/usage-guidelines), [CurseForge API terms](https://support.curseforge.com/support/solutions/articles/9000207405-curseforge-3rd-party-api-terms-and-conditions), [Caddy documentation](https://caddyserver.com/docs/).
