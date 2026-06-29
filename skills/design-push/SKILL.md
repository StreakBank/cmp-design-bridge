---
name: design-push
description: (GATED) Port existing screens/components INTO Claude Design — the one-time migration direction, not the steady-state loop. Every write is permission-gated. Use only for the deliberate port of an existing SoT into Claude Design.
argument-hint: <module> [--config <dir>]
disable-model-invocation: true
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
---

# /design-push — port INTO Claude Design (GATED, out of steady-state scope)

This is the WRITE direction (`create_project → finalize_plan → write_files`),
the inverse of the steady-state CONSUME→TRANSFORM→VERIFY loop. It is a one-time
migration tool, **permission-gated every call** (`disable-model-invocation:true`),
and explicitly NOT part of the reusable verify framework.

## Hard preconditions (do not skip)
1. **`get_claude_design_prompt` FIRST** — the authoring-model spec; call it once
   before any `write_files`.
2. **Backup gate** — if the source repo has no durable remote (e.g. streakbank-ux:
   0 remotes + untracked WIP), `git bundle` it BEFORE any destructive step.
3. **finalize_plan IS the permission boundary** — cj stays in the loop on every
   write. Never auto-approve.

## Steps (per the native /design-sync upload sequence)
1. `get_claude_design_prompt` → read the authoring spec.
2. Stage the per-state frames locally (the per-state-frame recipe — see
   `feedback-claude-design-per-state-frame-authoring.md`): thin `<stateId>.html`
   + shared `_<module>-screen.jsx` + `_<module>-data.jsx`, each stamped
   `<meta name="sb-state-id">`.
3. LOCAL render-check first (`cmp-design-bridge render`), then `finalize_plan`
   → `write_files` (≤256 files/call; base64 for JSX with quotes/glyphs).
   **Always check the returned `"written":N` == file count.**
4. `render_preview` to confirm in Claude Design's own env.
5. Self-verify: pull back (`/design-pull`) → diff vs the local mirror → render →
   `/design-fidelity`.

## Notes
- The DS-component port (Half 1) goes to the design-SYSTEM project via the native
  `DesignSync` tool, not here. This skill is for screen frames in a canvas
  project.
- Steady-state work never uses this skill — it is migration-only.
