# Deploying LifePlanSystem Closed Beta v0.1 to a small Ubuntu VPS

Shape:

```
Android APK --HTTPS--> Caddy (automatic TLS) --localhost--> LPS Express :4177 --> SQLite (/opt/lps/data)
```

The Express app is never reachable directly from the internet. It only ever
listens on `127.0.0.1`; Caddy is the only process bound to the public IP.

## 1. One-time server setup (as root)

```bash
# --shell /bin/bash is required: adduser --system otherwise assigns
# /usr/sbin/nologin, and `su - lps` below would fail immediately.
adduser --system --group --home /opt/lps --shell /bin/bash lps
mkdir -p /opt/lps/data /opt/lps/backups
chown -R lps:lps /opt/lps
# The database and its backups hold bearer tokens and every tester's
# private data -- never group/world-readable.
chmod 700 /opt/lps/data /opt/lps/backups

# Node 22.5+ is REQUIRED -- the app imports node:sqlite, which does not
# exist in Node 20 and will crash on startup before app.listen(). Node 24
# (what CI builds against) is used here for the same reason.
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs git sqlite3

# Caddy (official repo -- gives automatic HTTPS with zero manual cert work)
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
```

## 2. Firewall

Only 22 (SSH), 80, and 443 are ever open to the internet. Port 4177 (the
Express app) is never opened -- it's reached only via Caddy on localhost.

**Port 4178 (the phone<->desktop LAN sync bridge) does not exist in this
deployment at all.** It is a personal-desktop pairing feature only (always
resolves data against the single local desktop account, no per-user auth,
only a static pairing token) -- with `LIFE_PLANNER_MULTI_USER=1` set (as
this deployment always sets it, see step 4), the application itself never
starts that listener. This is enforced in code (`server/index.js`, gated
on `MULTI_USER`), not merely by the firewall rules above happening to
block it -- verified by `npm run verify:sync-bridge-multiuser`. Do not
open port 4178 in `ufw` for this deployment; there is nothing listening on
it to reach.

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

## 3. Deploy the app code

```bash
su - lps
git clone https://github.com/Daa13x/LifePlanSystemPublic.git /opt/lps/app
cd /opt/lps/app
npm ci
npm run build
```

Redeploying a new commit later is the same three commands (`git pull`,
`npm ci`, `npm run build`) followed by `systemctl restart lps-beta`.

## 4. Configure secrets/environment

```bash
cp /opt/lps/app/deploy/lps-beta.env.example /opt/lps/lps-beta.env
# edit /opt/lps/lps-beta.env if you changed the port/paths
chmod 600 /opt/lps/lps-beta.env
chown lps:lps /opt/lps/lps-beta.env
```

Nothing secret is ever bundled into the Android APK. The APK only ever
stores the server URL and its own per-tester bearer token (issued at
register/login time), both in the app's own local storage on the phone --
never a server credential.

## 5. Install the systemd service

```bash
cp /opt/lps/app/deploy/lps-beta.service /etc/systemd/system/lps-beta.service
# the unit's WorkingDirectory/ExecStart assume the checkout lives at
# /opt/lps/app -- edit deploy/lps-beta.service first if you used a
# different path
systemctl daemon-reload
systemctl enable --now lps-beta
systemctl status lps-beta
```

`Restart=always` in the unit handles both crash-recovery and
restart-on-reboot (via `enable`).

## 6. Point Caddy at your domain

Edit `deploy/Caddyfile`, replacing `beta.yourdomain.example` with your real
subdomain (create an A/AAAA DNS record pointing it at the VPS's IP first),
then:

```bash
cp /opt/lps/app/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
```

Caddy requests and renews the TLS certificate automatically the first time
it sees a request for that domain -- no manual certbot step.

## 7. Backups

```bash
chmod +x /opt/lps/app/deploy/backup.sh
crontab -u lps -e
# add (invoke via bash explicitly -- don't rely on the execute bit
# surviving a git checkout from a non-Linux machine):
# 0 3 * * * bash /opt/lps/app/deploy/backup.sh >> /opt/lps/data/backup.log 2>&1
```

To restore:

```bash
systemctl stop lps-beta
# Remove the live WAL sidecar files -- they belong to the database being
# replaced, and replaying them against the restored file would corrupt it.
rm -f /opt/lps/data/life-planner.sqlite-wal /opt/lps/data/life-planner.sqlite-shm
cp /opt/lps/backups/life-planner-<timestamp>.sqlite /opt/lps/data/life-planner.sqlite
chown lps:lps /opt/lps/data/life-planner.sqlite
systemctl start lps-beta
```

## 8. Verify

```bash
curl https://beta.yourdomain.example/api/health
# {"ok":true,"data":{"db":"ready",...}}
```

Logs: `journalctl -u lps-beta -f`

## 9. Point the APK at this server

On the phone, on first launch (or from the sign-in screen after clearing
app data), enter `https://beta.yourdomain.example` as the server address,
then register an account. No adb, no USB, no desktop LPS required.
