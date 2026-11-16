/*
 * Schema validation for merged install specs. Runs after the merge (which
 * already enforces version equality) and before any host mutation, so typos
 * like `familly` are caught before touching the box.
 *
 * The JSON schema (`schema.json`) is the source of truth; this file is a
 * tiny, dependency-free evaluator for the subset of draft-2020-12 keywords
 * the schema uses (`type`, `properties`, `additionalProperties`, `required`,
 * `items`, `prefixItems`, `const`, `enum`, `pattern`, `minLength`, `minItems`,
 * `oneOf`, `allOf` +
 * `if`/`then`). It has no third-party deps so it runs in every Bun version
 * and under `bun test` without extra setup.
 */
import { InstSpecError } from "./merge";
import schemaJson from "./schema.json";
import type { ModuleInstallSpec } from "./types";

type Schema = Record<string, unknown>;

const KEYWORDS = new Set([
    "$schema",
    "$id",
    "title",
    "type",
    "properties",
    "additionalProperties",
    "required",
    "items",
    "prefixItems",
    "const",
    "enum",
    "pattern",
    "minLength",
    "minItems",
    "oneOf",
    "allOf",
]);

/** The result of a single spec validation: issues with JSON paths. */
export interface ValidationIssue {
    path: string;
    message: string;
}

function typeOf(value: unknown): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    if (typeof value === "number") return "number";
    return typeof value;
}

/**
 * Validate `value` against `schema`, appending to `issues`. `path` is the
 * current JSON pointer (for readable errors). Only the keywords in KEYWORDS
 * are understood; anything else is ignored (the schema uses no others).
 */
function check(value: unknown, schema: Schema, path: string, issues: ValidationIssue[]): void {
    if (schema.type !== undefined) {
        const t = schema.type as string;
        const ok = t === "number" ? typeof value === "number" : typeOf(value) === t;
        if (!ok) {
            issues.push({ path, message: `expected type ${t}, got ${typeOf(value)}` });
            return; // type mismatch: sub-checks are meaningless
        }
    }

    if (schema.const !== undefined && value !== schema.const)
        issues.push({ path, message: `must be ${JSON.stringify(schema.const)}` });

    if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value as never))
        issues.push({ path, message: `must be one of ${JSON.stringify(schema.enum)}` });

    if (typeof schema.pattern === "string" && typeof value === "string") {
        if (!new RegExp(schema.pattern).test(value))
            issues.push({ path, message: `does not match pattern ${schema.pattern}` });
    }

    if (typeof schema.minLength === "number" && typeof value === "string") {
        if (value.length < schema.minLength)
            issues.push({ path, message: `must be at least ${schema.minLength} chars` });
    }

    if (typeof schema.minItems === "number" && Array.isArray(value)) {
        if (value.length < schema.minItems)
            issues.push({ path, message: `must have at least ${schema.minItems} items` });
    }

    if (Array.isArray(schema.oneOf)) {
        const branches = schema.oneOf as Schema[];
        if (
            !branches.some((b) => {
                const sub: ValidationIssue[] = [];
                check(value, b, path, sub);
                return sub.length === 0;
            })
        )
            issues.push({ path, message: "does not match any oneOf branch" });
    }

    if (Array.isArray(schema.allOf)) {
        for (const branch of schema.allOf as Schema[]) {
            const ifSchema = (branch as { if?: Schema }).if;
            const thenSchema = (branch as { then?: Schema }).then;
            if (ifSchema) {
                const cond: ValidationIssue[] = [];
                check(value, ifSchema, path, cond);
                if (cond.length === 0 && thenSchema) check(value, thenSchema, path, issues);
            }
        }
    }

    if (typeOf(value) === "object") {
        const props = (schema.properties ?? {}) as Record<string, Schema>;
        const required = (schema.required ?? []) as string[];
        const obj = value as Record<string, unknown>;
        for (const key of required)
            if (obj[key] === undefined)
                issues.push({ path: `${path}/${key}`, message: "is required" });
        for (const [key, val] of Object.entries(obj)) {
            if (val === undefined) continue; // JSON never has undefined; treat as absent
            if (props[key] !== undefined) check(val, props[key], `${path}/${key}`, issues);
            else if (schema.additionalProperties === false)
                issues.push({ path: `${path}/${key}`, message: "unknown key" });
            else if (typeof schema.additionalProperties === "object" && schema.additionalProperties !== null)
                check(val, schema.additionalProperties as Schema, `${path}/${key}`, issues);
        }
    }

    if (Array.isArray(value)) {
        const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems as Schema[] : [];
        for (let i = 0; i < Math.min(prefix.length, value.length); i++)
            check(value[i], prefix[i], `${path}/${i}`, issues);
        if (schema.items !== undefined) {
            for (let i = prefix.length; i < value.length; i++)
                check(value[i], schema.items as Schema, `${path}/${i}`, issues);
        }
    }
}

/** Validate without throwing; returns a (possibly empty) issue list. */
export function validateSpecDetailed(spec: unknown): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    check(spec, schemaJson as unknown as Schema, "", issues);
    return issues;
}

/**
 * Validate a (merged) spec. Throws `InstSpecError` listing every issue on
 * failure; returns the same spec on success.
 */
export function validateSpec(spec: unknown): ModuleInstallSpec {
    const issues = validateSpecDetailed(spec);
    if (issues.length) {
        const detail = issues.map((i) => `  ${cleanPath(i.path)} ${i.message}`).join("\n");
        throw new InstSpecError(`invalid install spec:\n${detail}`);
    }
    return spec as ModuleInstallSpec;
}

/** `/foo/0/bar` -> `.foo[0].bar` for readable messages. */
function cleanPath(pointer: string): string {
    if (!pointer) return "(root)";
    return pointer
        .split("/")
        .filter(Boolean)
        .map((seg) => (seg.match(/^\d+$/) ? `[${seg}]` : `.${seg}`))
        .join("");
}
