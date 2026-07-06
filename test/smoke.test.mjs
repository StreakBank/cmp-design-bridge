// smoke.test.mjs — standalone smoke test for the cmp-design-bridge CLI.
//
// Run: `npm test` (node --test). Project-agnostic: every fixture is synthesized
// in a temp dir, so the suite has ZERO dependency on StreakBank, the consuming
// repo, or any uploaded Claude Design content — it proves the CORE is a real
// standalone tool. The deterministic legs (config load, deriveCapture, lint,
// pull, gate-command build, CLI dispatch) run with no browser. The render leg is
// gated on a resolvable Chromium and SKIPS when one isn't installed, so `npm
// test` is green in a browserless CI while still exercising render when present.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { loadConfig, deriveCapture, locateFrame } from '../lib/config.mjs';
import { lint } from '../lib/lint.mjs';
import { pull } from '../lib/pull.mjs';
import { buildGateCommand, verify, allowlistFor } from '../lib/verify.mjs';
import { resolvePlaywright } from '../lib/util.mjs';
import { renderFrame } from '../lib/render.mjs';
import { intake, resolveModuleForImport, parseTokenSource, flattenOcrWords } from '../lib/intake.mjs';

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(PLUGIN_ROOT, 'bin', 'cmp-design-bridge.mjs');

// ── fixture builder ────────────────────────────────────────────────────────
// Lays out a self-contained CONFIG + repo so loadConfig/lint/pull/render run
// against synthetic content. Returns { configDir, repoRoot, cleanup }.
function makeFixture(opts = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'cdb-'));
  const repoRoot = path.join(root, 'repo');
  const configDir = path.join(repoRoot, '.design-bridge');
  const frames = path.join(configDir, '.cache', 'canvas');
  const dsRuntime = path.join(configDir, 'ds-runtime');
  const captureDir = path.join(repoRoot, 'app', 'feature', 'screenshots');
  for (const d of [frames, dsRuntime, captureDir, path.join(frames, 'demo')]) mkdirSync(d, { recursive: true });

  // Minimal DS runtime (pull hashes _ds_bundle.js; doctor wants styles.css).
  writeFileSync(path.join(dsRuntime, '_ds_bundle.js'), '/* ds runtime */\nwindow.__ds = true;\n');
  writeFileSync(path.join(dsRuntime, 'styles.css'), 'body{background:#0A0E17}');

  // A complete frame + the shared sibling JSX.
  const frame = (id) => `<!doctype html><html><head><meta name="sb-state-id" content="${id}">
<link rel="stylesheet" href="../_ds/styles.css"><script src="../_ds/_ds_bundle.js"></script></head>
<body><div id="root"></div>
<script>document.getElementById('root').appendChild(Object.assign(document.createElement('div'),
  {style:'width:411px;height:200px;background:#131924;color:#fff',textContent:'${id}'}));</script>
</body></html>\n`;
  writeFileSync(path.join(frames, 'demo', 'demo-a.html'), frame('demo-a'));
  writeFileSync(path.join(frames, 'demo', '_demo-screen.jsx'), '/* shared screen */\n;(function(){window.SBDemo={};})();\n');
  writeFileSync(path.join(frames, 'demo', '_demo-data.jsx'), '/* shared data */\n;(function(){window.SBDemoData={};})();\n');

  // A matching subject screenshot (lint existence check; bytes irrelevant).
  if (opts.withCapture !== false) writeFileSync(path.join(captureDir, 'demo-a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const recipe = {
    bundleRuntime: 'per-state-frame',
    viewport: { logicalWidthCss: 411, dpr: 3 },
    stateIdMeta: 'sb-state-id',
    gateCommandTemplate: 'cd app && ./gradlew :{module}:feature:verifyScreenshots',
    dsRuntimeSource: './ds-runtime',
    framesRoot: '.cache/canvas',
    ...opts.recipeExtra,
  };
  writeFileSync(path.join(configDir, 'render-recipe.json'), JSON.stringify(recipe));
  writeFileSync(path.join(configDir, 'state-inventory.txt'), 'demo-a\n');

  const config = {
    projectId: 'fixture',
    repoRoot: '..',
    modules: [{ id: 'demo', captureDir: 'feature/screenshots', statePrefix: 'demo-' }],
    cmpScreenshotRoot: 'app',
    captureDeriveRule: '{stateId}.png',
    inventoryPath: './state-inventory.txt',
    render: './render-recipe.json',
    joinManifest: './join-manifest.json',
    ...opts.configExtra,
  };
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config));
  if (opts.manifest) writeFileSync(path.join(configDir, 'join-manifest.json'), JSON.stringify(opts.manifest));

  return { root, repoRoot, configDir, frames, captureDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ── buildGateCommand (pure) ─────────────────────────────────────────────────
test('buildGateCommand substitutes {module}/{stateId} and is gate-tool-agnostic', () => {
  assert.equal(
    buildGateCommand('cd app && ./gradlew :{module}:feature:verifyScreenshots', 'ranks', 'profile-self'),
    'cd app && ./gradlew :ranks:feature:verifyScreenshots',
  );
  assert.equal(buildGateCommand('cap {module} {stateId}', 'm', 's'), 'cap m s');
  assert.equal(buildGateCommand('', 'm', 's'), null, 'empty template → null (advisory-only)');
  assert.equal(buildGateCommand(undefined, 'm', 's'), null, 'no template → null');
});

// ── loadConfig validation + path anchoring ──────────────────────────────────
test('loadConfig validates required keys and anchors paths', () => {
  const fx = makeFixture();
  try {
    const cfg = loadConfig(fx.configDir);
    // dsRuntimeSource + framesRoot are configDir-anchored.
    assert.equal(cfg.recipe.dsRuntimeSource, path.join(fx.configDir, 'ds-runtime'));
    assert.equal(cfg.recipe.framesRoot, path.join(fx.configDir, '.cache', 'canvas'));
    // cmpScreenshotRoot is repoRoot-anchored.
    assert.equal(cfg.cmpScreenshotRoot, path.join(fx.repoRoot, 'app'));
    assert.equal(cfg.modules[0].id, 'demo');
  } finally { fx.cleanup(); }
});

test('loadConfig throws on a missing required key', () => {
  // configExtra sets captureDeriveRule:undefined; JSON.stringify drops it, so the
  // written config.json lacks the required key.
  const fx = makeFixture({ configExtra: { captureDeriveRule: undefined } });
  try {
    assert.throws(() => loadConfig(fx.configDir), /missing required keys.*captureDeriveRule/);
  } finally { fx.cleanup(); }
});

// ── deriveCapture (both rule forms) ─────────────────────────────────────────
test('deriveCapture resolves the basename rule under the module captureDir', () => {
  const fx = makeFixture();
  try {
    const cfg = loadConfig(fx.configDir);
    const cap = deriveCapture(cfg, 'demo-a', cfg.modules[0]);
    assert.equal(cap, path.join(fx.captureDir, 'demo-a.png'));
  } finally { fx.cleanup(); }
});

test('deriveCapture resolves a full {module}/{stateId} path rule', () => {
  const fx = makeFixture({ configExtra: { captureDeriveRule: 'shots/{module}/{stateId}.png' } });
  try {
    const cfg = loadConfig(fx.configDir);
    const cap = deriveCapture(cfg, 'demo-a', cfg.modules[0]);
    assert.equal(cap, path.join(fx.repoRoot, 'app', 'shots', 'demo', 'demo-a.png'));
  } finally { fx.cleanup(); }
});

// ── locateFrame ─────────────────────────────────────────────────────────────
test('locateFrame finds an authored frame and returns null otherwise', () => {
  const fx = makeFixture();
  try {
    const cfg = loadConfig(fx.configDir);
    assert.ok(locateFrame(cfg, 'demo-a'), 'demo-a frame is found');
    assert.equal(locateFrame(cfg, 'nope-x'), null);
  } finally { fx.cleanup(); }
});

// ── lint: DERIVE pass, MISWIRE fail, burndown math ──────────────────────────
test('lint passes an all-DERIVED manifest with an existing capture', () => {
  const fx = makeFixture({ manifest: { rows: [{ frameId: 'demo/demo-a.html', stateId: 'demo-a', module: 'demo', cmpCapture: 'DERIVED', designContentHash: 'auto' }] } });
  try {
    const cfg = loadConfig(fx.configDir);
    const report = lint(cfg, { stamp: false });
    assert.equal(report.pass, true, JSON.stringify(report.findings));
    const demo = report.burndown.find((b) => b.module === 'demo');
    assert.equal(demo.coveragePct, 100);
  } finally { fx.cleanup(); }
});

test('lint FAILS a miswired row (hardcoded capture != derived)', () => {
  const fx = makeFixture({ manifest: { rows: [{ frameId: 'demo/demo-a.html', stateId: 'demo-a', module: 'demo', cmpCapture: 'totally/wrong/path.png' }] } });
  try {
    const cfg = loadConfig(fx.configDir);
    const report = lint(cfg, { stamp: false });
    assert.equal(report.pass, false);
    assert.ok(report.findings.some((f) => f.kind === 'MISWIRED_CAPTURE'));
  } finally { fx.cleanup(); }
});

test('lint coverage never exceeds 100% and buckets frames beyond the inventory', () => {
  // inventory = [demo-a]; author demo-a (in inventory) + demo-extra (beyond it).
  const fx = makeFixture({ manifest: { rows: [
    { frameId: 'demo/demo-a.html', stateId: 'demo-a', module: 'demo', cmpCapture: 'DERIVED' },
    { frameId: 'demo/demo-extra.html', stateId: 'demo-extra', module: 'demo', cmpCapture: 'DERIVED' },
  ] } });
  try {
    const cfg = loadConfig(fx.configDir);
    const report = lint(cfg, { stamp: false });
    const demo = report.burndown.find((b) => b.module === 'demo');
    assert.equal(demo.coveragePct, 100, 'capped at 100, not 200');
    assert.deepEqual(demo.framesNotInInventory, ['demo-extra']);
  } finally { fx.cleanup(); }
});

test('lint warns loudly when the configured join-manifest file is absent', () => {
  const fx = makeFixture(); // no manifest written
  try {
    const cfg = loadConfig(fx.configDir);
    const report = lint(cfg, { stamp: false });
    assert.equal(report.pass, false);
    assert.ok(report.findings.some((f) => f.kind === 'MANIFEST_FILE_ABSENT'));
  } finally { fx.cleanup(); }
});

// ── pull: completeness, empty/zero-frame fail-loud, shrink-guard ────────────
test('pull passes a complete frame and can generate the join-manifest', () => {
  const fx = makeFixture();
  try {
    const cfg = loadConfig(fx.configDir);
    const index = pull(cfg, { writeManifest: true });
    assert.equal(index.pass, true, JSON.stringify(index.findings));
    assert.equal(index.frameCount, 1);
    assert.equal(index.manifestRows, 1);
    assert.ok(existsSync(path.join(fx.configDir, 'join-manifest.json')));
  } finally { fx.cleanup(); }
});

test('pull FAILS a truncated frame (missing </html> and meta stamp)', () => {
  const fx = makeFixture();
  try {
    writeFileSync(path.join(fx.frames, 'demo', 'demo-a.html'), '<!doctype html><html><body><div id="root">truncated…');
    const cfg = loadConfig(fx.configDir);
    const index = pull(cfg, {});
    assert.equal(index.pass, false);
    assert.ok(index.findings.some((f) => f.kind === 'FRAME_INCOMPLETE'));
  } finally { fx.cleanup(); }
});

test('pull FAILS an empty module (no frames staged)', () => {
  const fx = makeFixture();
  try {
    rmSync(path.join(fx.frames, 'demo', 'demo-a.html'));
    const cfg = loadConfig(fx.configDir);
    const index = pull(cfg, {});
    assert.equal(index.pass, false);
    assert.ok(index.findings.some((f) => f.kind === 'EMPTY_MODULE' || f.kind === 'NO_FRAMES'));
  } finally { fx.cleanup(); }
});

test('pull --write-manifest refuses to shrink the manifest without --force', () => {
  const fx = makeFixture({ manifest: { rows: [
    { frameId: 'demo/demo-a.html', stateId: 'demo-a', module: 'demo', cmpCapture: 'DERIVED' },
    { frameId: 'demo/gone.html', stateId: 'gone', module: 'demo', cmpCapture: 'DERIVED' },
  ] } });
  try {
    const cfg = loadConfig(fx.configDir); // only demo-a is on disk → would shrink 2→1
    const index = pull(cfg, { writeManifest: true });
    assert.equal(index.pass, false);
    assert.ok(index.findings.some((f) => f.kind === 'MANIFEST_SHRINK_BLOCKED'));
  } finally { fx.cleanup(); }
});

// ── CLI dispatch (the bin is runnable as a command) ─────────────────────────
test('CLI: `help` prints usage and exits 0', () => {
  const out = execFileSync('node', [BIN, 'help']).toString();
  assert.match(out, /cmp-design-bridge <command>/);
  assert.match(out, /render|verify|lint|pull|doctor/);
});

test('CLI: unknown command exits non-zero', () => {
  assert.throws(() => execFileSync('node', [BIN, 'bogus-cmd', '--config', '/nope'], { stdio: 'pipe' }));
});

// ── render (gated on a resolvable Chromium; SKIP otherwise) ──────────────────
// The skip-gate must verify a LAUNCHABLE browser binary, not just that the
// playwright module resolves — the module always resolves (it's a dependency),
// but `npm install` does NOT download a browser, so a binary-absent CI must
// SKIP, not FAIL. Mirrors doctor()'s real launch+close (bin/cmp-design-bridge.mjs).
async function chromiumLaunchable() {
  try {
    const chromium = resolvePlaywright({});
    const b = await chromium.launch({ headless: true });
    await b.close();
    return true;
  } catch { return false; } // playwright module unresolved OR browser binary not installed
}

const pngHeight = (file) => readFileSync(file).readUInt32BE(20); // PNG IHDR height (BE, byte 20)

const SKIP_MSG = 'Playwright/Chromium not launchable — run `npm install && npx playwright install chromium`';

test('render produces an isolated PNG from a synthetic frame', async (t) => {
  if (!(await chromiumLaunchable())) { t.skip(SKIP_MSG); return; }
  const fx = makeFixture();
  try {
    const cfg = loadConfig(fx.configDir);
    const res = await renderFrame(cfg, 'demo-a', {});
    assert.equal(res.ok, true, JSON.stringify(res.manifest?.renderReasons));
    assert.ok(existsSync(res.designPng));
    assert.equal(res.manifest.childCount, 1);
    assert.ok(res.manifest.widthOk);
  } finally { fx.cleanup(); }
});

test('render clips a tall design to recipe.clipHeight and preserves the natural height', async (t) => {
  if (!(await chromiumLaunchable())) { t.skip(SKIP_MSG); return; }
  const fx = makeFixture({ recipeExtra: { clipHeight: 300 } });
  try {
    // A frame whose single root child (600px) is taller than the clip height.
    writeFileSync(path.join(fx.frames, 'demo', 'demo-tall.html'),
      `<!doctype html><html><head><meta name="sb-state-id" content="demo-tall">
<link rel="stylesheet" href="../_ds/styles.css"><script src="../_ds/_ds_bundle.js"></script></head>
<body><div id="root"></div><script>document.getElementById('root').appendChild(Object.assign(
  document.createElement('div'),{style:'width:411px;height:600px;background:#131924;color:#fff',textContent:'tall'}));</script></body></html>\n`);
    const cfg = loadConfig(fx.configDir);
    const res = await renderFrame(cfg, 'demo-tall', {});
    assert.equal(res.ok, true, JSON.stringify(res.manifest?.renderReasons));
    assert.equal(res.manifest.clipped, true, 'a 600px child must clip to clipHeight 300');
    assert.ok(res.manifest.naturalHeightCss >= 500, `natural height preserved (got ${res.manifest.naturalHeightCss})`);
    assert.equal(res.manifest.capturedHeightCss, 300);
    // The captured PNG is clipped to clipHeight * dpr (300 * 3 = 900), NOT the natural ~1800.
    assert.equal(pngHeight(res.designPng), 300 * 3);
  } finally { fx.cleanup(); }
});

test('render content-floor: text-less-but-content-ful PASSES; a truly-empty mount FAILS', async (t) => {
  if (!(await chromiumLaunchable())) { t.skip(SKIP_MSG); return; }
  const fx = makeFixture();
  try {
    // (a) shimmer: NO text, but a non-trivial element subtree → a real render.
    writeFileSync(path.join(fx.frames, 'demo', 'demo-shimmer.html'),
      `<!doctype html><html><head><meta name="sb-state-id" content="demo-shimmer">
<link rel="stylesheet" href="../_ds/styles.css"><script src="../_ds/_ds_bundle.js"></script></head>
<body><div id="root"></div><script>var c=document.createElement('div');
c.style='width:411px;height:200px;background:#131924';
for(var i=0;i<6;i++){var b=document.createElement('div');b.style='width:80px;height:12px;background:#222;margin:8px';c.appendChild(b);}
document.getElementById('root').appendChild(c);</script></body></html>\n`);
    // (b) empty: a sized child with NO text AND NO descendants → broken/blank mount.
    writeFileSync(path.join(fx.frames, 'demo', 'demo-empty.html'),
      `<!doctype html><html><head><meta name="sb-state-id" content="demo-empty">
<link rel="stylesheet" href="../_ds/styles.css"><script src="../_ds/_ds_bundle.js"></script></head>
<body><div id="root"></div><script>document.getElementById('root').appendChild(Object.assign(
  document.createElement('div'),{style:'width:411px;height:200px;background:#131924'}));</script></body></html>\n`);
    const cfg = loadConfig(fx.configDir);

    const shimmer = await renderFrame(cfg, 'demo-shimmer', {});
    assert.equal(shimmer.manifest.textLen, 0, 'shimmer renders no text');
    assert.ok(shimmer.manifest.descendantCount >= 4, 'shimmer has a real element subtree');
    assert.equal(shimmer.ok, true, 'a text-less render WITH content must PASS the floor');

    const empty = await renderFrame(cfg, 'demo-empty', {});
    assert.equal(empty.ok, false, 'a sized-but-empty mount must FAIL the content floor');
    assert.ok(empty.manifest.renderReasons.some((r) => r.startsWith('blank-render')), JSON.stringify(empty.manifest.renderReasons));
  } finally { fx.cleanup(); }
});

// ── intake + imported-reference verify ───────────────────────────────────────
// Pure parts run browserless; the end-to-end intake/verify legs are gated on a
// launchable Chromium like the render tests.

test('resolveModuleForImport: explicit id wins, longest statePrefix matches, no match throws', () => {
  const fx = makeFixture({ configExtra: { modules: [
    { id: 'demo', captureDir: 'feature/screenshots', statePrefix: 'demo-' },
    { id: 'demo-sub', captureDir: 'feature/screenshots', statePrefix: 'demo-sub-' },
  ] } });
  try {
    const cfg = loadConfig(fx.configDir);
    assert.equal(resolveModuleForImport(cfg, 'anything', 'demo').id, 'demo', 'explicit id wins');
    assert.throws(() => resolveModuleForImport(cfg, 'x', 'nope'), /not in config.modules/);
    assert.equal(resolveModuleForImport(cfg, 'demo-sub-a', null).id, 'demo-sub', 'LONGEST prefix wins');
    assert.equal(resolveModuleForImport(cfg, 'demo-a', null).id, 'demo');
    assert.throws(() => resolveModuleForImport(cfg, 'other-a', null), /No config module statePrefix matches/);
  } finally { fx.cleanup(); }
});

test('parseTokenSource: CSS custom properties (hex + rgba) and flat JSON', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cdb-tok-'));
  try {
    const cssPath = path.join(dir, 'tokens.css');
    writeFileSync(cssPath, ':root{\n  --bg: #0A0E17;\n  --accent: #00E87B;\n  --accent-dim: rgba(0,232,123,0.15);\n  --short: #fff;\n}\n');
    const css = parseTokenSource(cssPath);
    assert.equal(css.length, 4);
    assert.deepEqual(css.find((t) => t.name === 'bg').rgb, [10, 14, 23]);
    assert.equal(css.find((t) => t.name === 'accent-dim').alpha, 0.15, 'rgba alpha parsed');
    assert.deepEqual(css.find((t) => t.name === 'short').rgb, [255, 255, 255], '#fff shorthand');
    const jsonPath = path.join(dir, 'tokens.json');
    writeFileSync(jsonPath, JSON.stringify({ Bg: '#0A0E17', Accent: '#00E87B' }));
    assert.equal(parseTokenSource(jsonPath).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Synthesizes a foreign-geometry "device screenshot": 540x960, a 40px status
// bar strip on top, dominant #223344 content with a #FF6B35 block.
async function makeSourceScreenshot(file) {
  const chromium = resolvePlaywright({});
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 540, height: 960 }, deviceScaleFactor: 1 });
    await page.setContent(`<body style="margin:0"><div style="width:540px;height:960px">
      <div style="height:40px;background:#000;color:#0f0;font:12px monospace">12:00 ▮▮▮</div>
      <div style="height:920px;background:#223344"><div style="width:200px;height:100px;background:#FF6B35"></div>
        <p style="color:#F0F2F5;font:16px sans-serif;padding:8px">hello screenshot</p></div>
    </div></body>`);
    await page.waitForTimeout(50);
    await page.locator('body > div').screenshot({ path: file });
  } finally { await browser.close(); }
}

test('intake normalizes a foreign raster to canonical width, records provenance+params, emits palette + grid', async (t) => {
  if (!(await chromiumLaunchable())) { t.skip(SKIP_MSG); return; }
  const fx = makeFixture({ recipeExtra: { clipHeight: 914, tokensSource: './tokens.css', paletteSnapThreshold: 40 } });
  try {
    writeFileSync(path.join(fx.configDir, 'tokens.css'), ':root{ --bg: #0A0E17; --card: #223344; --hot: #FF6B35; --text: #F0F2F5; }');
    const src = path.join(fx.root, 'shot.png');
    await makeSourceScreenshot(src);
    const cfg = loadConfig(fx.configDir);
    const res = await intake(cfg, 'demo-import', { imagePath: src, contentBox: { x: 0, y: 40, w: 540, h: 920 }, themeTranslation: 'none' });
    assert.equal(res.ok, true);
    assert.ok(existsSync(res.referencePng) && existsSync(res.gridPng));
    const refW = readFileSync(res.referencePng).readUInt32BE(16);
    assert.equal(refW, 411 * 3, 'normalized to canonical width');
    const m = res.manifest;
    assert.equal(m.module, 'demo', 'module resolved via statePrefix');
    assert.match(m.sourceSha256, /^sha256:/);
    assert.match(m.paramsHash, /^sha256:/);
    assert.ok(Math.abs(m.scaleFactor - 1233 / 540) < 0.001, `scaleFactor (got ${m.scaleFactor})`);
    // Clipped: 920 * (1233/540) ≈ 2101 px < 2742 → NOT clipped.
    assert.equal(m.clipped, false);
    // Palette: the dominant content fill must pair with its exact token at distance 0.
    const pair = m.palette.tokenPairing.find((r) => r.observed === '#223344');
    assert.ok(pair, 'dominant color in census');
    assert.equal(pair.nearestToken.token, 'card');
    assert.equal(pair.nearestToken.distance, 0);
    assert.equal(pair.withinThreshold, true);
  } finally { fx.cleanup(); }
});

test('intake theme-gating: light-to-dark suppresses token pairing; bad content-box fails loud', async (t) => {
  if (!(await chromiumLaunchable())) { t.skip(SKIP_MSG); return; }
  const fx = makeFixture({ recipeExtra: { tokensSource: './tokens.css' } });
  try {
    writeFileSync(path.join(fx.configDir, 'tokens.css'), ':root{ --bg: #0A0E17; }');
    const src = path.join(fx.root, 'shot.png');
    await makeSourceScreenshot(src);
    const cfg = loadConfig(fx.configDir);
    const res = await intake(cfg, 'demo-light', { imagePath: src, themeTranslation: 'light-to-dark' });
    assert.equal(res.manifest.palette.tokenPairing, null, 'pairing suppressed cross-theme');
    assert.match(res.manifest.palette.tokenPairingNote, /SUPPRESSED/);
    assert.ok(res.manifest.palette.tokens.length > 0, 'token list still shipped for role mapping');
    await assert.rejects(
      () => intake(cfg, 'demo-bad', { imagePath: src, contentBox: { x: 0, y: 0, w: 9999, h: 10 } }),
      /out of source bounds/,
    );
  } finally { fx.cleanup(); }
});

test('verify imported mode: gates + packet + staleness trips on source drift', async (t) => {
  if (!(await chromiumLaunchable())) { t.skip(SKIP_MSG); return; }
  const fx = makeFixture();
  try {
    const src = path.join(fx.root, 'shot.png');
    await makeSourceScreenshot(src);
    const cfg = loadConfig(fx.configDir);
    const res = await intake(cfg, 'demo-import', { imagePath: src, contentBox: { x: 0, y: 40, w: 540, h: 920 } });
    // Subject: reuse the reference bytes at the derived capture path (existence + IHDR only).
    const cmpPath = path.join(fx.captureDir, 'demo-import.png');
    writeFileSync(cmpPath, readFileSync(res.referencePng));

    const v1 = await verify(cfg, 'demo-import', {});
    assert.equal(v1.packet.referenceMode, 'imported', 'auto-detected (no frame, manifest present)');
    assert.equal(v1.gatesPass, true, JSON.stringify(v1.packet.gates));
    assert.ok(existsSync(v1.packet.montagePng));
    assert.equal(v1.packet.intake.sourceSha256, res.manifest.sourceSha256);
    assert.ok(!v1.packet.gradeInstruction.includes('THEME TRANSLATION'));

    // Source drift → notStale false, gatesPass false (fail-loud, no self-heal).
    writeFileSync(src, readFileSync(src).subarray(0, 100));
    const v2 = await verify(cfg, 'demo-import', {});
    assert.equal(v2.packet.gates.notStale, false, 'source drift must trip staleness');
    assert.equal(v2.gatesPass, false);

    // Explicit flag on a frame-ful state forces the imported path (spike shape).
    await makeSourceScreenshot(src);
    await intake(cfg, 'demo-a', { imagePath: src, contentBox: { x: 0, y: 40, w: 540, h: 920 } });
    const v3 = await verify(cfg, 'demo-a', { referenceImported: true });
    assert.equal(v3.packet.referenceMode, 'imported', '--reference imported wins over the existing frame');
  } finally { fx.cleanup(); }
});

// ── 0.2.0: per-state allowlist scoping, backfill gate, inventory + OCR fields ─

test('allowlistFor: entries are global by default; states[] scopes to listed ids', () => {
  const cfg = { allowlist: { entries: [
    { id: 'global-a', class: 'render', rule: 'r', suppress: 's' },
    { id: 'scoped-b', class: 'translation', rule: 'r', suppress: 's', states: ['demo-x'] },
  ] } };
  assert.deepEqual(allowlistFor(cfg, 'demo-x').map((e) => e.id), ['global-a', 'scoped-b']);
  assert.deepEqual(allowlistFor(cfg, 'demo-y').map((e) => e.id), ['global-a'], 'scoped entry excluded elsewhere');
  assert.deepEqual(allowlistFor({ allowlist: {} }, 'any'), [], 'missing entries → empty');
});

test('lint --fail-on-backfill: captured-but-frameless inventory state becomes a real finding', () => {
  const fx = makeFixture({ manifest: { rows: [{ frameId: 'demo/demo-a.html', stateId: 'demo-a', module: 'demo', cmpCapture: 'DERIVED' }] } });
  try {
    // demo-b: capture on disk + inventory-enrolled, but NO frame → backfillQueue.
    writeFileSync(path.join(fx.captureDir, 'demo-b.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(path.join(fx.configDir, 'state-inventory.txt'), 'demo-a\ndemo-b\n');
    const cfg = loadConfig(fx.configDir);

    const soft = lint(cfg, { stamp: false });
    assert.equal(soft.pass, true, 'without the flag the queue stays informational');
    assert.ok(soft.burndown.find((b) => b.module === 'demo').backfillQueue.includes('demo-b'));

    const hard = lint(loadConfig(fx.configDir), { stamp: false, failOnBackfill: true });
    assert.equal(hard.pass, false, 'with the flag the queue is a real finding');
    assert.ok(hard.findings.some((f) => f.kind === 'BACKFILL_REQUIRED' && f.row === 'demo/demo-b'));
  } finally { fx.cleanup(); }
});

test('intake records inventory enrollment and the OCR optional-dep status', async (t) => {
  if (!(await chromiumLaunchable())) { t.skip(SKIP_MSG); return; }
  const fx = makeFixture();
  try {
    const src = path.join(fx.root, 'shot.png');
    await makeSourceScreenshot(src);
    const cfg = loadConfig(fx.configDir);

    // 'demo-import' is NOT in the fixture inventory (only demo-a) → warn field false.
    const un = await intake(cfg, 'demo-import', { imagePath: src });
    assert.equal(un.manifest.inventoryEnrolled, false);
    // OCR: tesseract.js is deliberately not installed here → graceful absence.
    assert.equal(un.manifest.ocr.available, false);
    assert.match(un.manifest.ocr.note, /OPTIONAL dependency/);

    // Enroll it → flips true.
    writeFileSync(path.join(fx.configDir, 'state-inventory.txt'), 'demo-a\ndemo-import\n');
    const en = await intake(loadConfig(fx.configDir), 'demo-import', { imagePath: src });
    assert.equal(en.manifest.inventoryEnrolled, true);
  } finally { fx.cleanup(); }
});

// ── 0.2.0 review fixes: fail-loud scoping, gate-without-inventory, OCR flatten,
//    missing-reference gate reachability ─────────────────────────────────────

test('allowlistFor throws on a malformed (non-array) states value — never fails open to global', () => {
  const cfg = { allowlist: { entries: [{ id: 'bad', class: 'translation', rule: 'r', suppress: 's', states: 'demo-x' }] } };
  assert.throws(() => allowlistFor(cfg, 'demo-x'), /must be an array/);
});

test('lint --fail-on-backfill without an inventory does NOT gate (info finding instead)', () => {
  const fx = makeFixture({ configExtra: { inventoryPath: undefined }, manifest: { rows: [] } });
  try {
    // A capture with no frame and NO inventory configured — must not become a finding.
    writeFileSync(path.join(fx.captureDir, 'demo-b.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const report = lint(loadConfig(fx.configDir), { stamp: false, failOnBackfill: true });
    assert.equal(report.pass, true, 'no inventory → the gate must not fire');
    assert.ok(report.findings.some((f) => f.kind === 'BACKFILL_GATE_NO_INVENTORY' && f.severity === 'info'));
    assert.ok(!report.findings.some((f) => f.kind === 'BACKFILL_REQUIRED'));
  } finally { fx.cleanup(); }
});

test('flattenOcrWords: v6/v7 block tree and legacy flat words both flatten', () => {
  const w = (t, x0) => ({ text: t, confidence: 90, bbox: { x0, y0: 0, x1: x0 + 10, y1: 10 } });
  const v7 = { blocks: [{ paragraphs: [{ lines: [{ words: [w('a', 0), w('b', 20)] }, { words: [w('c', 40)] }] }] }, { paragraphs: [{ lines: [{ words: [w('d', 60)] }] }] }] };
  assert.deepEqual(flattenOcrWords(v7).map((x) => x.text), ['a', 'b', 'c', 'd']);
  assert.deepEqual(flattenOcrWords(v7)[0].bboxPx, { x0: 0, y0: 0, x1: 10, y1: 10 });
  const legacy = { words: [w('z', 0)] };
  assert.deepEqual(flattenOcrWords(legacy).map((x) => x.text), ['z']);
  assert.deepEqual(flattenOcrWords({ blocks: null }), [], 'null blocks → empty');
});

test('verify imported: a DELETED reference.png reports referenceExists=false instead of crashing', async (t) => {
  if (!(await chromiumLaunchable())) { t.skip(SKIP_MSG); return; }
  const fx = makeFixture();
  try {
    const src = path.join(fx.root, 'shot.png');
    await makeSourceScreenshot(src);
    const cfg = loadConfig(fx.configDir);
    const res = await intake(cfg, 'demo-import', { imagePath: src });
    writeFileSync(path.join(fx.captureDir, 'demo-import.png'), readFileSync(res.referencePng));
    rmSync(res.referencePng); // simulate a cache wipe between intake and verify
    const v = await verify(cfg, 'demo-import', {});
    assert.equal(v.packet.gates.referenceExists, false);
    assert.equal(v.gatesPass, false);
    assert.ok(existsSync(v.packet.montagePng), 'montage still produced (placeholder reference cell)');
  } finally { fx.cleanup(); }
});
