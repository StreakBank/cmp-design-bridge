// verify.mjs — CORE half of the VERIFY leg: build the "fidelity packet" the
// model grades (FRAMEWORK_DESIGN §4). The CLI does the DETERMINISTIC work —
// render the REFERENCE (the design) side (re-rendering if the frame was
// re-authored), locate the SUBJECT (the app screenshot) side, assemble the
// allowlist + presence-contract context, produce a side-by-side montage, and
// run the mechanical gates. It does NOT grade: the cross-framework fidelity
// VERDICT is irreducibly model-driven and runs in /design-fidelity over this
// packet.
//
// Terminology (load-bearing): the DESIGN is the REFERENCE the CLI renders
// itself; the app screenshot is the SUBJECT under test, IMPORTED from the app's
// own self-regression baseline — a Node CLI can't render Compose, so it can't
// produce the subject, only the reference.
//
//   reference: <out>/<stateId>.design.png  (rendered by render.mjs from the design)
//   subject:   deriveCapture(stateId)       (the app's self-regression baseline)
//   packet:    <out>/<stateId>.fidelity-packet.json + <stateId>.montage.png

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolvePlaywright, sha256OfFiles } from './util.mjs';
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

async function buildMontage(cfg, designPng, cmpPng, outPng, cellWidth) {
  const chromium = resolvePlaywright(cfg);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: cellWidth * 2 + 80, height: 1600 }, deviceScaleFactor: 1 });
    const designB64 = readFileSync(designPng).toString('base64');
    const cmpB64 = existsSync(cmpPng) ? readFileSync(cmpPng).toString('base64') : null;
    const subjectCell = cmpB64
      ? `<img src="data:image/png;base64,${cmpB64}" style="width:${cellWidth}px;display:block;border:1px solid #1c2430"/>`
      : `<div style="width:${cellWidth}px;height:300px;display:flex;align-items:center;justify-content:center;color:#8aa;font:13px monospace;border:1px dashed #334">no subject screenshot<br/>(backfill slot)</div>`;
    await page.setContent(`<body style="margin:0;background:#05080f;padding:16px;font:12px monospace;color:#8aa">
      <div style="display:flex;gap:16px;align-items:flex-start">
        <figure style="margin:0"><figcaption style="padding:4px 0;color:#5ad">REFERENCE — design render (Claude Design)</figcaption>
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
  if (!located) throw new Error(`No frame for stateId "${stateId}"`);
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
  let designHeight = null;
  let cmpHeight = null;
  if (existsSync(designPng)) {
    try { designHeight = readFileSync(designPng).readUInt32BE(20); } catch { /* leave null */ }
  }
  if (cmpExists) {
    try {
      cmpHeight = readFileSync(cmpPng).readUInt32BE(20); // PNG IHDR height (BE, byte 20)
      if (designHeight) belowFoldRisk = designHeight > cmpHeight * 1.15;
    } catch { /* leave null */ }
  }

  // Relevant allowlist + presence-contract.
  const allowlist = cfg.allowlist.entries || [];
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
  await buildMontage(cfg, designPng, cmpPng, montagePng, widthCss);

  // Self-regression gate command — fully CONFIG-owned (the app supplies the
  // whole command; the framework is gate-tool-agnostic — any Compose screenshot
  // regression tool / device capture plugs in here). {module} + {stateId} are
  // substituted; a project that omits gateCommandTemplate runs advisory-only.
  const gateModule = mod.captureDir ? mod.captureDir.split('/')[0] : mod.id;
  const selfRegressionGate = buildGateCommand(cfg.recipe.gateCommandTemplate, gateModule, stateId);

  const packet = {
    stateId,
    module: mod.id,
    designPng,
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
    belowFoldRisk,
    allowlist,
    presenceContract: presence,
    gradeInstruction: 'GRADE is a model step — run /design-fidelity over the REFERENCE (designPng) vs the SUBJECT (cmpPng). '
      + 'Suppress every allowlist deviation (pair by rendered HEX/geometry, not token name). '
      + 'Classify an absent region: absent-but-presenceContract.present -> hard finding; absent-and-absentByGating -> suppressed. '
      + 'Ignore Skia-vs-CSS engine noise (line-box, elevation/shadow, AA edges). Verdict ∈ {MATCH, MINOR_DRIFT, MISMATCH}.'
      + (belowFoldRisk ? ' BELOW-FOLD RISK: the reference render is materially taller than the fixed-viewport subject screenshot, so subject content below the fold is INVISIBLE here. Do NOT assert parity on any presence-contract item that may sit below the subject fold — route it to the Tier-2 self-regression gate instead of suppressing.' : ''),
    selfRegressionGate,
  };
  await writeFile(path.join(outDir, `${stateId}.fidelity-packet.json`), JSON.stringify(packet, null, 2));
  return { packet, renderResult, gatesPass };
}

export function printVerify({ packet, gatesPass }) {
  console.log(`FIDELITY PACKET [${packet.stateId}] — mechanical gates ${gatesPass ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log(`  reference (design): ${packet.designPng}`);
  console.log(`  subject (app):      ${packet.cmpPng || '(none — backfill slot)'}`);
  console.log(`  montage:            ${packet.montagePng}`);
  console.log(`  gates:  evidence=${packet.gates.haveRenderEvidence} renderOk=${packet.gates.renderOk} consoleClean=${packet.gates.renderConsoleClean} widthOk=${packet.gates.renderWidthOk} singleRoot=${packet.gates.renderSingleRoot} notStale=${packet.gates.notStale} subjectExists=${packet.gates.cmpCaptureExists}`);
  if (packet.renderReasons.length) console.log(`  render reasons: ${packet.renderReasons.join(', ')}`);
  if (packet.belowFoldRisk) console.log(`  ⚠ below-fold risk: reference ${packet.designHeightPx}px > subject ${packet.cmpHeightPx}px — subject content below the fold is invisible to the image grade; confirm presence-contract items via Tier-2.`);
  if (packet.consoleErrors.length) packet.consoleErrors.forEach((e) => console.log('    !! console: ' + e));
  console.log(`  allowlist entries applied: ${packet.allowlist.length}; presence-contract: ${packet.presenceContract ? 'present' : 'none'}`);
  console.log(`  GRADE = model step (/design-fidelity). Tier-2 gate: ${packet.selfRegressionGate || '(none configured — set render-recipe.gateCommandTemplate)'}`);
}
