// render.mjs — CORE deterministic frame-renderer (FRAMEWORK_DESIGN §2.3).
//
// Renders ONE per-state Claude Design frame to an isolated PNG at a pinned
// viewport, offline + reproducibly. The per-state-frame runtime (the real
// uploaded Claude Design content) is hermetic: a `<stateId>.html` loads the
// shared DS runtime (`../_ds/_ds_bundle.js`, a plain-JS React-19 IIFE) plus a
// `_<feat>-screen.jsx` + `_<feat>-data.jsx` (plain `React.createElement`, no
// Babel, no CDN), then mounts `window.SB<Feat>.mount("root", STATES[id])`. So
// the renderer is just: static-serve the frame + DS runtime → headless Chromium
// → wait for the mount + fonts → crop the content frame.
//
// Output per render: <out>/<stateId>.design.png + <out>/<stateId>.pull-manifest.json
// The pull-manifest carries the source content-hash (frame + screen + data),
// the DS-runtime hash (revision pinning, §2.3), the rendered CSS box, the
// console-error list, AND the overall render-pass signals (renderOk +
// renderReasons) so the lint + verify legs never pin/grade a FAILED render.

import path from 'node:path';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolvePlaywright, staticServer, sha256OfFiles, sha256OfFile } from './util.mjs';
import { locateFrame } from './config.mjs';

// Framework defaults — neutral mobile-screen recipe (411 logical px @ DPR 3 =
// 1233px, the common xxhdpi capture size). A project pins its own in
// render-recipe.viewport; these only fill a partially-specified viewport.
const DEFAULT_WIDTH_CSS = 411;
const DEFAULT_DPR = 3;
const MIN_TEXT_LEN = 1; // a content floor — a sized-but-empty mount is NOT a pass

/** The shared per-module content files (screen + data), discovered by glob so
 *  the `_<x>.jsx` naming convention isn't baked in. Returns absolute paths. */
async function siblingContentFiles(modDir) {
  try {
    const entries = await readdir(modDir);
    return entries.filter((f) => f.startsWith('_') && f.endsWith('.jsx')).sort().map((f) => path.join(modDir, f));
  } catch { return []; }
}

export async function renderFrame(cfg, stateId, opts = {}) {
  const located = locateFrame(cfg, stateId);
  if (!located) {
    throw new Error(`No frame for stateId "${stateId}" under ${cfg.recipe.framesRoot} (modules: ${cfg.modules.map((m) => m.id).join(', ')})`);
  }
  const { module: mod, framePath } = located;
  const recipe = cfg.recipe;
  const dsSrc = recipe.dsRuntimeSource;
  if (!existsSync(dsSrc)) throw new Error(`dsRuntimeSource not found: ${dsSrc}`);
  if (!existsSync(path.join(dsSrc, '_ds_bundle.js'))) {
    throw new Error(`dsRuntimeSource has no _ds_bundle.js: ${dsSrc} (point render-recipe.dsRuntimeSource at the built ds-bundle/)`);
  }

  const widthCss = recipe.viewport.logicalWidthCss ?? recipe.viewport.logicalWidthDp ?? DEFAULT_WIDTH_CSS;
  const dpr = recipe.viewport.dpr ?? DEFAULT_DPR;
  const outDir = opts.outDir || path.join(cfg.cacheDir, 'out');
  const settleMs = opts.settleMs ?? recipe.settleMs ?? 700;
  await mkdir(outDir, { recursive: true });

  const modDir = path.join(recipe.framesRoot, mod.id);
  const sourceFiles = [framePath, ...(await siblingContentFiles(modDir))];

  // Static-serve: /_ds/* → DS runtime, everything else → frames root.
  const server = await staticServer({
    roots: [
      { prefix: '/_ds/', dir: dsSrc },
      { prefix: '/', dir: recipe.framesRoot },
    ],
  });
  const frameUrl = `${server.url}/${mod.id}/${stateId}.html`;

  const chromium = resolvePlaywright(cfg);
  const browser = await chromium.launch({ headless: true });
  const consoleErrors = [];
  let result;
  try {
    const ctx = await browser.newContext({
      deviceScaleFactor: dpr,
      viewport: { width: widthCss + 80, height: 1400 },
    });
    const page = await ctx.newPage();
    // Tightened favicon suppression: only swallow the favicon 404, never a real
    // error whose text happens to contain the word "favicon".
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon\.ico/.test(m.text())) consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

    await page.goto(frameUrl, { waitUntil: 'load', timeout: 30000 });
    // Wait for the frame's self-mount: #root gets exactly one child with size.
    await page.waitForFunction(() => {
      const root = document.getElementById('root');
      const child = root && root.firstElementChild;
      return !!child && child.getBoundingClientRect().height > 40;
    }, { timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    // Font-load check: fonts.ready resolves even when a face 404s. Capture any
    // FontFace that ended in 'error' so a wrong-font render isn't certified.
    const fontErrors = await page.evaluate(() => {
      const errs = [];
      document.fonts.forEach((f) => { if (f.status === 'error') errs.push(`${f.family} ${f.weight}`); });
      return errs;
    });

    // Neutralize the frame's centering shell so the content child takes its
    // NATURAL height (the `#root { display:flex; min-height:100vh }` +
    // `align-items:stretch` would otherwise stretch the content frame to the
    // full viewport height, padding the crop with empty space).
    await page.evaluate(() => {
      const r = document.getElementById('root');
      if (r) { r.style.alignItems = 'flex-start'; r.style.minHeight = 'auto'; r.style.height = 'auto'; }
      document.documentElement.style.minHeight = 'auto';
      if (document.body) document.body.style.minHeight = 'auto';
    });
    await page.waitForTimeout(settleMs);

    const info = await page.evaluate(() => {
      const root = document.getElementById('root');
      const child = root && root.firstElementChild;
      const r = child ? child.getBoundingClientRect() : null;
      return {
        childCount: root ? root.childElementCount : -1,
        w: r ? Math.round(r.width) : -1,
        h: r ? Math.round(r.height) : -1,
        textLen: child ? (child.innerText || '').length : 0,
        sample: child ? (child.innerText || '').replace(/\s+/g, ' ').slice(0, 120) : '',
      };
    });

    const designPng = path.join(outDir, `${stateId}.design.png`);
    const el = page.locator('#root > *:first-child');
    await el.screenshot({ path: designPng });

    // Overall render-pass signals — recorded in the manifest so lint (pin) and
    // verify (grade) never trust a FAILED render.
    const widthOk = Math.abs(info.w - widthCss) <= 2;
    const renderReasons = [];
    if (consoleErrors.length) renderReasons.push('console-errors');
    if (info.childCount !== 1) renderReasons.push(`childCount=${info.childCount}`);
    if (!widthOk) renderReasons.push(`width=${info.w}!=${widthCss}`);
    if (info.textLen < MIN_TEXT_LEN) renderReasons.push('blank-render(textLen<min)');
    if (fontErrors.length) renderReasons.push('font-load-error:' + fontErrors.join(','));
    const renderOk = renderReasons.length === 0;

    const manifest = {
      stateId,
      module: mod.id,
      framePath,
      designPng,
      viewport: { logicalWidthCss: widthCss, dpr },
      renderedBox: { w: info.w, h: info.h },
      childCount: info.childCount,
      textLen: info.textLen,
      textSample: info.sample,
      widthOk,
      renderOk,
      renderReasons,
      fontErrors,
      sourceContentHash: sha256OfFiles(sourceFiles),
      dsRuntimeHash: sha256OfFile(path.join(dsSrc, '_ds_bundle.js')),
      consoleErrors,
    };
    await writeFile(path.join(outDir, `${stateId}.pull-manifest.json`), JSON.stringify(manifest, null, 2));

    result = { ok: renderOk, stateId, designPng, manifest };
  } finally {
    await browser.close();
    await server.close();
  }
  return result;
}

/** The content-file set render hashes for a state — exported so verify can
 *  recompute it to detect a stale design render (frame re-authored since). */
export async function frameSourceFiles(cfg, stateId) {
  const located = locateFrame(cfg, stateId);
  if (!located) return null;
  const modDir = path.join(cfg.recipe.framesRoot, located.module.id);
  return [located.framePath, ...(await siblingContentFiles(modDir))];
}
