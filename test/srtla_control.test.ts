/** Adapters for the `srtla_send` control-socket liveness probe (adoption). */
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SrtlaControlSocket } from "../shared/srtla";

const SOCKET_PATH = join(tmpdir(), `srtla_ctrltest.${process.pid}.sock`);

let server: Bun.Server | null = null;
let cleanup = () => {};

afterAll(() => {
    cleanup();
    try {
        server?.stop(true);
    } catch {}
});

/** A fake `srtla_send` that answers any JSON-RPC line with a result. */
function serveFakeSender(): void {
    cleanup = () => {};
    server = Bun.listen({
        unix: SOCKET_PATH,
        socket: {
            data(s, chunk) {
                const text = chunk.toString().trim();
                if (!text) return;
                s.write(
                    `${JSON.stringify({
                        jsonrpc: "2.0",
                        id: 1,
                        result: { pong: true },
                    })}\n`,
                );
                s.end();
            },
            close() {},
            error() {},
        },
    });
}

describe("srtla control socket probe", () => {
    test("rejects when no srtla_send is listening", async () => {
        const c = new SrtlaControlSocket();
        expect(await c.probe(SOCKET_PATH, 400)).toBe(false);
    });

    test("succeeds against a live control socket", async () => {
        serveFakeSender();
        // Bun.listen is async-ready; a microtask flush is enough
        await new Promise((r) => setTimeout(r, 20));
        const c = new SrtlaControlSocket();
        expect(await c.probe(SOCKET_PATH, 1500)).toBe(true);
    });
});
