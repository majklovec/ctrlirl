/*
 * The real provider bundle for the device CLI. Every provider shares one
 * `RunOpts` so the raw command log (and a test `fake`, if injected) is
 * observable from one place.
 */
import type { InstallProvider } from "../provider";
import type { RunOpts } from "../host";
import { packagesProvider } from "./packages";
import { overlayProvider } from "./overlay";
import { udevProvider } from "./udev";
import { sysctlProvider } from "./sysctl";
import { firewallProvider } from "./firewall";
import { systemdProvider } from "./systemd";
import { hooksProvider } from "./hooks";

export function realProviderBundle(runOpts: RunOpts = {}): InstallProvider[] {
    return [
        packagesProvider(runOpts),
        overlayProvider(runOpts),
        udevProvider(runOpts),
        sysctlProvider(runOpts),
        firewallProvider(runOpts),
        systemdProvider(runOpts),
        hooksProvider(runOpts),
    ];
}
