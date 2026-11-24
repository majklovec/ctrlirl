Adding physical Stream Deck support to ctrlirl aligns perfectly with its modular architecture. The cleanest approach is to create a new **device module** that runs on the streaming box, reads button presses from the Stream Deck via USB HID, and exposes those inputs as capabilities on the capability bus. This way, any other module (like `encoder` or `obs`) can react to Stream Deck presses without knowing about the hardware directly.

The repository already has a **virtual** Stream Deck widget (`server/modules/deck`) for the dashboard, but no physical device integration. The plan below follows the module contract and the capability bus pattern described in the project's documentation.

---

## 📋 Overview of the New Module

| Aspect                    | Details                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Location**              | `client/modules/streamdeck/` (new directory)                                                                                                                                                |
| **Kind**                  | `device` (runs on the streaming box)                                                                                                                                                        |
| **Purpose**               | Read button events from an Elgato Stream Deck and expose them as capabilities (e.g., `streamdeck.pressed`, `streamdeck.released`). Optionally write feedback (icons/text) back to the Deck. |
| **Dependencies**          | A USB-HID library compatible with Bun. `@elgato-stream-deck/core` is a strong candidate because it works with Bun and supports multiple Stream Deck models.                                 |
| **Role**                  | Add the module to the `encoder` role (or create a new role) so it starts with the streaming pipeline.                                                                                       |
| **Capabilities provided** | `streamdeck.events` (button press/release events)                                                                                                                                           |
| **Capabilities consumed** | Possibly `stream.encoder` or `obs.events` to update button displays, but not strictly required for basic input.                                                                             |

---

## 🛠️ Step‑by‑Step Implementation

### 1. Create the Module Directory

```bash
mkdir -p client/modules/streamdeck
```

### 2. Add the USB-HID Dependency

Install the Stream Deck library. Because the project uses Bun, add it to `package.json`:

```bash
bun add @elgato-stream-deck/core
```

> **Linux note:** You will need udev rules to access the device without root. A common setup is to create `/etc/udev/rules.d/60-streamdeck.rules` with the appropriate VID/PID rules. The library’s documentation usually provides these.

### 3. Implement `backend.ts` (the Module Registration)

Below is a **skeleton** `backend.ts` that discovers the Stream Deck, listens for button events, and emits them onto the capability bus. It follows the `BackendModule` contract (see `shared/contracts/backend_module.ts`).

```ts
// client/modules/streamdeck/backend.ts
import type {
    BackendModule,
    Emit,
} from "../../../shared/contracts/backend_module";
import { StreamDeck } from "@elgato-stream-deck/core";

let deck: StreamDeck | undefined;
let emit: Emit | undefined;

const registration: BackendModule = {
    kind: "device",
    id: "streamdeck",
    title: "Stream Deck",
    dependencies: [], // no hard dependencies on other modules
    methods: [], // no RPC methods needed for basic input
    events: ["streamdeck.press", "streamdeck.release"], // events we emit

    async start(ctx) {
        emit = ctx.emit;

        // Discover and open the first connected Stream Deck
        const devices = await StreamDeck.discover();
        if (devices.length === 0) {
            ctx.log("streamdeck", "No Stream Deck found");
            return;
        }

        deck = await StreamDeck.open(devices[0]);
        ctx.log("streamdeck", `Connected to ${deck.model}`);

        // Listen for button presses
        deck.on("down", (keyIndex) => {
            emit?.("streamdeck.press", {
                key: keyIndex,
                timestamp: Date.now(),
            });
        });

        deck.on("up", (keyIndex) => {
            emit?.("streamdeck.release", {
                key: keyIndex,
                timestamp: Date.now(),
            });
        });
    },

    async stop() {
        if (deck) {
            await deck.close();
            deck = undefined;
        }
        emit = undefined;
    },

    // No dispatch needed for a pure input module
    async dispatch(_method, _params) {
        throw new Error("streamdeck module has no RPC methods");
    },
};

export default registration;
```

#### Key points

-   **`kind: "device"`** – the module runs on the streaming box.
-   **`events`** – declares the event names it will emit (`streamdeck.press`, `streamdeck.release`).
-   **`start()`** – opens the hardware, binds listeners, and uses `ctx.emit` to publish events on the capability bus.
-   **`stop()`** – cleanly releases the USB device.
-   **No `dispatch()`** – this module only _provides_ events; it does not accept RPC calls.

> If you later want to **update button displays** based on other modules (e.g., show the current scene on a button), you would consume a capability (like `obs.events`) inside `start()` and call `deck.setImage()` or `deck.setText()` accordingly.

### 4. (Optional) Add a `frontend.tsx`

If you want a card on the device page to show the connected Stream Deck model or a preview of buttons, create a `frontend.tsx` that exports a widget. However, for basic input support, this is not required.

### 5. Register the Module in the Role

Roles are declarative lists of modules. To make the Stream Deck module part of the encoder setup, edit `client/roles/encoder/role.json` and add `"streamdeck"` to the modules array.

**Before (example):**

```json
{
    "name": "encoder",
    "modules": ["encoder", "network", "srtla", "modems", "obs"]
}
```

**After:**

```json
{
    "name": "encoder",
    "modules": ["encoder", "network", "srtla", "modems", "obs", "streamdeck"]
}
```

Alternatively, create a new role (e.g., `streamdeck_operator`) if you want to keep the hardware separate from the main encoder role.

### 6. Consume the Events (Example: OBS Scene Switcher)

Now that `streamdeck.press` events are on the capability bus, any module can react to them. For instance, you could extend the `obs` module to listen for `streamdeck.press` and switch scenes:

```ts
// pseudo-code inside obs/backend.ts
core.bus.on("streamdeck.press", ({ key }) => {
    const sceneIndex = key; // map key numbers to scenes
    switchScene(sceneIndex);
});
```

Because the capability bus is decoupled, the `obs` module never needs to know that a physical Stream Deck exists—it only listens for the event name.

---

## 📝 Important Considerations

1. **USB Permissions on Linux** – Without proper udev rules, the process may not be able to open the HID device. The `@elgato-stream-deck` documentation provides the required VID/PID rules. Ensure the user running the ctrlirl client has access to the device (often by adding them to the `plugdev` group and installing a udev rule).

2. **Multiple Stream Deck Models** – `@elgato-stream-deck/core` supports Original, Mini, XL, and Plus models. The discovery step returns the first connected device; you can extend the code to choose a specific model or handle multiple decks.

3. **Error Handling** – The skeleton omits try/catch blocks for brevity. In production, wrap `discover()` and `open()` in try/catch and log failures gracefully so the rest of the pipeline can continue without the Deck.

4. **Bun Compatibility** – The library is known to work with Bun (as of recent versions). If you encounter native module issues, verify that the Bun version matches the library’s requirements.

5. **Virtual vs. Physical Deck** – The existing `server/modules/deck` is a **virtual** Stream Deck for the dashboard. The new `client/modules/streamdeck` is a **physical** input module. They complement each other; the virtual deck can still be used when no physical hardware is present.

---

## ✅ Summary

| Step | Action                                                                                |
| ---- | ------------------------------------------------------------------------------------- |
| 1    | Create `client/modules/streamdeck/`                                                   |
| 2    | Add `@elgato-stream-deck/core` to dependencies                                        |
| 3    | Implement `backend.ts` with `kind: "device"`, event listeners, and `ctx.emit`         |
| 4    | (Optional) Build a `frontend.tsx` for UI feedback                                     |
| 5    | Add `"streamdeck"` to the `encoder` role (or a new role)                              |
| 6    | Consume `streamdeck.press`/`streamdeck.release` events in other modules (e.g., `obs`) |

This approach keeps the Stream Deck integration **isolated**, **replaceable**, and **consistent** with ctrlirl’s module system, while leveraging the existing capability bus to wire button presses to any streaming action you need.
