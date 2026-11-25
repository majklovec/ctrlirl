/*
 * streamdeck module: reads Elgato Stream Deck button presses over USB HID and
 * exposes them two ways — as pushed events (`streamdeck.press` /
 * `streamdeck.release`) for the dashboards, and as the `streamdeck.events`
 * capability so other modules (encoder, obs, …) can react to a physical press
 * without knowing about the hardware.
 *
 * Self-contained: the only core edge is the `core` bag handed in at start. The
 * hardware SDK (@elgato-stream-deck/node) is imported lazily so discovering the
 * module never pulls in the native HID binding, and `start()` degrades to an
 * idle (logged) state when no deck is present — a missing deck must never break
 * the streaming pipeline.
 */
import type {
    BackendModule,
    ModuleDependencies,
    Params,
    Emit,
} from "../../../shared/contracts/backend_module";
import { errorMessage } from "../../../shared/util";
import type { ModuleCore } from "../../backend/module_core";
import log from "./log";
import type {
    StreamDeckKeyEvent,
    StreamDeckSlice,
    StreamDeckStatus,
} from "./types";

const MODULE_ID = "streamdeck";

/** A discovered deck (the node SDK's `StreamDeckDeviceInfo`, reduced). */
interface DeckInfo {
    path: string;
    model: string;
}

/** The open deck handle this module drives (a thin view over the SDK's `StreamDeck`). */
interface DeckHandle {
    model: string;
    keyCount: number;
    on(event: "down" | "up", listener: (keyIndex: number) => void): void;
    close(): Promise<void>;
}

/** The hardware seam. The real factories wrap the SDK; tests swap in fakes. */
let listDecks: () => Promise<DeckInfo[]>;
let openDeck: (path: string) => Promise<DeckHandle>;

const realList = async (): Promise<DeckInfo[]> => {
    const sdk = await import("@elgato-stream-deck/node");
    return (await sdk.listStreamDecks()).map((d) => ({
        path: d.path,
        model: d.modelInfo?.name ?? (d.model as unknown as string),
    }));
};

const realOpen = async (path: string): Promise<DeckHandle> => {
    const sdk = await import("@elgato-stream-deck/node");
    const deck = await sdk.openStreamDeck(path);
    return {
        model: deck.modelInfo?.name ?? (deck.MODEL as unknown as string),
        keyCount: deck.modelInfo?.controls?.length ?? deck.CONTROLS.length,
        on: (event, listener) => deck.on(event, (control) => listener(control.index)),
        close: () => deck.close(),
    };
};

listDecks = realList;
openDeck = realOpen;

/**
 * Test seam: swap the hardware factories (a fake deck that emits down/up
 * without USB). The core bag is bound separately at start.
 */
export const __setDeckFactories = (
    list: () => Promise<DeckInfo[]>,
    open: (path: string) => Promise<DeckHandle>,
): void => {
    listDecks = list;
    openDeck = open;
};

/** Core bag, bound at discovery and re-filled at start (a module never imports the core). */
let core: ModuleCore;

let emit: Emit | undefined;
let deck: DeckHandle | undefined;
let lastPress: StreamDeckKeyEvent | null = null;
let lastRelease: StreamDeckKeyEvent | null = null;

/** This module's settings slice (created by the core from `configDefaults`). */
const slice = (): StreamDeckSlice | undefined =>
    core.state.settings.modules?.[MODULE_ID] as StreamDeckSlice | undefined;

// --- the `streamdeck.events` capability --------------------------------------
// Other modules subscribe to a physical press/release without naming the
// streamdeck module; listeners are invoked by the deck's HID events.
type KeyListener = (key: number) => void;
const pressListeners = new Set<KeyListener>();
const releaseListeners = new Set<KeyListener>();

const notify = (listeners: Set<KeyListener>, key: number): void => {
    for (const fn of [...listeners]) {
        try {
            fn(key);
        } catch (err) {
            // A failing subscriber must not break the deck or its peers.
            try {
                core?.logEvent(
                    "warn",
                    "Stream Deck",
                    `subscriber failed: ${errorMessage(err)}`,
                );
            } catch {
                // core not bound yet — nothing to log to.
            }
        }
    }
};

export const streamdeckEvents = {
    /** Subscribe to key presses; returns an unsubscribe function. */
    onPress: (fn: KeyListener) => {
        pressListeners.add(fn);
        return () => pressListeners.delete(fn);
    },
    /** Subscribe to key releases; returns an unsubscribe function. */
    onRelease: (fn: KeyListener) => {
        releaseListeners.add(fn);
        return () => releaseListeners.delete(fn);
    },
};

const registration: BackendModule<ModuleCore> = {
    kind: "device",
    id: MODULE_ID,
    title: "Stream Deck",
    titleKey: "streamdeck.title",
    configDefaults: {},
    events: ["streamdeck.press", "streamdeck.release"],
    methods: [],
    log,
    services: {
        capabilities: {
            "streamdeck.events": streamdeckEvents,
        },
    },
    bind(c) {
        core = c;
    },
    async start(ctx) {
        core = ctx.core;
        emit = ctx.emit;
        if (slice()?.enabled !== true) return;

        let infos: DeckInfo[];
        try {
            infos = await listDecks();
        } catch (err) {
            ctx.log(MODULE_ID, `Failed to scan for a Stream Deck: ${errorMessage(err)}`);
            return;
        }
        if (infos.length === 0) {
            ctx.log(MODULE_ID, "No Stream Deck found; module idle");
            return;
        }
        try {
            deck = await openDeck(infos[0].path);
        } catch (err) {
            ctx.log(MODULE_ID, `Failed to open the Stream Deck: ${errorMessage(err)}`);
            return;
        }
        ctx.log(MODULE_ID, `Connected to ${deck.model} (${deck.keyCount} keys)`);

        deck.on("down", (key) => {
            lastPress = { key, timestamp: Date.now() };
            emit?.("streamdeck.press", { key, timestamp: lastPress.timestamp });
            notify(pressListeners, key);
        });
        deck.on("up", (key) => {
            lastRelease = { key, timestamp: Date.now() };
            emit?.("streamdeck.release", { key, timestamp: lastRelease.timestamp });
            notify(releaseListeners, key);
        });
        core.notifyStateChange();
    },
    async stop() {
        if (deck) {
            await deck.close().catch(() => {});
            deck = undefined;
        }
        emit = undefined;
    },
    /** Modules panel preflight: is a Stream Deck present? */
    async checkDependencies(): Promise<ModuleDependencies> {
        let infos: DeckInfo[];
        try {
            infos = await listDecks();
        } catch {
            return { ok: false, messageKey: "streamdeck.deps_error" };
        }
        return infos.length > 0
            ? { ok: true }
            : { ok: false, messageKey: "streamdeck.deps_none" };
    },
    async status(): Promise<Record<string, unknown>> {
        const fragment: StreamDeckStatus = {
            connected: deck !== undefined,
            model: deck?.model ?? null,
            keyCount: deck?.keyCount ?? 0,
            lastPress,
            lastRelease,
        };
        return { streamdeck: fragment };
    },
    // No RPC methods: a pure input module. The core never routes a method here.
    async dispatch(method: string): Promise<unknown> {
        throw new Error(`streamdeck has no method ${method} (params ignored)`);
    },
};

export default registration;
