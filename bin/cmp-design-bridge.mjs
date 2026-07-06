#!/usr/bin/env node
// cmp-design-bridge — the deterministic CORE CLI of the Claude-Design→Compose
// bridge. Project-agnostic: every project-specific value comes from a
// `.design-bridge/` CONFIG dir (--config). The two model-driven legs (the
// design→idiomatic-Compose TRANSFORM and the cross-framework fidelity VERDICT)
// are NOT here — they live in the thin skills + the model. This CLI owns the
// reproducible mechanisms: render, lint, pull(-assemble), verify(-packet).
//
//   cmp-design-bridge render  <stateId>  --config <dir> [--out <dir>]
//   cmp-design-bridge lint                --config <dir> [--no-stamp]
//   cmp-design-bridge pull                --config <dir>
//   cmp-design-bridge verify  <stateId>  --config <dir> [--render]
//   cmp-design-bridge doctor              --config <dir>
//
// Runnable by a human, by Claude (via the skills), by CI, or a git-hook — the
// whole point of layer 1 being a CLI and not Claude-Code-locked logic.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from '../lib/config.mjs';
import { renderFrame } from '../lib/render.mjs';
import { lint, printLintReport } from '../lib/lint.mjs';
import { pull, printPullReport } from '../lib/pull.mjs';
import { verify, printVerify } from '../lib/verify.mjs';
import { intake, printIntake } from '../lib/intake.mjs';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key.startsWith('no-')) { flags[key.slice(3)] = false; }
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { flags[key] = argv[++i]; }
      else { flags[key] = true; }
    } else positional.push(a);
  }
  return { positional, flags };
}

function resolveConfigDir(flags) {
  const dir = flags.config || process.env.DESIGN_BRIDGE_CONFIG || '.design-bridge';
  const abs = path.resolve(dir);
  if (!existsSync(path.join(abs, 'config.json'))) {
    console.error(`No config.json at ${abs}. Pass --config <dir> (a .design-bridge directory).`);
    process.exit(2);
  }
  return abs;
}

const USAGE = `cmp-design-bridge <command> --config <.design-bridge dir>

  render  <stateId>   Render one Claude Design frame → isolated dark PNG + pull-manifest
  verify  <stateId>   Build the fidelity packet (reference vs CMP capture + montage + gates)
  intake  <stateId>   Admit an arbitrary raster as the reference: normalize to the
                      canonical geometry + provenance + palette/grid evidence sidecars
  lint                Join-manifest integrity (derive/orphan/pin) + burndown sweep
  pull                Verify staged frames (truncation, runtime pin) + emit pull-index
  doctor              Sanity-check the CONFIG + toolchain (playwright, runtime, captures)

Flags: --config <dir>  --out <dir>  --render (verify: force re-render)
       lint: --no-stamp  --fail-on-backfill (captured-but-frameless inventory states become findings)
       verify: --reference imported (force the imported-screenshot reference path)
       intake: --image <path>  [--content-box x,y,w,h]  [--module <id>]
               [--theme-translation none|light-to-dark]`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(USAGE); return; }

  const cfg = loadConfig(resolveConfigDir(flags));
  const outDir = flags.out ? path.resolve(flags.out) : undefined;

  switch (cmd) {
    case 'render': {
      const stateId = positional[0];
      if (!stateId) { console.error('render needs a <stateId>'); process.exit(2); }
      const r = await renderFrame(cfg, stateId, { outDir });
      console.log(`RENDER [${stateId}] ${r.ok ? 'OK ✓' : 'CHECK ✗'} — ${r.manifest.renderedBox.w}x${r.manifest.renderedBox.h} txt=${r.manifest.textLen}`);
      console.log(`  -> ${r.designPng}`);
      if (r.manifest.consoleErrors.length) { r.manifest.consoleErrors.forEach((e) => console.log('  !! ' + e)); }
      if (!r.ok) process.exit(1);
      break;
    }
    case 'verify': {
      const stateId = positional[0];
      if (!stateId) { console.error('verify needs a <stateId>'); process.exit(2); }
      if (flags.reference !== undefined && flags.reference !== 'imported') {
        console.error(`--reference only supports "imported" (got "${flags.reference}")`); process.exit(2);
      }
      const res = await verify(cfg, stateId, { outDir, render: flags.render === true, referenceImported: flags.reference === 'imported' });
      printVerify(res);
      if (!res.gatesPass) process.exit(1);
      break;
    }
    case 'intake': {
      const stateId = positional[0];
      if (!stateId) { console.error('intake needs a <stateId>'); process.exit(2); }
      let contentBox = null;
      if (flags['content-box']) {
        const parts = String(flags['content-box']).split(',').map((v) => parseInt(v, 10));
        if (parts.length !== 4 || parts.some((v) => Number.isNaN(v))) {
          console.error('--content-box must be x,y,w,h (integers)'); process.exit(2);
        }
        contentBox = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
      }
      const r = await intake(cfg, stateId, {
        outDir,
        imagePath: flags.image,
        contentBox,
        module: flags.module,
        themeTranslation: flags['theme-translation'],
      });
      printIntake(r);
      break;
    }
    case 'lint': {
      const report = lint(cfg, { outDir, stamp: flags.stamp !== false, failOnBackfill: flags['fail-on-backfill'] === true });
      printLintReport(report);
      if (!report.pass) process.exit(1);
      break;
    }
    case 'pull': {
      const index = pull(cfg, { outDir, writeManifest: flags['write-manifest'] === true, force: flags.force === true });
      printPullReport(index);
      if (index.manifestRows != null) console.log(`  join-manifest written: ${index.manifestRows} rows (§9.5 generated from live frames)`);
      if (!index.pass) process.exit(1);
      break;
    }
    case 'doctor': {
      await doctor(cfg);
      break;
    }
    default:
      console.error(`unknown command "${cmd}"\n\n${USAGE}`);
      process.exit(2);
  }
}

async function doctor(cfg) {
  const lines = [];
  let ok = true;
  const check = (label, cond, detail = '') => { lines.push(`  ${cond ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`); if (!cond) ok = false; };

  check('config dir', existsSync(cfg.configDir), cfg.configDir);
  check('frames root', existsSync(cfg.recipe.framesRoot), cfg.recipe.framesRoot);
  check('DS runtime bundle', existsSync(path.join(cfg.recipe.dsRuntimeSource, '_ds_bundle.js')), path.join(cfg.recipe.dsRuntimeSource, '_ds_bundle.js'));
  check('DS runtime styles', existsSync(path.join(cfg.recipe.dsRuntimeSource, 'styles.css')));
  check('CMP screenshot root', existsSync(cfg.cmpScreenshotRoot), cfg.cmpScreenshotRoot);
  for (const m of cfg.modules) {
    const md = path.join(cfg.recipe.framesRoot, m.id);
    check(`module frames: ${m.id}`, existsSync(md), md);
  }
  // Actually launch Chromium — module resolution alone passes even when the
  // browser binary isn't downloaded (a common state that then fails at render).
  try {
    const { resolvePlaywright } = await import('../lib/util.mjs');
    const chromium = resolvePlaywright(cfg);
    const b = await chromium.launch({ headless: true });
    await b.close();
    check('playwright + chromium launch', true, cfg.playwrightFrom || 'resolved');
  } catch (e) { check('playwright + chromium launch', false, e.message.split('\n')[0]); }
  check('join-manifest present', cfg.manifestPresent !== false, cfg.manifestPresent === false ? 'ABSENT — run `pull --write-manifest`' : `${(cfg.manifest.rows || []).length} rows`);
  check('allowlist entries', (cfg.allowlist.entries || []).length > 0, `${(cfg.allowlist.entries || []).length}`);

  console.log(`DOCTOR ${ok ? 'OK ✓' : 'PROBLEMS ✗'}`);
  lines.forEach((l) => console.log(l));
  if (!ok) process.exit(1);
}

main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
