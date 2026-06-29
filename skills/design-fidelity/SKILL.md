---
name: design-fidelity
description: Verify a Claude Design frame against the shipped Compose app's self-regression (screenshot) baseline — cross-framework fidelity grade. Use after pulling/updating a design frame, or to check that a Compose screen still matches its design. The deterministic gate is the app's own self-regression gate; this skill adds the advisory cross-framework grade the old pixel-parity-vs-prototype gate used to provide.
argument-hint: <stateId> [--config <dir>]
allowed-tools:
  - Bash
  - Read
  - Glob
---

# /design-fidelity — cross-framework fidelity grade (VERIFY leg)

This skill is a THIN on-ramp. The deterministic mechanism (render the REFERENCE
design side, locate the SUBJECT app baseline, build the comparison packet +
montage, run the mechanical gates) is the `cmp-design-bridge verify` CLI. The
GRADE itself — "do these two engine-different renders depict the same screen at
acceptable fidelity?" — is the irreducibly model-driven leg, and YOU do it.

**CLI:** the skill calls the standalone `cmp-design-bridge` command (install once:
from the plugin dir `npm install && npm link`, or `npm i -g cmp-design-bridge`
when published; un-linked fallback `node "$CLAUDE_PLUGIN_ROOT/bin/cmp-design-bridge.mjs"`).

## Steps

1. **Build the fidelity packet** (deterministic):
   ```
   cmp-design-bridge verify <stateId> --config <repo>/.design-bridge --render
   ```
   This writes `<cache>/out/<stateId>.{design.png, montage.png, fidelity-packet.json}`
   and prints the mechanical-gate result (render console-clean, width-ok,
   subject capture exists). If the mechanical gates FAIL, stop and fix the render
   before grading.

2. **Read the packet + both images.** `Read` the `designPng`, the `cmpPng`, and
   the `fidelity-packet.json` (it carries the allowlist + the per-state
   presence-contract inline).

3. **Grade, applying the rules in the packet's `gradeInstruction`:**
   - IGNORE engine differences (Skia line-box ~1.4× CSS, elevation vs shadow,
     AA edges, M3 padding) — never findings.
   - TOLERATE fixture differences (different streak/rank/accuracy values, avatar
     glyph) — classify "fixture", never "real-drift".
   - APPLY the `allowlist` (pair by rendered hex/geometry, not token name).
   - USE the `presenceContract`: absent-but-in-`present` → candidate real
     finding; absent-and-in-`absentByGating` → suppressed.
   - Verdict ∈ {MATCH, MINOR_DRIFT, MISMATCH}; list only REAL drifts, each with a
     recommendation (fix-CMP / fix-design / fixture-align / needs-human).

4. **For thoroughness on a high-stakes screen** (or when the user asks for a
   rigorous grade), run the multi-rater + adversarial workflow instead of a
   single-pass grade: 3 independent raters → synthesis → skeptic. See the
   reference workflow in the framework docs (`design-pipeline/`); cap image
   agents at ≤3 concurrent (the 429 finding).

5. **Report**: the verdict + the real-drift list. State plainly that this grade
   is ADVISORY; the deterministic gate is the Tier-2 self-regression gate
   (`packet.selfRegressionGate`), which is unchanged and prototype-independent.

## What this skill does NOT do
- It does not pixel-diff (pixel diffs mislead across Skia-vs-CSS).
- It does not gate a merge by itself — the app's self-regression gate is the gate.
- It does not author Compose — that's `/design-transform`.
