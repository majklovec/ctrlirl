/*
 * Tests for the streamdeck module: registration invariants, the dependency
 * preflight (headless host → a non-fatal `ok: false`), `start()` degradation
 * without hardware, and — through the `__setDeckFactories` test seam — a fake
 * deck whose HID down/up events become `streamdeck.press`/`streamdeck.release`
 * pushes and `streamdeck.events` capability callbacks.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { state } from "../client/backend/state";
import type { ModuleCore } from "../client/backend/module_core";
import streamdeckModule, {
    __setDeckFactories,
    streamdeckEvents,
} from "../client/modules/streamdeck/backend";
import type { Emit, ModuleStartContext } from "../shared/contracts/backend_module";

interface DeckInfo {
    path: string;
    model: string;
}

const originalSettings = state.settings;
const restores: (() => void)[] = [];

/** Swap the hardware factories for a fake deck and restore them afterwards. */
function fakeDeck(
    keyCount = 5,
    model = "Fake Deck",
): {
    closed: boolean;
    model: string;
    keyCount: number;
    down: (key: number) => void;
    up: (key: number) => void;
    on(event: "down" | "up", listener: (key: number) => void): void;
    close(): Promise<void>;
} {
    const listeners: { down: Array<(k: number) => void>; up: Array<(k: number) => void> } =
        { down: [], up: [] };
    const deck = {
        closed: false,
        model,
        keyCount,
        on(event: "down" | "up", listener: (key: number) => void) {
            listeners[event].push(listener);
        },
        close: async () => {
            deck.closed = true;
        },
        down: (key: number) => listeners.down.forEach((fn) => fn(key)),
        up: (key: number) => listeners.up.forEach((fn) => fn(key)),
    };
    __setDeckFactories(
        async (): Promise<DeckInfo[]> => [{ path: "fake-usb", model }],
        async () => deck,
    );
    restores.push(() =>
        __setDeckFactories(
            async () => [],
            async () => {
                throw new Error("deck factories restored before start");
            },
        ),
    );
    return deck;
}

afterEach(async () => {
    for (const restore of restores.splice(0).reverse()) restore();
    // Reset the module's open-deck handle so a failure mid-test can't leak a
    // connected deck into the next test.
    try {
        await streamdeckModule.stop?.();
    } catch {
        // stop() must not throw; ignore.
    }
    state.settings = originalSettings;
});

function withEnabledStreamDeck() {
    state.settings = {
        ...originalSettings,
        role: "encoder",
        language: "en",
        modules: {
            ...(originalSettings.modules ?? {}),
            streamdeck: { enabled: true },
        },
    };
}

/** The core bag as the streamdeck module sees it (it only reads
 * `state`, `notifyStateChange` and `logEvent`; a stub avoids pulling the
 * full server core into a unit test). */
const stubCore: ModuleCore = {
    state,
    notifyStateChange: () => {},
    logEvent: () => {},
} as unknown as ModuleCore;

function makeCtx(emit: Emit): ModuleStartContext<ModuleCore> {
    return {
        config: {},
        emit,
        log: () => {},
        core: stubCore,
    } as ModuleStartContext<ModuleCore>;
}

describe("registration invariants", () => {
    test("a device module with press/release events and no RPC methods", () => {
        expect(streamdeckModule.kind).toBe("device");
        expect(streamdeckModule.id).toBe("streamdeck");
        expect(streamdeckModule.events).toEqual([
            "streamdeck.press",
            "streamdeck.release",
        ]);
        expect(streamdeckModule.methods ?? []).toEqual([]);
        expect(streamdeckModule.titleKey).toBe("streamdeck.title");
    });
});

describe("dependency preflight", () => {
    test("no deck attached → ok:false with a message key (non-fatal)", async () => {
        __setDeckFactories(async () => [], async () => {
            throw new Error("no deck to open");
        });
        expect(await streamdeckModule.checkDependencies?.()).toEqual({
            ok: false,
            messageKey: "streamdeck.deps_none",
        });
    });

    test("a failing scan → ok:false with an error key (non-fatal)", async () => {
        __setDeckFactories(
            async () => {
                throw new Error("HID not available");
            },
            async () => {
                throw new Error("no deck to open");
            },
        );
        expect(await streamdeckModule.checkDependencies?.()).toEqual({
            ok: false,
            messageKey: "streamdeck.deps_error",
        });
    });

    test("a deck present → ok:true", async () => {
        fakeDeck();
        expect(await streamdeckModule.checkDependencies?.()).toEqual({ ok: true });
    });
});

describe("start/stop", () => {
    test("without hardware start() idles gracefully and reports disconnected", async () => {
        withEnabledStreamDeck();
        // The real scan finds no deck headless; start() must log, not throw.
        await streamdeckModule.start(makeCtx(() => {}));
        const fragment = (await streamdeckModule.status?.()) as Record<
            string,
            { connected: boolean; model: string | null }
        >;
        expect(fragment.streamdeck.connected).toBe(false);
        expect(fragment.streamdeck.model).toBeNull();
        await streamdeckModule.stop?.();
    });

    test("a fake deck emits press/release events and feeds the capability", async () => {
        withEnabledStreamDeck();
        const deck = fakeDeck();
        const emitted: Array<[string, { key: number; timestamp: number }]> = [];
        const ctx = makeCtx((event, data) =>
            emitted.push([event, data as { key: number; timestamp: number }]),
        );
        await streamdeckModule.start(ctx);

        const status = (await streamdeckModule.status?.()) as Record<
            string,
            { connected: boolean; model: string; keyCount: number }
        >;
        expect(status.streamdeck).toMatchObject({
            connected: true,
            model: "Fake Deck",
            keyCount: 5,
        });

        const presses: number[] = [];
        const releases: number[] = [];
        const offPress = streamdeckEvents.onPress((key) => presses.push(key));
        const offRelease = streamdeckEvents.onRelease((key) =>
            releases.push(key),
        );

        deck.down(3);
        deck.up(3);
        expect(emitted).toEqual([
            ["streamdeck.press", expect.objectContaining({ key: 3 })],
            ["streamdeck.release", expect.objectContaining({ key: 3 })],
        ]);
        for (const data of emitted) expect(data[1].timestamp).toBeGreaterThan(0);
        expect(presses).toEqual([3]);
        expect(releases).toEqual([3]);

        offPress();
        offRelease();
        deck.down(4);
        expect(presses).toEqual([3]); // unsubscribed listeners stay quiet

        // A throwing subscriber must not break the deck or its peers.
        const healthy: number[] = [];
        const offHealthy = streamdeckEvents.onPress((key) => healthy.push(key));
        const offBroken = streamdeckEvents.onPress(() => {
            throw new Error("subscriber boom");
        });
        deck.down(7);
        offBroken();
        offHealthy();
        expect(healthy).toEqual([7]);

        await streamdeckModule.stop?.();
        expect(deck.closed).toBe(true);
        expect(
            ((await streamdeckModule.status?.()) as Record<string, { connected: boolean }>).streamdeck.connected,
        ).toBe(false);
    });

    test("a disabled slice keeps the module idle", async () => {
        state.settings = {
            ...originalSettings,
            role: "encoder",
            modules: { streamdeck: { enabled: false } },
        };
        let opened = false;
        __setDeckFactories(
            async () => [{ path: "fake-usb", model: "Fake Deck" }],
            async () => {
                opened = true;
                throw new Error("must not open a deck while disabled");
            },
        );
        restores.push(() =>
            __setDeckFactories(async () => [], async () => {
                throw new Error("restored");
            }),
        );
        await streamdeckModule.start(makeCtx(() => {}));
        expect(opened).toBe(false);
        const fragment = (await streamdeckModule.status?.()) as Record<
            string,
            { connected: boolean }
        >;
        expect(fragment.streamdeck.connected).toBe(false);
        await streamdeckModule.stop?.();
    });
});
