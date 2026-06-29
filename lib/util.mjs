// util.mjs — shared CORE helpers for the cmp-design-bridge CLI.
//
// Project-agnostic. Nothing in here knows about any particular app, palette, or
// feature — everything is driven by the per-project CONFIG handed in by
// config.mjs. The two things worth understanding:
//
//   * resolvePlaywright(cfg) — the CLI renders with headless Chromium via
//     Playwright, which is the CLI's OWN declared dependency (run `npm install`
//     + `npx playwright install chromium` once). Resolution precedence still
//     allows an override: env PLAYWRIGHT_FROM → CONFIG `playwrightFrom` (a dir
//     whose node_modules carries playwright) → the plugin's own node_modules →
//     the process CWD. The first that resolves wins, so a consuming repo that
//     already has Playwright can point at it instead of a second install.
//   * staticServer({ roots }) — a longest-prefix static file server. The
//     per-state frame references `../_ds/styles.css` (the shared DS runtime) and
//     `./_<feat>-screen.jsx` (the design content). We route `/_ds/*` to the DS
//     runtime source and everything else to the frames root, so the exact files
//     that were uploaded to Claude Design render unmodified, offline.

import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFile, readFileSync, existsSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';

export const CONTENT_TYPES = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.jsx': 'text/javascript',
  '.html': 'text/html', '.css': 'text/css', '.json': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

/**
 * Resolve Playwright's chromium without making the plugin own a browser binary.
 * Precedence: env PLAYWRIGHT_FROM → cfg.playwrightFrom → the plugin's own
 * node_modules → the process CWD. The first that resolves wins.
 */
export function resolvePlaywright(cfg) {
  const candidates = [
    process.env.PLAYWRIGHT_FROM,
    cfg?.playwrightFrom,
    fileURLToPath(new URL('..', import.meta.url)), // plugin root (lib/..); decoded + cross-platform
    process.cwd(),
  ].filter(Boolean);
  const errors = [];
  for (const base of candidates) {
    try {
      // createRequire needs a file-ish anchor; append a trailing slash dir.
      const anchor = base.endsWith('/') ? base : base + '/';
      const require = createRequire(anchor);
      const pw = require('playwright');
      if (pw?.chromium) return pw.chromium;
    } catch (e) {
      errors.push(`${base}: ${e.message}`);
    }
  }
  throw new Error(
    'Could not resolve Playwright. Set PLAYWRIGHT_FROM or config.playwrightFrom to a dir whose '
    + 'node_modules contains playwright.\nTried:\n  ' + errors.join('\n  '),
  );
}

/**
 * Longest-prefix static file server. `roots` is an ordered array of
 * { prefix, dir }. A request URL is matched against the first prefix it starts
 * with; the remainder is resolved (path-normalized, traversal-blocked) under
 * that root. Returns { url, port, close }.
 */
export async function staticServer({ roots }) {
  const sorted = [...roots].sort((a, b) => b.prefix.length - a.prefix.length);
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const match = sorted.find((r) => urlPath.startsWith(r.prefix));
      if (!match) { res.writeHead(404); res.end(); return; }
      const rel = urlPath.slice(match.prefix.length);
      const safe = path.normalize('/' + rel).replace(/^(\.\.[/\\])+/, '');
      const fp = path.join(match.dir, safe);
      const rootAbs = path.resolve(match.dir);
      if (!path.resolve(fp).startsWith(rootAbs)) { res.writeHead(403); res.end(); return; }
      readFile(fp, (err, body) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(fp)] || 'application/octet-stream' });
        res.end(body);
      });
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}`, port, close: () => new Promise((r) => server.close(r)) };
}

/** sha256 over the byte content of a list of files, in the given order. */
export function sha256OfFiles(paths) {
  const h = createHash('sha256');
  for (const p of paths) h.update(readFileSync(p));
  return 'sha256:' + h.digest('hex');
}

/** sha256 of a single file's bytes (or null if missing). */
export function sha256OfFile(p) {
  if (!existsSync(p)) return null;
  return 'sha256:' + createHash('sha256').update(readFileSync(p)).digest('hex');
}

export function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

export async function readText(p) {
  return readFileAsync(p, 'utf8');
}

export { existsSync };
