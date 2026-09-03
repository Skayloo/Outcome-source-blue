// Builds the web client and copies the result into desktop/web, which is what the app://
// protocol serves.
//
// The desktop shell carries its OWN copy of the SPA rather than loading one from a server.
// Two reasons, and the second is the important one:
//
//   • the app has to work against ANY Outcome instance, including one on a LAN, and asking a
//     stranger's server for the code that will run inside a shell with a preload bridge is a
//     different security proposition than opening a web page;
//   • the shell and the UI version then ship together, so a preload API can never be missing
//     from the bundle that expects it.
//
// Edition: RED by default, the same choice mobile/ makes. The desktop client is distributed as
// a binary, not as source, so it carries the encryption exactly like the iOS and Android apps
// do. Pass OUTCOME_EDITION=blue to build the cipher-free one.

import { spawnSync } from 'node:child_process';
import { cp, rm, mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const webSrc = path.join(root, 'frontend');
const dist = path.join(webSrc, 'dist');
const dest = path.resolve(here, '..', 'web');

const edition = process.env.OUTCOME_EDITION === 'blue' ? 'blue' : 'red';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

console.log(`── building the web client (edition: ${edition})`);

try {
  await access(path.join(webSrc, 'node_modules'));
} catch {
  console.log('── frontend/node_modules missing, installing first');
  const install = spawnSync(npm, ['install', '--no-audit', '--no-fund'], {
    cwd: webSrc, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (install.status !== 0) process.exit(install.status ?? 1);
}

const build = spawnSync(npm, ['run', 'build'], {
  cwd: webSrc,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, OUTCOME_EDITION: edition },
});
if (build.status !== 0) {
  console.error('!! the web build failed — not copying a stale bundle into the shell');
  process.exit(build.status ?? 1);
}

// The website's own files ride along in dist/ because Vite copies everything in public/.
// None of it means anything inside the shell — the landing page exists to convince a stranger
// to install this, and they already have — and the screenshots alone are 1.4 MB in an
// installer people download over whatever connection they have.
const SITE_ONLY = [
  'landing.html', 'landing.js', 'shots',
  'robots.txt', 'sitemap.xml',
];

console.log('── copying dist → desktop/web');
await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(dist, dest, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(dist, src);
    if (!rel) return true;
    return !SITE_ONLY.some((s) => rel === s || rel.startsWith(s + path.sep));
  },
});

console.log('── done');
