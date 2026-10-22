# Primes Auto — RO Workflow Portal

A standalone shop portal for tracking repair orders (ROs) through the twelve phases of the shop,
on a Kanban board, with a searchable archive and a full timestamped history for every RO.

It is **completely separate from the Parts portal**: its own folder, its own database, its own login.
Nothing here talks to Supabase or to `primeauto704.com/parts`.

```
Inspection → Estimate → Parts → Mechanical → Wheel → Repair → PDR → Paint Correction → Spot Repair → Interior → Detail → QC
```

Staff can move an RO straight to **any** phase (forward, backward, or skipping), by dragging the card
or with the **Move to…** menu on each card. From **QC**, "Complete" files the RO in the archive;
"Restore" brings it back to Inspection.

---

## Quick start (local shop PC or server)

Requirements: **Node.js 22.13 or newer** (uses Node's built-in SQLite; no `npm install` needed).
Check with `node --version`. (Running `node server.js` directly prints a harmless "SQLite is an experimental
feature" notice; the npm scripts and the `start`/`setup` launchers in the package pass the flag that silences it.)

```bash
cd primes-ro-workflow
npm run setup        # asks for the shared shop username + password (stored as a scrypt hash)
npm start            # http://localhost:8090
```

Open `http://<that computer's name or IP>:8090` from any PC in the shop and sign in with the shop login.

To run it as a service that starts with the machine, see [Running it permanently](#running-it-permanently).

---

## Stack and why

| Piece        | Choice                                                   | Why |
|--------------|----------------------------------------------------------|-----|
| Runtime      | Node.js 22 (installed in this environment, LTS) — or a Cloudflare Worker | Same language as the Parts portal; the Worker build shares all the API code |
| Web server   | Node's built-in `http` module, tiny router in `src/app.js` | No framework, **zero npm dependencies** — the folder *is* the deployable |
| Database     | SQLite via Node's built-in `node:sqlite` — or Cloudflare D1 | One file at `data/ro-workflow.sqlite`, WAL mode, survives restarts, needs no database server. Native-free, so it runs anywhere Node runs. The same schema runs on D1 (`src/d1-store.js`) |
| Front end    | Plain HTML/CSS/JS, no build step (`public/`)              | Matches the Parts portal's plain-JS approach; easy to tweak with any text editor |
| Passwords    | `crypto.scrypt` (N=2¹⁵), constant-time compares           | Standard, built into Node, nothing to install |
| Sessions     | Random 256-bit token, SHA-256 hash stored in SQLite, HttpOnly + SameSite=Lax cookie, 30-day sliding expiry | Survives restarts; logout deletes the row |

The whole app is about 2,000 lines. There is nothing to compile. `npm install` is only needed for the Cloudflare
tooling (wrangler); the Node server itself has no dependencies.

---

## Configuring the shop login

Nothing is hardcoded. The portal refuses to show the board until a login exists.

**Option A — setup script (recommended for a shop PC)**

```bash
npm run setup
```

Writes `config/credentials.json` containing the username and a scrypt hash of the password.
Re-run it any time to change the password. The file is git-ignored and created with owner-only permissions.
Non-interactive: `npm run setup -- --username shop --password 'YourPassword'` (note: lands in shell history).

**Option B — environment variables (recommended for Docker / a hosted server)**

```bash
npm run setup -- --hash-only          # prints SHOP_PASSWORD_HASH, writes nothing
```

Then set `SHOP_USERNAME` and `SHOP_PASSWORD_HASH` in `.env` or the container environment.
Environment variables override `config/credentials.json`. (`SHOP_PASSWORD` in plain text is also accepted for
convenience; the server warns on startup and hashes it in memory. Prefer the hash.)

**Check:** `npm run setup -- --check` confirms a login is configured and the database opens.

Login throttling: 8 failed attempts from one address locks that address out for 5 minutes.

---

## Database

- File: `data/ro-workflow.sqlite` (override with `DB_FILE`). Created automatically on first start or by `npm run setup`.
- Tables: `repair_orders`, `ro_history`, `sessions`. The schema lives in `src/db.js` and is applied with
  `CREATE TABLE IF NOT EXISTS`, so upgrades are just "replace the files and restart".
- A partial unique index (`ro_number WHERE status = 'active'`) is what enforces "no duplicate RO on the active board"
  — it holds even if two PCs add the same number at the same instant.
- **Backup:** copy `data/ro-workflow.sqlite` (plus `-wal`/`-shm` if present) while the app is stopped, or run
  `sqlite3 data/ro-workflow.sqlite ".backup backup.sqlite"` while it's running.
- To start over: stop the app and delete `data/ro-workflow.sqlite*`.

### History
Every RO keeps a timestamped log in `ro_history`: `created`, `phase_change` (with previous and new phase),
`completed`, `restored`, and `edited` (RO number / vehicle corrections). Staff never pick their name —
the portal is a shared shop login by design.

---

## Configuration reference (`.env`)

Copy `.env.example` to `.env`. Everything is optional.

| Variable             | Default                     | Meaning |
|----------------------|-----------------------------|---------|
| `PORT`               | `8090`                      | Port to listen on |
| `HOST`               | `0.0.0.0`                   | Bind address (`127.0.0.1` to allow only this machine) |
| `DB_FILE`            | `./data/ro-workflow.sqlite` | SQLite file |
| `CONFIG_DIR`         | `./config`                  | Folder containing `credentials.json` |
| `SHOP_USERNAME`      | —                           | Shop username (with one of the two below) |
| `SHOP_PASSWORD_HASH` | —                           | scrypt hash from `npm run setup -- --hash-only` |
| `SHOP_PASSWORD`      | —                           | Plain password (hashed in memory; prefer the hash) |
| `COOKIE_SECURE`      | `false`*                    | `true` when served over HTTPS so the cookie is `Secure` |
| `TRUST_PROXY`        | `false`*                    | `true` behind a reverse proxy that sets `X-Forwarded-For` (login throttling per real client) |
| `NODE_ENV`           | —                           | `production` caches static files in memory |

\* Both default to `true` automatically on Railway, Render and Fly.io (detected from their own environment variables).

---

## Deploying online (Cloudflare) — free, log in from your phone anywhere

The same front end runs as a **Cloudflare Worker** with the database on **D1** (Cloudflare's SQLite). It fits the
Workers Free plan (100,000 requests/day, 5 GB of D1) and needs no server to look after. Files involved:
`worker/index.js` (entry), `src/d1-store.js` (same data logic on D1), `wrangler.toml` (config).

### One-tap deploy
Once the code is in a **public** GitHub repository, this button sets everything up — it copies the repo into
your GitHub, creates the D1 database, asks for the two login secrets, and deploys:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/primeauto704/primes-roworkfile)

(Replace `<your-github-user>` in the link above with the GitHub account that holds the repo. Private repos aren't
supported by the button; use the manual route below instead.)

Afterwards the portal is live at `https://primes-ro-workflow.<your-subdomain>.workers.dev`. To use your own
domain: Worker → Settings → Domains & Routes → add `workflow.primeauto704.com` (one click if the domain's DNS is
already on Cloudflare).

### Manual deploy (private repo, or from a terminal)
```bash
npm install                                   # installs wrangler (the only dev dependency)
npx wrangler login
npx wrangler d1 create ro-workflow             # paste the printed database_id into wrangler.toml
npx wrangler secret put SHOP_USERNAME
npx wrangler secret put SHOP_PASSWORD
npx wrangler deploy
```
Or connect the repository in the dashboard (Workers & Pages → Create → Import a repository); every push then
redeploys. Create the D1 database in the dashboard first and put its id in `wrangler.toml`.

### Notes
- Tables are created automatically on the first request — no migration step.
- Secrets: `SHOP_USERNAME` + `SHOP_PASSWORD` (compared in constant time). `SHOP_PASSWORD_HASH` (scrypt) also works
  but each login then costs ~100 ms of CPU, which only the Workers Paid plan allows (Free is 10 ms).
- Login throttling on Workers is per isolate (best-effort). Cloudflare's own rate limiting rules can be added in
  front if you ever want more.
- Local run: copy `.dev.vars.example` to `.dev.vars`, then `npm run cf:dev` → http://localhost:8787 with a local D1.
  The API test suite runs against it with `TEST_BASE_URL=http://127.0.0.1:8787 npm test` (empty database,
  login `shop` / `test-password-123`).

---

## Deploying online (Railway) — the container option

The repo is ready for [Railway](https://railway.com): `railway.json` tells it to build the `Dockerfile`, the app
reads Railway's `PORT`, and it switches on Secure cookies + proxy trust automatically when it sees
`RAILWAY_ENVIRONMENT`. Railway's Hobby plan is $5/month and includes the persistent volume the database needs
(there is a one-time $5 trial credit).

1. Push this folder to a GitHub repository (private is fine).
2. Railway → **New Project → Deploy from GitHub repo** → pick the repository. The first build will fail its health
   check until step 4 is done — that's expected.
3. Service → **Variables** → add `SHOP_USERNAME` and either `SHOP_PASSWORD_HASH` (from `npm run setup -- --hash-only`)
   or, if you have no terminal handy, `SHOP_PASSWORD` (the app hashes it in memory at startup).
4. Service → **Volume** → mount path **`/app/data`**. This is where `ro-workflow.sqlite` lives; without it the
   board resets on every deploy.
5. Service → **Settings → Networking → Generate Domain** → open the `https://….up.railway.app` link and sign in.
6. Optional: **Custom Domain** → `workflow.primeauto704.com`, then add the CNAME Railway shows at your DNS provider.

Each `git push` redeploys (a few seconds of downtime while the volume moves to the new container).
Render and Fly.io work the same way (`RENDER` / `FLY_APP_NAME` trigger the same proxy defaults); mount their disk
at `/app/data`.

### Phone use
Below 900px wide the board shows one phase at a time with a tab strip to jump between phases, and the **Move to…**
menu on each card does what drag-and-drop does on a desktop.

---

## Running it permanently

**Windows shop PC (simplest):** install Node, run `npm run setup` once, then create a scheduled task
"At log on" that runs `node server.js` in this folder, or use [NSSM](https://nssm.cc) to register it as a service.

**Linux (systemd):**

```ini
# /etc/systemd/system/ro-workflow.service
[Unit]
Description=Primes Auto RO Workflow portal
After=network.target

[Service]
WorkingDirectory=/opt/primes-ro-workflow
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server.js
Restart=always
Environment=NODE_ENV=production
User=www-data

[Install]
WantedBy=multi-user.target
```

**Docker:**

```bash
docker compose up -d --build       # reads SHOP_USERNAME / SHOP_PASSWORD_HASH from .env, data in ./data
```
(The Dockerfile is a plain `node:22-alpine` copy of the folder; the image build itself could not be exercised in the
environment this was developed in, which had no Docker daemon.)

**HTTPS:** put it behind Caddy or nginx and set `COOKIE_SECURE=true` and `TRUST_PROXY=true`.
It can live on the shop domain at a path such as `/workflow` by proxying that path to port 8090
(the front end uses relative URLs, so a sub-path works).

---

## Standalone package

```bash
npm run package
```

Builds `dist/primes-ro-workflow-<version>.zip` containing everything needed to run (no `node_modules`, no
credentials, no data). On the target machine: unzip, `npm run setup`, `npm start`. Only Node 22.13+ is required.

---

## Verifying it works

```bash
npm test
```

Starts the app on a random port with an in-memory database and walks the whole workflow: login, add an RO,
forward/backward/skipped moves, active-duplicate block, history contents, complete from QC, archive search,
restore, restore-conflict, edit-conflict, CSRF guard, logout. Fifteen checks, about a second. The same suite was
run against the Cloudflare Worker on local D1 (`TEST_BASE_URL=…`), with identical results.

A browser-level pass (Chromium via Playwright: drag-and-drop, Move menu, drawer, archive modal, reload
persistence, logout — on a 1920px desktop and a 390px phone viewport) was run during development and is not part of
the shipped package.

---

## Day-to-day use

- **Add an RO:** type the number in the top-left box and press Enter (`N` focuses it). Vehicle is optional.
  New ROs land in Inspection.
- **Move:** drag the card onto a phase, or pick the phase from the card's **Move to…** menu (keyboard-friendly).
  Clicking a card opens its panel with all twelve phases as buttons plus the history.
- **Duplicates:** entering a number that's already on the board shows a message, scrolls to and opens the existing card.
  If the number only exists in the archive you're offered **Restore** or **New RO**.
- **Complete:** cards in QC show a **Complete** button. Completed ROs leave the board and go to the **Archive**
  (top-right), which has its own filter box and a **Restore** button per row.
- **Search:** the top-right box (`/`) searches active and archived ROs by number.
- **Fix a typo:** open the card and edit the RO number or vehicle under Details.
- Several PCs can use the board at once; it refreshes every 15 seconds and whenever the window regains focus.

---

## Project layout

```
primes-ro-workflow/
├── server.js             entry point (env, port, shutdown)
├── worker/index.js       Cloudflare Worker entry (same API on D1 + static assets)
├── wrangler.toml         Cloudflare config (assets, D1 binding)
├── src/
│   ├── routes.js         the API, independent of transport (used by app.js and the Worker)
│   ├── app.js            Node HTTP server: adapts req/res to routes.js, serves public/
│   ├── db.js             SQLite data access (Store)
│   ├── d1-store.js       the same data access on Cloudflare D1 (async, atomic batches)
│   ├── model.js          shared schema, RO-number normalization, row mapping
│   ├── errors.js         AppError
│   ├── auth.js           scrypt hashing, credential loading, login limiter
│   └── phases.js         the fixed twelve phases
├── public/               index.html, styles.css, app.js, favicon.svg
├── scripts/
│   ├── setup.js          shop-login setup
│   └── package.js        builds dist/*.zip
├── test/workflow.test.js end-to-end API test (node:test)
├── config/               credentials.json lives here (git-ignored); example included
├── data/                 ro-workflow.sqlite lives here (git-ignored)
├── Dockerfile, docker-compose.yml, railway.json, .env.example
```

## API (for reference)

All under `/api`, JSON. Mutations need the session cookie plus headers
`Content-Type: application/json` and `X-Requested-With: ro-workflow`.

| Method | Path                      | Purpose |
|--------|---------------------------|---------|
| GET    | `/session`                | auth state, phases |
| POST   | `/login`, `/logout`       | shop login |
| GET    | `/board`                  | active ROs + counts |
| POST   | `/ros`                    | create (`roNumber`, `vehicle?`, `allowArchivedDuplicate?`) |
| GET    | `/ros/:id`                | RO + history |
| POST   | `/ros/:id/move`           | `{ phase }` |
| POST   | `/ros/:id/complete`       | QC → archive |
| POST   | `/ros/:id/restore`        | archive → Inspection |
| PATCH  | `/ros/:id`                | edit number / vehicle |
| GET    | `/search?q=`              | active + archived by number |
| GET    | `/archive?q=`             | archived list |
