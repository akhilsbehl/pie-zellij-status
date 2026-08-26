# pie-zellij-status

A pragmatic Pi extension that mirrors Pi attention state into the current Zellij session.

## State model

- `idle`: Pi has settled and is ready for a new task. It is cleared by the next chat input.
- `waiting`: Pi is waiting for a user decision in one of the supported current extensions. It remains until the interaction resolves.
- No `running` state is displayed.

The extension is intentionally Zellij-only. It exits without changing anything unless `ZELLIJ_SESSION_NAME` and `ZELLIJ_PANE_ID` are present.

## Current integrations

The effective runtime inventory was checked with `kohai`, then reconciled with
Pi settings and the source imports used by the ambient `pie-damare` extension.
This is wider than `pi list`: two packages are loaded by `pie-damare` even
though their settings entries explicitly set `extensions: []`.

| Extension/package | How it is loaded | Version or revision |
| --- | --- | --- |
| `pie-damare` | Ambient `~/.pi/agent/extensions/pie-damare.ts`; also composes `pi-bg-tasks` and `pi-subagents` | `329ef0a` |
| `pie-jina` | Ambient `~/.pi/agent/extensions/pie-jina.ts` | `3407fed` |
| `pie-permission-auto-review-codex` | Ambient `~/.pi/agent/extensions/pie-permission-auto-review-codex` | 0.1.4 |
| `pie-zellij-status` | Ambient symlink plus this project package | current checkout |
| `pi-bg-tasks` | Dynamically invoked by `pie-damare` | 0.1.2 |
| `pi-subagents` | Dynamically invoked by `pie-damare`; the active `kohai` run is runtime evidence | 0.56.0 |
| `pi-openai-server-compaction` | Configured Git package | 0.1.0 |
| `pi-agent-browser-native` | Configured npm package | 0.5.0 |
| `@narumitw/pi-starship` | Configured npm package | 0.52.2 |
| `pi-context-view` | Configured npm package | 0.4.3 |

`pie-permission-auto-review-codex` emits the versioned
`pie-permission-auto-review-codex:permission-confirmation:v1` event immediately
before and after its agent-originated `ctx.ui.confirm`. The payload is
`{ requestId: string, active: boolean }`; only the request id and active state
are exposed. This adapter tracks request ids idempotently, treats malformed
payloads as no-ops, and clears its subscription at shutdown. Resolution,
rejection, and cancellation all emit `active: false`. Model review,
deterministic allows, redirects, no-UI blocks, and user-invoked configuration
menus do not emit this event. Subagent execution and background work are also
not user decisions, so they remain `running`, not `waiting`.

The extension acknowledges itself through
`subagent:acknowledge-extension` when loaded in a delegated child. This lets
`pi-subagents` report verified child-runtime registration through
`runtimeAcknowledgedExtensions`; absence of that metadata remains meaningful.
Child launch policy can still disable ambient extensions, so this inventory is
for the current setup/session, not a claim about every child process.

## Naming

Status values are appended to the current pane and tab names. The extension strips only its own trailing status suffix before appending a new one. It does not restore names on shutdown yet because these names are dynamic by design.

Examples:

```text
my-pane [☼ Idle]
my-pane [◷ Waiting]
my-tab [☼ Idle 0 / ● Running 1 / ◷ Waiting 0]
```

## Bell

A Zellij visual bell is produced by the Zellij pane when a waiting transition is displayed. Configure Zellij with `visual_bell true`. The extension does not use Windows notifications.

## Future package integration

When installing a package that might ask the user to make a decision:

1. Inspect the package source for `ctx.ui.select`, `input`, `editor`, `confirm`, and `custom`.
2. Determine whether the UI is agent-originated or only a user-invoked command menu.
3. Prefer a package-emitted event on `pi.events` with a start/end or active boolean.
4. If no event exists, identify a stable tool lifecycle or persisted state that proves the agent is waiting.
5. Add the smallest adapter to `extensions/pi-zellij-status.ts`.
6. Update this document with the package version, event/tool/state used, and known limitations.
7. Test both resolution and cancellation. Avoid treating every tool call or every UI primitive as waiting.

This is a deliberate pragmatic adapter pattern. Pi currently has no universal lifecycle hook around UI primitives.
