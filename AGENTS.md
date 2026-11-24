# Ctrl-IRL Agent Guide

## What this is

Ctrl-IRL turns a small Linux box strapped to a backpack into an IRL streaming rig. The **device client** runs on that box and drives the whole pipeline — bonding cellular modems into redundant uplinks, encoding video, and pushing SRT/RTMP to a destination — while a web UI on the same box lets the operator monitor links, switch modems, and control the stream. The optional **control server** manages a fleet of these devices from a browser. Everything is a **module**: a role just wires modules together, and modules talk only over a named **capability bus**.

## Commands

```bash
bun install
bun run dev:client / dev:server      # dev
bun run test                         # bun test --parallel=8
bun run build:bundle                 # build client + package for deploy
bunx biome check --write .           # format + lint
```

````

`predev` and `pretest` regenerate `generated/` automatically — don't edit those files by hand.

## Architecture

The system is a **device client** (runs one **role**) plus an optional **control server**. Every feature is a **module**; modules never import each other, only talk over the **capability bus** by name.

-   **Roles** (`client/roles/<name>/role.json`) declare which modules to load and which capabilities are required/provided. No logic.
-   **Modules** (`client/modules/<id>/`) have a required `backend.ts` (Bun-side, no DOM) and optional `frontend.tsx` (Mithril, `jsxFactory: m`).
-   **Capabilities** live in `shared/contracts/module_capabilities.ts`; the core routes by name only. Add a capability → update that file and the providing module's `backend.ts`.

A module must never name a role, and must never import another module directly.

## Conventions

-   TypeScript, `snake_case` filenames, Biome (`useConsistentCurlyBraces` = error, `useImportType` = off).
-   User-facing strings go through `shared/i18n`; run `bun run i18n` when adding keys.
-   Tests use `bun:test` in `test/`. Headless DOM modules stub `document`/`window` before dynamic import — see `test/alerts.test.ts`.
-   Commits follow **Conventional Commits** (`feat`, `fix`, `chore`, `docs`, `test`, `perf`; no `refactor`/`style` types). Semantic Release owns versioning and `CHANGELOG.md` — don't edit them.

## Boundaries

-   No subagents.
-   Never touch networking on `ssh vondracek.dev`.
-   Deploy the `dist/bundles/client-arm/app` bundle, not the bare binary — the installer reads each module's `install/` tree at runtime.
-   Don't edit `generated/`, don't bypass the capability bus, don't add role names to modules.

## Deployment

| Device  | SSH                  |
| ------- | -------------------- |
| Encoder | `pi@192.168.10.104`  |
| Relay   | `user@192.168.1.211` |

```bash
bun run build:bundle \
  && scp -r ./dist/bundles/client-arm/app pi@192.168.10.104:/home/pi \
  && scp -r ./dist/bundles/client-arm/app user@192.168.1.211:/home/user
```

Run a client on a deployed box: `./client-arm --host 0.0.0.0 <role>`.

relay / enable routing:

```bash
sudo sysctl -w net.ipv4.ip_forward=1
sudo iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
sudo iptables -A FORWARD -i eth1 -o eth0 -j ACCEPT
sudo iptables -A FORWARD -i eth0 -o eth1 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
```

## Runtime requirements

Bun, Linux with `iproute2` + `iptables`/`nftables`, ModemManager (`mmcli`), `belacoder`/`ceracoder`, `srtla_send`/`srtla_rec`, `ffmpeg`, `sshd`. Modules check their own deps at startup and log what's missing.

## More

[`README.md`](README.md) · [`docs/MANUAL.md`](docs/MANUAL.md) · [`docs/overlays.md`](docs/overlays.md) · [`docs/install-rules.md`](docs/install-rules.md) · [`shared/contracts/`](shared/contracts/)
````
