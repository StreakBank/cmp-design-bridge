// config.mjs — load + validate the per-project CONFIG, resolve every path to an
// absolute one. This is the CORE/CONFIG boundary made concrete: the CLI carries
// zero project knowledge; everything it needs (palette deviations, viewport,
// module → capture-dir mapping, the DS runtime location, where the frames live)
// comes from `.design-bridge/`.
//
// Path resolution: any relative path in a CONFIG file is resolved against the
// CONFIG DIRECTORY, except `repoRoot`, which (if relative) resolves against the
// config dir and then anchors `cmpScreenshotRoot` etc. This keeps a committed
// `.design-bridge/` portable across machines — no absolute paths required.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadJson } from './util.mjs';

const REQUIRED_CONFIG = ['modules', 'render', 'joinManifest', 'cmpScreenshotRoot', 'captureDeriveRule'];
const REQUIRED_RECIPE = ['viewport', 'dsRuntimeSource', 'framesRoot'];

function resolveRel(baseDir, p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.resolve(baseDir, p);
}

/**
 * Load CONFIG from a `.design-bridge` directory.
 * Returns a fully-resolved config object with absolute paths + the inlined
 * sub-documents (recipe, manifest, allowlist, presenceContract).
 */
export function loadConfig(configDir) {
  const dir = path.resolve(configDir);
  const configPath = path.join(dir, 'config.json');
  if (!existsSync(configPath)) {
    throw new Error(`No config.json at ${configPath} — pass --config <dir-containing-config.json>`);
  }
  const raw = loadJson(configPath);

  const missing = REQUIRED_CONFIG.filter((k) => raw[k] === undefined);
  if (missing.length) throw new Error(`config.json missing required keys: ${missing.join(', ')}`);

  // repoRoot anchors the CMP-side paths; defaults to the config dir's PARENT
  // (.design-bridge lives at <repo>/.design-bridge by convention). Set it
  // explicitly when the config dir is nested deeper (e.g. a multi-repo workspace
  // where .design-bridge lives under one stack but paths reference siblings).
  const repoRoot = raw.repoRoot ? resolveRel(dir, raw.repoRoot) : path.resolve(dir, '..');

  const recipePath = resolveRel(dir, raw.render);
  const recipe = loadJson(recipePath);
  const recipeMissing = REQUIRED_RECIPE.filter((k) => recipe[k] === undefined);
  if (recipeMissing.length) throw new Error(`${recipePath} missing required keys: ${recipeMissing.join(', ')}`);

  // A configured-but-absent join-manifest is distinct from an intentionally
  // empty one: track presence so commands can warn (a deleted manifest must not
  // make lint vacuously PASS over zero rows). `pull --write-manifest` creates it.
  const manifestPath = resolveRel(dir, raw.joinManifest);
  const manifestPresent = existsSync(manifestPath);
  const manifest = manifestPresent ? loadJson(manifestPath) : { rows: [] };

  const allowlistPath = raw.allowlist ? resolveRel(dir, raw.allowlist) : null;
  const allowlist = allowlistPath && existsSync(allowlistPath) ? loadJson(allowlistPath) : { entries: [] };

  const presencePath = raw.presenceContract ? resolveRel(dir, raw.presenceContract) : null;
  const presenceContract = presencePath && existsSync(presencePath) ? loadJson(presencePath) : { states: {} };

  // Normalize `modules` to objects { id, captureDir, statePrefix }.
  const modules = (raw.modules || []).map((m) => {
    const o = typeof m === 'string' ? { id: m } : { ...m };
    if (!o.id) throw new Error(`module entry missing id: ${JSON.stringify(m)}`);
    o.statePrefix = o.statePrefix || `${o.id}-`;
    return o;
  });

  return {
    configDir: dir,
    repoRoot,
    projectId: raw.projectId ?? null,
    designSystemProjectId: raw.designSystemProjectId ?? null,
    designSource: raw.designSource ?? 'canvas',
    modules,
    cmpScreenshotRoot: resolveRel(repoRoot, raw.cmpScreenshotRoot),
    captureDeriveRule: raw.captureDeriveRule,
    inventoryPath: raw.inventoryPath ? resolveRel(dir, raw.inventoryPath) : null,
    playwrightFrom: raw.playwrightFrom ? resolveRel(repoRoot, raw.playwrightFrom) : null,
    cacheDir: resolveRel(dir, raw.cacheDir || '.cache'),
    recipePath,
    recipe: {
      ...recipe,
      // dsRuntimeSource is the project's committed design-system render runtime
      // (the _ds_bundle.js + styles + fonts the frames were authored against).
      // It's a CONFIG artifact living under .design-bridge/ → configDir-anchored,
      // like framesRoot. A consumer that builds its runtime elsewhere in the repo
      // can climb out with a relative path (../../core/.../ds-bundle) or use an
      // absolute path (which always wins).
      dsRuntimeSource: resolveRel(dir, recipe.dsRuntimeSource),
      // framesRoot is pulled design content (lives under .design-bridge/.cache)
      // → configDir-anchored. Absolute paths always win.
      framesRoot: resolveRel(dir, recipe.framesRoot),
    },
    manifestPath,
    manifestPresent,
    manifest,
    allowlistPath,
    allowlist,
    presencePath,
    presenceContract,
  };
}

/** Map a stateId → its app self-regression (subject) capture path (the §9.1 derived-capture rule). */
export function deriveCapture(cfg, stateId, moduleEntry) {
  const captureDir = moduleEntry?.captureDir
    ? resolveRel(cfg.cmpScreenshotRoot, moduleEntry.captureDir)
    : cfg.cmpScreenshotRoot;
  const rel = cfg.captureDeriveRule.replace('{stateId}', stateId);
  // captureDeriveRule may be either a {stateId}-only basename rule (resolved
  // under the module captureDir) or a full repo-relative path with {module}.
  if (rel.includes('/')) {
    return resolveRel(cfg.cmpScreenshotRoot, rel.replace('{module}', moduleEntry?.id || ''));
  }
  return path.join(captureDir, rel);
}

/** Find the module entry + frame path for a stateId by scanning framesRoot. */
export function locateFrame(cfg, stateId) {
  for (const m of cfg.modules) {
    const fp = path.join(cfg.recipe.framesRoot, m.id, `${stateId}.html`);
    if (existsSync(fp)) return { module: m, framePath: fp };
  }
  // Fall back to the join-manifest row's module, if present.
  const row = cfg.manifest.rows.find((r) => r.stateId === stateId);
  if (row) {
    const m = cfg.modules.find((x) => x.id === row.module) || { id: row.module, statePrefix: `${row.module}-` };
    const fp = path.join(cfg.recipe.framesRoot, m.id, `${stateId}.html`);
    if (existsSync(fp)) return { module: m, framePath: fp };
  }
  return null;
}
