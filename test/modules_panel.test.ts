/*
 * Tests for the web UI's Modules panel: `modules.info` (role rows, field
 * metadata, masked secrets, non-fatal dependency preflight), `modules.configure`
 * validation (400 before any mutation), `modules.enable`/`disable` (config
 * survives the toggle), the setup wizard's `optionalModuleInfo`, and
 * `seedOptionalModules` (the wizard's selection).
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as eventlog from "../client/backend/eventlog";
import { handleRequest } from "../client/backend/methods";
import {
    defaultModules,
    seedOptionalModules,
} from "../client/backend/modules";
import { state } from "../client/backend/state";
import { ApiError } from "../shared/params";

const OBS = "obs";
const originalSettings = state.settings;
const originalData = state.data;
const restores: (() => void)[] = [];

afterEach(() => {
    for (const restore of restores.splice(0).reverse()) restore();
    state.settings = originalSettings;
    state.data = originalData;
});

function encoderDevice() {
    const modules = defaultModules("encoder");
    state.settings = {
        ...originalSettings,
        role: "encoder",
        language: "en",
        modules,
    };
    return modules;
}

/** The live settings slice for `id`. Mutations go through
 * `ensureModuleSlices()`, which rebuilds the module map, so assertions must
 * read the current object — not a reference captured before the mutation. */
const slice = (id: string): Record<string, unknown> | undefined =>
    state.settings.modules?.[id] as Record<string, unknown> | undefined;

interface RpcResponse {
    type: string;
    id: unknown;
    method: string;
    ok: boolean;
    result?: Record<string, unknown>;
    error?: string;
    code?: number;
}

async function request(
    method: string,
    params: Record<string, unknown> = {},
): Promise<RpcResponse> {
    return JSON.parse(
        await handleRequest(JSON.stringify({ id: "rpc-test", method, params })),
    );
}

function silenceLog() {
    const log = spyOn(eventlog, "logEvent").mockImplementation(() => {});
    restores.push(() => log.mockRestore());
}

/** The state JSON currently on disk ("" when no state file is configured). */
const diskState = (): string =>
    process.env.STATE_FILE ? readFileSync(process.env.STATE_FILE, "utf-8") : "";

describe("modules.info (the web UI's Modules panel)", () => {
    test("returns the encoder role's rows with required/optional flags", async () => {
        encoderDevice();
        silenceLog();
        const response = await request("modules.info");
        expect(response.ok).toBe(true);
        const rows = (response.result?.modules ?? []) as Array<{
            id: string;
            required: boolean;
            optional: boolean;
            enabled: boolean;
            fields: unknown[];
            titleKey: string;
        }>;
        const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
        expect(byId.encoder?.required).toBe(true);
        expect(byId.encoder?.enabled).toBe(true);
        expect(byId.obs?.required).toBe(false);
        expect(byId.obs?.optional).toBe(true);
        expect(byId.obs?.enabled).toBe(false);
        expect(byId.streamdeck?.required).toBe(false);
        expect(byId.streamdeck?.optional).toBe(true);
        for (const row of rows) expect(Array.isArray(row.fields)).toBe(true);
    });

    test("reports the OBS fields with their types and masked secret state", async () => {
        encoderDevice();
        silenceLog();
        const response = await request("modules.info");
        const obs = (response.result?.modules as Array<{ id: string; fields: Array<Record<string, unknown>> }> | undefined)
            ?.find((r) => r.id === OBS);
        const fieldByName = Object.fromEntries(
            (obs?.fields ?? []).map((f) => [f.name, f]),
        );
        expect(fieldByName.obsUrl?.type).toBe("text");
        expect(fieldByName.obsPassword?.type).toBe("password");
        expect(fieldByName.obsPassword?.secret).toBe(true);
        // `configured` mirrors the stored value, which defaults from the
        // ambient OBS_PASSWORD env (empty when the env is clean).
        const envPassword = process.env.OBS_PASSWORD ?? "";
        expect(fieldByName.obsPassword?.configured).toBe(envPassword !== "");
        expect(fieldByName.sceneEvents?.type).toBe("boolean");
    });

    test("dependency preflight is non-fatal: absent deps never fail the call", async () => {
        encoderDevice();
        silenceLog();
        // Force an empty obsUrl so the result is deterministic regardless of any
        // ambient OBS_URL in the environment.
        await request("modules.configure", { id: OBS, config: { obsUrl: "" } });
        const response = await request("modules.info");
        expect(response.ok).toBe(true);
        const rows = (response.result?.modules ?? []) as Array<{
            id: string;
            deps: { ok: boolean; messageKey?: string } | undefined;
        }>;
        const obs = rows.find((r) => r.id === OBS);
        const deck = rows.find((r) => r.id === "streamdeck");
        // No obsUrl configured → the preflight reports, it does not throw.
        expect(obs?.deps).toEqual({ ok: false, messageKey: "obs.deps_no_url" });
        // Headless host: the real HID scan finds no deck (or throws when the
        // native binding is absent) — either way it is a non-fatal ok:false.
        expect(deck?.deps?.ok).toBe(false);
        expect(deck?.deps?.messageKey).toMatch(/^streamdeck\.deps_/);
    });

    test("a stored secret is masked as configured and its value is never revealed", async () => {
        encoderDevice();
        silenceLog();
        await request("modules.configure", {
            id: OBS,
            config: { obsPassword: "hunter22" },
        });
        const response = await request("modules.info");
        expect(response.ok).toBe(true);
        const raw = JSON.stringify(response.result);
        expect(raw).not.toContain("hunter22");
        const obs = (response.result?.modules as Array<{ id: string; fields: Array<Record<string, unknown>> }> | undefined)
            ?.find((r) => r.id === OBS);
        const password = obs?.fields.find((f) => f.name === "obsPassword");
        expect(password?.secret).toBe(true);
        expect(password?.configured).toBe(true);
    });
});

describe("modules.configure validation", () => {
    test("an unknown field is a 400 and leaves the slice on disk untouched", async () => {
        const modules = encoderDevice();
        silenceLog();
        const before = structuredClone(modules[OBS]);
        const diskBefore = diskState();
        const response = await request("modules.configure", {
            id: OBS,
            config: { bogusField: true },
        });
        expect(response.ok).toBe(false);
        expect(response.code).toBe(400);
        expect(modules[OBS]).toEqual(before);
        expect(diskState()).toBe(diskBefore);
    });

    test("a wrong-typed value is a 400", async () => {
        encoderDevice();
        silenceLog();
        const response = await request("modules.configure", {
            id: OBS,
            config: { sceneEvents: "yes" },
        });
        expect(response.ok).toBe(false);
        expect(response.code).toBe(400);
    });

    test("a valid config is applied and persisted", async () => {
        encoderDevice();
        silenceLog();
        const response = await request("modules.configure", {
            id: OBS,
            config: { sceneEvents: true },
        });
        expect(response.ok).toBe(true);
        expect(slice(OBS)?.sceneEvents).toBe(true);
    });
});

describe("modules.enable / modules.disable", () => {
    test("disabling keeps the module config; re-enabling restores it", async () => {
        encoderDevice();
        silenceLog();
        await request("modules.configure", {
            id: OBS,
            config: { obsPassword: "hunter22", sceneEvents: true },
        });
        expect(slice(OBS)?.enabled).toBe(false);

        const disabled = await request("modules.disable", { id: OBS });
        expect(disabled.ok).toBe(true);
        expect(slice(OBS)?.enabled).toBe(false);
        // The config survives the toggle — the secret is still stored.
        expect(slice(OBS)?.obsPassword).toBe("hunter22");
        const list = (disabled.result?.modules ?? {}) as Record<
            string,
            Record<string, unknown>
        >;
        expect(list[OBS]?.obsPassword).toEqual({ configured: true });

        const enabled = await request("modules.enable", { id: OBS });
        expect(enabled.ok).toBe(true);
        expect(slice(OBS)?.enabled).toBe(true);
        expect(slice(OBS)?.obsPassword).toBe("hunter22");
        expect(slice(OBS)?.sceneEvents).toBe(true);
    });

    test("a required module cannot be disabled", async () => {
        encoderDevice();
        silenceLog();
        expect(slice("encoder")?.enabled).toBe(true);
        const response = await request("modules.disable", { id: "encoder" });
        expect(response.ok).toBe(false);
        expect(response.code).toBe(400);
        // The required module stays enabled.
        expect(slice("encoder")?.enabled).toBe(true);
    });
});

describe("setup wizard optional-module selection", () => {
    test("setup.get lists each role's optional modules with their fields", async () => {
        encoderDevice();
        silenceLog();
        const response = await request("setup.get");
        expect(response.ok).toBe(true);
        const info = (response.result?.optionalModuleInfo ?? {}) as Record<
            string,
            Array<{ id: string; optional: boolean; fields: unknown[] }>
        >;
        const encoderMods = info.encoder ?? [];
        expect(encoderMods.map((m) => m.id).sort()).toEqual([
            "obs",
            "streamdeck",
        ]);
        for (const mod of encoderMods) {
            expect(mod.optional).toBe(true);
            expect(Array.isArray(mod.fields)).toBe(true);
        }
    });

    test("seedOptionalModules enables the selected modules with their config", async () => {
        encoderDevice();
        silenceLog();
        await seedOptionalModules("encoder", {
            streamdeck: {},
            obs: { sceneEvents: true },
        });
        expect(slice("streamdeck")?.enabled).toBe(true);
        expect(slice(OBS)?.enabled).toBe(true);
        expect(slice(OBS)?.sceneEvents).toBe(true);
    });

    test("seedOptionalModules rejects modules that are not optional on the role", async () => {
        encoderDevice();
        silenceLog();
        // ctrlink_relay is a module of another role — not optional on the encoder.
        await expect(
            seedOptionalModules("encoder", { ctrlink_relay: {} }),
        ).rejects.toBeInstanceOf(ApiError);
        await expect(
            seedOptionalModules("encoder", { no_such_module: {} }),
        ).rejects.toBeInstanceOf(ApiError);
        // Nothing was seeded by the rejected calls.
        expect(slice("ctrlink_relay")?.enabled).toBe(false);
        expect(slice("streamdeck")?.enabled).toBe(false);
    });
});
