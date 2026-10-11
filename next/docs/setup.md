# Windows setup and activation

Bookmark Agent consists of the extension and a local companion service. Follow these instructions after cloning the repository. Setup registers the native messaging host for your Windows account; Chrome extension loading and access enablement are separate steps.

## 1. Prepare

```powershell
cd C:\Projects\chrome-bookmark-agent\next
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm test
npm run init-local
```

`init-local` only writes `next/.runtime/config.json` with fresh API and bridge tokens; it does not activate access. Keep `.runtime` private and out of source control. Use `BOOKMARK_AGENT_HOME` only if you deliberately want a different configuration directory; the native launcher and agent clients must agree on it. To change the port before activation, edit `port` in that local JSON to a free value in 1024–65535.

## 2. Activate deliberately

Run only after approving local Chrome access:

```powershell
npm run setup -- --activate
```

This script restricts `.runtime` ACLs to the current Windows user and SYSTEM, compiles the Windows launcher, records the stable extension ID in config, writes the native-host manifest, and registers `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.bookmark_agent.next`. It refuses to overwrite a registration belonging to another installation directory. No administrator rights or scheduled service are used.

The launcher requires the existing Windows .NET Framework C# compiler under `%WINDIR%\Microsoft.NET\Framework[64]\v4.0.30319`. Setup stops if it is unavailable. Moving the folder or changing the Node executable requires rebuilding/re-registering the launcher. Check that the recorded extension ID matches Chrome after loading.

## 3. Start service and load extension

```powershell
npm start
```

Keep that terminal open. In the chosen Chrome profile, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `next/dist/extension` (the built output, not the source `extension` folder). Click Bookmark Agent's toolbar action to open its settings. Enter a recognizable profile label and explicitly check **Enable local bookmark access**. Save the settings. The status shows the persistent profile ID and current session ID once connected.

For initial testing, use a separate empty Chrome profile. Automated fixture tests do not activate the extension or touch real profiles. The extension requests `bookmarks`, `nativeMessaging`, `storage`, and `alarms`; it has no host permissions or content scripts.

## 4. Open manager and configure agents

Open **Bookmark manager** from extension settings, or visit `http://127.0.0.1:32180/` using the configured port. The manager connects automatically without asking for a token. A single connected profile is selected automatically; when multiple profiles are connected, choose the intended one. Changes still require a preview and confirmation. CLI/MCP clients continue loading their credential from local configuration. The service is available only on this computer.

```powershell
npm run cli -- status
```

Configure local agent clients only after reviewing the scope they will receive; examples are in [usage.md](usage.md). No client config is installed automatically.

## Disconnect and troubleshoot

- Disable access in extension settings to disconnect that profile. Disable/remove the extension to revoke it completely.
- Stop `npm start` with Ctrl+C to stop the service. Restarting it reconnects enabled profiles with fresh session IDs; CLI/MCP resolve the sole connected profile automatically.
- **Native host not found:** run the deliberate registration command and verify the built extension ID matches its allowed origin.
- **Service offline:** start `npm start`; if the port is occupied, choose another in local config and restart the service/native connection.
- **NOT_CONFIGURED:** create config from this candidate folder, or align `BOOKMARK_AGENT_HOME` across launcher, CLI and MCP.
- **DISCONNECTED:** check Chrome settings/status and retry the read after reconnecting. Omit an outdated explicit session ID so CLI/MCP can resolve the current connection.
- **PROFILE_REQUIRED:** multiple profiles are connected; use `--profile 'Your profile label'` in CLI or `profile` in MCP.
- **STALE_PREVIEW:** preview again after inspecting the current bookmark state.
- **OUTCOME_UNKNOWN:** inspect the tree and supplied backup; do not replay blindly.

After disabling/removing the candidate extension, unregister its native host:

```powershell
npm run uninstall
```

Uninstall preserves config and backup files. It checks that the registration belongs to this installation.

The Node service and MCP/CLI are portable, but the provided activation script supports Windows only. macOS/Linux native-host registration is not implemented or validated in this candidate; use [Chrome's official native-host locations](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) with a reviewed executable wrapper and allowed extension origin if porting it.
