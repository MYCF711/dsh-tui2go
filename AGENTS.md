# AGENTS.md · dsh-tui2go

Agent-facing orientation for this repository. Keep it short; the code is the
source of truth.

## What this is

A single-package TypeScript **TUI AgentBackend bundle** named `dsh-tui2go`.
It declares one backend, `dsh-go`, and adapts the Go host `dshd` (DSH-GO) to the
`@deepseek-harness-tui/dsh-tui` 0.19 `AgentBackend` contract.

Not in scope: TUI core changes, Go host changes, Electron/WebView, a second
backend, or vendoring TUI internals.

## Layout

```text
src/index.ts             module namespace: backend / closeDshGoPool / manifest
src/backend.ts           AgentBackend + AgentSession implementation
src/transport.ts         HTTP /api + WS /ws + token + sinceSeq reconnect
src/events.ts            server frames -> AgentEvent translator
src/{auth,color,compact,context,effort,goals,images,init,mcp,modes,
     placement,rename,session-operations,side-query,subagents,tasks}.ts
                         capability adapters
src/{presentation,backend-manifest,refs,image-size}.ts
                         runtime values (the .d.ts files are types only)
src/types/agent/         vendored 0.19 type surface (do not edit by hand)
dsh-plugin.json          package-root declaration
cordis.patch.yml         [] — backend-only bundle
test/unit/               node:test + tsx
test/assembly/           real 0.19 declaration/assembly chain
scripts/                 conformance/assembly drivers
```

## Commands

```bash
npm install --ignore-scripts
npm run build           # tsc -> lib/
npm run typecheck
npm test                # build + assembly checks
node --import tsx/esm --test test/unit/*.test.ts
```

## Hard rules

- Only one writer per file. Do not edit `src/types/agent/**`; it is a vendored
  0.19 type surface.
- The backend id is `dsh-go`; the package name is `dsh-tui2go`. Do not rename.
- Do not declare `spec.install` until `dsh-go-host` is actually published.
- `grants` must stay `[]`; adding a grant hides the backend from the picker.
- Capability keys must be a subset of the manifest.
- No mock-only claims: assembly checks must use the real 0.19 package.
- Never commit `node_modules/`, `lib/`, logs, tokens or local absolute paths.
- TUI 0.18 is unsupported; compatibility is 0.19.x.
- Chinese or English is fine; keep public docs free of private hosts,
  credentials and internal task ledgers.

## Validation bar

A change is done only when `npm run build`, `npm run typecheck` and `npm test`
all exit 0, and `npm pack --dry-run` contains the expected files. Real
TUI+dshd conformance is a separate gate; unit/assembly green is not “playable”.
