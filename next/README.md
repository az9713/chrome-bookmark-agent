# Bookmark Agent application

This directory contains the TypeScript Chrome extension, native messaging bridge, loopback companion service, React manager, JSON CLI, and ten MCP tools.

For capabilities, agent examples, installation, and integration with Claude Code, Codex, or Cursor, start with the [project README](../README.md).

From the repository root:

```powershell
npm.cmd run prepare:app
npm.cmd run check
npm.cmd run build
npm.cmd test
```

The service must be running and extension access enabled for live bookmark operations. CLI and MCP resolve the sole connected profile automatically; multiple profiles require selection by label or ID. Writes require preview and confirmation and save a backup first.

Documentation: [setup](docs/setup.md), [usage](docs/usage.md), [architecture](docs/architecture.md), [validation](docs/validation.md).
