# Handoff (rev. 2): Optional Module Enablement for ctrlirl Roles

**Change from rev. 1:** configuration happens **in the web UI**, not via a new CLI command. The setup-time flow is separate and may remain CLI-based; the post-setup enable/disable/edit path must be a **web UI panel backed by an HTTP/WS endpoint**, not `ctrlirl config ...`.

---

## 1. Mission

Modify **ctrlirl** (`https://github.com/majklovec/ctrlirl`) so that **optional modules can be enabled per role**, both:

-   **(a) during setup** — when the role is first provisioned, and
-   **(b) later, from the web UI** — so an existing role (e.g. `encoder`) can turn `obs` on or off and edit its config without touching `role.json` by hand.

The OBS/encoder pair is the **acceptance example**, not the feature. Everything must generalize to any optional module (hypothetical `atem`, `vmix`, `midi`, …).

---

## 2. Context You Need Before Starting

> ⚠️ Clone and inspect the repo first. Paths and API names below are from the current public README and may have drifted.

Known facts:

-   **Runtime:** Bun + TypeScript. Entrypoint per docs: `bun client/backend/client.ts --role <role>`.
-   **Roles:** defined as `role.json` per role (an `encoder` role exists).
-   **Modules:** self-contained units; `obs` = obs-websocket v5 client. Modules self-check dependencies on start.
-   **Activation today:** a module is active iff its name is in the role's `modules` array. No enable flag, no per-module config prompt, no UI.
-   **Web UI exists** (per user direction) — locate it, learn its stack (framework, transport, existing panels), and reuse its patterns; do not introduce a second UI stack.
-   **No new CLI subcommand** is required. If a setup CLI already exists, extend it; otherwise hook into whatever the current setup path is.

---

## 3. Goal (Definition of Done)

1. **Role manifests split required vs optional.** Each module declares `required: true|false`; the role config stores both.
2. **Setup flow** asks, per role, which optional modules to enable, and prompts for each newly enabled module's config.
3. **Web UI** exposes a **Modules panel** for the active role with:
    - list of modules with `enabled / disabled / required` state,
    - toggle to **enable** / **disable** optional modules,
    - inline form to **edit** a module's config (rendered from the module's schema),
    - dependency status indicator (green/red) fed by `checkDependencies()`.
4. **Backend API** supports: `GET modules` (list + schema + status), `POST modules/:name/enable`, `POST modules/:name/disable`, `PUT modules/:name/config`. All scoped to the currently active role.
5. **Disabling** flips `enabled: false` and **preserves stored config**, so re-enabling does not re-prompt.
6. **`role.json` (or an adjacent override file)** is written deterministically and idempotently. Legacy `modules: string[]` shape still loads.
7. **Docs** updated with a working `encoder + obs` walkthrough (both setup-time and via the web UI).

---

## 4. Suggested Approach

### 4.1 Data model (additive, backward-compatible)

Preferred shape:

```jsonc
{
    "role": "encoder",
    "modules": {
        "required": ["core", "http", "..."],
        "optional": {
            "obs": {
                "enabled": true,
                "config": {
                    "host": "127.0.0.1",
                    "port": 4455,
                    "password": "...",
                },
            },
        },
    },
}
```

Add a **loader/normalizer** that accepts the legacy `modules: string[]` form on read and upgrades on next write, so existing installs boot unchanged.

### 4.2 Module manifest — must be UI-friendly

The web UI renders enable toggles and config forms **generically from the manifest**. That means the manifest must be **serializable to JSON** and ship a **JSON-schema-like description** of its config (or a `zod` schema with `zod-to-json-schema`) so the frontend can render fields without hard-coding `obs`.

Suggested shape:

```ts
export const manifest = {
    name: "obs",
    required: false,
    describe: "OBS Studio control via obs-websocket v5",
    configSchema: z.object({
        host: z.string(),
        port: z.number().int(),
        password: z.string(),
    }),
    // serializable projection sent to the UI:
    uiSchema: { password: { widget: "password" } },
    async checkDependencies() {
        /* throws with actionable message */
    },
};
```

**Hard rule:** the web UI, the setup wizard, and the loader all consume this manifest generically. No `if (name === "obs")` anywhere in the wizard, UI, or loader.

### 4.3 Setup-time flow

Locate the existing setup entrypoint (CLI script, shell installer, or whatever provisions the role). Insert:

1. Role selection (existing).
2. Show required modules (read-only info).
3. Multi-select optional modules (defaults from a role preset file, see §4.6).
4. For each newly selected optional module → prompt for config (CLI prompts are fine here; reuse the same manifest `configSchema`).
5. Persist role config; run `checkDependencies()` for enabled modules and warn (non-fatal) on failure.

### 4.4 Web UI — Modules panel

Backend endpoints (adapt to the existing router/framework; do **not** invent a parallel API surface):

-   `GET  /api/role/:role/modules` → array of `{ name, required, enabled, describe, config, schema, status: { ok, message? } }`
-   `POST /api/role/:role/modules/:name/enable` → set `enabled: true`, run dependency check, return new state
-   `POST /api/role/:role/modules/:name/disable` → set `enabled: false`, keep `config`
-   `PUT  /api/role/:role/modules/:name/config` → validate against `configSchema`, persist

Frontend panel (reuse the existing UI framework/components):

-   Table of modules: name · description · state · dependency indicator · actions.
-   "Enable" opens a form rendered from `schema`; on submit → `PUT config` then `POST enable` (or a single combined call if the API prefers).
-   "Disable" is a single click; config is retained.
-   "Edit" reopens the same form pre-filled with current config.
-   Surface `status.message` verbatim when dependency check fails (this is where "OBS websocket not reachable at 127.0.0.1:4455" appears).

### 4.5 Secrets

OBS `password` is a secret. Decide once and document:

-   Persist in the same store the rest of the config uses, **git-ignored**; or
-   Use an existing secrets mechanism if the repo has one.

Non-negotiable: the web UI must **never** echo the password back in plaintext in the `GET` response — mask it (`"••••"` or omit + `hasPassword: true`), and treat an unchanged masked value on `PUT` as "keep existing".

### 4.6 Role presets (recommended)

`roles/encoder.preset.json` (or equivalent) listing recommended optional modules, e.g. `obs: true`. Lets the setup wizard default to sensible choices and lets the UI show "recommended" badges. Cheap to add, big UX win, and it keeps the OBS example one click away.

---

## 5. Files to Investigate First

Greppable starting points — verify paths:

-   `**/role.json`, `**/roles/*.json` — role definitions and presets
-   `client/backend/client.ts` — role bootstrap, module loading
-   Existing **web UI** source (`web/`, `frontend/`, `ui/`, or similar) — framework, router, transport
-   Existing **backend API** routes — reuse conventions
-   Setup entrypoint (`setup.*`, `install.*`, `scripts/`)
-   `**/modules/obs/**` — reference for the manifest shape
-   `README.md`, `docs/` — must be updated

Run: `grep -r "modules" --include="*.ts"`, `grep -r "role.json"` to enumerate every consumer of the current schema.

---

## 6. Acceptance Tests

Automated (bun test) + one manual UI smoke test:

1. **Legacy read:** old `role.json` with `modules: ["obs"]` still boots `encoder` with OBS active; next write upgrades it to the new shape without data loss.
2. **Setup happy path:** fresh setup → choose `encoder` → enable `obs` → provide host/port/password → persisted config valid; module initializes (or fails only on missing external OBS, with a clear message).
3. **Setup idempotent:** re-running setup without changes does not duplicate modules or lose config.
4. **UI enable:** from the web UI, enable `obs` on `encoder`, fill the form → config written, module active, dependency indicator updates without a page reload (or with a documented reload).
5. **UI disable preserves config:** disable `obs` → `enabled: false`, `config.host` still present; re-enable → no re-prompt, previous config pre-filled.
6. **API validation:** `PUT config` with invalid data (e.g. `port: "abc"`) returns `400` and does **not** mutate disk.
7. **Secret masking:** `GET modules` never returns the plaintext password; submitting the unchanged masked value on `PUT` does not corrupt the stored secret.
8. **Dependency failure is non-fatal:** enabled module with missing external dependency logs a warning and shows red in the UI; client does not crash.
9. **Docs:** README contains a walkthrough for both paths (setup CLI and web UI toggle) that a fresh user can follow verbatim.

---

## 7. Constraints & Non-Goals

-   **Backward compatibility is mandatory.** No manual `role.json` edits required post-upgrade.
-   **No special-casing `obs`.** Wizard, UI, API, and loader are all generic over the manifest. If you find yourself writing `if (name === "obs")`, stop and fix the abstraction.
-   **No new CLI subcommand.** Post-setup configuration lives in the web UI. If a setup CLI exists, extend it; otherwise do not introduce one.
-   **No second UI stack.** Reuse the framework, components, and transport already present in the web UI.
-   **Secrets** are never returned in plaintext from the API.
-   **Non-goals:** writing new modules; changing the runtime entrypoint; touching obs-websocket protocol logic.

---

## 8. Deliverables Checklist

-   [ ] Manifest interface with `required`, serializable `configSchema` + `uiSchema`, `checkDependencies`
-   [ ] Role config loader/normalizer (legacy `string[]` → new shape, upgrade-on-write)
-   [ ] Setup wizard step for optional-module selection + per-module config prompt
-   [ ] Backend endpoints `GET /modules`, `POST enable|disable`, `PUT config` (scoped to role)
-   [ ] Web UI **Modules panel**: list, toggle, edit form rendered from schema, dependency status, secret masking
-   [ ] `obs` module refactored to export a manifest
-   [ ] `encoder.preset.json` (or equivalent) recommending `obs`
-   [ ] Tests covering scenarios §6.1–§6.8
-   [ ] README + docs: `encoder + obs` walkthrough for **both** setup and web-UI paths
-   [ ] Changelog / migration note

---

## 9. Open Questions to Resolve in Code (not by guessing)

1. What framework/transport does the existing web UI use, and where do API routes live? Reuse them — do not add a parallel layer.
2. Where is the setup flow actually invoked from — `bun setup`, shell script, systemd unit, or a web-based first-run wizard? If the setup flow is _also_ in the web UI, merge §4.3 and §4.4 into a single first-run wizard and drop the CLI-only assumption.
3. Is there an existing config validator (zod / io-ts / JSON Schema) that `configSchema` should reuse?
4. How are secrets currently stored (env file, config file, systemd `EnvironmentFile=`)? Align OBS password handling with whatever exists.
5. Are other roles besides `encoder` already shipping optional modules? Enumerate — the abstraction must cover them from day one.
6. Is `obs` currently a **required** part of `encoder`? If so, this is a _required → optional_ migration, not an addition — call it out explicitly in release notes and handle the case where an existing user had it implicitly on.

---

## 10. Communication Back to Requesting User

When done, report:

-   Diff summary (files touched, ± lines).
-   Step-by-step repro for the `encoder + obs` flow, **once via setup and once via the web UI**.
-   Screenshot or GIF of the Modules panel (if feasible) — the UI is the user-facing deliverable here.
-   Confirmation that a legacy `role.json` boots unchanged and is upgraded transparently on next write.
-   Any schema migration that ran automatically vs. required user action.

---

**Handoff author's note:** the user explicitly said _no new CLI command — configuration happens in the web UI_. Treat the **Modules panel + its backend endpoints** as the primary deliverable, the setup-time prompt as the secondary one, and the OBS/encoder pair as the proof that both work. Do not ship a CLI `config` command as a "fallback."
