'use strict';

const { createHash } = require('node:crypto');
const { readFile, stat } = require('node:fs/promises');
const path = require('node:path');

// Explicit allowlist: only files in the public interface can be served.
const routes = new Map(Object.entries({
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/manager-ui.js': ['manager-ui.js', 'text/javascript; charset=utf-8'],
  '/features-ui.js': ['features-ui.js', 'text/javascript; charset=utf-8'],
  '/navigation-ui.js': ['navigation-ui.js', 'text/javascript; charset=utf-8'],
  '/layout.css': ['layout.css', 'text/css; charset=utf-8'],
  '/motd-editor.css': ['motd-editor.css', 'text/css; charset=utf-8'],
  '/motd-model.js': ['motd-model.js', 'text/javascript; charset=utf-8'],
  '/motd-editor.js': ['motd-editor.js', 'text/javascript; charset=utf-8'],
  '/network-ui.js': ['network-ui.js', 'text/javascript; charset=utf-8'],
  '/player-tools-ui.js': ['player-tools-ui.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/theme.css': ['theme.css', 'text/css; charset=utf-8'],
  '/brand-icon.png': ['brand-icon.png', 'image/png'],
  '/logo.svg': ['logo.svg', 'image/svg+xml'],
  '/logo.png': ['logo.png', 'image/png'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/i18n.css': ['i18n.css', 'text/css; charset=utf-8'],
  '/locales.json': ['locales.json', 'application/json; charset=utf-8'],
  '/hosting-ui.js': ['hosting-ui.js', 'text/javascript; charset=utf-8'],
  '/recovery-ui.js': ['recovery-ui.js', 'text/javascript; charset=utf-8'],
  '/welcome-ui.js': ['welcome-ui.js', 'text/javascript; charset=utf-8'],
  '/help-ui.js': ['help-ui.js', 'text/javascript; charset=utf-8'],
  '/edition-ui.js': ['edition-ui.js', 'text/javascript; charset=utf-8'],
  '/edition.css': ['edition.css', 'text/css; charset=utf-8'],
  '/help.html': ['help.html', 'text/html; charset=utf-8'],
  '/hero-world.png': ['hero-world.png', 'image/png'],
  '/pixel-heading.ttf': ['pixel-heading.ttf', 'font/ttf'],
}));

const contentPolicy = [
  "default-src 'self'",
  "img-src 'self' data: blob: https://media.forgecdn.net https://mediafilez.forgecdn.net",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function createStaticFiles(directory) {
  const cache = new Map();

  async function load(name) {
    const file = path.join(directory, name);
    const info = await stat(file);
    const revision = [info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
    const previous = cache.get(name);
    if (previous?.revision === revision) return previous.ready;

    // Reuse both the bytes and hash, including while another request is reading them.
    const ready = readFile(file).then(data => ({
      data,
      etag: '"' + createHash('sha256').update(data).digest('hex') + '"',
    }));
    const entry = { revision, ready };
    cache.set(name, entry);
    try {
      return await ready;
    } catch (error) {
      if (cache.get(name) === entry) cache.delete(name);
      throw error;
    }
  }

  return async function serve(res, pathname, req, sendJson) {
    const route = routes.get(pathname);
    if (!route) return sendJson(res, 404, { error: 'No encontrado.' });
    const [name, type] = route;
    let asset;
    try {
      asset = await load(name);
    } catch {
      return sendJson(res, 500, { error: 'No se pudo cargar la interfaz.' });
    }
    const unchanged = req?.headers['if-none-match'] === asset.etag;
    res.writeHead(unchanged ? 304 : 200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
      'ETag': asset.etag,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': contentPolicy,
    });
    res.end(unchanged ? undefined : asset.data);
  };
}

module.exports = { createStaticFiles };
