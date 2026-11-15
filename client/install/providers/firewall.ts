/*
 * firewall provider (handoff §9.3).
 *
 * Preferred: nftables per-module table `ctrlirl_<role>_<module>`. Chains and
 * rules are grouped and applied in a single `nft -f` batch (temp ruleset file,
 * so a parse failure changes nothing). The table is module-owned, so
 * re-install is an atomic delete+re-apply.
 *
 * Fallback: iptables — each rule is tagged `-m comment --comment
 * "ctrlirl:<role>:<module>:<hash>"`; uninstall lists the chain and deletes the
 * rules whose comment matches exactly.
 *
 * A module may not mix `nft` and `iptables` rules. An nft ruleset on a host
 * without a working nft is a hard error (never a silent no-op).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { run, type RunOpts } from "../host";
import type {
    DryArtifact,
    InstallProvider,
    ModuleCtx,
    StepKey,
    ProviderResult,
} from "../provider";
import type { FirewallRule } from "../../../shared/install/types";

const TABLE_RE = /^ctrlirl_[a-z0-9_-]+$/;
const FAM_RE = /^(inet|ip|ip6)$/;

export function firewallProvider(runOpts: RunOpts = {}): InstallProvider {
    const steps: StepKey[] = ["firewallInstall", "firewallUninstall"];
    return {
        name: "firewall",
        steps,
        async run(step, ctx): Promise<ProviderResult> {
            if (step === "firewallInstall") return fwInstall(ctx, runOpts);
            return fwUninstall(ctx, runOpts);
        },
        async dryRun(mode, ctx): Promise<DryArtifact[]> {
            const rules = ctx.spec.firewall ?? [];
            if (mode === "install")
                return rules.map((r) => ({
                    mark: "+" as const,
                    target:
                        r.tool === "nft"
                            ? nftTable(ctx, rules) ?? "nft"
                            : `${iptTarget(r).bin} -t ${iptTarget(r).table}`,
                    detail: r.chain,
                }));
            const fw = ctx.state.firewall;
            if (fw.type === "nft" && fw.table)
                return [
                    { mark: "-" as const, target: fw.table, detail: "delete table" },
                ];
            if (fw.type === "iptables" && fw.comments.length > 0)
                return [
                    {
                        mark: "-" as const,
                        target: "iptables",
                        detail: `${fw.comments.length} tagged rule(s)`,
                    },
                ];
            return [];
        },
    };
}

/* ── naming ─────────────────────────────────────────────────────────────── */

function nftFamily(rules: FirewallRule[]): string {
    if (rules.some((r) => r.family === "inet")) return "inet";
    if (rules.some((r) => r.family === "ip6")) return "ip6";
    if (rules.some((r) => r.family === "ip")) return "ip";
    return "inet";
}

function nftTable(ctx: ModuleCtx, rules: FirewallRule[]): string | null {
    const fam = nftFamily(rules);
    if (fam === "ip6")
        return null; // ip6 uses the ip6tables path (see iptTarget); nft ip6 tables unsupported here
    const t = `ctrlirl_${ctx.role}_${ctx.module}`;
    return TABLE_RE.test(t) ? t : null;
}

/** iptables binary + table for a rule (`filter` default; ip6 → ip6tables). */
function iptTarget(r: FirewallRule): { bin: string; table: string } {
    const bin = r.family === "ip6" ? "ip6tables" : "iptables";
    const table = r.family === "ip6" ? "filter" : (r.table ?? "filter");
    return { bin, table };
}

/** Deterministic 8-hex tag per rule so re-install yields the same comment. */
function hash(r: FirewallRule): string {
    return createHash("sha256")
        .update(`${r.tool}|${r.table ?? ""}|${r.chain}|${r.rule}`)
        .digest("hex")
        .slice(0, 8);
}

const comment = (ctx: ModuleCtx, r: FirewallRule): string =>
    `ctrlirl:${ctx.role}:${ctx.module}:${hash(r)}`;

/* ── install ────────────────────────────────────────────────────────────── */

async function nftAvailable(opts: RunOpts): Promise<boolean> {
    const res = await run("nft", ["list", "tables"], opts);
    return res.exitCode === 0;
}

async function fwInstall(ctx: ModuleCtx, opts: RunOpts): Promise<ProviderResult> {
    const rules = ctx.spec.firewall ?? [];
    if (rules.length === 0) return { changed: false, lines: [] };

    const tools = new Set(rules.map((r) => r.tool));
    if (tools.size > 1)
        throw new Error(
            `firewall: a module cannot mix nft and iptables rules (${[...tools].join(", ")})`,
        );

    if (rules[0].tool === "nft") return nftInstall(ctx, rules, opts);
    return iptablesInstall(ctx, rules, opts);
}

async function nftInstall(
    ctx: ModuleCtx,
    rules: FirewallRule[],
    opts: RunOpts,
): Promise<ProviderResult> {
    const fam = nftFamily(rules);
    if (fam === "ip6")
        throw new Error(
            "firewall: nft rules with family ip6 are not supported; declare tool: \"iptables\" for ip6 rules",
        );
    const table = `ctrlirl_${ctx.role}_${ctx.module}`;
    if (!TABLE_RE.test(table))
        throw new Error(`firewall: ${table} is not a valid nft table name`);

    // The table is module-owned and recorded in state → idempotent.
    if (ctx.state.firewall.type === "nft" && ctx.state.firewall.table === table)
        return {
            changed: false,
            lines: [`    ~ nft table ${table}  (unchanged, skip)`],
        };

    if (!(await nftAvailable(opts)))
        throw new Error(
            `firewall: nftables is required for table ${table} but \`nft list tables\` failed — install nftables or convert to tool: "iptables"`,
        );

    // Group by chain → one temp ruleset file → one atomic `nft -f` batch.
    const chains = new Map<string, FirewallRule[]>();
    for (const r of rules) {
        const list = chains.get(r.chain) ?? [];
        list.push(r);
        chains.set(r.chain, list);
    }
    const body: string[] = [`table ${fam} ${table} {`];
    for (const [chain, rs] of chains) {
        body.push(`    chain ${chain} {`, ...rs.map((r) => `        ${r.rule}`), "    }");
    }
    body.push("}");

    const dir = await mkdtemp(join(tmpdir(), "ctrlirl-nft-"));
    const file = join(dir, `${table}.nft`);
    try {
        await writeFile(file, body.join("\n") + "\n");
        // Module-owned table: delete-then-apply keeps re-install exact.
        const exists = await run("nft", ["list", "table", fam, table], opts);
        if (exists.exitCode === 0)
            await run("nft", ["delete", "table", fam, table], opts);
        const res = await run("nft", ["-f", file], opts);
        if (res.exitCode !== 0)
            throw new Error(`firewall: nft batch failed: ${res.stderr.trim()}`);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
    ctx.state.firewall = { type: "nft", table };
    return {
        changed: true,
        lines: [
            `    + nft table ${table}  (${rules.length} rule(s), ${chains.size} chain(s))`,
        ],
    };
}

async function iptablesInstall(
    ctx: ModuleCtx,
    rules: FirewallRule[],
    opts: RunOpts,
): Promise<ProviderResult> {
    const lines: string[] = [];
    const recorded = new Set(
        ctx.state.firewall.type === "iptables"
            ? ctx.state.firewall.comments
            : [],
    );
    let wrote = false;
    for (const r of rules) {
        const tag = comment(ctx, r);
        if (recorded.has(tag)) {
            lines.push(`    ~ ${r.chain}  (unchanged, skip)`);
            continue;
        }
        const { bin, table } = iptTarget(r);
        const res = await run(
            bin,
            ["-t", table, "-A", r.chain, r.rule, "-m", "comment", "--comment", tag],
            opts,
        );
        if (res.exitCode !== 0)
            throw new Error(`firewall: ${bin} append failed: ${res.stderr.trim()}`);
        recorded.add(tag);
        wrote = true;
        lines.push(`    + ${table}/${r.chain}  (tag ${tag})`);
    }
    if (wrote) ctx.state.firewall = { type: "iptables", comments: [...recorded] };
    return { changed: wrote, lines };
}

/* ── uninstall ──────────────────────────────────────────────────────────── */

async function fwUninstall(
    ctx: ModuleCtx,
    opts: RunOpts,
): Promise<ProviderResult> {
    const lines: string[] = [];
    const fw = ctx.state.firewall;

    if (fw.type === "nft" && fw.table) {
        // exit 2 = "table does not exist" — the goal state, so not an error.
        const res = await run("nft", ["delete", "table", "inet", fw.table], opts);
        if (res.exitCode !== 0 && res.exitCode !== 2)
            console.warn(
                `firewall: nft delete table ${fw.table}: ${res.stderr.trim()}`,
            );
        ctx.state.firewall = { type: "nft", table: "" };
        lines.push(`    - nft table ${fw.table}`);
        return { changed: true, lines };
    }

    if (fw.type === "iptables" && fw.comments.length > 0) {
        let removed = 0;
        for (const tag of fw.comments) {
            removed += await deleteTagged(ctx, tag, opts);
        }
        ctx.state.firewall = { type: "iptables", comments: [] };
        lines.push(`    - iptables tagged rule(s) removed (${removed})`);
        return { changed: removed > 0, lines };
    }

    return { changed: false, lines: [] };
}

/**
 * Delete every iptables rule whose comment equals `tag`. The owning
 * binary/table/chain(s) are recovered from the spec rules that produce this
 * tag; each is listed with `-S` and the matching positions deleted (highest
 * first, so indices stay valid).
 */
async function deleteTagged(
    ctx: ModuleCtx,
    tag: string,
    opts: RunOpts,
): Promise<number> {
    const targets = new Map<string, { bin: string; table: string; chain: string }>();
    for (const r of ctx.spec.firewall ?? []) {
        if (comment(ctx, r) !== tag) continue;
        const t = iptTarget(r);
        targets.set(`${t.bin}\t${t.table}\t${r.chain}`, {
            bin: t.bin,
            table: t.table,
            chain: r.chain,
        });
    }
    let removed = 0;
    for (const t of targets.values()) {
        const res = await run(t.bin, ["-t", t.table, "-S", t.chain], opts);
        if (res.exitCode !== 0) continue;
        // Line 0 is the chain policy; rule i (1-based) is the following line i.
        const rules = res.stdout
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.startsWith("-A"));
        const nums = rules
            .map((line, i) =>
                line.includes(`--comment ${tag}`) ? i + 1 : -1,
            )
            .filter((n) => n > 0);
        for (const num of [...nums].reverse()) {
            const del = await run(t.bin, ["-t", t.table, "-D", t.chain, `${num}`], opts);
            if (del.exitCode === 0) removed++;
        }
    }
    return removed;
}
