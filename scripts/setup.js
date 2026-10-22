#!/usr/bin/env node
'use strict';

/**
 * Configure the shared shop login.
 *
 *   npm run setup                       interactive: asks for username + password, writes config/credentials.json
 *   npm run setup -- --username shop --password 'S3cret!'   non-interactive (careful: shell history)
 *   npm run setup -- --hash-only        prints a SHOP_PASSWORD_HASH value for use in .env / Docker, writes nothing
 *   npm run setup -- --check            verifies that a login is configured and the database opens
 *
 * Passwords are stored only as scrypt hashes. Nothing is hardcoded in the app.
 */

const path = require('node:path');
const readline = require('node:readline');
const { Writable } = require('node:stream');
const auth = require('../src/auth');

const ROOT = path.join(__dirname, '..');
const CONFIG_DIR = process.env.CONFIG_DIR ? path.resolve(process.env.CONFIG_DIR) : path.join(ROOT, 'config');
const DB_FILE = process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(ROOT, 'data', 'ro-workflow.sqlite');

const args = parseArgs(process.argv.slice(2));
let rl = null;         // shared readline interface (see getRl)
let muted = false;     // hide typed characters while asking for a password
const lineQueue = [];  // answers that arrived before a prompt asked for them (piped stdin)
let waiter = null;
let closed = false;


async function main() {
  if (args.help) return usage();

  if (args.check) {
    const creds = auth.loadCredentials({ configDir: CONFIG_DIR, log: console });
    if (!creds) { console.log('✗ No shop login configured. Run: npm run setup'); process.exitCode = 1; }
    else console.log(`✓ Shop login configured from ${creds.source} (username "${creds.username}").`);
    const { Store } = require('../src/db');
    const store = new Store(DB_FILE);
    const c = store.counts();
    store.close();
    console.log(`✓ Database OK at ${DB_FILE} — ${c.active} active, ${c.archived} archived RO(s).`);
    return;
  }

  console.log('Primes Auto — RO Workflow portal: shop login setup\n');

  let username = args.username;
  let password = args.password;

  if (!args.hashOnly && !username) username = (await ask('Shop username: ')).trim();
  if (!password) {
    password = await askHidden('Shop password: ');
    const again = await askHidden('Repeat password: ');
    if (password !== again) throw new Error('Passwords did not match.');
  }
  validate(username, password, args.hashOnly);

  if (args.hashOnly) {
    console.log('\nAdd these to your .env (or container environment):\n');
    if (username) console.log(`SHOP_USERNAME=${username}`);
    console.log(`SHOP_PASSWORD_HASH=${auth.hashPassword(password)}\n`);
    return;
  }

  const file = auth.writeCredentialsFile(CONFIG_DIR, username, password);
  console.log(`\n✓ Saved shop login for "${username}" to ${file}`);
  console.log('  (password stored as a scrypt hash — keep this file private, it is git-ignored)');

  // Make sure the database can be created now so the first start is clean.
  const { Store } = require('../src/db');
  const store = new Store(DB_FILE);
  store.close();
  console.log(`✓ Database ready at ${DB_FILE}`);
  console.log('\nStart the portal with:  npm start');
}

function validate(username, password, hashOnly) {
  if (!hashOnly) {
    if (!username || username.length < 2) throw new Error('Username must be at least 2 characters.');
    if (/\s/.test(username)) throw new Error('Username cannot contain spaces.');
  }
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters.');
}

function usage() {
  console.log(`Usage:
  npm run setup                                   interactive setup (recommended)
  npm run setup -- --username NAME --password PW  non-interactive
  npm run setup -- --hash-only                    print SHOP_PASSWORD_HASH for .env / Docker
  npm run setup -- --check                        verify login + database

Environment: CONFIG_DIR (default ./config), DB_FILE (default ./data/ro-workflow.sqlite)`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--username' || a === '-u') out.username = argv[++i];
    else if (a === '--password' || a === '-p') out.password = argv[++i];
    else if (a === '--hash-only') out.hashOnly = true;
    else if (a === '--check') out.check = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

// One shared readline interface for the whole run, with a line queue: when the answers are piped
// in (e.g. from a provisioning script) every line arrives at once, so each prompt takes the next
// queued line instead of racing readline's own question() handling.
function getRl() {
  if (rl) return rl;
  const output = new Writable({
    write(chunk, _enc, cb) { if (!muted) process.stdout.write(chunk); cb(); },
  });
  rl = readline.createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  rl.on('line', (line) => { if (waiter) { const w = waiter; waiter = null; w.resolve(line); } else lineQueue.push(line); });
  rl.on('close', () => { closed = true; if (waiter) { const w = waiter; waiter = null; w.reject(new Error('No input received (stdin closed).')); } });
  return rl;
}
function closeRl() { if (rl && !closed) rl.close(); }

function nextLine() {
  getRl();
  if (lineQueue.length) return Promise.resolve(lineQueue.shift());
  if (closed) return Promise.reject(new Error('No input received (stdin closed).'));
  return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
}

async function ask(prompt) {
  process.stdout.write(prompt);
  return nextLine();
}

async function askHidden(prompt) {
  process.stdout.write(prompt);
  muted = true;
  try { return await nextLine(); }
  finally { muted = false; process.stdout.write('\n'); }
}

main().then(closeRl).catch((err) => { closeRl(); console.error(`\nSetup failed: ${err.message}`); process.exit(1); });
