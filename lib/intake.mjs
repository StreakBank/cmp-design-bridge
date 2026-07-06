// intake.mjs — CORE deterministic screenshot-reference intake.
//
// The pipeline's REFERENCE is normally a rendered Claude Design frame. `intake`
// admits an arbitrary raster (a Figma export, a device screenshot, a photo of a
// mock) as the reference for one state instead: it normalizes the image to the
// project's canonical comparison geometry, records provenance, and emits
// deterministic EVIDENCE sidecars for the model legs (palette census + token
// pairing, a dp-grid measuring overlay). It never generates code and never
// decides anything a model leg should judge — the content-box (which pixels are
// the screen vs foreign chrome) and the theme-translation declaration are
// upstream JUDGMENT inputs passed as arguments; intake applies them as a pure
// function.
//
//   normalize:  crop declared content-box → width-fit to viewport width × dpr
//               → clip to clipHeight × dpr for the grading copy (natural height
//               preserved; belowFold surfaces in verify, mirroring render's
//               clipHeight semantics in device space)
//   provenance: sha256 of the source bytes + the transform params — verify's
//               imported-mode staleness covers BOTH (a re-declared crop on an
//               unchanged source must trip notStale; there is no re-render to
//               self-heal with, so verify fails loud instead)
//   module:     an imported state has no frame for locateFrame to resolve, so
//               the module (which locates the SUBJECT capture) comes from
//               --module or the longest matching config statePrefix, recorded
//               in the manifest
//
// Output per intake: <out>/<stateId>.reference.png (normalized grading copy)
//                    <out>/<stateId>.grid.png       (dp-grid overlay variant)
//                    <out>/<stateId>.intake-manifest.json

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolvePlaywright, sha256OfFile } from './util.mjs';

const DEFAULT_PALETTE_TOP_N = 24;
const DEFAULT_SNAP_THRESHOLD = 40;   // euclidean RGB distance; CONFIG-overridable
const DEFAULT_GRID_STEP_DP = 8;      // CONFIG-overridable

/** Resolve the module entry for a frame-less (imported) state: explicit id wins,
 *  else the LONGEST config statePrefix that prefixes the stateId (mirrors the
 *  burndown's capture-attribution semantics; longest-match sidesteps prefix
 *  nesting). Fail-loud — a wrong module means a wrong SUBJECT path in verify. */
export function resolveModuleForImport(cfg, stateId, explicitId) {
  if (explicitId) {
    const m = cfg.modules.find((x) => x.id === explicitId);
    if (!m) throw new Error(`--module "${explicitId}" is not in config.modules (${cfg.modules.map((x) => x.id).join(', ')})`);
    return m;
  }
  const matches = cfg.modules.filter((m) => stateId.startsWith(m.statePrefix));
  if (matches.length === 0) {
    throw new Error(`No config module statePrefix matches "${stateId}" — pass --module <id> (an imported state has no frame to resolve the module from)`);
  }
  return matches.sort((a, b) => b.statePrefix.length - a.statePrefix.length)[0];
}

/** Parse a token palette source: CSS custom properties (--name: #hex | rgb/a())
 *  or a flat JSON {name: "#hex"}. Alpha'd tokens are parsed but excluded from
 *  nearest-pairing (compositing-dependent); they're listed for the model leg. */
export function parseTokenSource(p) {
  const text = readFileSync(p, 'utf8');
  const tokens = [];
  const push = (name, raw) => {
    const c = parseColor(raw);
    if (c) tokens.push({ name, raw, rgb: c.rgb, alpha: c.alpha });
  };
  if (p.endsWith('.json')) {
    for (const [name, raw] of Object.entries(JSON.parse(text))) push(name, String(raw));
  } else {
    for (const m of text.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))/g)) push(m[1], m[2]);
  }
  return tokens;
}

function parseColor(raw) {
  let m = raw.match(/^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/);
  if (m) {
    const v = parseInt(m[1], 16);
    return { rgb: [v >> 16, (v >> 8) & 255, v & 255], alpha: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  }
  m = raw.match(/^#([0-9a-fA-F]{3})$/);
  if (m) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16));
    return { rgb: [r, g, b], alpha: 1 };
  }
  m = raw.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (m) return { rgb: [+m[1], +m[2], +m[3]], alpha: m[4] === undefined ? 1 : +m[4] };
  return null;
}

const dist = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

const OCR_ABSENT_NOTE = 'tesseract.js not installed — OCR sidecar skipped (OPTIONAL dependency: `npm i tesseract.js` in the consuming repo, or globally alongside the CLI, to enable)';

/** Resolve the OPTIONAL OCR engine. tesseract.js is deliberately NOT a
 *  dependency of this package (heavy, runtime traineddata download) — the
 *  sidecar engages only when a consuming environment provides it. Resolution:
 *  the package root, then the process CWD (a consuming repo's node_modules). */
function tryResolveOcr() {
  for (const base of [fileURLToPath(new URL('..', import.meta.url)), process.cwd()]) {
    try {
      const require = createRequire(base.endsWith('/') ? base : base + '/');
      return require('tesseract.js');
    } catch { /* optional — keep trying */ }
  }
  return null;
}

/** Emit the OCR evidence sidecar when the optional engine is present. The
 *  output is ADVISORY EVIDENCE for the model legs — the transform reads copy
 *  from the raster natively; OCR supplements with machine-readable boxes and
 *  MUST NOT be treated as authoritative over the pixels. Word boxes are in
 *  device px of the normalized reference (divide by dpr for dp). */
async function tryOcrSidecar(referencePng, outPath, dpr) {
  const engine = tryResolveOcr();
  if (!engine) return { available: false, note: OCR_ABSENT_NOTE };
  try {
    const worker = await engine.createWorker('eng');
    const { data } = await worker.recognize(referencePng);
    await worker.terminate();
    const words = (data.words || []).map((w) => ({
      text: w.text,
      confidence: w.confidence,
      bboxPx: w.bbox ? { x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 } : null,
    }));
    await writeFile(outPath, JSON.stringify({
      engine: 'tesseract.js',
      note: 'ADVISORY evidence — supplementary to the raster, never authoritative over it. tesseract.js downloads language data at runtime; treat exact glyph output as approximate on stylized UI text. Boxes are device px of the normalized reference; divide by dpr for dp.',
      dpr,
      text: data.text,
      words,
    }, null, 2));
    return { available: true, sidecar: outPath, engine: 'tesseract.js', wordCount: words.length };
  } catch (e) {
    return { available: false, note: `OCR engine present but recognition failed: ${e.message.split('\n')[0]} — sidecar skipped (advisory only)` };
  }
}

export async function intake(cfg, stateId, opts = {}) {
  const recipe = cfg.recipe;
  const imagePath = opts.imagePath && path.resolve(opts.imagePath);
  if (!imagePath || !existsSync(imagePath)) throw new Error(`intake needs --image <path to the source raster> (got: ${opts.imagePath || 'none'})`);
  const mod = resolveModuleForImport(cfg, stateId, opts.module);
  const themeTranslation = opts.themeTranslation || 'none';
  if (!['none', 'light-to-dark'].includes(themeTranslation)) throw new Error(`--theme-translation must be none|light-to-dark (got "${themeTranslation}")`);

  const widthCss = recipe.viewport.logicalWidthCss ?? recipe.viewport.logicalWidthDp ?? 411;
  const dpr = recipe.viewport.dpr ?? 3;
  const targetWidthPx = widthCss * dpr;
  const clipPx = recipe.clipHeight != null ? recipe.clipHeight * dpr : null;
  const gridStepDp = recipe.gridStepDp ?? DEFAULT_GRID_STEP_DP;
  const snapThreshold = recipe.paletteSnapThreshold ?? DEFAULT_SNAP_THRESHOLD;
  const outDir = opts.outDir || path.join(cfg.cacheDir, 'out');
  await mkdir(outDir, { recursive: true });

  const sourceSha256 = sha256OfFile(imagePath);
  const sourceB64 = readFileSync(imagePath).toString('base64');

  // Inventory enrollment (advisory, never fatal): the burndown + the
  // --fail-on-backfill merge gate only see inventory-enrolled states, so an
  // un-enrolled imported state would silently escape the design-SoT gate.
  let inventoryEnrolled = null; // null = no inventory configured
  if (cfg.inventoryPath && existsSync(cfg.inventoryPath)) {
    const inv = readFileSync(cfg.inventoryPath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    inventoryEnrolled = inv.includes(stateId);
  }

  const chromium = resolvePlaywright(cfg);
  const browser = await chromium.launch({ headless: true });
  let result;
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });

    // All raster work happens on in-page canvases (the CLI's existing Chromium
    // is the only dependency). imageSmoothing pinned explicitly for determinism.
    const px = await page.evaluate(async ({ b64, box, targetW, clip }) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('source image failed to decode')); img.src = 'data:image/png;base64,' + b64; });
      const sw = box ? box.w : img.naturalWidth;
      const sh = box ? box.h : img.naturalHeight;
      const sx = box ? box.x : 0;
      const sy = box ? box.y : 0;
      if (sx < 0 || sy < 0 || sx + sw > img.naturalWidth || sy + sh > img.naturalHeight || sw <= 0 || sh <= 0) {
        throw new Error(`content-box ${sx},${sy},${sw},${sh} out of source bounds ${img.naturalWidth}x${img.naturalHeight}`);
      }
      const scale = targetW / sw;
      const dh = Math.round(sh * scale);
      const full = document.createElement('canvas');
      full.width = targetW; full.height = dh;
      const fctx = full.getContext('2d');
      fctx.imageSmoothingEnabled = true; fctx.imageSmoothingQuality = 'high';
      fctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetW, dh);
      const clipped = clip != null && dh > clip;
      const outH = clipped ? clip : dh;
      let refCanvas = full;
      if (clipped) {
        refCanvas = document.createElement('canvas');
        refCanvas.width = targetW; refCanvas.height = clip;
        refCanvas.getContext('2d').drawImage(full, 0, 0);
      }
      // Palette census over the grading copy: exact-color histogram. Flat UI
      // fills dominate exact counts; antialiased blends land in the long tail.
      const data = refCanvas.getContext('2d').getImageData(0, 0, targetW, outH).data;
      const counts = new Map();
      for (let i = 0; i < data.length; i += 4) {
        const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const total = targetW * outH;
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 64)
        .map(([k, n]) => ({ rgb: [k >> 16, (k >> 8) & 255, k & 255], count: n, coveragePct: +(100 * n / total).toFixed(2) }));
      return {
        sourceW: img.naturalWidth, sourceH: img.naturalHeight,
        naturalHeightPx: dh, clipped, outH,
        scaleFactor: +(scale.toFixed(6)),
        referenceB64: refCanvas.toDataURL('image/png').split(',')[1],
        paletteTop: top,
      };
    }, { b64: sourceB64, box: opts.contentBox || null, targetW: targetWidthPx, clip: clipPx });

    const referencePng = path.join(outDir, `${stateId}.reference.png`);
    await writeFile(referencePng, Buffer.from(px.referenceB64, 'base64'));

    // dp-grid overlay variant — a SEPARATE image (never occludes the clean
    // reference): minor line each gridStepDp, labeled major line each 4 steps.
    const gridPng = path.join(outDir, `${stateId}.grid.png`);
    await page.setViewportSize({ width: targetWidthPx, height: Math.min(px.outH, 4000) });
    await page.setContent(`<body style="margin:0"><div style="position:relative;width:${targetWidthPx}px;height:${px.outH}px">
      <img src="data:image/png;base64,${px.referenceB64}" style="display:block;width:${targetWidthPx}px"/>
      <svg width="${targetWidthPx}" height="${px.outH}" style="position:absolute;inset:0">${gridSvg(targetWidthPx, px.outH, gridStepDp * dpr, dpr)}</svg>
    </div></body>`);
    await page.waitForTimeout(100);
    await page.locator('div').first().screenshot({ path: gridPng });

    // Token pairing — theme-gated: nearest-hex across a theme boundary is
    // systematically wrong (a light background's nearest dark-theme token is a
    // TEXT token), so for light-to-dark the census ships WITHOUT pairing and
    // the model leg maps by ROLE against the token list instead.
    let tokens = null;
    let tokenPairing = null;
    if (recipe.tokensSource) {
      const tokensPath = path.isAbsolute(recipe.tokensSource) ? recipe.tokensSource : path.resolve(cfg.configDir, recipe.tokensSource);
      tokens = parseTokenSource(tokensPath).map((t) => ({ ...t, hex: hex(t.rgb) }));
      if (themeTranslation === 'none') {
        const opaque = tokens.filter((t) => t.alpha === 1);
        tokenPairing = px.paletteTop.slice(0, DEFAULT_PALETTE_TOP_N).map((c) => {
          const ranked = opaque.map((t) => ({ token: t.name, tokenHex: t.hex, distance: +dist(c.rgb, t.rgb).toFixed(1) })).sort((a, b) => a.distance - b.distance);
          const best = ranked[0] || null;
          return { observed: hex(c.rgb), coveragePct: c.coveragePct, nearestToken: best, withinThreshold: best ? best.distance <= snapThreshold : false };
        });
      }
    }

    // Optional OCR evidence sidecar (engages only when tesseract.js is present).
    const ocr = await tryOcrSidecar(referencePng, path.join(outDir, `${stateId}.ocr.json`), dpr);

    const params = { contentBox: opts.contentBox || null, targetWidthPx, clipHeightPx: clipPx, themeTranslation, gridStepDp };
    const paramsHash = 'sha256:' + createHash('sha256').update(JSON.stringify(params)).digest('hex');
    const referenceWidthOk = true; // canvas width is targetWidthPx by construction; re-verified from PNG bytes in verify
    const manifest = {
      stateId,
      module: mod.id,
      referenceMode: 'imported',
      sourcePath: imagePath,
      sourceSha256,
      sourceDims: { w: px.sourceW, h: px.sourceH },
      ...params,
      paramsHash,
      scaleFactor: px.scaleFactor,
      naturalHeightPx: px.naturalHeightPx,
      clipped: px.clipped,
      referencePng,
      gridPng,
      referenceWidthOk,
      intakeOk: true,
      inventoryEnrolled,
      ocr,
      palette: {
        topColors: px.paletteTop.slice(0, DEFAULT_PALETTE_TOP_N).map((c) => ({ hex: hex(c.rgb), coveragePct: c.coveragePct })),
        snapThreshold,
        themeTranslation,
        tokenPairing, // null when no tokensSource or when theme-gated off
        tokenPairingNote: themeTranslation === 'light-to-dark'
          ? 'SUPPRESSED: nearest-hex pairing is systematically wrong across a theme boundary — map observed colors to token ROLES (background/surface/text tiers/accent/status) using the tokens list.'
          : (tokens ? 'Nearest-token by RGB distance is EVIDENCE for the model leg, not a decision.' : 'No recipe.tokensSource configured — census only.'),
        tokens: tokens?.map((t) => ({ name: t.name, hex: t.hex, alpha: t.alpha })) ?? null,
      },
    };
    await writeFile(path.join(outDir, `${stateId}.intake-manifest.json`), JSON.stringify(manifest, null, 2));
    result = { ok: true, stateId, referencePng, gridPng, manifest };
  } finally {
    await browser.close();
  }
  return result;
}

function gridSvg(w, h, stepPx, dpr) {
  const parts = [];
  for (let x = 0, i = 0; x <= w; x += stepPx, i++) {
    const major = i % 4 === 0;
    parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="${major ? 'rgba(0,220,255,0.45)' : 'rgba(0,220,255,0.15)'}" stroke-width="1"/>`);
    if (major && x > 0) parts.push(`<text x="${x + 2}" y="12" font-size="10" fill="rgba(0,220,255,0.9)" font-family="monospace">${x / dpr}</text>`);
  }
  for (let y = 0, i = 0; y <= h; y += stepPx, i++) {
    const major = i % 4 === 0;
    parts.push(`<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="${major ? 'rgba(0,220,255,0.45)' : 'rgba(0,220,255,0.15)'}" stroke-width="1"/>`);
    if (major && y > 0) parts.push(`<text x="2" y="${y - 2}" font-size="10" fill="rgba(0,220,255,0.9)" font-family="monospace">${y / dpr}</text>`);
  }
  return parts.join('');
}

export function printIntake({ stateId, referencePng, gridPng, manifest }) {
  console.log(`INTAKE [${stateId}] OK ✓ — module=${manifest.module} ${manifest.targetWidthPx}x${manifest.clipped ? manifest.clipHeightPx : manifest.naturalHeightPx}${manifest.clipped ? ` (clipped from ${manifest.naturalHeightPx})` : ''} scale=${manifest.scaleFactor}`);
  console.log(`  source: ${manifest.sourcePath} (${manifest.sourceDims.w}x${manifest.sourceDims.h}, ${manifest.sourceSha256.slice(0, 19)}…)`);
  if (manifest.contentBox) console.log(`  content-box: ${manifest.contentBox.x},${manifest.contentBox.y} ${manifest.contentBox.w}x${manifest.contentBox.h}`);
  console.log(`  reference: ${referencePng}`);
  console.log(`  grid:      ${gridPng}`);
  console.log(`  theme-translation: ${manifest.themeTranslation}${manifest.themeTranslation === 'light-to-dark' ? ' (token pairing suppressed — role mapping is the model leg)' : ''}`);
  if (manifest.inventoryEnrolled === false) console.log(`  ⚠ stateId not in the state inventory — enroll it so the burndown + \`lint --fail-on-backfill\` gate can see this state`);
  console.log(`  ocr: ${manifest.ocr.available ? `${manifest.ocr.wordCount} words → ${manifest.ocr.sidecar}` : manifest.ocr.note}`);
  const tp = manifest.palette.tokenPairing;
  if (tp) {
    for (const row of tp.slice(0, 8)) {
      console.log(`    ${row.observed} ${String(row.coveragePct).padStart(6)}%  → ${row.nearestToken ? `${row.nearestToken.token} ${row.nearestToken.tokenHex} (d=${row.nearestToken.distance})${row.withinThreshold ? '' : '  ⚠ no token within threshold'}` : '(no opaque tokens)'}`);
    }
  } else {
    for (const c of manifest.palette.topColors.slice(0, 8)) console.log(`    ${c.hex} ${String(c.coveragePct).padStart(6)}%`);
  }
}
