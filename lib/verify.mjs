// verify.mjs — CORE half of the VERIFY leg: build the "fidelity packet" the
// model grades (FRAMEWORK_DESIGN §4). The CLI does the DETERMINISTIC work —
// acquire the REFERENCE (the design) side, locate the SUBJECT (the app
// screenshot) side, assemble the allowlist + presence-contract context, produce
// a side-by-side montage, and run the mechanical gates. It does NOT grade: the
// cross-framework fidelity VERDICT is irreducibly model-driven and runs in
// /design-fidelity over this packet.
//
// Terminology (load-bearing): the DESIGN is the REFERENCE the CLI acquires
// itself; the app screenshot is the SUBJECT under test, IMPORTED from the app's
// own self-regression baseline — a Node CLI can't render Compose, so it can't
// produce the subject, only the reference.
//
// TWO reference modes:
//   rendered (default) — the reference is a Claude Design frame the CLI renders
//     (render.mjs); staleness re-renders on frame-source drift; gates come from
//     the render's pull-manifest evidence.
//   imported — the reference is an arbitrary raster admitted via `intake`
//     (intake.mjs): a normalized screenshot. There is no frame and no render;
//     the module comes from the intake manifest, staleness covers the SOURCE
//     BYTES + the declared transform params (no re-render can self-heal a
//     drifted source, so verify fails loud instead), and the gates are the
//     intake-evidence analogs. Forced with `--reference imported`; auto-detected
//     when no frame exists but an intake manifest does.
//
//   reference: <out>/<stateId>.design.png     (rendered mode)
//              <out>/<stateId>.reference.png  (imported mode)
//   subject:   deriveCapture(stateId)          (the app's self-regression baseline)
//   packet:    <out>/<stateId>.fidelity-packet.json + <stateId>.montage.png

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolvePlaywright, sha256OfFiles, sha256OfFile } from './util.mjs';
import { deriveCapture, locateFrame } from './config.mjs';
import { renderFrame, frameSourceFiles } from './render.mjs';

/**
 * Build the app-owned Tier-2 self-regression gate command from its template.
 * Pure (exported for tests). Substitutes {module} + {stateId}; returns null when
 * no template is configured (advisory-only mode). The framework is gate-tool-
 * agnostic — the whole command lives in CONFIG, so it knows nothing about Gradle
 * or any specific screenshot tool.
 */
export function buildGateCommand(template, moduleId, stateId) {
  if (!template) return null;
  return template.replace(/\{module\}/g, moduleId).replace(/\{stateId\}/g, stateId);
}

/**
 * Allowlist entries applicable to one state. Entries are GLOBAL by default; an
 * entry carrying `states: [...]` applies only to those stateIds (per-state
 * translation deviations — a per-state delta recorded globally would suppress
 * that difference on every state and erode grade sensitivity estate-wide).
 * Pure (exported for tests).
 */
export function allowlistFor(cfg, stateId) {
  return (cfg.allowlist.entries || []).filter((e) => !Array.isArray(e.states) || e.states.includes(stateId));
}

const GRADE_BASE = 'GRADE is a model step — run /design-fidelity over the REFERENCE vs the SUBJECT (cmpPng). '
  + 'Suppress every allowlist deviation (pair by rendered HEX/geometry, not token name). '
  + 'Classify an absent region: absent-but-presenceContract.present -> hard finding; absent-and-absentByGating -> suppressed. '
  + 'Ignore Skia-vs-CSS engine noise (line-box, elevation/shadow, AA edges). Verdict ∈ {MATCH, MINOR_DRIFT, MISMATCH}.';

const BELOW_FOLD_CLAUSE = ' BELOW-FOLD RISK: the reference is materially taller than the fixed-viewport subject screenshot (or was clipped to it), so subject content below the fold is INVISIBLE here. Do NOT assert parity on any presence-contract item that may sit below the subject fold — route it to the Tier-2 self-regression gate instead of suppressing.';

const THEME_CLAUSE = ' THEME TRANSLATION DECLARED (light→dark): hex comparison on the color axis is semantically void — every color differs by design. Grade color by ROLE consistency (does each region use the design-system role corresponding to the reference region\'s role: background/surface/text tier/accent/status?) and grade structure, geometry, and typography normally.';

function pngDim(p, offset) {
  try { return readFileSync(p).readUInt32BE(offset); } catch { return null; }
}

async function buildMontage(cfg, referencePng, cmpPng, outPng, cellWidth, referenceCaption) {
  const chromium = resolvePlaywright(cfg);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: cellWidth * 2 + 80, height: 1600 }, deviceScaleFactor: 1 });
    const designB64 = readFileSync(referencePng).toString('base64');
    const cmpB64 = existsSync(cmpPng) ? readFileSync(cmpPng).toString('base64') : null;
    const subjectCell = cmpB64
      ? `<img src="data:image/png;base64,${cmpB64}" style="width:${cellWidth}px;display:block;border:1px solid #1c2430"/>`
      : `<div style="width:${cellWidth}px;height:300px;display:flex;align-items:center;justify-content:center;color:#8aa;font:13px monospace;border:1px dashed #334">no subject screenshot<br/>(backfill slot)</div>`;
    await page.setContent(`<body style="margin:0;background:#05080f;padding:16px;font:12px monospace;color:#8aa">
      <div style="display:flex;gap:16px;align-items:flex-start">
        <figure style="margin:0"><figcaption style="padding:4px 0;color:#5ad">REFERENCE — ${referenceCaption}</figcaption>
          <img src="data:image/png;base64,${designB64}" style="width:${cellWidth}px;display:block;border:1px solid #1c2430"/></figure>
        <figure style="margin:0"><figcaption style="padding:4px 0;color:#fa5">SUBJECT — app screenshot (self-regression baseline)</figcaption>${subjectCell}</figure>
      </div></body>`);
    await page.waitForTimeout(250);
    await page.screenshot({ path: outPng, fullPage: true });
  } finally {
    await browser.close();
  }
}

export async function verify(cfg, stateId, opts = {}) {
  const outDir = opts.outDir || path.join(cfg.cacheDir, 'out');
  await mkdir(outDir, { recursive: true });

  const located = locateFrame(cfg, stateId);
  const intakeManifestPath = path.join(outDir, `${stateId}.intake-manifest.json`);
  const imported = opts.referenceImported === true || (!located && existsSync(intakeManifestPath));
  if (imported) return verifyImported(cfg, stateId, outDir, intakeManifestPath);

  if (!located) throw new Error(`No frame for stateId "${stateId}" and no intake manifest at ${intakeManifestPath} — author/pull a frame, or admit a screenshot reference via \`intake\``);
  const mod = located.module;
  const widthCss = cfg.recipe.viewport.logicalWidthCss ?? cfg.recipe.viewport.logicalWidthDp ?? 411;

  const designPng = path.join(outDir, `${stateId}.design.png`);
  const pmPath = path.join(outDir, `${stateId}.pull-manifest.json`);

  // Staleness check (the grade-entry-point counterpart to lint's CONTENT_HASH_DRIFT):
  // if the frame was re-authored since the last render, the design.png is stale.
  let stale = false;
  if (existsSync(designPng) && existsSync(pmPath)) {
    try {
      const prevHash = JSON.parse(readFileSync(pmPath, 'utf8')).sourceContentHash;
      const files = await frameSourceFiles(cfg, stateId);
      if (files && sha256OfFiles(files) !== prevHash) stale = true;
    } catch { stale = true; }
  }

  // Render the design side if forced, missing, OR stale. A re-render produces a
  // PNG + manifest matching the current source by construction, so it CLEARS the
  // staleness (the gate fails only when a stale render is graded without re-rendering).
  let renderResult = null;
  if (opts.render || !existsSync(designPng) || !existsSync(pmPath) || stale) {
    renderResult = await renderFrame(cfg, stateId, { outDir });
    stale = false;
  }
  const pullManifest = existsSync(pmPath) ? JSON.parse(readFileSync(pmPath, 'utf8')) : null;

  // CMP side (derived capture).
  const cmpPng = deriveCapture(cfg, stateId, mod);
  const cmpExists = existsSync(cmpPng);

  // Below-fold blind-spot detection (the grade-skeptic finding): the design
  // (reference) frame renders FULL content height; the app (subject) screenshot
  // is a fixed device viewport. When the reference render is materially taller,
  // any subject content below the fold (and any presence-contract item there) is
  // INVISIBLE to the image grade and MUST go to the Tier-2 deterministic gate.
  let belowFoldRisk = false;
  const designHeight = existsSync(designPng) ? pngDim(designPng, 20) : null;
  const cmpHeight = cmpExists ? pngDim(cmpPng, 20) : null;
  if (designHeight && cmpHeight) belowFoldRisk = designHeight > cmpHeight * 1.15;
  // When render clipped the design to the subject viewport (recipe.clipHeight),
  // the two PNGs now MATCH in height — the dimension check above won't fire — but
  // there IS content below the fold the image grade cannot see. Surface it from
  // the manifest so presence-contract items below the fold route to the Tier-2
  // gate rather than being (in)validated against an image that can't show them.
  if (pullManifest?.clipped === true) belowFoldRisk = true;

  // Relevant allowlist + presence-contract.
  const allowlist = allowlistFor(cfg, stateId);
  const presence = cfg.presenceContract.states?.[stateId] || null;

  // Mechanical gates — a null pull-manifest is a HARD FAIL (can't certify a
  // render that produced no evidence); widthOk + childCount must be affirmative;
  // and the render must have passed its OWN gate (renderOk).
  const consoleErrors = pullManifest?.consoleErrors || [];
  const gates = {
    haveRenderEvidence: pullManifest != null,
    renderOk: pullManifest?.renderOk === true,
    renderConsoleClean: pullManifest != null && consoleErrors.length === 0,
    renderWidthOk: pullManifest?.widthOk === true,
    renderSingleRoot: pullManifest?.childCount === 1,
    notStale: !stale,
    cmpCaptureExists: cmpExists,
  };
  const gatesPass = gates.haveRenderEvidence && gates.renderOk && gates.renderConsoleClean
    && gates.renderWidthOk && gates.renderSingleRoot && gates.notStale && cmpExists;

  // Montage for the grader, at the configured viewport width.
  const montagePng = path.join(outDir, `${stateId}.montage.png`);
  await buildMontage(cfg, designPng, cmpPng, montagePng, widthCss, 'design render (Claude Design)');

  // Self-regression gate command — fully CONFIG-owned (the app supplies the
  // whole command; the framework is gate-tool-agnostic — any Compose screenshot
  // regression tool / device capture plugs in here). {module} + {stateId} are
  // substituted; a project that omits gateCommandTemplate runs advisory-only.
  const gateModule = mod.captureDir ? mod.captureDir.split('/')[0] : mod.id;
  const selfRegressionGate = buildGateCommand(cfg.recipe.gateCommandTemplate, gateModule, stateId);

  const packet = {
    stateId,
    module: mod.id,
    referenceMode: 'rendered',
    designPng,
    referencePng: designPng, // canonical alias; imported mode has no "design" render
    cmpPng: cmpExists ? cmpPng : null,
    montagePng,
    viewport: pullManifest?.viewport || cfg.recipe.viewport,
    sourceContentHash: pullManifest?.sourceContentHash || null,
    gates,
    gatesPass,
    consoleErrors,
    renderReasons: pullManifest?.renderReasons || (pullManifest ? [] : ['no-render-evidence']),
    designHeightPx: designHeight,
    cmpHeightPx: cmpHeight,
    designNaturalHeightCss: pullManifest?.naturalHeightCss ?? null,
    designClipped: pullManifest?.clipped ?? false,
    belowFoldRisk,
    allowlist,
    presenceContract: presence,
    gradeInstruction: GRADE_BASE + (belowFoldRisk ? BELOW_FOLD_CLAUSE : ''),
    selfRegressionGate,
  };
  await writeFile(path.join(outDir, `${stateId}.fidelity-packet.json`), JSON.stringify(packet, null, 2));
  return { packet, renderResult, gatesPass };
}

/** Imported-reference mode: the reference is an intake-normalized screenshot.
 *  No frame, no render — the intake manifest supplies module + provenance, and
 *  staleness covers the source bytes + transform params (fail-loud; nothing to
 *  re-render). */
async function verifyImported(cfg, stateId, outDir, intakeManifestPath) {
  if (!existsSync(intakeManifestPath)) {
    throw new Error(`--reference imported: no intake manifest at ${intakeManifestPath} — run \`intake ${stateId} --image <raster>\` first`);
  }
  const im = JSON.parse(readFileSync(intakeManifestPath, 'utf8'));
  const mod = cfg.modules.find((m) => m.id === im.module);
  if (!mod) throw new Error(`intake manifest names module "${im.module}" which is not in config.modules`);
  const widthCss = cfg.recipe.viewport.logicalWidthCss ?? cfg.recipe.viewport.logicalWidthDp ?? 411;
  const dpr = cfg.recipe.viewport.dpr ?? 3;

  const referencePng = path.join(outDir, `${stateId}.reference.png`);
  const referenceExists = existsSync(referencePng);

  // Staleness: source bytes AND declared transform params. The manifest and the
  // reference are written together by intake, so the params in the manifest are
  // the params that produced the PNG — only source drift (or a hand-edited
  // manifest) can desynchronize, and both must fail loud.
  const liveSourceSha = sha256OfFile(im.sourcePath);
  const liveParamsHash = 'sha256:' + createHash('sha256').update(JSON.stringify({
    contentBox: im.contentBox ?? null,
    targetWidthPx: im.targetWidthPx,
    clipHeightPx: im.clipHeightPx ?? null,
    themeTranslation: im.themeTranslation,
    gridStepDp: im.gridStepDp,
  })).digest('hex');
  const notStale = liveSourceSha != null && liveSourceSha === im.sourceSha256 && liveParamsHash === im.paramsHash;

  const referenceWidth = referenceExists ? pngDim(referencePng, 16) : null;
  const referenceWidthOk = referenceWidth === widthCss * dpr;

  const cmpPng = deriveCapture(cfg, stateId, mod);
  const cmpExists = existsSync(cmpPng);

  const referenceHeight = referenceExists ? pngDim(referencePng, 20) : null;
  const cmpHeight = cmpExists ? pngDim(cmpPng, 20) : null;
  let belowFoldRisk = im.clipped === true;
  if (referenceHeight && cmpHeight && referenceHeight > cmpHeight * 1.15) belowFoldRisk = true;

  const allowlist = allowlistFor(cfg, stateId);
  const presence = cfg.presenceContract.states?.[stateId] || null;

  const gates = {
    haveIntakeEvidence: true, // the manifest itself; absence throws above
    referenceExists,
    referenceWidthOk,
    notStale,
    cmpCaptureExists: cmpExists,
  };
  const gatesPass = referenceExists && referenceWidthOk && notStale && cmpExists;

  const montagePng = path.join(outDir, `${stateId}.montage.png`);
  await buildMontage(cfg, referencePng, cmpPng, montagePng, widthCss, 'imported screenshot (normalized)');

  const gateModule = mod.captureDir ? mod.captureDir.split('/')[0] : mod.id;
  const selfRegressionGate = buildGateCommand(cfg.recipe.gateCommandTemplate, gateModule, stateId);

  const packet = {
    stateId,
    module: mod.id,
    referenceMode: 'imported',
    designPng: referencePng, // compat alias for packet consumers; see referencePng
    referencePng,
    cmpPng: cmpExists ? cmpPng : null,
    montagePng,
    viewport: cfg.recipe.viewport,
    intake: {
      sourcePath: im.sourcePath,
      sourceSha256: im.sourceSha256,
      sourceDims: im.sourceDims,
      contentBox: im.contentBox ?? null,
      scaleFactor: im.scaleFactor,
      themeTranslation: im.themeTranslation,
      gridPng: im.gridPng,
      palette: im.palette,
    },
    gates,
    gatesPass,
    referenceHeightPx: referenceHeight,
    designHeightPx: referenceHeight, // compat alias
    cmpHeightPx: cmpHeight,
    referenceNaturalHeightPx: im.naturalHeightPx,
    referenceClipped: im.clipped === true,
    designClipped: im.clipped === true, // compat alias
    belowFoldRisk,
    allowlist,
    presenceContract: presence,
    gradeInstruction: GRADE_BASE
      + (belowFoldRisk ? BELOW_FOLD_CLAUSE : '')
      + (im.themeTranslation === 'light-to-dark' ? THEME_CLAUSE : ''),
    selfRegressionGate,
  };
  await writeFile(path.join(outDir, `${stateId}.fidelity-packet.json`), JSON.stringify(packet, null, 2));
  return { packet, renderResult: null, gatesPass };
}

export function printVerify({ packet, gatesPass }) {
  console.log(`FIDELITY PACKET [${packet.stateId}] (${packet.referenceMode} reference) — mechanical gates ${gatesPass ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log(`  reference: ${packet.referencePng}`);
  console.log(`  subject:   ${packet.cmpPng || '(none — backfill slot)'}`);
  console.log(`  montage:   ${packet.montagePng}`);
  if (packet.referenceMode === 'imported') {
    console.log(`  gates:  referenceExists=${packet.gates.referenceExists} widthOk=${packet.gates.referenceWidthOk} notStale=${packet.gates.notStale} subjectExists=${packet.gates.cmpCaptureExists}`);
    console.log(`  intake: source ${packet.intake.sourceDims.w}x${packet.intake.sourceDims.h}, scale ${packet.intake.scaleFactor}, theme-translation ${packet.intake.themeTranslation}`);
  } else {
    console.log(`  gates:  evidence=${packet.gates.haveRenderEvidence} renderOk=${packet.gates.renderOk} consoleClean=${packet.gates.renderConsoleClean} widthOk=${packet.gates.renderWidthOk} singleRoot=${packet.gates.renderSingleRoot} notStale=${packet.gates.notStale} subjectExists=${packet.gates.cmpCaptureExists}`);
    if (packet.renderReasons.length) console.log(`  render reasons: ${packet.renderReasons.join(', ')}`);
    if (packet.consoleErrors.length) packet.consoleErrors.forEach((e) => console.log('    !! console: ' + e));
  }
  if (packet.belowFoldRisk) {
    const note = packet.designClipped
      ? 'reference clipped to the subject viewport — content below the fold is invisible to the image grade'
      : `reference ${packet.designHeightPx}px > subject ${packet.cmpHeightPx}px`;
    console.log(`  ⚠ below-fold risk: ${note}; confirm presence-contract items via Tier-2.`);
  }
  console.log(`  allowlist entries applied: ${packet.allowlist.length}; presence-contract: ${packet.presenceContract ? 'present' : 'none'}`);
  console.log(`  GRADE = model step (/design-fidelity). Tier-2 gate: ${packet.selfRegressionGate || '(none configured — set render-recipe.gateCommandTemplate)'}`);
}
