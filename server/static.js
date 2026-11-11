// Minimal static file server for the client. Only whitelisted prefixes, no traversal.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ALLOWED = [
  '/client/',
  '/shared/',
  '/node_modules/three/build/',
  '/node_modules/three/examples/jsm/',
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

export function serveStatic(req, res, rawPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }
  let p;
  try { p = decodeURIComponent(rawPath); } catch { notFound(res); return; }
  if (p.includes('\0') || p.includes('\\')) { notFound(res); return; }
  if (p === '/' || p === '/index.html') p = '/client/index.html';
  // Normalise and re-check the prefix AFTER normalisation (defeats /client/../server/...).
  const norm = path.posix.normalize(p);
  if (norm.split('/').includes('..') || !ALLOWED.some((a) => norm.startsWith(a))) { notFound(res); return; }
  const file = path.resolve(ROOT, '.' + norm);
  if (!file.startsWith(ROOT + path.sep)) { notFound(res); return; }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { notFound(res); return; }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const isVendor = norm.startsWith('/node_modules/');
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': isVendor ? 'public, max-age=3600' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}
