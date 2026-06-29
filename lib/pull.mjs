// pull.mjs — CORE deterministic pull-assembly + revision pinning
// (FRAMEWORK_DESIGN §2.1 + §9.3).
//
// THE BOUNDARY: fetching files OUT of Claude Design needs the `claude_design`
// MCP (list_files / read_file), which is a Claude-Code tool, not something a
// Node subprocess can call. So the MCP fetch loop lives in the /design-pull
// SKILL (layer 3, Claude-driven): it stages each frame + the shared `_ds/`
// runtime into the frames root. THIS subcommand is the deterministic half: given
// staged frames, it (a) checks each for silent truncation (the 256 KiB read cap
// is real), (b) pins the DS-runtime content-hash against the value recorded at
// upload, and (c) emits a pull-index whose per-frame contentHash matches the
// render/lint pin (frame html + shared `_*.jsx` siblings).
//
// Fail-loud: an empty pull (0 frames, or any configured module with 0 frames) is
// a FAILURE, not a green check — transferring nothing is the #1 thing pull exists
// to catch. And `--write-manifest` refuses to shrink the join-manifest without
// `--force`, so a botched pull can't silently wipe it.

import path from 'node:path';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { sha256OfFiles, sha256OfFile } from './util.mjs';

/** Heuristic truncation check for the hermetic per-state-frame runtime.
 *  Hard problems FAIL pull; the brittle paren-balance heuristic is a WARNING
 *  only (UI copy like "(locked" / "co-winner)" can imbalance a COMPLETE file). */
function checkFrameComplete(html, screenJs, dataJs, stateIdMeta) {
  const hard = [];
  const warn = [];
  if (!/<\/html>\s*$/i.test(html.trimEnd() + '\n')) hard.push('html does not end with </html> (truncated?)');
  if (!new RegExp(`name="${stateIdMeta}"`).test(html)) hard.push(`html missing <meta name="${stateIdMeta}"> identity stamp`);
  // The screen/data JS are IIFEs assigning window.SB* — a truncated tail breaks
  // the closing `})();`. Prefer the tail-token check; fall back to paren-balance
  // as a non-failing warning (it false-positives on parens in UI copy).
  for (const [name, js] of [['screen', screenJs], ['data', dataJs]]) {
    if (js == null) continue;
    const trimmed = js.trimEnd();
    const tailOk = /\}\)\(\)\s*;?\s*$/.test(trimmed) || /\}\s*;?\s*$/.test(trimmed);
    if (!tailOk) {
      const open = (js.match(/\(/g) || []).length;
      const close = (js.match(/\)/g) || []).length;
      if (open !== close) warn.push(`${name}.jsx does not end with a closing IIFE/brace and parens imbalance ${open}/${close} (possible truncation)`);
    }
  }
  return { hard, warn };
}

export function pull(cfg, opts = {}) {
  const recipe = cfg.recipe;
  const stateIdMeta = recipe.stateIdMeta || 'design-state-id';
  const findings = [];  // hard — fail pull
  const warnings = [];  // soft — informational
  const frames = [];

  // (b) DS-runtime revision pin.
  const dsBundle = path.join(recipe.dsRuntimeSource, '_ds_bundle.js');
  const dsHash = sha256OfFile(dsBundle);
  if (!dsHash) {
    findings.push({ kind: 'NO_DS_RUNTIME', detail: `dsRuntimeSource missing _ds_bundle.js: ${recipe.dsRuntimeSource}` });
  } else if (recipe.dsRuntimeHash && recipe.dsRuntimeHash !== dsHash) {
    findings.push({ kind: 'DS_RUNTIME_DRIFT', detail: `_ds_bundle.js hash ${dsHash.slice(0, 23)}… != pinned ${recipe.dsRuntimeHash.slice(0, 23)}…` });
  }

  // (a)+(c) per-frame completeness + hashing, across every module.
  for (const mod of cfg.modules) {
    const modDir = path.join(recipe.framesRoot, mod.id);
    if (!existsSync(modDir)) { findings.push({ kind: 'NO_MODULE_DIR', detail: `${mod.id}: ${modDir}` }); continue; }
    const htmls = readdirSync(modDir).filter((f) => f.endsWith('.html') && !f.startsWith('_'));
    if (htmls.length === 0) { findings.push({ kind: 'EMPTY_MODULE', detail: `${mod.id}: module dir exists but has 0 *.html frames (pull staged nothing?)` }); continue; }
    // The shared content files render/lint hash alongside each frame.
    const siblings = readdirSync(modDir).filter((f) => f.startsWith('_') && f.endsWith('.jsx')).sort().map((f) => path.join(modDir, f));
    const screenJs = siblings.find((p) => /screen\.jsx$/.test(p));
    const dataJs = siblings.find((p) => /data\.jsx$/.test(p));
    const screenSrc = screenJs ? readFileSync(screenJs, 'utf8') : null;
    const dataSrc = dataJs ? readFileSync(dataJs, 'utf8') : null;
    for (const f of htmls) {
      const fp = path.join(modDir, f);
      const html = readFileSync(fp, 'utf8');
      const stateId = (html.match(new RegExp(`name="${stateIdMeta}"\\s+content="([^"]+)"`)) || [])[1] || f.replace(/\.html$/, '');
      const { hard, warn } = checkFrameComplete(html, screenSrc, dataSrc, stateIdMeta);
      hard.forEach((p) => findings.push({ kind: 'FRAME_INCOMPLETE', detail: `${mod.id}/${f}: ${p}` }));
      warn.forEach((p) => warnings.push({ kind: 'FRAME_SUSPECT', detail: `${mod.id}/${f}: ${p}` }));
      // contentHash matches render/lint's sourceContentHash: frame + module siblings.
      frames.push({ module: mod.id, stateId, framePath: fp, contentHash: sha256OfFiles([fp, ...siblings]) });
    }
  }

  if (frames.length === 0) findings.push({ kind: 'NO_FRAMES', detail: 'pull discovered 0 frames across all modules — nothing was staged' });

  const index = {
    designSource: cfg.designSource,
    projectId: cfg.projectId,
    dsRuntimeHash: dsHash,
    frameCount: frames.length,
    frames,
    findings,
    warnings,
    pass: findings.length === 0,
  };
  mkdirSync(cfg.cacheDir, { recursive: true });
  writeFileSync(path.join(cfg.cacheDir, 'pull-index.json'), JSON.stringify(index, null, 2));

  // §9.5: the join-manifest is GENERATED from the live frame inventory, never a
  // memorized constant. --write-manifest (re)derives rows from the discovered
  // frames, preserving any existing pinned designContentHash. Guard: refuse to
  // shrink the manifest (a botched/empty pull must not silently wipe it) unless
  // --force is given.
  if (opts.writeManifest) {
    const prevRows = cfg.manifest.rows || [];
    if (frames.length < prevRows.length && !opts.force) {
      findings.push({ kind: 'MANIFEST_SHRINK_BLOCKED', detail: `--write-manifest would shrink the join-manifest from ${prevRows.length} to ${frames.length} rows; pass --force to confirm a real removal` });
      index.findings = findings;
      index.pass = false;
      writeFileSync(path.join(cfg.cacheDir, 'pull-index.json'), JSON.stringify(index, null, 2));
    } else {
      const prevByState = new Map(prevRows.map((r) => [r.stateId, r]));
      const rows = frames.map((f) => {
        const prev = prevByState.get(f.stateId);
        return {
          frameId: `${f.module}/${f.stateId}.html`,
          stateId: f.stateId,
          module: f.module,
          cmpCapture: 'DERIVED',
          designContentHash: prev && prev.designContentHash && prev.designContentHash !== 'auto' ? prev.designContentHash : 'auto',
          ...(prev?.fixtureNote ? { fixtureNote: prev.fixtureNote } : {}),
        };
      }).sort((a, b) => a.stateId.localeCompare(b.stateId));
      writeFileSync(cfg.manifestPath, JSON.stringify({
        _comment: 'GENERATED from the live frame inventory by `cmp-design-bridge pull --write-manifest` (§9.5). cmpCapture is DERIVED from stateId; designContentHash auto → lint stamps from the live render.',
        rows,
      }, null, 2));
      index.manifestRows = rows.length;
    }
  }
  return index;
}

export function printPullReport(index) {
  console.log(`PULL ${index.pass ? 'OK ✓' : 'FINDINGS ✗'} — ${index.frameCount} frames, DS runtime ${index.dsRuntimeHash ? index.dsRuntimeHash.slice(0, 19) + '…' : 'MISSING'}`);
  const byMod = {};
  for (const f of index.frames) (byMod[f.module] ||= []).push(f.stateId);
  for (const [m, ids] of Object.entries(byMod)) console.log(`  ${m}: ${ids.length} frames`);
  (index.warnings || []).forEach((w) => console.log(`  ·· ${w.kind}: ${w.detail}`));
  index.findings.forEach((f) => console.log(`  !! ${f.kind}: ${f.detail}`));
}
