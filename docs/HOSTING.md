# Hosting and recovery

Wolf MC Panel runs on the Windows computer that executes Minecraft. You can use that computer locally, administer it over a trusted LAN, or expose its administrative website through your own HTTPS domain. A game hostname and an administrative hostname are separate.

## Local only (default)

Run the installer or node src/main.cjs. The web server binds to 127.0.0.1 and validates the requested hostname. Open the address printed at launch. A nearby free web port is selected if the preferred port is occupied. No router forwarding is needed for local administration.

## Trusted LAN

In Connection of the panel, choose LAN access, save, and restart the panel. This binds the web listener to the host's interfaces but accepts private IPv4/loopback peers and explicitly permitted local hostnames. Enter an additional local name if your local DNS or hosts file provides one. The app does not silently modify another computer's hosts file.

Use the server PC's LAN address and panel port from another device. Allow the panel through Windows Firewall on a trusted private network if necessary. Plain HTTP on a LAN does not encrypt your password or session; use a trusted network, a VPN, or HTTPS when confidentiality is required. Do not forward this HTTP backend from your router.

## Your domain with HTTPS

1. Set a personal password locally first. The bootstrap key is not accepted in public-domain mode.
2. Own or control a domain and point its DNS A/AAAA records at this host. Resolve CG-NAT/double NAT with your provider or use a suitable reverse-proxy arrangement.
3. Provide inbound web access for Caddy, normally TCP 80 and 443. These are not Minecraft's game ports. Check for another web service already using those ports.
4. In Connection of the panel, select domain mode and enter a complete HTTPS origin without a path, for example https://panel.example.org.
5. Choose managed HTTPS to use the included official Caddy binary, or use the generated Caddy configuration with your own proxy on the same host. Save and restart the panel.
6. Confirm that the browser shows a valid certificate for your exact domain, then sign in. Do not bypass certificate warnings.

In domain mode the backend binds only to loopback and accepts the configured hostname and HTTPS forwarding headers from the local proxy. Authentication cookies are HttpOnly, SameSite=Strict and Secure. Changing the personal password revokes existing sessions. Login attempts are rate limited. This remains a powerful single-administrator application: anyone with access can run commands, install executable mods and manage worlds.

The managed Caddy instance disables its administrative API and stores its own configuration, certificate data and logs under the application's data directory in https/. The panel stops only its own proxy process when it closes. Certificate issuance and renewal depend on valid DNS, reachable challenge ports and the certificate authority. See [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https).

A non-default HTTPS port can be configured in the origin; automatic certificate challenges still need an appropriate externally reachable validation path. For complex TLS/DNS arrangements use your own local reverse proxy and Caddy's official documentation.

## Source installation

Use Node 24 on Windows. The backend has no npm runtime dependencies. Run scripts/fetch-caddy.ps1 to obtain the pinned official Caddy executable with checksum validation, or set WOLF_CADDY_EXE to an existing official binary. Keeping the Node/Caddy binaries updated is part of maintaining your installation. Never put API keys into frontend files.

## Recover local access

Use the Windows Start-menu shortcut Recover local access, or run the desktop launcher with --local. It stops the identified panel instance, switches its hosting configuration to local only and starts it again. It does not stop Minecraft or reset your password.

If you forget your password, stop the panel, back up auth.json in its data directory and rename it to auth.json.old. Restart locally to regenerate the initial-access instructions, sign in and set a new password. Treat access to the data folder as administrator-level access to this application.

Keep both program and data backups before moving machines. Copying program files alone does not copy your worlds. This release does not provide remote worker agents or support Linux/Docker deployment.


## Forgotten password

On the Windows PC that hosts the panel, choose **Start → Wolf MC Panel → Restablecer contraseña** and confirm the local Windows prompt. The browser’s **I forgot my password** button explains these steps; it cannot reset access remotely. Source users can run `scripts/recuperar-contrasena.ps1` in PowerShell. The personal installation has a separate Windows recovery shortcut.

The tool refuses to interrupt active panel maintenance. It closes the panel and its sessions, saves previous access settings under `recovery-backups`, rotates the temporary key in the main and managed-server configurations, and switches web access to this PC only. Minecraft processes, worlds, mods and RCON passwords remain unchanged. A new local access-key file opens. Use it to sign in and set a personal password, then explicitly re-enable LAN or HTTPS if needed. Existing router forwarding rules are not changed.

Anyone who controls the server’s Windows account can already read or modify its files; protect that account and its backups. Do not share temporary keys or recovery backups. Recovery is not an email service and does not expose an unauthenticated reset API.
