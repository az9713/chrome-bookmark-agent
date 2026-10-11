# Validation

From the repository root:

```powershell
npm.cmd run prepare:app
npm.cmd run check
npm.cmd run build
npm.cmd test
```

The Node suite currently contains 34 tests and passed on Windows with no failures or skips. Tests use synthetic bookmark profiles and temporary credentials; they do not register the extension or alter real Chrome bookmarks. Build first because tests launch compiled service, CLI, MCP, extension, and native-host code.

Coverage includes:

- Read/search filters, pagination, duplicate grouping, and rediscovery.
- Bookmark and folder creation, updates, moves, recursive deletion, managed protections, and partial failure receipts.
- Authentication, exact loopback Host/Origin checks, automatic manager sessions, and cross-origin rejection.
- Preview/confirm, one-shot and expired plans, full backups, stale-tree rejection, disconnects, unknown write outcomes, and cross-session preview isolation.
- Real CLI child processes and official MCP SDK stdio clients, including synthetic preview/commit operations.
- Automatic sole-profile selection, multi-profile label/ID selection, ambiguous and unmatched profile rejection, optional MCP selectors, and npm-linked CLI startup.
- Folder scopes, descendant/direct-only reads, overlapping folder unions, excluded target/destination rejection, protected scope roots, and retained preview scope.
- Built extension worker checks with a mocked Chrome API, native binary framing, Unicode, and the compiled Windows C# launcher.
- UI tree indexing, inherited managed-folder protections, and a synthetic 70,000-node library.

GitHub Actions builds and tests on Windows and Ubuntu. The Windows-only C# launcher test is skipped on other operating systems; passing portable tests does not imply macOS/Linux native-host activation support.

## Optional browser checks

The browser manager scripts use synthetic profiles. Install Playwright and its Chromium browser in an independent tooling directory, then set `PLAYWRIGHT_MODULE` to that installation's `playwright` package path. From `next/`, run:

```powershell
node scripts/ui-smoke.mjs
node scripts/ui-scope-smoke.mjs
```

These cover automatic connection without token entry, search submission and stale-result handling, domain/folder filters, pagination, zero results, scoped reads and writes, preview/confirm, export, and responsive layouts. The previous local browser runs passed twelve general checks and five scope groups with no page JavaScript errors. Reports and screenshots are written to ignored `next/output/playwright/`.

Runtime state, live-profile reports, credentials, and private bookmark data are excluded from the repository. Automatic rollback, cross-machine access, and non-Windows activation remain outside the validated feature set.
