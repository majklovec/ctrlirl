# Install / uninstall rules

Ctrl-IRL devices get their host configuration (systemd units, sysctl keys,
firewall rules, udev rules, config overlays, package dependencies) from
**declarative JSON specs**, one directory per module:

```
client/modules/<module>/install/
  install.json              # base spec (applies to every role)
  install.<role>.json       # optional role delta (merged over the base)
  hooks/
    install.sh              # optional, runs after everything else
    uninstall.sh            # optional, runs first on uninstall
  udev/
    <name>.rules            # optional; referenced via "contentFile"
  overlay/                  # optional; mirrors the destination root (/)
    etc/<module>/app.conf
```

Modules **without** an `install/` directory behave exactly as before — the
installer simply has nothing to do for them.

## Writing a spec

```json
{
    "version": 1,
    "dependencies": ["ffmpeg"],
    "capabilities": { "ambient": ["CAP_NET_ADMIN"] },
    "services": [
        {
            "name": "myapp",
            "unit": "systemd",
            "content": "[Unit]\nDescription=Ctrl-IRL myapp\n\n[Service]\nExecStart=/opt/ctrlirl/run\n\n[Install]\nWantedBy=multi-user.target\n",
            "enabled": true,
            "started": true
        }
    ],
    "sysctl": { "net.ipv4.ip_forward": 1 },
    "firewall": [
        {
            "tool": "nft",
            "chain": "forward",
            "rule": "ip daddr 10.7.0.0/16 accept"
        }
    ],
    "udev": [
        {
            "file": "55-ctrlirl-myapp.rules",
            "content": "SUBSYSTEM==\"net\", KERNEL==\"myapp*\", NAME=\"%k\"\n",
            "trigger": { "subsystem": "usb", "action": "change" }
        }
    ],
    "overlay": {
        "preserve": ["etc/myapp/app.conf"],
        "allowProtected": [],
        "reload": []
    },
    "hooks": {
        "install": "hooks/install.sh",
        "uninstall": "hooks/uninstall.sh"
    }
}
```

All keys are optional. `version` must be `1`. `install.<role>.json` is merged
over `install.json` (role wins) — arrays concatenate then dedupe:
`services` by `name`, `firewall` by `(tool, table, chain, rule)`, `udev` by
`file` (later entry wins).

**Constraints**

- udev filenames must match `^\d{2}-ctrlirl-[a-z0-9_-]+\.rules$`
- `iptables` rules require a `comment`; nft rules live in the module-owned
  table `inet ctrlirl_<role>_<module>`
- A module cannot mix `nft` and `iptables` rules in one spec
- `services[].content` / `contentFile` and `udev[].content` /
  `contentFile` are mutually exclusive

**Placeholders** (resolved at load time; missing values are a validation
error, never a silent empty string):

- `{{file:udev/modem.rules}}` — inline a file from the `install/` directory
- `{{env:PORT}}` — an environment variable (a validation error when unset)
- `{{cfg:module.key}}` — a value from the device config file

Run `bun run validate:install` (or `bun client/backend/client.ts install
validate`) to schema-check every spec in the repo, both standalone and after
role merging.

## How installing works

`bun client/backend/client.ts --role <role> install` builds a plan
(ordered by module-to-module `dependencies`) and runs, per module, in this
fixed order:

```
packages → overlay → udev → sysctl → firewall → systemd → overlay reload → hooks
```

Uninstall runs the **exact reverse** (hooks first, packages last). State is
persisted to `/var/lib/ctrlirl/installed/<role>.json` (mode 0600) after every
module, so a crash leaves a recoverable file and uninstall knows exactly what
to remove — including pre-install values of sysctl keys.

Every provider is idempotent: an identical unit/file/rule is skipped (and its
reload skipped too); the nft table is module-owned, so re-install is an atomic
delete + re-apply. Operator-managed files are never overwritten: an unmanaged
systemd unit or udev rule file that already exists is a hard error, and
overlay files protected by `preserve` are left in place with a warning.

If a module fails mid-install, the installer rolls back **that module only**
(reverse of the steps already applied) and exits 2 — other modules are never
touched, and state stays consistent.

### Role switching

```
sudo bun client/backend/client.ts --role <new> switch-from <old>
```

Modules present in both roles whose fully-resolved specs are identical are
left on disk (their state entry is copied to the new role's file); only the
deltas are torn down / installed. Plain `start` does the same when the
requested role has no state yet — it auto-installs first (opt out with
`--skip-install`).

## CLI

```
sudo bun client/backend/client.ts --role <role> install   [--dry-run] [--install-deps]
sudo bun client/backend/client.ts --role <role> uninstall [--dry-run] [--purge]
sudo bun client/backend/client.ts --role <role> reinstall [--dry-run]
sudo bun client/backend/client.ts --role <new> switch-from <old> [--dry-run]
bun    client/backend/client.ts install validate
```

- `--dry-run` prints the resolved per-module plan and exits 0 (no host
  changes, no root needed)
- `--install-deps` lets the installer `apt-get install -y` missing packages
  (off by default: a missing package is an error)
- `--purge` on uninstall removes only the packages the installer itself
  added (`packagesAdded` in state) — pre-existing packages are never removed
- Exit codes: `0` success, `1` validation/usage error, `2` install error
  (state preserved), `3` not root

Dry-run output groups artifacts by provider in the fixed step order:

```
[modems] install
  packages:
    * dpkg -s ModemManager  (check)
  udev:
    + /etc/udev/rules.d/55-ctrlirl-modem.rules  (write, reload, trigger)
```

Prefix legend: `+` write/create, `~` skip (unchanged), `-` remove
(uninstall), `*` run (check/hook).

## Hooks

`install.sh` runs after everything else in the module's install;
`uninstall.sh` runs first in the uninstall. Both get the environment
`CTRLIRL_ROLE`, `CTRLIRL_MODULE`, `CTRLIRL_INSTALL_DIR` (absolute path to the
module's `install/` directory). Hooks are **not** idempotent by design — the
installer always runs them. State records that an install hook ran, so the
uninstall counterpart is invoked even when the install partially failed.

## Testing without root

All install logic is testable on a developer machine:

- `CTRLIRL_ROOT_OVERRIDE=<tmp>` redirects the destination root **and** the
  state file root, so providers write into a temp dir
- `CTRLIRL_TEST=1` makes `host.run()` refuse to spawn a real command (an
  injected `fake` must answer) — a test can never hit the host's
  `systemctl`/`nft`/`udevadm`
- Tests: `test/install_spec.test.ts` (M1), `test/install_orchestrator.test.ts`
  (M2), `test/install_providers.test.ts` (M3/M4), `test/install_m5.test.ts`
  (M5)
