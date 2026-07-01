# cmp-design-bridge

A reusable, standalone **Claude Design → Compose** bridge. Implement, update, and
verify Compose Multiplatform screens against designs authored in [Claude
Design](https://claude.ai/design) — from a CLI, from CI, from a git-hook, or from
Claude Code.

## Scope (what this tool targets)

This is a **Compose-targeted** tool (hence `cmp-`). The design source is Claude
Design (which authors **React/HTML**); the implementation target is **Kotlin
Compose Multiplatform**. The framework's reason to exist is the two
**cross-framework** legs the native Claude Design surface structurally cannot do:

1. **TRANSFORM** — turn a Claude Design artifact into *idiomatic* Compose.
2. **VERIFY** — grade a Compose render against the design it came from, across the
   engine gap (Skia line-box ≠ CSS, `DrawScope` ≠ SVG, elevation ≠ box-shadow).

It is **project-agnostic**: a different Compose app adopts it by writing a
`.design-bridge/` CONFIG dir and following the frame-authoring contract below —
no edits to this package.

## The architecture — 3 layers split by determinism

The framework is deliberately split by what is reproducible vs. what needs
judgment:

1. **Deterministic core → a real CLI** (`bin/cmp-design-bridge.mjs`). Runnable by
   a human, by Claude, by CI, or a git-hook — not Claude-Code-locked. Subcommands:
   - `render <stateId>` — render one per-state Claude Design frame to an isolated
     PNG at a pinned viewport (default 411 CSS px / DPR 3), offline + reproducibly.
   - `lint` — join-manifest integrity (the identity spine): the subject capture is
     DERIVED from `stateId` so a miswired row is structurally impossible;
     content-hash revision pinning; a per-module burndown sweep.
   - `pull` — verify staged frames (truncation, DS-runtime hash pin) + (re)generate
     the join-manifest from the live frame inventory.
   - `verify <stateId>` — build the fidelity packet (REFERENCE design render vs the
     SUBJECT app screenshot + montage + mechanical gates) the grade consumes.
   - `doctor` — sanity-check CONFIG + toolchain (including a real Chromium launch).

2. **Two model-driven legs → NOT a CLI** (thin skills + the model):
   - **TRANSFORM** (`/design-transform`) — Design → *idiomatic* Compose under the
     project's declarative-stack rules. Re-authoring, not transpiling.
   - **FIDELITY VERDICT** (`/design-fidelity`) — grade match/close/mismatch from
     the two renders, ignoring engine noise. No pixel-diff (pixel diffs mislead
     across frameworks).

3. **Skills → thin on-ramp**: `/design-pull` `/design-transform` `/design-fidelity`
   `/design-push` (gated). The logic lives in the CLI + the model; each skill just
   calls the `cmp-design-bridge` command and invokes the judgment. The skills ship
   as a separate Claude Code plugin (`StreakBank/cmp-marketplace`, plugin
   `cmp-design-bridge`) — this repo is the CLI they call.

## Terminology: REFERENCE vs SUBJECT

- The **design is the REFERENCE** (the target). The CLI renders it itself
  (design HTML → PNG).
- The **app screenshot is the SUBJECT** under test. A Node CLI can't render
  Compose (that needs the Android/JVM toolchain), so the CLI **imports** the
  subject image — the app's own self-regression baseline (which the app's gate
  already certifies as "baseline == current app", so the imported subject is
  certified-current for free). `cmpScreenshotRoot` + `captureDeriveRule` are the
  seam that locates it.

## Install

```bash
npm i -g cmp-design-bridge       # the published CLI
npx playwright install chromium  # the headless browser the renderer drives
```

For local development against this repo:

```bash
git clone https://github.com/StreakBank/cmp-design-bridge.git
cd cmp-design-bridge
npm install                      # the CLI's own deps (Playwright)
npx playwright install chromium  # the headless browser the renderer drives
npm link                         # exposes `cmp-design-bridge` on PATH (dev)
npm test                         # the standalone smoke suite (browser-gated render test included)
```

Playwright is the CLI's own dependency.

## CORE / CONFIG

- **CORE** = this package (project-agnostic). Carries zero project knowledge.
- **CONFIG** = `<consuming-repo>/.design-bridge/` (committed): `config.json`,
  `render-recipe.json`, `join-manifest.json`, `allowlist.json`,
  `presence-contract.json`, `conventions.md`, and `ds-runtime/` (the project's
  design-system render runtime). Everything project-specific — palette deviations,
  viewport, module→capture mapping, the DS runtime, the self-regression gate
  command. See `schema/*.schema.json`.

The cut: every CONFIG field answers "yes" to *would a different Compose app
change it?*; the CORE answers "no" to all of them. That is the reusability
invariant.

## The frame-authoring contract

The CLI renders **per-state frames** authored in Claude Design. Each
`<stateId>.html` is hermetic and self-mounting; the renderer just static-serves
it + the DS runtime, drives headless Chromium, and crops the content. A
conformant frame:

1. **Stamps its state-id** — `<meta name="<stateIdMeta>" content="<stateId>">`
   (the `render-recipe.stateIdMeta` key; one state = one frame = one id).
2. **Loads the DS runtime** — `../_ds/styles.css` + `../_ds/_ds_bundle.js` (a
   self-contained JS bundle that defines the design-system atoms it was authored
   against). The renderer serves `/_ds/*` from `render-recipe.dsRuntimeSource`.
3. **Self-mounts a single child under `#root`** — after load, `#root` has exactly
   one element child with real height. The CLI crops `#root > :first-child`; the
   single-root rule is a mechanical gate.

Per-module shared content (`_<module>-screen.jsx` + `_<module>-data.jsx`) lives
beside the frames; the renderer + pull hash `[frame.html + the `_*.jsx` siblings]`
together for revision pinning.

## Quick start

```bash
cmp-design-bridge doctor  --config <repo>/.design-bridge
cmp-design-bridge pull    --config <repo>/.design-bridge --write-manifest
cmp-design-bridge render  <stateId> --config <repo>/.design-bridge
cmp-design-bridge lint    --config <repo>/.design-bridge
cmp-design-bridge verify  <stateId> --config <repo>/.design-bridge
```

## What's a hard gate vs. advisory

- **Tier-2 self-regression gate** is the deterministic gate. It is the app's own
  screenshot-regression check (Compose vs the app's committed baselines) — zero
  framework gap, prototype-independent. The framework is **gate-tool-agnostic**:
  the app supplies the *whole command* in `render-recipe.gateCommandTemplate`
  (`{module}` / `{stateId}` substituted; e.g. a Gradle screenshot-compare task).
  Omit it to run advisory-only.
- **Tier-1 cross-framework fidelity** (`/design-fidelity`) is ADVISORY — it
  surfaces real candidate drifts without flooding, but cannot deterministically
  separate a bug from a presence-gated absence, and is blind to subject content
  below the fixed-viewport fold (`verify` flags `belowFoldRisk`). It replaces the
  old pixel-parity-vs-prototype gate's *advisory* role, not its determinism.

## Design rationale
The 3-layer split (deterministic CLI / two model-driven legs / thin skills), the
CORE/CONFIG boundary, the identity spine (one state → one frame → one id → one
UiState member → one capture), and the cross-framework verify model are documented
in the authoring project's internal design notes (a `FRAMEWORK_DESIGN.md` blueprint
plus the CLI build/proof writeups) — these are not shipped in the npm package.
