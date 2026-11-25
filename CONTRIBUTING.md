# Contributing

Bug reports, accessibility feedback, translation corrections and pull requests are welcome. Check existing issues first and describe the expected behavior, actual behavior, Windows version, panel version and relevant Minecraft/loader versions. Share only sanitized logs.

Use Node 24 on Windows x64. Run node scripts/check-release.cjs and node --test tests/*.test.cjs before submitting a change. Run live-server-smoke.cjs only in an isolated directory after accepting Minecraft's EULA for that test. Never use your only world for development.

Keep platform/provider validation server-side. Do not put API keys in frontend code, persist CurseForge API metadata contrary to provider terms, silently open network services or remove backup/confirmation safeguards.

Start in `src/main.cjs` for panel startup and sessions, `src/panel/server-manager.js` for managed server lifecycle, and `src/panel/server.js` for routes inside a server. The public UI lives in `src/panel/public`. When adding a public script, stylesheet or image, register it in the explicit allowlist in `src/panel/static-assets.js`.

The UI starts with Spanish source strings; locales.json supplies the other five languages. Preserve WOLFSLOT placeholders exactly when editing dynamic translations. Do not translate resource identifiers, player names, filesystem paths or provider mod descriptions.

Contributions are provided under AGPL-3.0-only unless a file explicitly documents a separate compatible third-party license. Preserve attribution and third-party notices. This project does not require donations to participate.
