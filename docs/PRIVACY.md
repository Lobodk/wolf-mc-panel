# Privacy

Wolf MC Panel stores its application state on the computer where it runs. It does not include advertising, tracking pixels or automatic telemetry uploads to the creator. There is no central Wolf MC Panel account or hosted account database.

## Data on your host

Local data may include the panel password's salted scrypt hash, an internal machine-control key, your API credentials, server configuration, console output, player names/UUIDs/IP addresses recorded by Minecraft, worlds, backups and audit actions. A personal password is not stored in plaintext. Session tokens are random, retained server-side as hashes and expire; closing the panel invalidates its in-memory sessions. A language preference and guided-tour state are stored by the browser.

Changing the password revokes existing sessions and disables the initial login key. The internal control key remains local for the desktop launcher. Anyone who can read or modify your data directory may be able to control this application and its servers. Protect that folder and your backups using Windows account permissions and disk security.

## External connections

Version catalogs and downloads contact Mojang/Microsoft, the selected loader's provider, Adoptium/Temurin and mod distribution services as needed. CurseForge API use sends the authorized key to CurseForge and requests project/file information; the panel does not persist API-derived project metadata as a reusable disk cache. Metadata read directly from installed JAR files may be indexed locally. Provider logos/descriptions displayed during a search can require browser requests to provider-controlled hosts.

Managed HTTPS contacts the certificate authority used by Caddy and public DNS. Domain certificates may be recorded in public certificate-transparency logs. Clicking Ko-fi, router support or other external links opens that third party's site under its own privacy policy. These providers can observe connection information such as the connecting IP. No promise is made about their retention or availability.

## Your players and support

If you host a server, inform players about the data you collect and meet any applicable privacy/retention obligations. Before sharing logs or reporting a problem, remove passwords, API keys, tokens, IPs and private world information. Public GitHub issues are public.

Uninstalling preserves application data deliberately. Delete it yourself only after exporting any worlds/backups you want to retain. The project does not have a remote deletion service because it does not operate a central copy of your local data.
