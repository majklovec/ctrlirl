# Implementation notes — install/uninstall rules

Deviations, assumptions, and open questions for the declarative install layer
(handoff doc, milestones M1–M6). Read together with
[docs/install-rules.md](docs/install-rules.md).

## Deviations from the handoff

### No `relay` role or `relay` module (repo drift)

The handoff was written against an older repo state in which `relay` was the
default role and a `relay` module existed ("srtla ports in firewall, service
unit"). The current tree has **no `relay` role and no `relay` module** (last
touch: "refactor(roles): remove relay role"). Real roles are
`broadcaster`, `ctrlink_relay`, `encoder`, `obs`.

- The handoff's `relay` port was therefore **not** done. Its likely content
  (SRTLA ports in the firewall) now belongs to whichever role owns that
  transport; `ctrlink_relay` was ported instead (see below).
- Acceptance criterion #1 names `relay/install/install.json`; the equivalent
  coverage here is the `ctrlink_relay` port.
- `switch-from relay` (acceptance #5) is exercised by the tests as
  `switch-from <old>` with two synthetic roles plus the real role definitions.

### `Bun.SchemaValidator` does not exist (Bun 1.4.4)

The handoff assumed `Bun.SchemaValidator` for `schema.json`. It is not
available in the runtime in use, so
[`shared/install/validate.ts`](shared/install/validate.ts) implements a small
self-contained evaluator for the subset of JSON Schema the spec uses
(`type`, `enum`, `required`, `properties`, `additionalProperties`, `pattern`,
`minLength`, `items`, `oneOf`, and the `if/then` for
"iptables requires comment"). It is tested in
[test/install_spec.test.ts](test/install_spec.test.ts).

### `Bun.glob` typing in the validator script

`Bun.glob` is not declared in the pinned `@types/bun`, so
[`scripts/validate_install.ts`](scripts/validate_install.ts) uses `node:fs`
(`readdirSync`) instead of globbing. The script exports
`validateAllInstallSpecs()` and auto-runs only when executed directly
(`import.meta.main`), so the CLI `install validate` subcommand can reuse it.

### `RoleDefinition.requires.modules`, not a top-level `modules`

The handoff sketched role specs with a flat module list. The repo's
`RoleDefinition` (shared/contracts/roles.ts) carries
`requires.modules` (+ `requires.optionalModules`); the plan builder
(`client/install/plan.ts`) reads those. `RoleDefinition.install` (added in
M2) is the role-wide spec, merged as a synthetic `__role__` plan entry.

### Board detection and the per-board delta layer

Board identity lives in [`shared/install/board.ts`](shared/install/board.ts) as
a pure, injectable `detectBoardId()` (device-tree `model` → CPUinfo fallback,
never throws) plus `BOARD_IDS`/`isBoardId`. It is the single source of truth:
the systeminfo module (`client/modules/systeminfo/factory.ts`) reuses the same
function for provider selection, so install deltas and systeminfo can't drift.
Detection is read-only (`/proc/device-tree/model`, `/proc/cpuinfo`) and safe on
the host.

The board is a **third merge layer** — base → role → board (board wins) — read
from `install/boards/<board>.json` in `loadInstallSpec`. It is applied only
when the board is non-generic, so `generic` (the default) is a no-op. The board
id threads through `buildPlan` → `InstallPlan.board` → install state
(`state.board`) → CLI (`--board` / `BOARD_ID`, validated, exit 1 on unknown).
`orderByModuleDependencies`/`reverseOrder` spread the plan, so the `board`
field propagates to reversed/uninstalled plans.

## Provider notes

### Root-gated providers are verified through the command seam

`systemd`, `sysctl`, `firewall`, `udev`, `packages`, and `hooks` all go
through [`client/install/host.ts`](client/install/host.ts) `run()`, which has
a test seam: under `CTRLIRL_TEST=1` (set by every install test), a real
command is **never** spawned — a missing `fake` is a hard error, so a test
cannot accidentally hit the host's `systemctl`/`nft`/`udevadm`/`apt-get`.

Consequences:

- Idempotency + reversal are verified in the suites (files land in a temp
  `CTRLIRL_ROOT_OVERRIDE` root; commands are recorded and asserted on).
- What is **not** verified on a real host: actual `nft -f` batch application,
  `systemctl enable/start`, `udevadm trigger` effects, and `apt-get`
  behavior. Fallback verification is manual on a disposable device
  (acceptance criteria #3–#6 remain to be run with `sudo` on the target
  box).
- `isRoot()` gates every mutating CLI path (exit 3 otherwise); `--dry-run`
  needs no root and prints the §15-format plan.

### iptables uninstall is comment-position based

The iptables fallback deletes rules by locating the tag
(`ctrlirl:<role>:<module>:<hash8>`) in `iptables -S <chain>` output and
deleting by position (highest first). The owning binary/table/chain is
recovered from the spec, so uninstall works without re-deriving rule order.
A rule the operator hand-added with the same comment would also be deleted —
the tag is namespaced and 32-bit hashed, so this is acceptable.

### packages `--purge` / rollback scope

`packagesAdded` accumulates across runs. An explicit `--purge` removes
everything recorded; a **rollback** (reverse of a failed install) removes
only the packages added in *that* run (tracked in per-run `transient`), so a
partial failure never removes packages a previous successful install added.

### hooks are not idempotent (by design)

Hooks always run. The installer records `hooksRun` (`<module>:install`) so
the `uninstall.sh` counterpart runs even when the install partially failed.
Documented in docs/install-rules.md.

## Module ports and what was inferred

| Module | Rules | Source |
|---|---|---|
| `network` | sysctl `ip_forward=1`, `rp_filter=2` (loose mode for the bridged L2 traffic); nft `forward` rules for the `10.7.0.0/16` ctrlirl tunnel range | inferred from `client/modules/network/*` (routing/bridge handling) and the handoff's table |
| `ctrlink_relay` | udev rule pinning `gretap*` kernel names (relay side of the GRETAP data plane) | inferred from `client/modules/ctrlink_relay/gretap.ts` (`gretap_<iface>`, `br_gretap`) |
| `ctrlink_streamer` (M6) | same `gretap*` udev pin + `CAP_NET_ADMIN` (ambient, informational) | inferred from `client/modules/ctrlink_streamer/backend.ts` |
| `modems` | `ModemManager` dependency; udev `55-ctrlirl-modem.rules` (usb dialout/uucp group, AT port access) with `usb` `change` trigger; content via `contentFile` | inferred from `client/modules/modems/modems.ts` (ModemManager D-Bus + AT port) |
| `encoder` | `ffmpeg` + `libav-tools` dependency check only (no host config of its own) | inferred from `client/modules/encoder/encoder.ts` (`Bun.spawn([this.bin …])` of ffmpeg) |
| `ssh` | **not ported** | the repo's ssh module manages its *own* plain sshd (pid file, no init system — `client/modules/ssh/backend.ts`), so there is no system unit/config to install. The handoff's ssh pilot predates that design. |

The `10.7.0.0/16` tunnel range and `rp_filter=2` are **inferred values** —
confirm against the actual fleet before the first real install.

## Open questions for the maintainer

1. Should `--install-deps` (apt auto-install) default to on on a fresh
   device, given `start` already auto-installs? Currently off: missing
   packages are a hard error, which is friendlier to `apt`-less images.
2. The `network` module's forward rules assume the `ctrlirl` tunnel subnet is
   `10.7.0.0/16`. Should specs read this from config (`{{cfg:…}}`) instead?
3. Should `switch-from` also verify (and warn on) *operator-modified*
   artifacts that are recorded as ours (today: skip-if-identical silently
   keeps them)?
4. Optional (handoff §16): a control-server `GET /api/install/preview`
   endpoint that renders the §15 plan for a role — not implemented; low
   priority.
5. `systemd` services for the modems/ssh-style daemons: the modems port
   currently relies on the distro's `ModemManager` service. If the target
   images ship without it, we need a unit under `modems/install/` —
   say the word and I'll add one.
