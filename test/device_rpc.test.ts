import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as eventlog from "../client/backend/eventlog";
import { handleRequest } from "../client/backend/methods";
import {
    ALL_MODULES,
    defaultModules,
    moduleById,
} from "../client/backend/modules";
import { state } from "../client/backend/state";
import {
    parseBitrates,
    parseEncoderConfig,
} from "../client/modules/encoder/params";
import type { Status } from "../shared/contracts/wire";
import type { Params } from "../shared/params";

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
    modules[OBS].enabled = true;
    state.settings = {
        ...originalSettings,
        role: "encoder",
        language: "en",
        modules,
    };
    return modules;
}

interface RpcResponse {
    type: string;
    id: unknown;
    method: string;
    ok: boolean;
    result?: Record<string, unknown>;
    error?: string;
    code?: number;
    logged?: boolean;
}

async function request(
    method: string,
    params: Params = {},
): Promise<RpcResponse> {
    return JSON.parse(
        await handleRequest(JSON.stringify({ id: "rpc-test", method, params })),
    );
}

function silenceLog() {
    const log = spyOn(eventlog, "logEvent").mockImplementation(() => {});
    restores.push(() => log.mockRestore());
    return log;
}

/** The core methods plus every module's own, as exposed over the socket. */
const CORE_METHODS = [
    "status",
    "log.list",
    "log.clear",
    "setup.get",
    "setup.complete",
    "settings.get",
    "settings.update",
    "modules.list",
    "modules.enable",
    "modules.disable",
    "modules.configure",
    "autostart.set",
];

describe("device RPC surface", () => {
    test("every method has exactly one owner", () => {
        const names = ALL_MODULES.flatMap((m) => m.methods ?? []);
        for (const name of CORE_METHODS) expect(names).not.toContain(name);
        expect(new Set(names).size).toBe(names.length);
        expect([...names].sort()).toEqual(
            [
                "broadcaster.start",
                "broadcaster.stop",
                "interfaces.list",
                "ctrlink_relay.start",
                "ctrlink_relay.stop",
                "ctrlink_relay.status",
                "ctrlink_relay.getConfig",
                "ctrlink_relay.setConfig",
                "ctrlink_streamer.status",
                "ctrlink_streamer.encoderInfo",
                "ctrlink_streamer.getConfig",
                "ctrlink_streamer.setConfig",
                "modems.list",
                "modems.scan",
                "modems.select",
                "modems.setup",
                "modems.toggle",
                "modems.enable",
                "modems.disable",
                "modems.reset",
                "modems.connect",
                "modems.disconnect",
                "modems.profile",
                "pipelines.list",
                "pipelines.get",
                "pipelines.create",
                "pipelines.update",
                "pipelines.delete",
                "pipelines.repositories.add",
                "pipelines.repositories.remove",
                "pipelines.repositories.update",
                "pipelines.repositories.updateAll",
                "encoder.status",
                "encoder.stop",
                "encoder.bitrate",
                "ceracoder.set",
                "stream.start",
                "stream.stop",
                "stream.stats",
                "stream.options",
                "stream.reload",
                "obs.request",
                "obs.requestBatch",
                "obs.setEventSubscriptions",
                "lowBitrateSwitcher.save",
                "speedtest.servers",
                "speedtest.interfaces",
                "speedtest.run",
                "speedtest.cancel",
                "speedtest.last",
                "speedtest.saveSettings",
                "ssh.status",
                "ssh.start",
                "ssh.stop",
                "ssh.reset_password",
                "ssh.set_password",
                "systeminfo.get",
            ].sort(),
        );
    });

    test("keeps the read-only settings envelope and token redaction", async () => {
        encoderDevice();
        state.settings.remoteToken = "secret";
        const response = await request("settings.get");
        expect(response).toMatchObject({
            type: "response",
            id: "rpc-test",
            method: "settings.get",
            ok: true,
            result: {
                restartRequired: true,
                settings: { hasRemoteToken: true },
            },
        });
        expect(response).not.toHaveProperty("logged");
        expect(response.result?.settings).not.toHaveProperty("remoteToken");
    });

    test("status composes the module fragments", async () => {
        encoderDevice();
        const response = await request("status");
        expect(response.ok).toBe(true);
        expect(response.result).toMatchObject({
            role: "encoder",
            state: { autostart: false },
            modules: { encoder: { enabled: true } },
        });
        expect(response.result).toHaveProperty("summary");
        expect(response.result?.state).toHaveProperty("encoder");
    });

    test("log.clear clears the persistent log", async () => {
        const clear = spyOn(eventlog, "clearLog").mockImplementation(() => {});
        restores.push(() => clear.mockRestore());
        const response = await request("log.clear");
        expect(response).toMatchObject({
            type: "response",
            id: "rpc-test",
            method: "log.clear",
            ok: true,
            result: { cleared: true },
        });
        expect(clear).toHaveBeenCalledTimes(1);
        expect(response).not.toHaveProperty("logged");
    });

    test("setup.get returns encoder resources on a non-encoder process", async () => {
        // The wizard lets the user pick any role, but the process role stays
        // what it started as (obs here). The encoder's setup step reads
        // `pipelines`/`audioSources` from this response, so they must be
        // present even when the encoder is not applicable to the process role.
        state.settings = { ...originalSettings, role: "obs" };
        const response = await request("setup.get");
        expect(response.ok).toBe(true);
        expect(Array.isArray(response.result?.pipelines)).toBe(true);
        expect(Array.isArray(response.result?.audioSources)).toBe(true);
    });

    test.each([
        ["obs", "pipelines.list"],
        ["obs", "ceracoder.set"],
        ["obs", "stream.start"],
        ["obs", "encoder.stop"],
        ["obs", "modems.enable"],
        ["obs", "ssh.status"],
    ] as const)(
        "rejects %s before invoking %s or logging",
        async (role, method) => {
            state.settings = { ...originalSettings, role };
            const log = silenceLog();
            expect(await request(method)).toEqual({
                type: "response",
                id: "rpc-test",
                method,
                ok: false,
                error: `${method} is not available on ${role} devices`,
                code: 409,
            });
            expect(log).not.toHaveBeenCalled();
        },
    );

    test.each(["obs.request", "obs.requestBatch", "lowBitrateSwitcher.save"])(
        "gates %s on the OBS module before validation",
        async (method) => {
            const modules = encoderDevice();
            modules[OBS].enabled = false;
            const response = await request(method);
            expect(response.code).toBe(409);
            expect(response).not.toHaveProperty("logged");
        },
    );

    test.each([
        [
            "encoder",
            "settings.update",
            { uuid: "changed" },
            "The device uuid can't be changed",
            false,
        ],
        [
            "encoder",
            "modems.enable",
            {},
            "index must be a non-negative integer",
            true,
        ],
        ["encoder", "pipelines.get", {}, "id is required", false],
        ["encoder", "pipelines.create", {}, "id is required", true],
        [
            "encoder",
            "encoder.bitrate",
            {},
            "maxBitrate or minBitrate is required",
            true,
        ],
        ["encoder", "stream.start", {}, "pipeline is required", true],
        ["encoder", "autostart.set", {}, "enabled must be a boolean", true],
        ["encoder", "modules.enable", {}, "id is required", true],
        ["encoder", "obs.request", {}, "requestType is required", false],
        [
            "encoder",
            "obs.requestBatch",
            {},
            "requests must be a non-empty array",
            false,
        ],
    ] satisfies [Status["role"], string, Params, string, boolean][])(
        "validates %s in the owning module and keeps the logged flag",
        async (role, method, params, error, logged) => {
            const modules = defaultModules(role);
            modules[OBS].enabled = true;
            state.settings = {
                ...originalSettings,
                role,
                language: "en",
                modules,
            };
            // Always differ from the supplied update, regardless of local config.
            state.settings.uuid = "original";
            const log = silenceLog();
            expect(await request(method, params)).toEqual({
                type: "response",
                id: "rpc-test",
                method,
                ok: false,
                error,
                code: 400,
                ...(logged ? { logged: true } : {}),
            });
            expect(log).toHaveBeenCalledTimes(logged ? 1 : 0);
        },
    );

    test("routes a module method to its owner's dispatch with the raw params", async () => {
        encoderDevice();
        const log = silenceLog();
        const modems = moduleById("modems");
        if (!modems) throw new Error("modems module missing");
        const dispatch = spyOn(modems, "dispatch").mockResolvedValue({
            modemIndex: 2,
            action: "enable",
            ok: false,
        });
        restores.push(() => dispatch.mockRestore());
        expect(await request("modems.enable", { index: "2" })).toEqual({
            type: "response",
            id: "rpc-test",
            method: "modems.enable",
            ok: true,
            result: { modemIndex: 2, action: "enable", ok: false },
            logged: true,
        });
        expect(dispatch).toHaveBeenCalledWith("modems.enable", { index: "2" });
        expect(log).toHaveBeenCalledTimes(1);
    });

    test("unknown methods and unknown module ids are rejected", async () => {
        encoderDevice();
        expect((await request("nope.method")).code).toBe(404);
        const response = await request("modules.enable", { id: "nope" });
        expect(response).toMatchObject({
            ok: false,
            error: "Unknown module: nope",
        });
    });
});

describe("encoder parameter parsing", () => {
    test("validates bitrates in start order versus live-update order", () => {
        encoderDevice();
        const params = { minBitrate: "bad-min", maxBitrate: "bad-max" };
        expect(() => parseBitrates(params)).toThrow(
            "maxBitrate must be an integer",
        );
        expect(() => parseBitrates(params, true)).toThrow(
            "minBitrate must be an integer",
        );
        expect(() =>
            parseBitrates({ minBitrate: 2000, maxBitrate: 1000 }),
        ).toThrow("minBitrate must not exceed maxBitrate");
    });

    test("uses the saved encoder config as the defaults", () => {
        encoderDevice();
        const config = {
            pipeline: "saved",
            host: "old-host",
            port: "9000",
            minBitrate: 1000,
            maxBitrate: 4000,
            latency: 500,
            delay: -100,
            streamid: "old-stream",
            audioSource: "saved-source",
            audioCodec: "opus" as const,
            bitrateOverlay: true,
        };
        state.data = { ...originalData, encoder: config };
        expect(
            parseEncoderConfig(
                { pipeline: "new", streamid: "", audioSource: "" },
                "host",
                "1234",
            ),
        ).toEqual({
            ...config,
            pipeline: "new",
            host: "host",
            port: "1234",
            streamid: undefined,
        });
    });
});
