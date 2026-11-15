/* The canonical provider order for dry-run rendering (matches the install
 * step order in handoff §11). Providers not listed are appended alphabetically. */
export const DRY_ORDER: readonly string[] = [
    "packages",
    "overlay",
    "udev",
    "sysctl",
    "firewall",
    "systemd",
    "hooks",
];

export interface DryGroup {
    provider: string;
    artifacts: import("./provider").DryArtifact[];
}
