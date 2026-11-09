# dsh-tui2go

`dsh-tui2go` is a third-party **AgentBackend bundle** that lets
[`dsh-tui`](https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui) talk to
the Go host **DSH-GO** (`dshd`). It adds one backend, `dsh-go`, to the TUI
`/kernel` picker.

It is not a TUI fork and not a Go-host plugin. The package ships the declaration,
the lazy `backend` handler and the pool hook; the assembly chain stays in the TUI.

## Compatibility

| dsh-tui2go | DSH-GO host | dsh-tui |
|---|---|---|
| `0.1.x` | `0.2.2-go.*` | `^0.19.0` |

TUI 0.18 is not supported. `dsh-go-host` is not published on npm, so this
package deliberately declares **no** `spec.install` recipe; install `dshd`
yourself and point `DSH_GO_DSHD` at it.

## Install

```bash
# 1) install the bundle into the TUI profile
dsh plugin --profile dsh-tui add -w dsh-tui2go

# 2) build/run DSH-GO and note the ready line
dshd serve --home <home> --addr 127.0.0.1:0
# ready {"url":"http://127.0.0.1:<port>","token":"<token>"}

# 3) launch the TUI with this backend
dsh-tui --backend dsh-go
```

The TUI reads the host URL/token from its own connection flow. In standalone
mode, pass `--base <url> --token <token>` explicitly.

Approval policy is the **host's** decision, not this bundle's: with
`DSH_GO_POLICY` unset the backend passes no `--policy` at all, so `dshd serve`'s
own default (`allow`) applies. An explicit `DSH_GO_POLICY=deny|ask|allow` is
passed through verbatim; any other non-empty value refuses to launch.

## Runtime contract

| Variable | Required | Meaning |
|---|---|---|
| `DSH_GO_HOME` | yes | DSH-GO home (sessions, tool state) |
| `DSH_GO_DSHD` | no | path to `dshd` (default `dshd` on `PATH`) |
| `DSH_GO_POLICY` | no | unset = no `--policy` is passed (the host default, `allow`, decides); `deny`/`ask`/`allow` are passed through verbatim |
| `DSH_GO_MODEL` | no | model override, as the gateway's fully-qualified id (`group/...`) |

Transport: `POST /api/<method>`, one-shot `GET /connect?token=` and `WS /ws`.
Requires TUI `0.19.0` and Go host `0.2.2-go.*`.

## Validation

```bash
npm install --ignore-scripts
npm run build
npm run typecheck
npm test
npm pack --dry-run
```

The public suite is unit-level and runs without a local 0.19 checkout. Real
0.19 assembly/conformance evidence is kept out of the public repository.

## Workspace capability (known dependency)

`/workspace` is not a backend-session capability: TUI 0.19's non-DSH channel
hard-codes its workspace actions to unavailable (`dsh-adapter/channel/action-readiness.js`,
`listWorkspaces`/`switchWorkspace`/...), while `TuiWorkspaceProvider` is only
consumed by the DSH extension. This bundle now ships a real
`src/workspace.ts` port and a reproducible **temporary-profile** overlay
(`PLAY-WORKSPACE-PORT/overlay`); the overlay is fixture-tested and must not be
mistaken for a whole-chain GO. DSH-GO still needs the workspace registry and
`workspace.list/resolve/switch/rename/remove/commands` host methods before the
port can be exercised against a real dshd; `workspace.init` remains the only
currently wired host method. See `tmp/GO2-TEAM/PLAY-WORKSPACE-PORT/RESULT.md`.
This bundle does **not** hide or fake workspace support.

## Status

`0.1.0` is the first public bundle. The TUI 0.19 profile launcher currently
hits broken upstream `workspace:*` publishes in `@deepseek-ai/cordis-plugin-*`
and `@deepseek-ai/dsh-session-persistence`; the package itself builds, packs and
passes the 0.19 assembly checks. See `CHANGELOG.md`.

## License

MIT
