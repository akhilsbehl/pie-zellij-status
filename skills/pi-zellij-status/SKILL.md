---
name: pie-zellij-status
description: Extend the pie-zellij-status extension when a new Pi package introduces user-blocking interactions. Use this skill to inspect the package source, distinguish agent waiting from user-invoked UI, choose an event/tool/state adapter, and document the integration.
---

# Extending pie-zellij-status

Read `README.md` in the pie-zellij-status project before changing the extension.

## Decision procedure

1. Identify every interaction the package can display.
   Search for:

   ```text
   ctx.ui.select
   ctx.ui.input
   ctx.ui.editor
   ctx.ui.confirm
   ctx.ui.custom
   pi.events.emit
   registerTool
   registerCommand
   ```

2. Classify each interaction:
   - Agent-originated: the model called a tool or the agent workflow reached a decision point. This can set `waiting`.
   - User-originated: the user typed a command such as `/compact`. Do not set `waiting` merely because that command opens a menu.
   - Background work: long-running work without user input. Do not set `waiting`.

3. Prefer signals in this order:
   - A public package event on `pi.events` that brackets the interaction.
   - A specific tool's `tool_execution_start` and `tool_execution_end`, if the tool itself waits for the user.
   - A stable persisted state that proves a decision menu is being presented.

4. Do not mark every tool call as waiting. Most tools run without user attention.

5. Do not infer waiting from question marks in assistant text.

6. Add the smallest adapter to `extensions/pi-zellij-status.ts`.

7. Update `README.md` with:
   - package name and version
   - interaction covered
   - event, tool, or state used
   - cancellation and resolution behavior
   - known limitations

## Existing adapters

The permission waiting adapter subscribes to
`pie-ez-pass:permission-confirmation:v1`. It accepts only
payloads with a non-empty string `requestId` and boolean `active`, tracks
request ids idempotently, and removes the subscription at shutdown. The
permission package emits the matching inactive event in a `finally` block, so
resolution and cancellation clear waiting. Do not infer waiting from the
permission package's model review or generic `tool_call` hook.

`pi-bg-tasks` and `pi-subagents` are composed dynamically by the ambient
`pie-damare` extension. Their background work, delegation, and supervisor
messages are not user decisions and must not set `waiting`. The status adapter
tracks `subagent:async-started`, `subagent:async-complete`,
`subagent:foreground-complete`, and `subagent:process-terminal` to show a
`subagent` pane status while the parent is idle. Tab tallies use the icons and
initials `☼ I`, `● R`, `◷ W`, and `◆ S`; legacy tally formats are accepted while
renaming.

This extension emits `subagent:acknowledge-extension` in delegated child
processes. Treat `pi-subagents`' `runtimeAcknowledgedExtensions` result
metadata as the only reliable evidence that a child extension registered; do
not infer child registration from `pi list`, a package installation, or an
ambient extension that the child launch policy may have disabled.

The extension is intentionally pragmatic. It does not patch Pi core or monkey-patch `ctx.ui`.
