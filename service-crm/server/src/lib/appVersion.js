import fs from 'node:fs';
import path from 'node:path';

// The deployed CRM version: the hashed main script the built index.html
// loads (e.g. "index-CThnbxcP.js"). It changes with every deployment that
// changes the app, and an open browser tab knows the one it was loaded with,
// so the two can be compared ("A new CRM version is available").
// Read-only: no database or record is touched. Cached until index.html
// changes on disk. null when there's no build (local development).
let cache = { mtimeMs: null, version: null };

export function versionFromIndexHtml(html) {
  const m = String(html || '').match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/);
  return m ? m[1] : null;
}

export function getAppVersion(distDir) {
  try {
    const file = path.join(distDir, 'index.html');
    const { mtimeMs } = fs.statSync(file);
    if (cache.mtimeMs !== mtimeMs) cache = { mtimeMs, version: versionFromIndexHtml(fs.readFileSync(file, 'utf8')) };
    return cache.version;
  } catch {
    return null;
  }
}
