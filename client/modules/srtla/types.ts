/* Types for the srtla module's source-routing domain: the srtla_send uplinks
 * file and the reconfigure result. The cross-module capability contracts
 * (network.interfaces, network.uplinks) live in shared/ — re-exported so
 * module-internal imports can stay on `./types`. */

import type {
    Iface,
    NetworkInterfaces,
    Uplinks,
} from "../../../shared/contracts/module_capabilities";
export type {
    Iface,
    NetworkInterfaces,
    Uplinks,
};
export type { UplinkEntry } from "../../../shared/contracts/module_capabilities";

/** The result of a routing + uplinks-file reconfigure. */
export interface ReconfigureResult {
    ok: boolean;
    selected: Iface[];
    uplinksFile: string;
    ips: string[];
    changed: boolean;
    error?: string;
}

/** The srtla module's status fragment (deep-merged into the device status). */
export interface SrtlaStatus {
    /** The srtla_send uplinks file (the bond source IPs it dials). */
    uplinksFile: string;
    /** Main-table default-route failover state. */
    failover: { running: boolean };
}
