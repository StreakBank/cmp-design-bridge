# Changelog

## 0.2.0 — 2026-07-06

The screenshot leg: arbitrary rasters as REFERENCES.

- **New `intake <stateId> --image <path>` subcommand** — admit an arbitrary raster (Figma export,
  device screenshot, photo of a mock) as the reference for one state: declared content-box crop
  (foreign-chrome exclusion is an upstream judgment input; the CLI applies a pure function),
  width-fit to the canonical comparison geometry, clip to the subject viewport with belowFold
  semantics, provenance (source sha256 + transform-params hash), module resolution for frame-less
  states (`--module` or longest config statePrefix). Emits `<stateId>.reference.png`, a dp-grid
  measuring overlay, and an intake manifest (`schema/intake-manifest.schema.json`).
- **Evidence sidecars** — deterministic palette census with theme-gated nearest-token pairing
  (new optional recipe keys `tokensSource`, `paletteSnapThreshold`, `gridStepDp`; pairing is
  SUPPRESSED for declared `--theme-translation light-to-dark` inputs — nearest-hex is systematically
  wrong across a theme boundary; the token list ships for role mapping instead). Optional-dependency
  OCR sidecar (`tesseract.js`, engages only when installed; advisory, never authoritative over the
  raster).
- **`verify --reference imported`** — a second reference mode (auto-detected when no frame exists
  but an intake manifest does; the explicit flag wins over an existing frame). Gates:
  referenceExists / referenceWidthOk / notStale(source bytes + transform params — fails loud, no
  re-render self-heal) / cmpCaptureExists. The grade instruction gains a role-consistency color
  clause for declared cross-theme inputs; the packet carries `referenceMode` + the intake evidence.
- **Per-state allowlist scoping** — optional `states: [...]` filter on allowlist entries (+ new
  `translation` entry class); entries without it keep global semantics. Records per-state
  translate-to-the-design-system deviations without suppressing that delta estate-wide.
- **`lint --fail-on-backfill`** — promotes captured-but-frameless inventory-enrolled states from
  informational burndown to real findings (`BACKFILL_REQUIRED`); the mechanical design-SoT merge
  gate for the screenshot flow. `intake` warns when its stateId is not inventory-enrolled.
- Tests: intake/imported-verify/scoping/backfill coverage added, including the first tests over
  `verify()` itself.

## 0.1.0 — 2026-06-30

Initial standalone release: `pull` / `render` / `lint` / `verify` / `doctor` over a per-project
`.design-bridge/` CONFIG; Playwright as the only dependency; 17-test smoke suite.
