# Contributing

The primary implementation is in `next/`: TypeScript source, a Manifest V3 extension, React manager, and CLI/MCP clients.

From the repository root:

```powershell
npm.cmd run prepare:app
npm.cmd run check
npm.cmd run build
npm.cmd test
```

Build before testing: integration tests launch compiled CLI, MCP, native-host, and service code. Fixtures use synthetic profiles and temporary credentials. Tests must never require real Chrome bookmarks or native-host registration.

Keep profile selection unambiguous. Preserve preview/confirm behavior, session-bound plans, scope checks, backups before dispatch, and the rule against retrying unknown write outcomes. Treat bookmark titles and URLs as untrusted input.

Do not commit `.runtime`, credentials, real bookmark exports, backups, or local validation output. Use synthetic examples and screenshots.

Optional browser tests are described in [validation.md](next/docs/validation.md). Windows CI also tests the C# launcher. Native-host activation is a separate local action documented in [setup.md](next/docs/setup.md).
