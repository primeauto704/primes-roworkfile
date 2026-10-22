#!/usr/bin/env node
'use strict';

/**
 * Build a standalone package: dist/primes-ro-workflow-<version>.zip
 * Contains everything needed to run on any machine with Node 22.13+.
 * Excludes: data/, config/credentials.json, .env, .dev.vars, node_modules/, dist/, .git — never ship live data or logins.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const DIST = path.join(ROOT, 'dist');
const NAME = `${pkg.name}-${pkg.version}`;
const STAGE = path.join(DIST, NAME);

const INCLUDE = [
  'package.json', 'server.js', 'README.md', 'Dockerfile', 'docker-compose.yml', 'railway.json', '.env.example', '.gitignore',
  'wrangler.toml', '.dev.vars.example', 'worker',
  'src', 'public', 'scripts', 'test',
  'config/credentials.example.json',
];

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
for (const item of INCLUDE) {
  const from = path.join(ROOT, item);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(STAGE, item), { recursive: true });
}
fs.mkdirSync(path.join(STAGE, 'data'), { recursive: true });
fs.writeFileSync(path.join(STAGE, 'data', '.gitkeep'), '');

// Convenience launchers so a shop PC doesn't need to know npm.
fs.writeFileSync(path.join(STAGE, 'start.cmd'), '@echo off\r\ncd /d "%~dp0"\r\nnode --disable-warning=ExperimentalWarning server.js\r\npause\r\n');
fs.writeFileSync(path.join(STAGE, 'setup.cmd'), '@echo off\r\ncd /d "%~dp0"\r\nnode --disable-warning=ExperimentalWarning scripts\\setup.js\r\npause\r\n');
fs.writeFileSync(path.join(STAGE, 'start.sh'), '#!/bin/sh\ncd "$(dirname "$0")"\nexec node --disable-warning=ExperimentalWarning server.js\n', { mode: 0o755 });
fs.writeFileSync(path.join(STAGE, 'setup.sh'), '#!/bin/sh\ncd "$(dirname "$0")"\nexec node --disable-warning=ExperimentalWarning scripts/setup.js "$@"\n', { mode: 0o755 });

const zipPath = path.join(DIST, `${NAME}.zip`);
fs.rmSync(zipPath, { force: true });
try {
  execFileSync('zip', ['-rq', zipPath, NAME], { cwd: DIST, stdio: 'inherit' });
} catch (err) {
  // zip CLI not available (e.g. Windows): fall back to PowerShell, else leave the folder.
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${STAGE}' -DestinationPath '${zipPath}' -Force`], { stdio: 'inherit' });
  } catch (_) {
    console.log(`Could not create a zip (no 'zip' or PowerShell). The package folder is ready at:\n  ${STAGE}`);
    process.exit(0);
  }
}
const size = (fs.statSync(zipPath).size / 1024).toFixed(0);
console.log(`Package built: ${zipPath} (${size} KB)\nUnzip on the target machine, then:  npm run setup  &&  npm start`);
