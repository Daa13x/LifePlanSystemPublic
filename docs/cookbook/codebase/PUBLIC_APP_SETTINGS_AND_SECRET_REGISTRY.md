# LifePlanSystemPublic Settings and Secret Registry

Status: complete static registry of environment overrides and SQLite setting keys observed in `server/db.js`, `server/index.js`, `src/main.jsx`, Vite configuration, and the Chrome extension snapshot; runtime validation remains separate.

Last updated: 2026-07-16

Source snapshots:

```text
server/db.js                         46f761bad8f03592bda1915f1b4fca04f9ccc4bc
server/index.js                      1ef2992c2aa5be14b655022cd6ab986a48a9b3ad
src/main.jsx                         4592881c34af44848dfc72e74895face6098a1da
vite.config.js                       08034372ba72183b33717c1e6d8140602ad07fb3
browser-extension/.../background.js d6d139b5f16e291dbe963e08793b7cb553d662b8
browser-extension/.../manifest.json 13599ad298f16aea312bca44f58e5ab145c90f7a
```

---

## 1. Storage model

Application settings are stored in SQLite:

```text
settings.key   TEXT PRIMARY KEY
settings.value TEXT NOT NULL (JSON encoded)
```

`setSetting` JSON-stringifies every value. `getSetting` JSON-parses and returns the raw text only when parsing fails.

The generic settings endpoint accepts arbitrary keys. This registry therefore describes the keys used by maintained source, not a database-enforced allowlist.

---

## 2. Application environment variables

### `LIFE_PLANNER_DB`

| Property | Value |
|---|---|
| Purpose | Override SQLite database file |
| Default | `<cwd>/data/life-planner.sqlite` |
| Read by | `server/db.js` at module import |
| Type | File path string |
| Restart required | Yes |
| Secret | No, but path may reveal user/environment details |

Known limitations:

- effective parent directory is not created when it differs from `<cwd>/data`;
- `/api/health` reports the default path instead of the override;
- all imports use one process-global database connection.

### `LIFE_PLANNER_PORT`

| Property | Value |
|---|---|
| Purpose | Override Express listen port |
| Default | `4177` |
| Read by | `server/index.js` at startup |
| Type | Number conversion |
| Bind address | Always `127.0.0.1` |
| Restart required | Yes |
| Secret | No |

Known integration mismatch:

- `vite.config.js` proxies `/api` to `127.0.0.1:4177`;
- extension `background.js` calls `127.0.0.1:4177`;
- extension manifest permits only `127.0.0.1:4177`;
- SQLite key `browserAgentPort` is not wired into these values.

Changing only `LIFE_PLANNER_PORT` breaks Vite development proxy and Chrome connector communication.

---

## 3. Ambient operating-system environment

These are discovery inputs rather than Life Planner configuration contracts.

| Variable / mechanism | Use |
|---|---|
| `LOCALAPPDATA` | Windows per-user Chrome executable lookup |
| `ProgramFiles` | Windows Chrome and Docker Desktop CLI lookup |
| `ProgramFiles(x86)` | 32-bit Windows Chrome lookup |
| `PATH` | Resolves Node, npm, npx, Git, GitHub CLI, HF CLI, winget, Docker, PowerShell, clipboard tools, Chrome on Linux, and external-browser launchers |

The app does not currently read API tokens from environment variables. Tokens are persisted in SQLite instead.

---

## 4. Complete maintained SQLite setting-key registry

| Key | Default / fallback | Writer | Reader / consumer | Classification |
|---|---|---|---|---|
| `modelFolders` | `[]` | Settings UI, model scan | Model scanner, Settings UI | Active |
| `modelDownloadFolder` | server fallback `<cwd>/models`; UI may show empty | Settings UI, HF download | HF download/re-download, Settings UI | Active |
| `hfToken` | empty string | Generic Settings save | HF search/files/download | Active secret |
| `localModelEndpoint` | empty string | Settings UI; managed-server start | Chat/browser local-model router | Active |
| `localModelName` | `planner-assistant` | Settings UI; managed-server start | OpenAI-compatible endpoint requests | Active |
| `llamaCliPath` | empty string | Settings UI | Runtime status and llama-cli execution | Active |
| `llamaServerPath` | empty string | Settings UI; server start | Runtime status and managed-server start | Active |
| `llamaServerPort` | `8080` | Settings UI; server start | Managed endpoint/status | Active |
| `llamaContextSize` | `4096` | Settings UI; server start | Managed llama-server arguments | Active |
| `browserAgentMode` | `myChromeConnector` | Settings UI | Browser consultation routing | Active |
| `browserAgentPort` | `4177` | Settings UI | Display text only in current frontend | Stored but ineffective |
| `githubToken` | empty string | Dedicated Source token endpoint; generic settings endpoint can also write | Authenticated Source push/tag push | Active secret |

No other maintained setting keys were observed in the inspected source snapshot.

---

## 5. `modelFolders`

Expected shape:

```json
["C:\\Models", "D:\\LLMs"]
```

Behaviour:

- Settings textarea is split by newline, trimmed, and empty entries removed.
- `/api/models/scan` accepts request folders or falls back to this key.
- Every existing directory is recursively traversed.
- `.gguf` files are inserted/upserted by absolute path.

Validation gaps:

- no array/type validation in generic settings storage;
- no directory allowlist;
- no recursion/file-count limit in the model scanner;
- inaccessible directories may throw during traversal;
- arbitrary local directories can be scanned when supplied by the local user/API caller.

---

## 6. `modelDownloadFolder`

Behaviour:

- Settings UI initial state may be empty.
- Server default for download is `path.resolve('models')`.
- HF download stores the chosen folder after a successful download.
- Re-download uses the existing registry path, otherwise this setting/default.

Validation gaps:

- no workspace confinement;
- no allowed-root policy;
- no free-space check;
- no path normalization registry;
- caller can choose an arbitrary locally writable directory.

This is intentional local-user capability but should be explicit in first-run and packaging documentation.

---

## 7. `hfToken` — secret

Purpose: authenticate Hugging Face API and file requests for private or gated models.

Use:

```http
Authorization: Bearer <hfToken>
```

Used by:

- `/api/hf/files`
- `/api/hf/search`
- `/api/hf/download`
- `/api/models/:id/download`

Protection:

- listed in `SECRET_SETTING_KEYS`;
- normal settings/bootstrap reads return `[redacted]` when populated;
- normal backup export redacts it;
- Settings POST ignores the literal `[redacted]` placeholder, preserving stored value.

Weaknesses:

- stored unencrypted in SQLite;
- generic `/api/settings` can set it without format validation;
- no dedicated clear/validate endpoint;
- explicit backup export with secrets can reveal it;
- raw database copies reveal it;
- no environment/keychain alternative.

Public HF search/download normally works without this token.

---

## 8. Local model runtime settings

### `localModelEndpoint`

Expected value:

```text
http://127.0.0.1:8080
```

The server appends `/v1/chat/completions` unless the configured value already ends with that route.

Risks:

- no URL allowlist or localhost-only validation;
- a local API caller can configure a remote endpoint, causing Planner prompt/context egress;
- no explicit endpoint request timeout;
- no authentication/header settings;
- endpoint errors are returned in governance-aware fallback text.

### `localModelName`

Default: `planner-assistant`.

Sent as the `model` field to the OpenAI-compatible endpoint. The server does not enumerate or validate available endpoint models.

### `llamaCliPath`

Absolute/local executable path used for direct `llama-cli` invocation.

Gate:

- configuration flag means non-empty;
- runtime additionally checks file existence.

The command receives the assigned model path, prompt, `-n 700`, and temperature `0.3`.

### `llamaServerPath`

Executable path used by `/api/models/server/start`.

Gate:

- must be supplied and exist;
- assigned Planner Assistant model required.

### `llamaServerPort`

Default: `8080`.

Used to bind managed llama-server to `127.0.0.1` and construct the managed endpoint.

Validation gaps:

- no integer range check;
- no availability check before spawn;
- can conflict with another local service;
- changing it does not stop/restart an existing managed child automatically.

### `llamaContextSize`

Default: `4096`.

Passed to llama-server as `-c <value>`.

Validation gaps:

- numeric conversion only;
- no lower/upper bound;
- hardware/model compatibility is not validated.

---

## 9. Browser-agent settings

### `browserAgentMode`

Frontend choices:

```text
myChromeConnector
debugChrome
```

Server behaviour:

- exact `myChromeConnector` uses the extension job queue;
- every other value falls through to the debug-Chrome/Playwright consultation path.

Risks:

- generic settings can store arbitrary strings;
- server does not validate against the UI enum;
- a typo silently changes routing to the fallback path.

### `browserAgentPort`

Default/display value: `4177`.

Current source behaviour:

- saved by Settings UI;
- displayed in extension setup instructions;
- not read by `server/index.js`;
- not read by extension `background.js`;
- not reflected in extension host permissions;
- not reflected in Vite proxy.

Therefore this setting is currently misleading. It should either become the authoritative generated/configured connector port or be removed from the UI until wiring exists.

---

## 10. `githubToken` — secret

Purpose: authenticated HTTPS branch/tag pushes when no credential helper is available.

Preferred writer:

```text
POST /api/source/token
```

Validation there requires prefix:

```text
github_pat_
ghp_
```

Use:

1. Read token only at push time.
2. Read `origin` URL.
3. For HTTPS remotes, construct an ephemeral URL with `x-access-token` userinfo.
4. Pass it to the one Git subprocess.
5. Do not update stored remote URL.
6. Scrub exact token from returned error text.

Used by:

- `/api/source/push`
- `/api/source/tags/push`

Protection:

- listed in `SECRET_SETTING_KEYS`;
- redacted from settings/bootstrap/normal backup;
- dedicated clear endpoint;
- Source status exposes only configured/not configured.

Weaknesses:

- stored unencrypted in SQLite;
- command-line process arguments can be observable to sufficiently privileged local processes;
- generic `/api/settings` bypasses dedicated prefix validation and can overwrite it;
- explicit secrets backup/raw database reveals it;
- no expiry/scope validation;
- error scrubbing covers returned command output but not every possible OS/process diagnostic channel.

---

## 11. Redaction contract

Known secret registry:

```js
new Set(['hfToken', 'githubToken'])
```

`readSettings({redactSecrets:true})` returns:

- `[redacted]` for a populated known secret;
- empty string for an empty known secret.

Client-safe readers:

- `/api/bootstrap`
- `GET /api/settings`
- normal public/backup export unless secrets explicitly requested.

Write preservation rule:

```text
POST /api/settings ignores a known-secret value exactly equal to [redacted]
```

This allows the frontend to round-trip a redacted settings object without erasing the token.

Redaction limitations:

- registry is manual and easy to forget when a new secret key is introduced;
- arbitrary unknown secret-like keys are not redacted;
- secret detection is by exact key only;
- values remain plaintext at rest;
- the generic write endpoint is not allowlisted;
- explicit secret backup is query-controlled.

---

## 12. Export and backup secret behaviour

Public export:

```text
GET /api/export/json?mode=public
```

Does not include settings.

Normal backup:

```text
GET /api/export/json?mode=backup
```

Includes settings with known secrets redacted.

Explicit secrets backup:

```text
GET /api/export/json?mode=backup&includeSecrets=1
```

Includes stored secret values.

This route is bound to localhost under normal server configuration but has no secondary confirmation, password, or one-time token. Any process/browser page able to call the local endpoint may trigger the export.

---

## 13. Frontend-only and pseudo-settings

### Theme

Storage:

```text
localStorage['life-planner-theme']
```

Values used: `dark`, `light`.

This is not stored in SQLite and is browser-profile specific.

### `storageLocation`

The sidebar reads:

```text
boot.settings.storageLocation || 'Local database'
```

No maintained server writer/default for `storageLocation` was observed. It is currently a possible arbitrary settings key or a dormant UI field, not an authoritative database-path report.

### Form-only state

These are not persistent settings unless a save/download action writes related keys:

- current HF repository search;
- model search query;
- delete-confirmation state;
- selected browser/cloud agent;
- Temporary Chat confirmation;
- consultation prompt/draft;
- Source Control form values.

---

## 14. Port and endpoint authority problem

Current sources of port truth:

| Surface | Value source |
|---|---|
| Express server | `LIFE_PLANNER_PORT`, default `4177` |
| Vite dev proxy | hardcoded `4177` |
| Chrome extension API base | hardcoded `4177` |
| Chrome extension host permission | hardcoded `4177` |
| Settings UI | SQLite `browserAgentPort`, default `4177` |

There is no single authority.

Recommended fix options:

1. Declare `4177` immutable and remove ineffective configuration.
2. Generate extension/Vite configuration from one build-time port contract.
3. Add extension options/storage and matching host permission strategy.
4. Expose a discovery file/native messaging mechanism.

Until fixed, use the default port for Browser connector development and packaged operation.

---

## 15. Validation and type gaps

The generic settings POST loops over every request-body entry and stores it.

Missing central validation includes:

- key allowlist;
- per-key type/schema;
- numeric bounds;
- URL scheme/host rules;
- path existence/allowed roots;
- enum validation;
- secret format validation;
- maximum value size;
- restart-required metadata;
- dependency/conflict checks.

Some consumers add their own checks—for example model assignment file existence and dedicated GitHub PAT prefix validation—but the stored database value itself remains unconstrained.

---

## 16. Recommended settings architecture

Create a central registry such as:

```js
{
  key: 'llamaServerPort',
  type: 'integer',
  default: 8080,
  min: 1024,
  max: 65535,
  secret: false,
  restartRequired: false,
  consumer: ['modelRuntime'],
  validate(value) { ... }
}
```

Required improvements:

1. Allowlist maintained keys in `/api/settings`.
2. Validate and normalise every key through one registry.
3. Derive redaction from registry metadata.
4. Move tokens to OS credential storage or an encrypted local vault.
5. Prevent generic settings writes from bypassing dedicated secret validation.
6. Add explicit secret-clearing endpoints and confirmation.
7. Restrict configured model endpoints to localhost by default, with explicit egress consent for remote URLs.
8. Make port authority consistent across server, Vite, extension, and UI.
9. Export effective database path from `db.js`.
10. Add restart-required and live-apply status to Settings UI.
11. Add settings migration/rename support.
12. Add automated redaction tests for every client/export path.

---

## 17. Verification checklist

Use an isolated database and avoid real production tokens.

1. Save each non-secret key and restart; confirm type/value round-trip.
2. Confirm populated secrets return `[redacted]` from bootstrap/settings.
3. POST the redacted response unchanged; confirm stored secrets survive.
4. Clear HF token through Settings and GitHub token through dedicated clear route.
5. Confirm normal backup redacts both tokens.
6. Confirm explicit secret backup includes them only when requested.
7. Confirm public export contains no settings.
8. Confirm a direct generic settings write can bypass GitHub prefix validation; record as defect until fixed.
9. Set non-default `LIFE_PLANNER_PORT`; confirm Vite/extension breakage is reproduced and documented.
10. Set non-default `LIFE_PLANNER_DB`; confirm actual file changes and health metadata mismatch.
11. Configure a remote `localModelEndpoint`; confirm current egress behaviour before deciding the required policy.
12. Confirm `browserAgentPort` changes no runtime connector target.

Adjacent references:

```text
docs/cookbook/codebase/PUBLIC_APP_DATABASE_SCHEMA_AND_MIGRATION_REFERENCE.md
docs/cookbook/codebase/PUBLIC_APP_EXPRESS_ENDPOINT_CATALOGUE.md
docs/cookbook/codebase/PUBLIC_APP_BACKEND_HELPER_AND_PROCESS_MAP.md
```