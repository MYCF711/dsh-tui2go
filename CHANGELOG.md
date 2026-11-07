# Changelog

## 0.1.0

- First public `dsh-tui2go` bundle.
- Declares backend `dsh-go` for dsh-tui 0.19.
- HTTP `/api`, per-session `WS /ws`, one-shot `/connect` token and `sinceSeq`
  reconnect.
- Capability adapters: auth, color, compact, context, effort, goals, images,
  init, mcp, modes, placement, rename, session-operations, side-query,
  subagents, tasks.
- Real 0.19 declaration/assembly checks; no `spec.install` until
  `dsh-go-host` is published.
