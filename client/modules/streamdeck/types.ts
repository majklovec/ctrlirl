/*
 * Local types for the streamdeck module (never imported by the core or other modules).
 */

/** The persisted configuration slice of the streamdeck module (`modules.streamdeck`).
 * The module is zero-config: only the enabled flag matters. */
export interface StreamDeckSlice {
    enabled: boolean;
    [field: string]: unknown;
}

/** One key press/release as published on `streamdeck.press` / `streamdeck.release`. */
export interface StreamDeckKeyEvent {
    /** The key index the operator pressed (0-based, per the deck's layout). */
    key: number;
    /** When the event fired (epoch millis). */
    timestamp: number;
}

/** Live streamdeck state (the status `streamdeck` fragment). */
export interface StreamDeckStatus {
    /** A deck is open and reading HID input. */
    connected: boolean;
    /** The connected deck's model name (null when not connected). */
    model: string | null;
    /** The number of keys on the connected deck (0 when not connected). */
    keyCount: number;
    /** The most recent press (null until one happens). */
    lastPress: StreamDeckKeyEvent | null;
    /** The most recent release (null until one happens). */
    lastRelease: StreamDeckKeyEvent | null;
}
