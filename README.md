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
dshd serve --home <home> --addr 127.0.0.1:0 --policy ask
# ready {"url":"http://127.0.0.1:<port>","token":"<token>"}

# 3) launch the TUI with this backend
dsh-tui --backend dsh-go
```

The TUI reads the host URL/token from its own connection flow. In standalone
mode, pass `--base <url> --token <token>` explicitly.

## Runtime contract

| Variable | Required | Meaning |
|---|---|---|
| `DSH_GO_HOME` | yes | DSH-GO home (sessions, tool state) |
| `DSH_GO_DSHD` | no | path to `dshd` (default `dshd` on `PATH`) |
| `DSH_GO_POLICY` | no | `ask` (default), `allow`, `deny` |
| `DSH_GO_MODEL` | no | model override |

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

## Status

`0.1.0` is the first public bundle. The TUI 0.19 profile launcher currently
hits broken upstream `workspace:*` publishes in `@deepseek-ai/cordis-plugin-*`
and `@deepseek-ai/dsh-session-persistence`; the package itself builds, packs and
passes the 0.19 assembly checks. See `CHANGELOG.md`.

## License

MIT
