/*
 * Assemble on-device deploy bundles for the compiled client binaries.
 *
 * `bun build --compile` embeds only the JS: the declarative installer still
 * reads each module's install/ sidecar tree (install.json, install.sh,
 * board.*.json, udev/…) from disk at runtime, at
 * `<binaryDir>/client/modules/<id>/install/` (see shared/paths.ts `APP_ROOT`
 * and shared/install/load.ts). A bare `scp dist/client-arm <host>` therefore
 * ships a binary whose installer finds no specs — dependencies like srtla_send
 * are never installed. This script fixes that by copying the built binary and
 * every module's install/ tree into one self-contained bundle:
 *
 *   bun run build:client && bun scripts/package_client.ts
 *   scp -r dist/bundles/client-arm/app pi@192.168.10.104:~
 *   ssh pi@192.168.10.104 'sudo ./app/client-arm --config ./app/encoder.json'
 *
 * Each bundle is dist/bundles/<target>/app/ : the <target> binary plus the
 * client/modules/<id>/install/ trees as its siblings — exactly what the
 * installer reads from `<binaryDir>/client/modules/<id>/install/`. Runs in Bun.
 */
import { chmod, cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const distDir = join(repoRoot, "dist");
const modulesRoot = join(repoRoot, "client", "modules");
const bundlesRoot = join(distDir, "bundles");

/** The compiled client targets (bin name = bundle dir name = binary file name). */
const TARGETS = ["client", "client-arm"] as const;

async function isFile(p: string): Promise<boolean> {
    try {
        return (await lstat(p)).isFile();
    } catch {
        return false;
    }
}
async function isDir(p: string): Promise<boolean> {
    try {
        return (await lstat(p)).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Copy one target's bundle: the built binary plus every module's `install/`
 * sidecar tree, laid out exactly as the runtime expects beside the binary.
 * Returns the list of shipped module ids.
 */
async function packageTarget(
    target: (typeof TARGETS)[number],
): Promise<{ deployName: string; modules: string[] }> {
    const binPath = join(distDir, target);
    if (!(await isFile(binPath))) {
        throw new Error(
            `missing built binary ${binPath} — run \`bun run build:client\` first`,
        );
    }

    // Rebuild the bundle from scratch so a stale layout never lingers.
    // The payload lives under app/ so the binary dir (app/) holds the binary
    // and the client/modules/install sidecar trees as siblings — the layout
    // the runtime reads from `<binaryDir>/client/modules/<id>/install/`.
    //
    // The amd64 build is named `client`, which would collide with the required
    // `client/` tree root in the same dir; deploy it as `ctrlirl` instead. The
    // ARM build (`client-arm`) — the one the live devices run — keeps its name.
    const deployName = target === "client" ? "ctrlirl" : target;
    const bundleDir = join(bundlesRoot, target);
    const appDir = join(bundleDir, "app");
    await rm(bundleDir, { recursive: true, force: true });
    await mkdir(appDir, { recursive: true });

    // 1. The binary, at the app/ root (the binary dir the installer reads).
    const binDest = join(appDir, deployName);
    await cp(binPath, binDest, { force: true });
    await chmod(binDest, 0o755);

    // 2. Every module that ships an install/ tree, under client/modules/<id>/.
    const withInstall = (
        await Promise.all(
            (
                await readdir(modulesRoot, { withFileTypes: true })
            )
                .filter((e) => e.isDirectory())
                .map(async (e) => ({
                    id: e.name,
                    hasInstall: await isDir(
                        join(modulesRoot, e.name, "install"),
                    ),
                })),
        )
    )
        .filter((m) => m.hasInstall)
        .sort((a, b) => a.id.localeCompare(b.id));

    for (const { id } of withInstall) {
        const src = join(modulesRoot, id, "install");
        const dest = join(appDir, "client", "modules", id, "install");
        await mkdir(dirname(dest), { recursive: true });
        await cp(src, dest, { recursive: true, force: true });
        // The .sh hooks are exec'd by the installer — make sure they're +x.
        for (const name of ["install.sh", "uninstall.sh"]) {
            const hook = join(dest, name);
            if (await isFile(hook)) await chmod(hook, 0o755);
        }
    }
    return { deployName, modules: withInstall.map((m) => m.id) };
}

// --- main -----------------------------------------------------------------
await mkdir(bundlesRoot, { recursive: true });
for (const target of TARGETS) {
    const { deployName, modules } = await packageTarget(target);
    console.log(
        `dist/bundles/${target}/app  →  ${deployName} + ${modules.length} install/ tree(s) [${modules.join(", ")}]`,
    );
}
console.log(
    "\nDeploy: scp -r dist/bundles/client-arm/app <host>:~  then run ./app/client-arm",
);
