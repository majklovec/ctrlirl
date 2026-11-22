import { alias } from "drizzle-orm/sqlite-core";
import { desc, eq, sql } from "drizzle-orm";
import {
    randomBytes,
    randomUUID,
    scryptSync,
    timingSafeEqual,
} from "node:crypto";
import { text } from "../../../shared/http";
import { type AppDatabase, openDatabase } from "../db";
import { invitations, tokens, users } from "../schema";
import { LOCAL_PROJECT_ID, LOCAL_USER } from "../runtime";

export async function createAuth({
    noAuth,
    databaseFile,
}: {
    noAuth: boolean;
    databaseFile: string;
}) {
    const NO_AUTH = noAuth;
    const DB_FILE = databaseFile;

    // ----------------------------------------------------------------------
    // Auth (SQLite user store)
    // ----------------------------------------------------------------------
    /** scrypt password hash: `scrypt$<salt hex>$<hash hex>`. */
    function hashPassword(password: string): string {
        const salt = randomBytes(16).toString("hex");
        return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
    }
    /** Constant-time check of a password against a stored hash. */
    function verifyPassword(password: string, stored: string): boolean {
        const parts = stored.split("$");
        if (parts.length !== 3 || parts[0] !== "scrypt") return false;
        const expected = Buffer.from(parts[2], "hex");
        if (expected.length === 0) return false;
        return timingSafeEqual(
            scryptSync(password, parts[1], expected.length),
            expected,
        );
    }
    /** Hash only consumed by the login timing-equalizer below. */
    const DUMMY_PASSWORD_HASH = hashPassword("__padding__");

    /** The user database (null in `--no-auth` mode): logins with scrypt-hashed
     * passwords and the device tokens assigned to each user. */
    const db: AppDatabase | null = NO_AUTH
        ? null
        : await (async () => {
              const d = await openDatabase(DB_FILE);

              if (
                  (
                      d
                          .select({ n: sql<number>`count(*)` })
                          .from(users)
                          .get()?.n ?? 0
                  ) === 0
              ) {
                  console.log(
                      `[auth] the user database ${DB_FILE} has no users yet — create the first account at /register`,
                  );
              }
              return d;
          })();

    /**
     * Resolve the user for a presented device token. With `--no-auth` every
     * connection maps to the single local user.
     */
    function userForToken(token: string | null): string | null {
        if (NO_AUTH) return LOCAL_USER;
        if (!token || !db) return null;
        const row = db
            .select({ login: users.login })
            .from(tokens)
            .innerJoin(users, eq(tokens.userId, users.id))
            .where(eq(tokens.token, token))
            .get();
        return row?.login ?? null;
    }

    /**
     * Resolve the project for a presented device token (the `tokens.project_id`
     * column, back-filled by migration 0012). With `--no-auth` every
     * connection maps to the local user's Personal project so the same
     * project-scoped code path runs. `null` when the token is unknown.
     */
    function projectForToken(token: string | null): string | null {
        if (NO_AUTH) return LOCAL_PROJECT_ID;
        if (!token || !db) return null;
        const row = db
            .select({ projectId: tokens.projectId })
            .from(tokens)
            .where(eq(tokens.token, token))
            .get();
        return row?.projectId ?? null;
    }

    // Opaque cookie sessions: the browser stores a session id (HttpOnly), so
    // the user token never lives in JS storage and WebSocket upgrades inherit the
    // cookie automatically.
    const SESSION_COOKIE = "srtla_session";
    const sessions = new Map<string, string>(); // session id -> user

    function sessionCookie(req: Request): string | null {
        const raw = req.headers.get("cookie");
        if (!raw) return null;
        for (const part of raw.split(";")) {
            const idx = part.indexOf("=");
            if (idx > 0 && part.slice(0, idx).trim() === SESSION_COOKIE) {
                return part.slice(idx + 1).trim() || null;
            }
        }
        return null;
    }

    /** Resolve the user from the session cookie (or the local user in
     *  `--no-auth` mode). Null when unauthenticated. */
    function userFromRequest(req: Request): string | null {
        if (NO_AUTH) return LOCAL_USER;
        const id = sessionCookie(req);
        if (!id) return null;
        const user = sessions.get(id);
        if (!user) sessions.delete(id);
        return user ?? null;
    }

    const unauthorized = () => text("Authentication required", 401);

    /** Whether a login has the admin flag. `--no-auth` maps everything to the
     * full-privilege local user. */
    function adminOf(login: string): boolean {
        if (NO_AUTH) return true;
        if (!db) return false;
        const row = db
            .select({ admin: users.admin })
            .from(users)
            .where(eq(users.login, login))
            .get();
        return row?.admin ?? false;
    }

    /** Auth + admin guard: the session user's login, or a 401/403 Response. */
    function requireAdmin(req: Request): string | Response {
        const user = userFromRequest(req);
        if (!user) return unauthorized();
        if (!adminOf(user))
            return Response.json(
                { ok: false, error: "Forbidden" },
                { status: 403 },
            );
        return user;
    }

    /** Exchange a username + password for an opaque session cookie. */
    async function loginResponse(req: Request): Promise<Response> {
        let username: unknown;
        let password: unknown;
        try {
            const body = (await req.json()) as {
                username?: unknown;
                password?: unknown;
            };
            username = body.username;
            password = body.password;
        } catch {
            return Response.json(
                { ok: false, error: "Invalid JSON" },
                { status: 400 },
            );
        }
        let match: string | null = null;
        if (
            typeof username === "string" &&
            typeof password === "string" &&
            db
        ) {
            const rows = db
                .select({ login: users.login, password: users.password })
                .from(users)
                .all() as {
                login: string;
                password: string;
            }[];
            let checked = false;
            for (const row of rows) {
                if (row.login !== username) continue;
                if (verifyPassword(password, row.password)) match = row.login;
                checked = true;
                break;
            }
            // One dummy scrypt verify when no account matched, so timing does
            // not reveal which usernames exist.
            if (!checked) verifyPassword(password, DUMMY_PASSWORD_HASH);
        }
        if (!match)
            return Response.json(
                { ok: false, error: "Invalid username or password" },
                { status: 401 },
            );
        const user = match;
        const id = randomUUID();
        sessions.set(id, user);
        return Response.json(
            { ok: true, user },
            {
                headers: {
                    "set-cookie": `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax`,
                },
            },
        );
    }

    /** POST /api/register — create a new profile. The first-ever account is
     * bootstrapped as admin with no invite; every later account requires a valid,
     * single-use invitation code, which is consumed in the same transaction. The
     * new account has no device tokens yet; the user adds them on the profile
     * page after signing in. */
    async function registerResponse(req: Request): Promise<Response> {
        let username: unknown;
        let password: unknown;
        let invite: unknown;
        try {
            const body = (await req.json()) as {
                username?: unknown;
                password?: unknown;
                invite?: unknown;
            };
            username = body.username;
            password = body.password;
            invite = body.invite;
        } catch {
            return Response.json(
                { ok: false, error: "Invalid JSON" },
                { status: 400 },
            );
        }
        if (
            typeof username !== "string" ||
            typeof password !== "string" ||
            username.trim().length === 0 ||
            password.length < 8
        ) {
            return Response.json(
                {
                    ok: false,
                    error: "Username and an 8+ character password are required",
                },
                { status: 400 },
            );
        }
        if (!db)
            return Response.json(
                { ok: false, error: "Registration is disabled" },
                { status: 403 },
            );
        const clean = username.trim();
        const hash = hashPassword(password);

        // Bootstrap: the very first account becomes admin and needs no invite. The
        // guarded INSERT makes this atomic for concurrent first registrations —
        // the builder cannot express a guarded insert, so it stays raw on the
        // underlying driver.
        const bootstrap = db.$client
            .prepare(
                "INSERT INTO users (login, password, admin) SELECT ?, ?, 1 WHERE (SELECT COUNT(*) FROM users) = 0",
            )
            .run(clean, hash);
        if (bootstrap.changes > 0)
            return Response.json(
                { ok: true, user: clean, admin: true },
                { status: 201 },
            );

        // Everyone after the first account needs a valid, single-use invite.
        const code = typeof invite === "string" ? invite.trim() : "";
        if (!code)
            return Response.json(
                { ok: false, error: "Invitation code required" },
                { status: 403 },
            );

        const row = db
            .select({
                id: invitations.id,
                usedBy: invitations.usedBy,
                expiresAt: invitations.expiresAt,
            })
            .from(invitations)
            .where(eq(invitations.code, code))
            .get();
        if (!row)
            return Response.json(
                { ok: false, error: "Invalid invitation code" },
                { status: 403 },
            );
        if (row.usedBy !== null)
            return Response.json(
                { ok: false, error: "Invitation already used" },
                { status: 403 },
            );
        if (row.expiresAt && new Date(row.expiresAt) < new Date())
            return Response.json(
                { ok: false, error: "Invitation expired" },
                { status: 403 },
            );

        try {
            db.transaction((t) => {
                const [created] = t
                    .insert(users)
                    .values({ login: clean, password: hash, admin: false })
                    .returning()
                    .all();
                t.update(invitations)
                    .set({
                        usedBy: created.id,
                        usedAt: sql`(CURRENT_TIMESTAMP)`,
                    })
                    .where(eq(invitations.id, row.id))
                    .run();
            });
        } catch {
            // Username already taken (UNIQUE) or any other insert/commit failure.
            return Response.json(
                { ok: false, error: "That username is already taken" },
                { status: 409 },
            );
        }
        return Response.json(
            { ok: true, user: clean, admin: false },
            { status: 201 },
        );
    }

    /** GET /api/register/status — lets the register page know whether an invite
     * code is required (i.e. whether any account already exists). */
    function hasUsers(): boolean {
        return (
            db !== null &&
            (
                db.select({ n: sql<number>`count(*)` }).from(users).get()?.n ??
                0
            ) > 0
        );
    }

    function registerStatusResponse(): Response {
        return Response.json({ ok: true, needsInvite: hasUsers() });
    }

    function logoutResponse(req: Request): Response {
        const id = sessionCookie(req);
        if (id) sessions.delete(id);
        return Response.json(
            { ok: true },
            {
                headers: {
                    "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
                },
            },
        );
    }

    // ----------------------------------------------------------------------
    // Profile API: the session user's password and device tokens
    // ----------------------------------------------------------------------

    /** GET /api/whoami — the session user's login name (profile dropdown). */
    function whoamiResponse(user: string): Response {
        return Response.json({ ok: true, user });
    }

    /** GET /api/profile — just the identity: username + admin flag. Device
     * tokens live on the project now (see the projects module's token routes). */
    function profileResponse(user: string): Response {
        if (!db)
            return Response.json(
                { ok: false, error: "Authentication unavailable" },
                { status: 503 },
            );
        return Response.json({
            ok: true,
            username: user,
            admin: adminOf(user),
        });
    }

    // ----------------------------------------------------------------------
    // Invitations: admin-only minting + history of the single-use codes that gate
    // registration after the first (bootstrapped) account exists.
    // ----------------------------------------------------------------------

    /** POST /api/invitations — mint a fresh single-use invite (admin only). */
    function createInvitationResponse(req: Request): Response {
        const auth = requireAdmin(req);
        if (auth instanceof Response) return auth;
        if (!db) return unauthorized();

        const code = randomBytes(16).toString("hex");
        const expiresAt = new Date(
            Date.now() + 7 * 24 * 60 * 60 * 1000,
        ).toISOString();

        // created_by selects from the acting user's row — stays raw on the
        // underlying driver.
        db.$client
            .prepare(
                "INSERT INTO invitations (code, created_by, expires_at) SELECT ?, id, ? FROM users WHERE login = ?",
            )
            .run(code, expiresAt, auth);

        return Response.json({ ok: true, code, expiresAt }, { status: 201 });
    }

    /** GET /api/invitations — the invite history, newest first (admin only). */
    function listInvitationsResponse(req: Request): Response {
        const auth = requireAdmin(req);
        if (auth instanceof Response) return auth;
        if (!db) return unauthorized();

        // The wire format keeps the snake_case column names (the profile
        // page reads them as-is).
        const rows = db
            .select({
                code: invitations.code,
                created_at: invitations.createdAt,
                expires_at: invitations.expiresAt,
                used_at: invitations.usedAt,
                created_by: alias(users, "u1").login,
                used_by: alias(users, "u2").login,
            })
            .from(invitations)
            .leftJoin(
                alias(users, "u1"),
                eq(alias(users, "u1").id, invitations.createdBy),
            )
            .leftJoin(
                alias(users, "u2"),
                eq(alias(users, "u2").id, invitations.usedBy),
            )
            .orderBy(desc(invitations.id))
            .all();

        return Response.json({ ok: true, invitations: rows });
    }

    /** POST /api/profile/password — {current, new}; the new password is
     * required to differ from the current one. */
    async function changePasswordResponse(
        req: Request,
        user: string,
    ): Promise<Response> {
        let current: unknown;
        let next: unknown;
        try {
            const body = (await req.json()) as {
                current?: unknown;
                new?: unknown;
            };
            current = body.current;
            next = body.new;
        } catch {
            return Response.json(
                { ok: false, error: "Invalid JSON" },
                { status: 400 },
            );
        }
        if (
            typeof current !== "string" ||
            typeof next !== "string" ||
            next.length === 0 ||
            !db
        ) {
            return Response.json(
                {
                    ok: false,
                    error: "A current password and a non-empty new password are required",
                },
                { status: 400 },
            );
        }
        const row = db
            .select({ password: users.password })
            .from(users)
            .where(eq(users.login, user))
            .get();
        if (!row || !verifyPassword(current, row.password)) {
            return Response.json(
                { ok: false, error: "Invalid username or password" },
                { status: 401 },
            );
        }
        db.update(users)
            .set({ password: hashPassword(next) })
            .where(eq(users.login, user))
            .run();
        // The session itself stays valid: only the login secret changed.
        return Response.json({ ok: true });
    }

    return {
        db,
        hasUsers,
        userForToken,
        projectForToken,
        userFromRequest,
        unauthorized,
        loginResponse,
        registerResponse,
        registerStatusResponse,
        logoutResponse,
        whoamiResponse,
        profileResponse,
        changePasswordResponse,
        listInvitationsResponse,
        createInvitationResponse,
    };
}
