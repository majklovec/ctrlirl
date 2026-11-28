## [10.6.1](https://github.com/majklovec/ctrlirl/compare/v10.6.0...v10.6.1) (2026-11-28)


### Bug Fixes

* **roles:** declare optional streamdeck capability in provides ([e1ea457](https://github.com/majklovec/ctrlirl/commit/e1ea4575a2098fcde9e008ab996b6216aff68f70))

# [10.6.0](https://github.com/majklovec/ctrlirl/compare/v10.5.0...v10.6.0) (2026-11-28)


### Features

* **distribution:** publish ctrlirl-coder as a signed apt repository ([9027efc](https://github.com/majklovec/ctrlirl/commit/9027efc841ecacf2bdb9e24957f8ee37f954001c))

# [10.5.0](https://github.com/majklovec/ctrlirl/compare/v10.4.1...v10.5.0) (2026-11-27)


### Features

* **armbian:** add ctrlirl-coder apt repo ([7a88867](https://github.com/majklovec/ctrlirl/commit/7a8886749b3e59058bf90406e883909c71fcd74e))

## [10.4.1](https://github.com/majklovec/ctrlirl/compare/v10.4.0...v10.4.1) (2026-11-27)


### Bug Fixes

* **armbian:** correct build script references ([8af35a8](https://github.com/majklovec/ctrlirl/commit/8af35a8e991c2d3e65072eff97ed4e6262347bcc))

# [10.4.0](https://github.com/majklovec/ctrlirl/compare/v10.3.0...v10.4.0) (2026-11-26)


### Features

* **armbian:** build RK GStreamer from source ([2f49de6](https://github.com/majklovec/ctrlirl/commit/2f49de677318a782022d21c670522f61ddf617d6))
* **roles:** align module dependencies ([faba1ae](https://github.com/majklovec/ctrlirl/commit/faba1ae38d5430aa4cbee31718799c3a56c3c301))

# [10.3.0](https://github.com/majklovec/ctrlirl/compare/v10.2.0...v10.3.0) (2026-11-25)


### Bug Fixes

* **settings:** modules Edit button + full-viewport config modal ([d13c797](https://github.com/majklovec/ctrlirl/commit/d13c797431b924a4400c582ca4b0350153080a47))
* **setup:** render optional-module block in the role step ([0fc87f5](https://github.com/majklovec/ctrlirl/commit/0fc87f52362509f530d246069919e71d94dcfd21))
* **ui:** dedupe OBS config + hide Stream Deck card when disabled ([8f4bfd5](https://github.com/majklovec/ctrlirl/commit/8f4bfd54cff7e25861c69280dac47fd85718a725))


### Features

* **modules:** lock required modules' toggle ([4b8b4af](https://github.com/majklovec/ctrlirl/commit/4b8b4af48bdd17089e9ebaa3ed96c1a620d758d7))
* **modules:** optional modules + streamdeck ([f94250a](https://github.com/majklovec/ctrlirl/commit/f94250a69fecf9ab4d395086271901f2df913147))

# [Unreleased](https://github.com/majklovec/ctrlirl/compare/v10.2.0...HEAD)


### Features

* **modules:** optional modules — per-device feature modules that a role can run but that start disabled. They can be enabled/disabled on demand from a new Modules panel (device UI + a `modules.info` / `modules.configure` RPC) and configured inline; enabling a module (re)starts it and its dependencies. Setup wizard gains an inline **Optional modules** block in the role step.
* **streamdeck:** Stream Deck device module — reads an Elgato Stream Deck over USB HID, emits `streamdeck.press` / `streamdeck.release` events and a `streamdeck.events` capability other modules can subscribe to. An optional module (Encoder + OBS roles).
* **obs:** OBS module config form (WebSocket URL, password, scene-events) surfaced in the Modules panel; reads `OBS_URL` / `OBS_PASSWORD` env as defaults.

### Documentation

* **manual:** new section on optional modules & the Stream Deck module (EN + CS); `client/modules/README.md` documents the optional-modules and `configFields` / `checkDependencies` conventions.

# [10.2.0](https://github.com/majklovec/ctrlirl/compare/v10.1.0...v10.2.0) (2026-11-24)


### Features

* **overlay:** add ticker padding ([3f07018](https://github.com/majklovec/ctrlirl/commit/3f07018b37bb9fa9f0d4790e0bd47fe213669e51))

# [10.1.0](https://github.com/majklovec/ctrlirl/compare/v10.0.1...v10.1.0) (2026-11-24)


### Features

* **projects:** add project runtime token ([3b3c214](https://github.com/majklovec/ctrlirl/commit/3b3c2146edd1785a41f109d62d67a09a501b2cce))

## [10.0.1](https://github.com/majklovec/ctrlirl/compare/v10.0.0...v10.0.1) (2026-11-23)


### Bug Fixes

* **install:** cross-platform contain check for udev/service contentFile ([14c114b](https://github.com/majklovec/ctrlirl/commit/14c114bd86de6c175780d6d925ad46f7c82fa3f6))

# [10.0.0](https://github.com/majklovec/ctrlirl/compare/v9.4.0...v10.0.0) (2026-11-23)


### Code Refactoring

* **server:** rename db to database.sqlite ([ad28f94](https://github.com/majklovec/ctrlirl/commit/ad28f94150dcd74b1ee63da7ca594b7b58f4e6cb))


### Features

* **overlay:** add ticker element ([fc86437](https://github.com/majklovec/ctrlirl/commit/fc8643703b146c09c2864c0f5332357cb1ef77cd))


### BREAKING CHANGES

* **server:** the control server now creates database.sqlite by default.

# [9.4.0](https://github.com/majklovec/ctrlirl/compare/v9.3.0...v9.4.0) (2026-11-21)


### Features

* **log:** add clear log action ([2d4bc8f](https://github.com/majklovec/ctrlirl/commit/2d4bc8f43f2a41478e68cc3fa7ee41a0157bd9ea))

# [9.3.0](https://github.com/majklovec/ctrlirl/compare/v9.2.0...v9.3.0) (2026-11-21)


### Features

* **modems:** add udp bearer keepalive ([637c866](https://github.com/majklovec/ctrlirl/commit/637c866dd776153e884b999158ab0840a96bf28d))

# [9.2.0](https://github.com/majklovec/ctrlirl/compare/v9.1.2...v9.2.0) (2026-11-20)


### Features

* **network:** add sparkline trend cells ([cac06a2](https://github.com/majklovec/ctrlirl/commit/cac06a21d0de5ae67a150d14c953385f1ee7c6e3))

## [9.1.2](https://github.com/majklovec/ctrlirl/compare/v9.1.1...v9.1.2) (2026-11-20)


### Bug Fixes

* **network:** sync uplinks file with bond ([6d388df](https://github.com/majklovec/ctrlirl/commit/6d388dfa3adc9d36db1dca42dba6ebb9ebb36cb4))

## [9.1.1](https://github.com/majklovec/ctrlirl/compare/v9.1.0...v9.1.1) (2026-11-19)


### Bug Fixes

* **client:** bundle module install trees ([551bb65](https://github.com/majklovec/ctrlirl/commit/551bb65c2b3861259512fca37f0cbe27e7663e17))
* **ctrlink_relay:** add tunnel to iface events ([5ab6813](https://github.com/majklovec/ctrlirl/commit/5ab681364cf24930d9f6e45ed06ef8ae26f5ebfa))
* **ctrlink:** serialize relay network-change passes so a replug's tunnel offer survives ([8387e2d](https://github.com/majklovec/ctrlirl/commit/8387e2d99183ec943aba9cec65a02b486b2fc093)), closes [#6](https://github.com/majklovec/ctrlirl/issues/6)
* **pipeline/rpi4:** update h264 test patterns ([9659dce](https://github.com/majklovec/ctrlirl/commit/9659dced8e99a70c24fa6a67c194dad05caba297))

# [9.1.0](https://github.com/majklovec/ctrlirl/compare/v9.0.0...v9.1.0) (2026-11-18)


### Features

* **ctrlink:** add broadcast discovery capability ([241b668](https://github.com/majklovec/ctrlirl/commit/241b6689aa3fb04217e46f1305918faa26a3c0df))

# [9.0.0](https://github.com/majklovec/ctrlirl/compare/v8.2.1...v9.0.0) (2026-11-18)


### Bug Fixes

* **ctrlink_relay:** force-delete TUN on stop ([8e4d023](https://github.com/majklovec/ctrlirl/commit/8e4d02389ebbc5da8fcb808eb0c3e98a16720582))
* **modems:** sort modems by numeric index ([62765cd](https://github.com/majklovec/ctrlirl/commit/62765cd8b3a7f5dc3ec81736362b878756a341db))
* **network:** skip via for CtrLink TUNs ([49f60a3](https://github.com/majklovec/ctrlirl/commit/49f60a323fbc30e0e948347afc82a6e1cfd5f34f))


### Code Refactoring

* **udp-relay:** single-socket TUN relay ([48be413](https://github.com/majklovec/ctrlirl/commit/48be413831256900a1e89feb6922acd77d43f75f))


### Features

* **modems:** group network options ([594a538](https://github.com/majklovec/ctrlirl/commit/594a53897d727863be3f7c9366a743540bce3357))


### BREAKING CHANGES

* **udp-relay:** rename the package to @irlctrl/udp-relay and replace the old relay API

## [8.2.1](https://github.com/majklovec/ctrlirl/compare/v8.2.0...v8.2.1) (2026-11-18)


### Bug Fixes

* **ctrlink_relay:** release pendingConnects when the encoder WS closes ([0f59f66](https://github.com/majklovec/ctrlirl/commit/0f59f66a8bc309617a6b00ab1cf38b3db6ebe204))
* **encoder:** default pipelines dir to ./pipeline ([4ca4ea4](https://github.com/majklovec/ctrlirl/commit/4ca4ea40677e3f30123ab5f58a92db2211002b21))
* **network:** honor empty bond selection and let CtrLink TUNs bond ([1dd492d](https://github.com/majklovec/ctrlirl/commit/1dd492d371063d99c43e443392e5f93b72be8ef7))

# [8.2.0](https://github.com/majklovec/ctrlirl/compare/v8.1.0...v8.2.0) (2026-11-17)


### Bug Fixes

* **udpip:** keep tunnel peer pin valid across pump restarts ([41f9f56](https://github.com/majklovec/ctrlirl/commit/41f9f56d0fb33c8c3cb6256e17d988878c95c188))


### Features

* **ctrlink:** replace kernel WireGuard with plain-UDP IP tunnels ([ea2a863](https://github.com/majklovec/ctrlirl/commit/ea2a8632e0e0377c3f43729db0b5ee699e169b39))
* **vagrant:** make relay a gateway for encoder ([b24ee02](https://github.com/majklovec/ctrlirl/commit/b24ee02a8e0feb511d509bfcece52c21f0274316))

# [8.1.0](https://github.com/majklovec/ctrlirl/compare/v8.0.0...v8.1.0) (2026-11-16)


### Features

* **projects:** add device websocket endpoint ([39576e5](https://github.com/majklovec/ctrlirl/commit/39576e505d2367ec424cd4a6852228bf493dfaaa))

# [8.0.0](https://github.com/majklovec/ctrlirl/compare/v7.12.0...v8.0.0) (2026-11-16)


### Features

* **install:** optional role + wizard install ([1bcd7aa](https://github.com/majklovec/ctrlirl/commit/1bcd7aa648b73b79b0b228af59ec4b5519a2a6d2))
* **vagrant:** add relay uplinks + USB modems ([860d0e9](https://github.com/majklovec/ctrlirl/commit/860d0e9d25d3980069ed6c5550bde95ef6109d1f))


### BREAKING CHANGES

* **install:** --role no longer defaults to encoder; devices without a role stay in the setup wizard

# [7.12.0](https://github.com/majklovec/ctrlirl/compare/v7.11.2...v7.12.0) (2026-11-16)


### Features

* **install:** add board matchers + GStreamer ([085c51e](https://github.com/majklovec/ctrlirl/commit/085c51e9f493e75d62c48d9442005bfa966d3d90))
* **install:** declarative per-module install/uninstall rules (M1–M6) ([a0263ef](https://github.com/majklovec/ctrlirl/commit/a0263ef242df3562c93feea72e28c6efad2e4cb8))
* **install:** hardware-specific board deltas + shared board detection ([c1f5697](https://github.com/majklovec/ctrlirl/commit/c1f56973dbf3a1e4c321edb6240e345cf183c281))

## [7.11.2](https://github.com/majklovec/ctrlirl/compare/v7.11.1...v7.11.2) (2026-11-14)


### Bug Fixes

* remove obsolete TODO and add Huawei quirk ([a0c9194](https://github.com/majklovec/ctrlirl/commit/a0c9194b86a21cea68c17dbb39608d0090adecdd))

## [7.11.1](https://github.com/majklovec/ctrlirl/compare/v7.11.0...v7.11.1) (2026-11-14)


### Bug Fixes

* **config:** avoid spurious config rewrites ([2af1963](https://github.com/majklovec/ctrlirl/commit/2af196337d0e626483918fb51f685c14c8615c31))
* **files:** remove in-flight tmps on exit ([a0c1237](https://github.com/majklovec/ctrlirl/commit/a0c12373b73db4ebc3965ba1941dc7446dbe47ea))

# [7.10.0](https://github.com/majklovec/ctrlirl/compare/v7.9.0...v7.10.0) (2026-11-12)

### Features

-   **ctrlink:** show live WebSocket links ([7360c79](https://github.com/majklovec/ctrlirl/commit/7360c793a514e02469ccb3ddbc5f7b6dff5b7bad))

# [7.9.0](https://github.com/majklovec/ctrlirl/compare/v7.8.0...v7.9.0) (2026-11-12)

### Features

-   **link:** immediate changes in ifaces ([1f6315b](https://github.com/majklovec/ctrlirl/commit/1f6315bd788e9553c60db33cc097de8f1ea415f1))

# [7.8.0](https://github.com/majklovec/ctrlirl/compare/v7.7.1...v7.8.0) (2026-11-12)

### Features

-   **ctrlink:** show throughput and announce times ([c1d86f1](https://github.com/majklovec/ctrlirl/commit/c1d86f18b2ad521251e850720be32167e7044079))

## [7.7.1](https://github.com/majklovec/ctrlirl/compare/v7.7.0...v7.7.1) (2026-11-12)

### Bug Fixes

-   **ctrlink:** keepalive so a live WS channel outlives discovery silence ([b5c23e0](https://github.com/majklovec/ctrlirl/commit/b5c23e0e27615762875e39109e883e125774859c))
-   **ctrlink:** relay unicasts announces to known encoders ([15113e0](https://github.com/majklovec/ctrlirl/commit/15113e05472bfb84d73049daae4dde34f9c95a30))

# [7.7.0](https://github.com/majklovec/ctrlirl/compare/v7.6.0...v7.7.0) (2026-11-12)

### Bug Fixes

-   **relay:** SNAT to NIC IP and unicast discovery ([ce74467](https://github.com/majklovec/ctrlirl/commit/ce74467d0155772132fa4a0ae3915af8524c1759))

### Features

-   **ctrlink:** add mDNS discovery path ([5f06687](https://github.com/majklovec/ctrlirl/commit/5f0668773bdc156ed6a798cc4293659037fbc2c5))

# [7.6.0](https://github.com/majklovec/ctrlirl/compare/v7.5.0...v7.6.0) (2026-11-12)

### Features

-   **ctrlink:** add NAT (SNAT) mode to the UDP relay ([5f50b85](https://github.com/majklovec/ctrlirl/commit/5f50b855a4692e6f50cea6593a982edfed54992d))
-   **relay:** implement relay-encoder protocol ([bfe1ae5](https://github.com/majklovec/ctrlirl/commit/bfe1ae5235276c31cd870aa7e1ab4d15316217b6)), closes [hi#water-mark](https://github.com/hi/issues/water-mark)

# [7.5.0](https://github.com/majklovec/ctrlirl/compare/v7.4.1...v7.5.0) (2026-11-11)

### Features

-   **relay:** remote relay interfaces ([266a647](https://github.com/majklovec/ctrlirl/commit/266a647dc8f6dca831d9a37180f7ada261c25a01))

## [7.4.1](https://github.com/majklovec/ctrlirl/compare/v7.4.0...v7.4.1) (2026-11-10)

### Bug Fixes

-   **network:** keep default on eth uplink ([2a8bef0](https://github.com/majklovec/ctrlirl/commit/2a8bef07a87c1083a6aca0198ba875e61e0ecab9))

# [7.4.0](https://github.com/majklovec/ctrlirl/compare/v7.3.0...v7.4.0) (2026-11-10)

### Features

-   **network:** prefer ethernet default route ([41b7199](https://github.com/majklovec/ctrlirl/commit/41b7199021aeffb21bc03327116e5c028fb211f1))

# [7.3.0](https://github.com/majklovec/ctrlirl/compare/v7.2.0...v7.3.0) (2026-11-10)

### Features

-   **network:** add dhcp lease gateway ([b5bc055](https://github.com/majklovec/ctrlirl/commit/b5bc0559948bf6843de5414c1454f6779c5ae2bf))

# [7.2.0](https://github.com/majklovec/ctrlirl/compare/v7.1.0...v7.2.0) (2026-11-10)

### Features

-   **network:** use cellular bearer gateway ([39a923f](https://github.com/majklovec/ctrlirl/commit/39a923f5b4bd11ba4239b820e7579a284e143ba7))

# [7.1.0](https://github.com/majklovec/ctrlirl/compare/v7.0.1...v7.1.0) (2026-11-10)

### Features

-   **modems:** add gsm auto-dial/reconnect ([9d62e15](https://github.com/majklovec/ctrlirl/commit/9d62e158447467823d005d0c781aed40e1f07822))
-   **relay:** add srtla_rec binary option ([ed4fb67](https://github.com/majklovec/ctrlirl/commit/ed4fb67759d5ef3dc50ba71d15ff53fde9f7b713))

## [7.0.1](https://github.com/majklovec/ctrlirl/compare/v7.0.0...v7.0.1) (2026-11-09)

### Bug Fixes

-   **srtla:** resolve uplinks and seed tables ([65f98fe](https://github.com/majklovec/ctrlirl/commit/65f98fe86c77f678b6d668c219652603762406e1))

# [7.0.0](https://github.com/majklovec/ctrlirl/compare/v6.5.0...v7.0.0) (2026-11-09)

### Features

-   **webrtc:** add turn server env ([2174a3e](https://github.com/majklovec/ctrlirl/commit/2174a3e072426c6ffa528111d793b493917d63b6))
-   **webrtc:** mint turn credentials server-side ([f441beb](https://github.com/majklovec/ctrlirl/commit/f441beb5b0ffb34bd77538cb49cd255cc42b1fbf))

### BREAKING CHANGES

-   **webrtc:** element TURN props and the ice-config frame are removed.

# [6.5.0](https://github.com/majklovec/ctrlirl/compare/v6.4.0...v6.5.0) (2026-11-09)

### Features

-   **webrtc:** add overlay element and sender ([c88a770](https://github.com/majklovec/ctrlirl/commit/c88a77009a91bfc66a8e9e5eea04602a9e1898f0))
-   **webrtc:** add turn support and split module ([6dbc4c1](https://github.com/majklovec/ctrlirl/commit/6dbc4c1ca3fe8a53e9967ed7c3a9cf9589a8ee21))

# [6.4.0](https://github.com/majklovec/ctrlirl/compare/v6.3.0...v6.4.0) (2026-11-09)

### Features

-   **webrtc:** add sender hijack handling ([4b6f6e3](https://github.com/majklovec/ctrlirl/commit/4b6f6e3b8f44d62229a5a323abc120593b8f29c1))

# [6.3.0](https://github.com/majklovec/ctrlirl/compare/v6.2.0...v6.3.0) (2026-11-09)

### Features

-   **webrtc:** add source icons to sender buttons ([ad5924f](https://github.com/majklovec/ctrlirl/commit/ad5924fec883098f71f0c4a4f082de40f7402c50))

# [6.2.0](https://github.com/majklovec/ctrlirl/compare/v6.1.1...v6.2.0) (2026-11-09)

### Features

-   **webrtc:** support shadow receivers ([24214f9](https://github.com/majklovec/ctrlirl/commit/24214f9d82e35f7bafbfd381b3bab3479e955609))

## [6.1.1](https://github.com/majklovec/ctrlirl/compare/v6.1.0...v6.1.1) (2026-11-09)

### Bug Fixes

-   **overlays:** use active project device token ([8eb7690](https://github.com/majklovec/ctrlirl/commit/8eb7690eff470169e5d4888fafcb9118c58e5e6b))

# [6.1.0](https://github.com/majklovec/ctrlirl/compare/v6.0.2...v6.1.0) (2026-11-09)

### Features

-   **webrtc:** select cameras by device id ([9e5a1fb](https://github.com/majklovec/ctrlirl/commit/9e5a1fb2acad8ac54d891fb18cf0ae1a07b3a07f))

## [6.0.2](https://github.com/majklovec/ctrlirl/compare/v6.0.1...v6.0.2) (2026-11-09)

### Bug Fixes

-   **webrtc:** hide screen share when unsupported ([f02f0ac](https://github.com/majklovec/ctrlirl/commit/f02f0ac9114da8186d3baad0de785f86e2cf1f7a))

## [6.0.1](https://github.com/majklovec/ctrlirl/compare/v6.0.0...v6.0.1) (2026-11-09)

### Bug Fixes

-   **webrtc:** use standard facing modes ([52b0718](https://github.com/majklovec/ctrlirl/commit/52b0718a51f2105e1946b29e0e3663ccb3a1f8cd))

# [6.0.0](https://github.com/majklovec/ctrlirl/compare/v5.2.0...v6.0.0) (2026-11-08)

### Features

-   **projects:** require explicit project creation ([da0e4f1](https://github.com/majklovec/ctrlirl/commit/da0e4f1165204a95f2ff2be9e1bc35daada64e37))

### BREAKING CHANGES

-   **projects:** users no longer receive an implicit Personal project; project-scoped requests without a project return 404.

# [5.2.0](https://github.com/majklovec/ctrlirl/compare/v5.1.0...v5.2.0) (2026-11-08)

### Features

-   **srtla:** share send leg supervision ([b06f33c](https://github.com/majklovec/ctrlirl/commit/b06f33ca89d7d2f73ab3a0385ad8ebb72ca5ce65))

# [5.1.0](https://github.com/majklovec/ctrlirl/compare/v5.0.0...v5.1.0) (2026-11-08)

### Features

-   **overlay:** add webrtc QR and camera selection ([b77234a](https://github.com/majklovec/ctrlirl/commit/b77234a8406ed954484322f258b05f3b349fc843))

# [5.0.0](https://github.com/majklovec/ctrlirl/compare/v4.0.0...v5.0.0) (2026-11-08)

### Features

-   **encoder:** rename SRT port to SRTLA ([3a1af3d](https://github.com/majklovec/ctrlirl/commit/3a1af3da8b4e96719d563e11226d1a2bcbe30d01))
-   **modules:** extract network and modem modules ([40252d4](https://github.com/majklovec/ctrlirl/commit/40252d43b689ff5cff4de7ad2ec7728e722e77bf))
-   **modules:** order relay before network ([c89e1e8](https://github.com/majklovec/ctrlirl/commit/c89e1e8e3b4960248c459b5d5efeac7cb72bb1da))
-   **stream:** use SRTLA everywhere ([a817c47](https://github.com/majklovec/ctrlirl/commit/a817c47c607e611c4e71a0a95a3cc87915dc4318))

### BREAKING CHANGES

-   **stream:** combined devices must be migrated to the
    encoder role and SRT is no longer accepted on the relay input

# [Unreleased]

### Removed

-   `combined` role. Its behavior is now the default for `encoder`.
    Migration: replace `combined` with `encoder` and point its destination
    at the relay (default: `<relay>:6000`) or directly at the final destination.

### Changed

-   Encoder → relay transport is now SRTLA (UDP 6000 default).
-   Relay input is now SRTLA; relay is a full SRTLA→SRTLA bridge.

# [4.0.0](https://github.com/majklovec/ctrlirl/compare/v3.5.1...v4.0.0) (2026-11-08)

### Features

-   **auth:** preserve route after auth ([bd41c2c](https://github.com/majklovec/ctrlirl/commit/bd41c2cefb8660e063393a34527d2893eb828a8d))
-   **i18n:** add project and overlay translations ([70c717d](https://github.com/majklovec/ctrlirl/commit/70c717df120d573a1c8833a59049305b2d469a13))
-   **projects:** present device tokens in a table ([52d9e55](https://github.com/majklovec/ctrlirl/commit/52d9e55e3beb5e8cf160c6e54ff69cec329481fd))
-   **projects:** preview invite before join ([98247f2](https://github.com/majklovec/ctrlirl/commit/98247f2c14c9da2994a00c4f638d75be00b3e6e6))
-   **projects:** scope all entities by project ([9b40e63](https://github.com/majklovec/ctrlirl/commit/9b40e63f8f9462453b12dd4ae1a9516224d0914f))
-   **projects:** scope device tokens to projects ([f550f37](https://github.com/majklovec/ctrlirl/commit/f550f37d5f60a07a494b09ebe4b5510e199149cc))

### BREAKING CHANGES

-   **projects:** /api/profile/tokens removed; use /api/projects/:id/tokens

## [3.5.1](https://github.com/majklovec/ctrlirl/compare/v3.5.0...v3.5.1) (2026-11-08)

### Bug Fixes

-   **i18n:** shorten create overlay label ([e1f8336](https://github.com/majklovec/ctrlirl/commit/e1f8336d9f1c13d97ffae16791be9f066febf8db))

# [3.5.0](https://github.com/majklovec/ctrlirl/compare/v3.4.0...v3.5.0) (2026-11-08)

### Features

-   **ui:** add create tooltip ([82a4a3d](https://github.com/majklovec/ctrlirl/commit/82a4a3d35c722656dfbec0d86a208d2054e90fdb))
-   **ui:** improve overlay create toolbar ([f276bf1](https://github.com/majklovec/ctrlirl/commit/f276bf108e93c4da46f380cc353c4e3f10255694))

# [3.4.0](https://github.com/majklovec/ctrlirl/compare/v3.3.0...v3.4.0) (2026-11-08)

### Features

-   **auth:** add device web login ([a8031c4](https://github.com/majklovec/ctrlirl/commit/a8031c47dd75c767d6821070c1e3eb923757fe71))

# [3.3.0](https://github.com/majklovec/ctrlirl/compare/v3.2.2...v3.3.0) (2026-11-08)

### Features

-   **app:** validate setup and harden relay ([2586e47](https://github.com/majklovec/ctrlirl/commit/2586e471c0fd1e2294678d89e61058267116fd28))

## [3.2.2](https://github.com/majklovec/ctrlirl/compare/v3.2.1...v3.2.2) (2026-11-07)

### Bug Fixes

-   **overlay:** restore webcam_frame logo slot lost in regroup ([7e15f10](https://github.com/majklovec/ctrlirl/commit/7e15f1024543f30dd4ab4ecc3c39d71002a77faf))

## [3.2.1](https://github.com/majklovec/ctrlirl/compare/v3.2.0...v3.2.1) (2026-11-07)

### Bug Fixes

-   **setup:** return all module setup info ([44ad9bd](https://github.com/majklovec/ctrlirl/commit/44ad9bd75469e3f33e484f8609aaa3cbf005fdfc))

# [3.2.0](https://github.com/majklovec/ctrlirl/compare/v3.1.0...v3.2.0) (2026-11-07)

### Features

-   **overlay:** add zoom fit and regroup tools ([597aa2a](https://github.com/majklovec/ctrlirl/commit/597aa2a5a78a88476c69b7bb3e8cb7594016ec28))

# [3.1.0](https://github.com/majklovec/ctrlirl/compare/v3.0.2...v3.1.0) (2026-11-07)

### Features

-   **overlay:** export and import, ambient parameters ([0c1fbee](https://github.com/majklovec/ctrlirl/commit/0c1fbee7f3a1493358a17ce89c38d7d8e565d3cc))

## [3.0.2](https://github.com/majklovec/ctrlirl/compare/v3.0.1...v3.0.2) (2026-11-07)

### Bug Fixes

-   **nomad:** change image ([6473183](https://github.com/majklovec/ctrlirl/commit/6473183fec581d039f1caea9efc9fa9f679d86a1))

## [3.0.1](https://github.com/majklovec/ctrlirl/compare/v3.0.0...v3.0.1) (2026-11-07)

### Bug Fixes

-   **gen-pages:** normalize glob paths ([f3c104b](https://github.com/majklovec/ctrlirl/commit/f3c104b50e608eb98bb9bda06dc6967daa3e2b98))

# [3.0.0](https://github.com/majklovec/ctrlirl/compare/v2.25.0...v3.0.0) (2026-11-07)

### Features

-   status ([17f12a4](https://github.com/majklovec/ctrlirl/commit/17f12a49daa5618fd00f27b028fc35737ef0edb5))
-   Add ambient background feature and related tests ([3bc233f](https://github.com/majklovec/ctrlirl/commit/3bc233f42717024a2930d13c16c9b5131e02acb0))
-   Add new ambient background variants: Constellation, Embers, Fireflies, and Ripple ([dd6ed14](https://github.com/majklovec/ctrlirl/commit/dd6ed145c08506e25ead9cd234a6e5f7e3c13b0d))
-   **bindableForm:** implement control rendering and binding logic for dynamic fields ([155f828](https://github.com/majklovec/ctrlirl/commit/155f828df388b18bfbf09fe265428e66b9c1f8f8))
-   dynamic form ([6e69f16](https://github.com/majklovec/ctrlirl/commit/6e69f16da8fd2672e2f4410707972c49feec09e8))
-   enhance asset generation and testing for dynamic forms ([cbc595a](https://github.com/majklovec/ctrlirl/commit/cbc595a1b1c45583218c8092e4de13fb98293d63))
-   **i18n:** add "overlay.live_map_zoom" translations for multiple languages ([ed7f881](https://github.com/majklovec/ctrlirl/commit/ed7f8810c860cd07c8f2b68117fedefa502b0a2b))
-   **live-map:** add gps route history and markers ([4569ee4](https://github.com/majklovec/ctrlirl/commit/4569ee47f3f0b0fef01e2084e0c0c14c41936540))
-   **live-map:** fetch history on new centre fixes ([8083663](https://github.com/majklovec/ctrlirl/commit/80836635aff545566fc3c39502af25e9e4c421e2))
-   **live-map:** vendor leaflet and animate moves ([1062407](https://github.com/majklovec/ctrlirl/commit/10624075d36f91cecb146588f4b38e4b3c434a00))

### BREAKING CHANGES

-   **live-map:** live-map elements now use centerPosition and markerPositions/markerIcons/markerColors; centerLat, centerLon, and startPosition props are removed.

# [2.25.0](https://github.com/majklovec/ctrlirl/compare/v2.24.0...v2.25.0) (2026-11-06)

### Bug Fixes

-   **overlay:** add missing referrer meta tag and ensure newline at end of file ([3b6f0db](https://github.com/majklovec/ctrlirl/commit/3b6f0dbb5d0624660285c8a382d141db42eb4267))

### Features

-   **live_map:** add customizable marker properties and distance badge options ([6ab534e](https://github.com/majklovec/ctrlirl/commit/6ab534e9f3d8e127c6a70e31e896acb78fe55d41))
-   **overlay:** add variableUrl support for bound fields and copy functionality ([814ec62](https://github.com/majklovec/ctrlirl/commit/814ec62db109313583798fb48401c96d0c273ef7))

# [2.24.0](https://github.com/majklovec/ctrlirl/compare/v2.23.0...v2.24.0) (2026-11-05)

### Features

-   **overlay:** add support for element variants in the catalog and improve element addition ([02471e4](https://github.com/majklovec/ctrlirl/commit/02471e44547d2358a159ef24d1b68e138f733694))

# [2.23.0](https://github.com/majklovec/ctrlirl/compare/v2.22.0...v2.23.0) (2026-11-05)

### Bug Fixes

-   **i18n:** update Czech translations for overlay terminology ([3e3300d](https://github.com/majklovec/ctrlirl/commit/3e3300d6de4b5ca450ab9fd46e319e401614662a))

### Features

-   **i18n:** update translations for overlay templates and UI elements ([ba876f5](https://github.com/majklovec/ctrlirl/commit/ba876f53848988b65d6845e8388fe6c5e70a215d))

# [2.22.0](https://github.com/majklovec/ctrlirl/compare/v2.21.0...v2.22.0) (2026-11-05)

### Bug Fixes

-   **twitch:** badges ([1ca684b](https://github.com/majklovec/ctrlirl/commit/1ca684bcef9276a9f1f05b7dabc8f5eab43e3bc7))

### Features

-   **map:** add live map overlay element with internationalization support ([30c3708](https://github.com/majklovec/ctrlirl/commit/30c370841cc12eb2c6eb864e027d0110bd3e57a4))
-   **map:** enhance live map props with grayscale and invert options, update translations ([3eccd17](https://github.com/majklovec/ctrlirl/commit/3eccd172ac65d8909165e7260e8577ad683e3333))

# [2.21.0](https://github.com/majklovec/ctrlirl/compare/v2.20.0...v2.21.0) (2026-11-05)

### Bug Fixes

-   **webrtc:** implement room-state synchronization and enhance signaling logic ([7d94fa3](https://github.com/majklovec/ctrlirl/commit/7d94fa30d63b04092a9bd781e83efed523eb60a8))

### Features

-   add WebRTC sender functionality with signaling and media handling ([2541d7a](https://github.com/majklovec/ctrlirl/commit/2541d7a58f2f41e8b044a270e3310a15b65c0331))

# [2.20.0](https://github.com/majklovec/ctrlirl/compare/v2.19.0...v2.20.0) (2026-11-05)

### Features

-   **chat:** improve image URL handling for Google CDNs and update segment regex ([a9a4ae2](https://github.com/majklovec/ctrlirl/commit/a9a4ae29c91aece2c0de4caaa601c5a5f799f872))

# [2.19.0](https://github.com/majklovec/ctrlirl/compare/v2.18.0...v2.19.0) (2026-11-05)

### Features

-   **chat:** enhance chat feed styling with customizable text properties ([3c8f389](https://github.com/majklovec/ctrlirl/commit/3c8f389e3465bd4758971de244d16df183b22b97))

# [2.18.0](https://github.com/majklovec/ctrlirl/compare/v2.17.0...v2.18.0) (2026-11-05)

### Bug Fixes

-   cast component types to unknown for better type safety ([df3c9b9](https://github.com/majklovec/ctrlirl/commit/df3c9b9dffa5622d9e6b9951e3c41efd0cba45e0))

### Features

-   add new overlay elements and schemas for countdown, weather, now playing, and more ([9a59135](https://github.com/majklovec/ctrlirl/commit/9a591350a88ca05eeff854285968b108180f2ea3))
-   **countdown:** add trigger event support and localization for countdown element ([a974d21](https://github.com/majklovec/ctrlirl/commit/a974d210beae92e93140d6e9c7ab1356874f4873))
-   implement element catalog for overlay editor ([9c3bb60](https://github.com/majklovec/ctrlirl/commit/9c3bb6037c5e54cb1bb807112cdaf0e9a395a746))
-   refactor chat overlay element and schema ([d9145bd](https://github.com/majklovec/ctrlirl/commit/d9145bde6331e115e4b8379be9a691223d4af9cf))
-   **spin-wheel:** enhance landing point calculation for winner segment ([c672e1a](https://github.com/majklovec/ctrlirl/commit/c672e1a04ebf34851f8b6bf3db7a2e69e60f22b7))
-   **spin-wheel:** implement seamless spin animation and highlight winner ([002f89a](https://github.com/majklovec/ctrlirl/commit/002f89a44d8325135a5e4604306db4b2fd6f969d))
-   **weather:** add GeoFillButton to auto-fill latitude and longitude from browser location ([478f8dc](https://github.com/majklovec/ctrlirl/commit/478f8dcfd0c0e037d3cfcf1d62a8f2ca182d1f2d))

# [2.17.0](https://github.com/majklovec/ctrlirl/compare/v2.16.0...v2.17.0) (2026-11-05)

### Bug Fixes

-   **nav:** sort menu items for consistent display order ([c21f0a8](https://github.com/majklovec/ctrlirl/commit/c21f0a8b06981e302b9459d673351f2e4754fde2))

### Features

-   **editor:** add template preview size options and HTML/CSS syntax highlighting ([c6ce712](https://github.com/majklovec/ctrlirl/commit/c6ce712aa1db5b9ea89aa6baf1a41cbe1e33a758))
-   **templates:** implement template management system with editor and preview functionality ([8123e85](https://github.com/majklovec/ctrlirl/commit/8123e85a7fe467ed2783cb1be46f9345e733773e))

# [2.16.0](https://github.com/majklovec/ctrlirl/compare/v2.15.1...v2.16.0) (2026-11-04)

### Features

-   add new overlay templates for alerts, breaking banners, chat boxes, goal bars, and music visualizers ([f30659d](https://github.com/majklovec/ctrlirl/commit/f30659d62a3858087e689d5a205ce21cdb7eb738))
-   add new overlay templates for starting soon, ticker, and webcam frame ([74b3fb2](https://github.com/majklovec/ctrlirl/commit/74b3fb2830a2a5cbec014c5873f8b1d4bd137b59))
-   enhance number input handling with unit display in overlay editor ([e3f8337](https://github.com/majklovec/ctrlirl/commit/e3f8337713ae7db7aea10ee8431e3f322e5190a2))
-   implement live saving of overlay element positions during drag and resize ([0b11b62](https://github.com/majklovec/ctrlirl/commit/0b11b62fcc1a9ead4bfcfd394df8d7e4b1da7a92))
-   **templates:** switching templates and variable forms ([679757b](https://github.com/majklovec/ctrlirl/commit/679757b0b0ea64c15dd3b3b7e6f83edd7e34f7fa))

## [2.15.1](https://github.com/majklovec/ctrlirl/compare/v2.15.0...v2.15.1) (2026-11-03)

### Bug Fixes

-   **device_list:** correct device link URL format in row function ([c8d5482](https://github.com/majklovec/ctrlirl/commit/c8d54823f9e6620bbbfe10d96a865ffe2ba4e017))

# [2.15.0](https://github.com/majklovec/ctrlirl/compare/v2.14.0...v2.15.0) (2026-11-03)

### Features

-   Refactor asset handling in overlays to utilize server-side asset library ([7e252b1](https://github.com/majklovec/ctrlirl/commit/7e252b1872ddb39cd58a2506d41e3c25ccf62535))

# [2.14.0](https://github.com/majklovec/ctrlirl/compare/v2.13.0...v2.14.0) (2026-11-03)

### Features

-   **overlays:** optimize asset handling in overlay frames and improve performance ([756592b](https://github.com/majklovec/ctrlirl/commit/756592bcef212c306d2ff1011b12b0c891f498ed))

# [2.13.0](https://github.com/majklovec/ctrlirl/compare/v2.12.0...v2.13.0) (2026-11-03)

### Features

-   **chat:** implement Twitch and YouTube badge parsing and rendering ([9b43844](https://github.com/majklovec/ctrlirl/commit/9b43844ca75bdd462842f1a503138a9243923a25))

# [2.12.0](https://github.com/majklovec/ctrlirl/compare/v2.11.0...v2.12.0) (2026-11-03)

### Features

-   add overlays table for OBS overlay editor ([ba421ee](https://github.com/majklovec/ctrlirl/commit/ba421ee1b9661b2120e95345f2e90d8ca1f80e52))

# [2.11.0](https://github.com/majklovec/ctrlirl/compare/v2.10.0...v2.11.0) (2026-11-03)

### Features

-   **overlays:** add scene duplication functionality and update UI elements ([41b8a3e](https://github.com/majklovec/ctrlirl/commit/41b8a3e971126cc08228b6419d274d65292a68c6))

# [2.10.0](https://github.com/majklovec/ctrlirl/compare/v2.9.0...v2.10.0) (2026-11-03)

### Bug Fixes

-   **chat:** clip the in-scene feed to the element box ([d517867](https://github.com/majklovec/ctrlirl/commit/d51786758dd7596534cd40ac1fee1f4bb97c225a))
-   **chat:** don't double-stream a feed after a channel change ([3baac3e](https://github.com/majklovec/ctrlirl/commit/3baac3e851e3d8936e89212521350cea5d7cac90))
-   **chat:** pin the top-ordered feed to the top of the element ([208c905](https://github.com/majklovec/ctrlirl/commit/208c905ab8808cea89753cb5555d033330cc7679))
-   **chat:** wrap long messages in the in-scene chat element ([9474dd0](https://github.com/majklovec/ctrlirl/commit/9474dd0a6e0aa18781c162df64798e9860744868))

### Features

-   **chat:** add a show/hide option for sender badges ([5806022](https://github.com/majklovec/ctrlirl/commit/580602203ff40ffef162eae176d7b4a256445d12))
-   **chat:** auto-size the overlay element's visible history ([06ab953](https://github.com/majklovec/ctrlirl/commit/06ab953613a9bc9ebe5a4f8de9e157c37824053f))

# [2.9.0](https://github.com/majklovec/ctrlirl/compare/v2.8.0...v2.9.0) (2026-11-03)

### Features

-   **overlays:** implement channel change detection for embedded chat widgets and auto-reload functionality ([705d91d](https://github.com/majklovec/ctrlirl/commit/705d91d651aea3a1e92a481de6a38a8c70a3ad84))

# [2.8.0](https://github.com/majklovec/ctrlirl/compare/v2.7.0...v2.8.0) (2026-11-03)

### Features

-   **overlays:** add versioning to overlay snapshots and implement reload on new deployment ([c20bc3f](https://github.com/majklovec/ctrlirl/commit/c20bc3fb9b48fa6de4a4b3fec09c280b28d68304))

# [2.7.0](https://github.com/majklovec/ctrlirl/compare/v2.6.0...v2.7.0) (2026-11-03)

### Features

-   **chat:** implement versioning for chat overlay and reload on new deployment ([131f647](https://github.com/majklovec/ctrlirl/commit/131f64767127ecda8c335651a98fbcd96773ecd8))

# [2.6.0](https://github.com/majklovec/ctrlirl/compare/v2.5.1...v2.6.0) (2026-11-03)

### Bug Fixes

-   **assets:** improve file name display and icon alignment in files panel ([6c75c24](https://github.com/majklovec/ctrlirl/commit/6c75c24a07ae5e7848190474c75c9d12e7ad7ac6))
-   **video:** restore import of DEFAULT_VIDEO_PROPS and clean up video draw logic ([21cf39d](https://github.com/majklovec/ctrlirl/commit/21cf39d97de665267b5eec979ba7288912016664))

### Features

-   add video overlay element with properties and UI support ([213a913](https://github.com/majklovec/ctrlirl/commit/213a9130de59958b69022ba01ac6a3c463890537))
-   **assets:** add localization for "move would cycle" message in multiple languages and enhance trash drop zone UI ([035fa82](https://github.com/majklovec/ctrlirl/commit/035fa821a4836135439c748e599ff8b1dd4d07d6))
-   **assets:** implement assets management feature with folder and file operations ([b759f70](https://github.com/majklovec/ctrlirl/commit/b759f70bd6dfcc13e62b4eff7286885883196653))
-   **chat:** add inline SVG role badges for Kick and update badge handling ([cbb238f](https://github.com/majklovec/ctrlirl/commit/cbb238f4774933a18f95b4efb1b9a84aef9424e7))
-   **chat:** add message spacing, fade direction, fade size, and text alignment properties ([77c93ba](https://github.com/majklovec/ctrlirl/commit/77c93ba2686773f9afb449866a17f03b15887352))
-   **chat:** add sender badges rendering and staleness watchdog for chat provider ([e6789d7](https://github.com/majklovec/ctrlirl/commit/e6789d79af5c456f75d4b4371217008d0244308e))
-   **filters:** add filter prop for every element ([7e591f5](https://github.com/majklovec/ctrlirl/commit/7e591f56d34302f55fa3cceb005ade841901a179))

## [2.5.1](https://github.com/majklovec/ctrlirl/compare/v2.5.0...v2.5.1) (2026-11-02)

### Bug Fixes

-   adjust padding for inspector controls for better usability ([deed77b](https://github.com/majklovec/ctrlirl/commit/deed77ba5bf95f8a1261bf6843d2ca9da7012fd4))

# [2.5.0](https://github.com/majklovec/ctrlirl/compare/v2.4.0...v2.5.0) (2026-11-01)

### Features

-   enhance chat overlay with customizable text properties and new TTS voices page ([deaf211](https://github.com/majklovec/ctrlirl/commit/deaf211f7df792d90be5bc3967625a46deddafc4))

# [2.4.0](https://github.com/majklovec/ctrlirl/compare/v2.3.0...v2.4.0) (2026-11-01)

### Features

-   enhance alert media and audio fields with improved layout and upload functionality ([fdd34fa](https://github.com/majklovec/ctrlirl/commit/fdd34fac140e1be888cfb6344f0913dae52a6ed4))
-   implement WebSocket support for chat overlay with improved state management and error handling ([acf430a](https://github.com/majklovec/ctrlirl/commit/acf430a09325f93a5f9ab3c7d5330f5be2037440))
-   zoom controls ([ffb773e](https://github.com/majklovec/ctrlirl/commit/ffb773ea061aa7e6cf02661dfdfdbb328ec31770))

# [2.3.0](https://github.com/majklovec/ctrlirl/compare/v2.2.0...v2.3.0) (2026-11-01)

### Features

-   add fitZoom function to adjust canvas zoom to fit viewport and update overlayUpdatePage to call fitZoom on load ([e8dd84e](https://github.com/majklovec/ctrlirl/commit/e8dd84edd62fb338fe9b134c3540cad4f41fce86))
-   add variables modal and toolbar icon for variable management ([7faa38c](https://github.com/majklovec/ctrlirl/commit/7faa38c3378adda18e5674d0789edfdbf3d540e2))
-   enhance variable binding UI with new selection and usage indicators ([58fa5df](https://github.com/majklovec/ctrlirl/commit/58fa5dfdce978ca5aafe2cd2100ae8e4b5065ef8))

# [2.2.0](https://github.com/majklovec/ctrlirl/compare/v2.1.0...v2.2.0) (2026-11-01)

### Features

-   implement runtime URL dialog with copy and rotate functionality ([5e4ec81](https://github.com/majklovec/ctrlirl/commit/5e4ec81c309a31a75047997e4667a5fb66843966))

# [2.1.0](https://github.com/majklovec/ctrlirl/compare/v2.0.0...v2.1.0) (2026-11-01)

### Bug Fixes

-   **handles:** add CSS variable for counter-scaling handles based on zoom ([108f239](https://github.com/majklovec/ctrlirl/commit/108f239ccc0948883c5186b5fdfa11abf19bbd90))
-   **handles:** adjust border width for overlay handles ([0957a84](https://github.com/majklovec/ctrlirl/commit/0957a847575cf937a954f51f9fca408a548ae4a2))
-   **overlay:** improve CSS inlining for first paint and adjust progress bar layout ([cd86bda](https://github.com/majklovec/ctrlirl/commit/cd86bda8e1eb78ed2c85d1e3628de36f71f69834))
-   **setup:** role diagrams ([d6d7d88](https://github.com/majklovec/ctrlirl/commit/d6d7d8837d6d15421875dcf47123c63bc96ac6a3))

### Features

-   enhance alert handling with payload validation and persistence in project variables ([fd055c0](https://github.com/majklovec/ctrlirl/commit/fd055c017b68d1cb118e458f3b5b0e85dfa0e3d9))
-   implement alert element with trigger-driven overlays ([c9f07bf](https://github.com/majklovec/ctrlirl/commit/c9f07bf4226ac3c6281bc41811616182d25f02d4))
-   introduce dedicated alert trigger endpoint and update variable handling ([d6e3879](https://github.com/majklovec/ctrlirl/commit/d6e387939e6b5d8faae2cffb5de5455f3a7005dc))
-   update variable handling in overlays ([f106b42](https://github.com/majklovec/ctrlirl/commit/f106b42d55517117c8093144f87c0322568233eb))

# [2.0.0](https://github.com/majklovec/ctrlirl/compare/v1.21.0...v2.0.0) (2026-11-01)

-   refactor!: snake_case file names, rename srtla→relay and obs-controller→obs, add combined module ([6bcb371](https://github.com/majklovec/ctrlirl/commit/6bcb37157c40dfaabae149f6a96fc51fb09a3ea3))

### Bug Fixes

-   **boot:** regenerate generated/ before the application graph loads ([05cde65](https://github.com/majklovec/ctrlirl/commit/05cde655c2f490143343808cac18b4cc914762ed))
-   **control-server:** overlay editor duplication, selection, z-order ([f17a048](https://github.com/majklovec/ctrlirl/commit/f17a0480e1a27659dba15f64fe4c213d72211cdf))
-   **line:** implement line diagonal flipping based on drag delta and add tests ([03f435c](https://github.com/majklovec/ctrlirl/commit/03f435c0d28c1ea8dc2ae2231e8e63e25a2b5380))
-   **overlays:** add line endpoint handles for shape elements and adjust overflow behavior ([ec4ed1b](https://github.com/majklovec/ctrlirl/commit/ec4ed1b1e80601ec045ca46294e3cb0ccdcff328))
-   **overlays:** add server-managed monotonic counter to Scene for handling stale WS pushes ([3eae414](https://github.com/majklovec/ctrlirl/commit/3eae4142b4b2fe8b532d6ad879349eedbfd01830))
-   **overlays:** enhance drag snapping logic for element resizing and clamping ([c94e638](https://github.com/majklovec/ctrlirl/commit/c94e6387cb57195c5710a01371591b0b33859616))
-   **overlays:** stroke element-row chevron with currentColor ([d3124ea](https://github.com/majklovec/ctrlirl/commit/d3124ea35af35d4e609f80ee5d67d1e86e7ff367))
-   **resize:** redraw on moce, implement variable revalue via token-authenticated URL and update documentation ([c15e2d9](https://github.com/majklovec/ctrlirl/commit/c15e2d93bb50705adae96c560c8b4e3af2d53332))

### Features

-   add progress overlay element with properties and bindings ([f54decf](https://github.com/majklovec/ctrlirl/commit/f54decf8b466e1558cb39d6f3e261c6cd90d6782))
-   **control-server:** inline canvas text editing + row collapse toggle ([fad7fd5](https://github.com/majklovec/ctrlirl/commit/fad7fd5121f8682f60f79fa0b9fb211dedd58bb4))
-   **control-server:** inspector element list + header z-order arrows ([cc286b7](https://github.com/majklovec/ctrlirl/commit/cc286b7792dfc6eb86fcfa89904098a8ab9dc624))
-   **control-server:** OBS overlay editor (M1) ([b0038bb](https://github.com/majklovec/ctrlirl/commit/b0038bb0c491245cb037e301c6e8fcde05a09530))
-   **control-server:** per-element collapsible inspector rows with own z-order buttons ([2517514](https://github.com/majklovec/ctrlirl/commit/25175147b661a621b358afb1a4b405e925571236))
-   **control-server:** remove redundant Scenes rail from overlay editor ([f99e722](https://github.com/majklovec/ctrlirl/commit/f99e7228084283972fc22401087aed1a43865d30))
-   **control-server:** show overlays list before the editor ([208adb9](https://github.com/majklovec/ctrlirl/commit/208adb9475f4ae81bda2bfd1fc5fa0d38f3202bc))
-   **control-server:** z-order arrows in Elements header, drop Inspector title ([d86a244](https://github.com/majklovec/ctrlirl/commit/d86a244b83ebda8d100848a201550d059b745a38))
-   enhance overlay element bindings and styling ([ac8bdd6](https://github.com/majklovec/ctrlirl/commit/ac8bdd660ca7b3ca8ce9d1048b97b772dcd367b9))
-   **overlays:** add chat and iframe elements with corresponding properties and UI integration ([4854942](https://github.com/majklovec/ctrlirl/commit/4854942d1ed51a69ee1b07426087998a748094c6))
-   **overlays:** implement toolbar with undo/redo and element addition buttons ([8503475](https://github.com/majklovec/ctrlirl/commit/85034756a2bc46a0b43e90689565de4297d47c25))
-   **overlays:** inline Runtime URL icons in header row; chevron before element name ([6860e65](https://github.com/majklovec/ctrlirl/commit/6860e65716cf9355302b3196f26fe5df53694842))
-   **overlays:** replace Assets panel with per-image-element upload; icon buttons in Runtime URL card ([880ea0b](https://github.com/majklovec/ctrlirl/commit/880ea0b09135b5847d7fc218ab94cf7ecec47f9e))
-   **overlays:** white collapse chevron; keep only forward/backward z-order ([ec99a38](https://github.com/majklovec/ctrlirl/commit/ec99a38a8ebb7055df9b8427695589f11570dcaf))
-   **toolbar:** add zoom in/out buttons to editor toolbar and update styles ([e313ee8](https://github.com/majklovec/ctrlirl/commit/e313ee8a13a6d26ccd586e62ee8f7dea4eab960f))
-   **ui:** component library — one file per component, new primitives ([e3fd4ee](https://github.com/majklovec/ctrlirl/commit/e3fd4ee78fe2473389d8f4aea033785b14374e4d))

### BREAKING CHANGES

-   device RPC methods/events `srtla.*` are now `relay.*`,
    the status carries `state.relay` / `relayTarget` / `relayOptions` /
    `summary.relay` instead of the `srtla*` keys, the capability is
    `stream.relay`, and the module ids `srtla` / `obs-controller` are `relay` /
    `obs` (settings slices, dashboard action ids, i18n keys). Devices and the
    control server must be upgraded together; stored device configs and
    dashboards are migrated automatically on first start.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>

# [1.21.0](https://github.com/majklovec/ctrlirl/compare/v1.20.0...v1.21.0) (2026-10-30)

### Bug Fixes

-   **chat:** add support for Kick emotes with valid image URLs in chat ([0e3b81a](https://github.com/majklovec/ctrlirl/commit/0e3b81a81f069a251f44d3000529921ed21feb09))

### Features

-   **routing:** implement default route failover and enhance interface display ([f250756](https://github.com/majklovec/ctrlirl/commit/f250756a928552ab772c5137d15f24ddfafc6c21))

# [1.20.0](https://github.com/majklovec/ctrlirl/compare/v1.19.0...v1.20.0) (2026-10-30)

### Features

-   **chat:** add OBS overlay support with token authentication ([34d2ea0](https://github.com/majklovec/ctrlirl/commit/34d2ea0a1508c8a17b40b93a3dbf437aca9cb2db))

# [1.19.0](https://github.com/majklovec/ctrlirl/compare/v1.18.0...v1.19.0) (2026-10-30)

### Features

-   **broadcaster:** add new streaming profiles for audio-only, copy, and re-encoding formats ([8ed4d75](https://github.com/majklovec/ctrlirl/commit/8ed4d75480a482b76c7c2ba034d1a14f5b98a91d))

# [1.18.0](https://github.com/majklovec/ctrlirl/compare/v1.17.0...v1.18.0) (2026-10-29)

### Features

-   **chat:** add message timestamps feature with localization support ([0703e5a](https://github.com/majklovec/ctrlirl/commit/0703e5a20d4dfc4d8068dd7b268309894037de05))

# [1.17.0](https://github.com/majklovec/ctrlirl/compare/v1.16.0...v1.17.0) (2026-10-29)

### Features

-   **table:** align table text to the center for improved readability ([fa0f372](https://github.com/majklovec/ctrlirl/commit/fa0f3726e3f9bad8dd89819b323935faa92a9297))

# [1.16.0](https://github.com/majklovec/ctrlirl/compare/v1.15.0...v1.16.0) (2026-10-29)

### Features

-   **broadcaster:** align table headers and data to the right for better readability ([0fdde78](https://github.com/majklovec/ctrlirl/commit/0fdde78e81010bf94267ecc5df47195a069bad9f))

# [1.15.0](https://github.com/majklovec/ctrlirl/compare/v1.14.0...v1.15.0) (2026-10-29)

### Features

-   **broadcaster:** implement SRTLA keepalive tracking and UI display ([97b44cc](https://github.com/majklovec/ctrlirl/commit/97b44cc79fad124d531991794ee6f1672666b969))

# [1.14.0](https://github.com/majklovec/ctrlirl/compare/v1.13.0...v1.14.0) (2026-10-29)

### Bug Fixes

-   **broadcaster:** update RTMP URL for Kick server ([37d22ae](https://github.com/majklovec/ctrlirl/commit/37d22ae031af11f8404604c0c17a10a1b7f09f72))

### Features

-   **broadcaster:** enhance stream lifecycle tracking in device summary ([605f3aa](https://github.com/majklovec/ctrlirl/commit/605f3aa606521899640b4638bc143a82ced2318a))
-   **chat:** implement banned messages feature with moderation handling ([f4de822](https://github.com/majklovec/ctrlirl/commit/f4de822870b9be6317fcf6338fe40fdd9d1f89cd))
-   **docker:** add extra_hosts for broadcaster resolution in relay container ([b83d2c5](https://github.com/majklovec/ctrlirl/commit/b83d2c502666191b327028e7d71c09aa43a4251d))

# [1.13.0](https://github.com/majklovec/ctrlirl/compare/v1.12.0...v1.13.0) (2026-10-29)

### Features

-   **broadcaster:** add autostart configuration command to manage boot behavior ([b68aa98](https://github.com/majklovec/ctrlirl/commit/b68aa98ed987bcef5ed6a12732f5b1c4020cfd66))
-   **dashboards:** add color customization for dashboards ([53bfad3](https://github.com/majklovec/ctrlirl/commit/53bfad3475a08852e97b1fa6030e208aa055352c))
-   **database:** consolidate migration logic into db.ts and remove migrate.ts ([13d560b](https://github.com/majklovec/ctrlirl/commit/13d560b1f120d0c64e94d636abbe838517c251eb))
-   **database:** implement database migration system and refactor auth initialization ([a4e41c5](https://github.com/majklovec/ctrlirl/commit/a4e41c58e936d35a77f1cf3f73d35a63529d79e9))

# [1.12.0](https://github.com/majklovec/ctrlirl/compare/v1.11.0...v1.12.0) (2026-10-29)

### Features

-   **broadcaster:** implement RTMP destination management and UI ([4ef38f9](https://github.com/majklovec/ctrlirl/commit/4ef38f9e6998fa27063186f89c7ec7d8eae10d17))

# [1.11.0](https://github.com/majklovec/ctrlirl/compare/v1.10.0...v1.11.0) (2026-10-29)

### Features

-   **srtla2platform:** implement RTMP service catalog and settings UI ([01b7a97](https://github.com/majklovec/ctrlirl/commit/01b7a97d393d27b89467cb9aad22da8f4de24c8e))

# [1.10.0](https://github.com/majklovec/ctrlirl/compare/v1.9.0...v1.10.0) (2026-10-28)

### Bug Fixes

-   **encoder:** force I420 before x264enc to stop High 4:4:4 output ([f9b54e7](https://github.com/majklovec/ctrlirl/commit/f9b54e7ccd50673ed0de76053232d5f2152fd94b))
-   **encoder:** re-emit SPS/PPS on every IDR to fix green video on Kick ([bf1da11](https://github.com/majklovec/ctrlirl/commit/bf1da11a782380db03c3615c9ad2f26b29602030))

### Features

-   add srtla2platform agent with install script and main functionality ([f823b99](https://github.com/majklovec/ctrlirl/commit/f823b99584a58b3b241e08dc1b760d37b410305a))
-   **chat:** add text-to-speech (TTS) functionality for chat messages ([e08fa1f](https://github.com/majklovec/ctrlirl/commit/e08fa1fc1570e8f4810553ca59d941ba7bdcdf8a))
-   **srtla2platform:** add SRT-LA→SRT→RTMP relay module with web UI ([87f7105](https://github.com/majklovec/ctrlirl/commit/87f710567b7385d22a6d20e13621f95bf5e1d95d))
-   **srtla2platform:** migrate legacy UUID to config file and mask RTMP key in logs ([537b25c](https://github.com/majklovec/ctrlirl/commit/537b25c8150debd95d69540c5c614919e9232f4e))
-   **srtla2platform:** replace ffmpeg pipeline mids with file-based output profiles ([a2ff782](https://github.com/majklovec/ctrlirl/commit/a2ff782d65341e9d3071f535381e7a7f5c716f9c))

# [1.9.0](https://github.com/majklovec/ctrlirl/compare/v1.8.0...v1.9.0) (2026-10-27)

### Features

-   **srtla:** add start action and localization for SRTLA control ([086894e](https://github.com/majklovec/ctrlirl/commit/086894e478b5a6017160ab9269eb693192d48ad4))

# [1.8.0](https://github.com/majklovec/ctrlirl/compare/v1.7.0...v1.8.0) (2026-10-27)

### Features

-   add SceneTracker and corresponding tests for OBS scene management ([a66202a](https://github.com/majklovec/ctrlirl/commit/a66202acc7cb2a50eb2deb308083c0cf5dafb741))
-   **buttons:** add editor row reservation for draggable keys in grid layout ([5532997](https://github.com/majklovec/ctrlirl/commit/5532997263a6e69f9c48aee741ae396f7e1933c7))
-   **buttons:** enhance button configurations with grid layout support ([5baf560](https://github.com/majklovec/ctrlirl/commit/5baf56069b032056255edbfc06dfed64d4cf1799))
-   **deck:** implement button configuration and layout management ([c94356e](https://github.com/majklovec/ctrlirl/commit/c94356e17971b7d59fcec4998dd2e07fa148c671))

# [1.8.0](https://github.com/majklovec/ctrlirl/compare/v1.7.0...v1.8.0) (2026-10-27)

### Features

-   add SceneTracker and corresponding tests for OBS scene management ([a66202a](https://github.com/majklovec/ctrlirl/commit/a66202acc7cb2a50eb2deb308083c0cf5dafb741))
-   **buttons:** add editor row reservation for draggable keys in grid layout ([5532997](https://github.com/majklovec/ctrlirl/commit/5532997263a6e69f9c48aee741ae396f7e1933c7))
-   **buttons:** enhance button configurations with grid layout support ([5baf560](https://github.com/majklovec/ctrlirl/commit/5baf56069b032056255edbfc06dfed64d4cf1799))
-   **deck:** implement button configuration and layout management ([c94356e](https://github.com/majklovec/ctrlirl/commit/c94356e17971b7d59fcec4998dd2e07fa148c671))

# [1.7.0](https://github.com/majklovec/ctrlirl/compare/v1.6.1...v1.7.0) (2026-10-27)

### Features

-   add dashboard buttons ([c4db7ec](https://github.com/majklovec/ctrlirl/commit/c4db7ecc2a3f1b04052b964fbf4a372858c323e0))
-   implement audio source tracking for OBS and update dashboard actions ([124e66e](https://github.com/majklovec/ctrlirl/commit/124e66e63d759671a09c09070e5d5d2c3b2b0e7c))

## [1.6.1](https://github.com/majklovec/ctrlirl/compare/v1.6.0...v1.6.1) (2026-10-27)

### Bug Fixes

-   normalize file paths for i18n manifest generation on Windows ([f888343](https://github.com/majklovec/ctrlirl/commit/f8883434b262f02660a3980eb20e780b147228b1))

# [1.6.0](https://github.com/majklovec/ctrlirl/compare/v1.5.0...v1.6.0) (2026-10-27)

### Features

-   add footer component with app version and enhance login/register pages ([f5a7ed8](https://github.com/majklovec/ctrlirl/commit/f5a7ed8f64c8ca08afdf2e65e86a61ea3032a7d7))
