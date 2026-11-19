/*
 * The repository layout, in one place. Every piece of code that has to find
 * files on disk by convention (module discovery, i18n catalogs, page
 * bundling, static assets, the generators) reads these constants instead of
 * spelling the directories out, so a directory move touches only this file.
 *
 *   client/   the device process: backend, its web UI and the device modules
 *   server/   the control server: core, its page slices, its shell UI and
 *             the widget modules
 *   shared/   dependency-free helpers, contracts and the UI design system
 *             (components, CSS, static assets) both sides and all modules use
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isCompiledBinary } from "./util";

/** Absolute `file:` URL of the application root (the directory holding package.json). */
export const APP_ROOT = new URL("../", import.meta.url);

/**
 * The physical directory that holds the application's on-disk files.
 *
 * In an unbundled (dev / script) run `import.meta.url` is a real path, so the
 * base is the repo root (the parent of `shared/`). In a compiled single-file
 * binary, `import.meta.url` lives in Bun's virtual `/$bunfs` mount, which
 * cannot read real sidecar files — so the base is the executable's own
 * directory (from `process.execPath`). The deploy bundle (scripts/package_
 * client.ts) ships each module's `install/` tree under that directory, which
 * is what the declarative installer reads.
 */
export const APP_BASE = isCompiledBinary()
    ? dirname(process.execPath)
    : fileURLToPath(APP_ROOT);

/** A path under the physical application base (see `APP_BASE`). */
export const appBasePath = (relative: string): string => join(APP_BASE, relative);

/**
 * The directory whose children are the device modules, resolvable on disk for
 * the declarative installer. Unlike `appPath` (anchored on `import.meta.url`),
 * this points at the directory that actually contains the bundled
 * `client/modules/<id>/install/` trees in a compiled binary.
 */
export const installModuleRoot = (): string => appBasePath("client/modules");

/**
 * Directories whose immediate children are modules (`<root>/<id>/backend.ts`).
 *
 * The control server's widget/overlay modules live inside the page slices that
 * consume them (01-refactor): the dashboards widgets under
 * `server/pages/dashboards/modules` and the overlays element/template modules
 * under `server/pages/overlays/modules`. A page that ships its own module adds
 * its `server/pages/<id>/modules` directory here.
 */
export const MODULE_ROOTS = [
    "client/modules",
    "server/pages/dashboards/modules",
    "server/pages/overlays/modules",
] as const;

/**
 * Directory whose immediate children are roles (`<root>/<id>/role.json`).
 *
 * A role owns the knowledge of which modules and capabilities it requires
 * and provides; modules never reference roles.
 */
export const ROLE_ROOT = "client/roles";

/** Page entry points (`<dir>/<name>.html`) of each side's web UI. */
export const PAGE_DIRS = {
    client: "client/frontend/pages",
    server: "server/shell/pages",
} as const;

/** The control server's page slices (`server/pages/<id>/…`, 01-refactor). */
export const PAGES_ROOT = "server/pages";

/** The control server's numbered SQLite schema migrations (`NNNN_<name>.sql`). */
export const MIGRATIONS_DIR = "server/core/migrations";

/** The core translation catalogs (`i18n/<lang>.json`). */
export const CORE_I18N_DIR = "i18n";

/** Static assets shared by both web UIs (images, PWA files). */
export const ASSETS_DIR = "shared/assets";

/** Build-time generated manifests (gitignored). */
export const GENERATED_DIR = "generated";

/** Absolute filesystem path of a repository-relative directory or file. */
export const appPath = (relative: string): string =>
    fileURLToPath(new URL(relative, APP_ROOT));
