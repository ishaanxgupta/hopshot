// Builds a static copy of the client into dist/ for a static host (e.g. Vercel).
// The page is served from there and connects to the game server at HOPSHOT_SERVER.
//
//   HOPSHOT_SERVER=https://your-server.example node tools/build-static.js
//
// Layout: dist/index.html, dist/client/*, dist/shared/*, dist/vendor/three.module.min.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const SERVER = String(process.env.HOPSHOT_SERVER || 'https://hopshot.onrender.com').replace(/\/+$/, '');
if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(SERVER)) {
  console.error(`HOPSHOT_SERVER must look like https://host[:port], got: ${SERVER}`);
  process.exit(1);
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'client'), { recursive: true });
fs.mkdirSync(path.join(DIST, 'shared'), { recursive: true });
fs.mkdirSync(path.join(DIST, 'vendor'), { recursive: true });

let files = 0;
for (const f of fs.readdirSync(path.join(ROOT, 'client'))) {
  if (!/\.(js|css)$/.test(f)) continue;
  fs.copyFileSync(path.join(ROOT, 'client', f), path.join(DIST, 'client', f)); files++;
}
for (const f of fs.readdirSync(path.join(ROOT, 'shared'))) {
  if (!f.endsWith('.js')) continue;
  fs.copyFileSync(path.join(ROOT, 'shared', f), path.join(DIST, 'shared', f)); files++;
}
fs.copyFileSync(
  path.join(ROOT, 'node_modules', 'three', 'build', 'three.module.min.js'),
  path.join(DIST, 'vendor', 'three.module.min.js'),
); files++;

let html = fs.readFileSync(path.join(ROOT, 'client', 'index.html'), 'utf8');
const mapRe = /<script type="importmap">[\s\S]*?<\/script>/;
const modRe = /<script type="module" src="\/client\/main\.js"><\/script>/;
if (!mapRe.test(html) || !modRe.test(html)) {
  console.error('client/index.html no longer has the expected import map / module script');
  process.exit(1);
}
html = html.replace(mapRe, '<script type="importmap">\n    {"imports": {"three": "/vendor/three.module.min.js"}}\n  </script>');
html = html.replace(modRe, `<script>window.HOPSHOT_SERVER = ${JSON.stringify(SERVER)};</script>\n  <script type="module" src="/client/main.js"></script>`);
fs.writeFileSync(path.join(DIST, 'index.html'), html); files++;

console.log(`built dist/ (${files} files), game server: ${SERVER}`);
