import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { ApiError, authMiddleware, dbSession, signAccessToken, type CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  InMemoryAuditSink,
  InMemoryRateLimiter,
  createRouteAreaMap,
  isAdminRoute,
  requireAdminAccess,
  requireOrganizationMembership,
} from "../src/index.ts";

const SECRET = "test-secret";

/** Mismo patrón que fakeEngine en core-auth/tests/middleware.spec.ts: simula
 * el contrato de TenancyEngine para probar la LÓGICA de autorización sin
 * levantar Postgres. `rowsForQuery` responde SIEMPRE la misma fila — basta
 * para estos tests porque cada uno usa un solo usuario/membership. */
function fakeEngine(rowsForQuery: readonly unknown[]): TenancyEngine {
  return {
    async withAppSession(_claims, fn) {
      const session: TenantDbSession = {
        query: async () => ({ rows: rowsForQuery as never[] }),
        exec: async () => undefined,
      };
      return fn(session);
    },
  };
}

function buildApp(opts: {
  engine: TenancyEngine;
  audit: InMemoryAuditSink;
  rateLimiter: InMemoryRateLimiter;
  allowedRoles?: readonly ("owner" | "admin" | "member" | "viewer")[];
}) {
  const app = new Hono<CoreAuthHonoEnv>();
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ code: err.code, message: err.message }, err.status as 400 | 401 | 403 | 429);
    }
    throw err;
  });
  app.use(authMiddleware({ jwtSecret: SECRET }));
  app.use(dbSession(opts.engine));
  app.use(requireOrganizationMembership());
  app.get(
    "/admin/usuarios",
    requireAdminAccess({
      allowedRoles: opts.allowedRoles,
      audit: opts.audit,
      rateLimiter: opts.rateLimiter,
      now: () => new Date("2026-09-11T12:00:00.000Z"),
    }),
    (c) => c.json({ ok: true }),
  );
  return app;
}

async function tokenFor(userId: string): Promise<string> {
  return signAccessToken({ sub: userId, org_id: "org-claim", vertical: "hoteles", property_ids: null, email: "a@b.com" }, SECRET, 60);
}

describe("isAdminRoute", () => {
  it("reconoce /admin y /admin/*, no un prefijo parecido", () => {
    expect(isAdminRoute("/admin")).toBe(true);
    expect(isAdminRoute("/admin/usuarios")).toBe(true);
    expect(isAdminRoute("/administracion")).toBe(false);
    expect(isAdminRoute("/dashboard")).toBe(false);
  });
});

describe("requireAdminAccess — camino feliz", () => {
  it("200 y NO audita cuando el rol SÍ está permitido", async () => {
    const audit = new InMemoryAuditSink();
    const rateLimiter = new InMemoryRateLimiter({ capacity: 5, refillPerSecond: 1 });
    const app = buildApp({ engine: fakeEngine([{ organization_id: "org-real", platform_role: "owner", vertical_role: "gm" }]), audit, rateLimiter });
    const res = await app.request("/admin/usuarios", { headers: { authorization: `Bearer ${await tokenFor("user-1")}` } });
    expect(res.status).toBe(200);
    expect(audit.entries).toHaveLength(0);
  });
});

describe("requireAdminAccess — LA PIEZA NUEVA: auditoría + rate-limit del intento denegado", () => {
  it("un usuario SIN permiso (rol 'member') que intenta /admin queda 403 Y auditado con decision:'denied'", async () => {
    const audit = new InMemoryAuditSink();
    const rateLimiter = new InMemoryRateLimiter({ capacity: 5, refillPerSecond: 1 });
    const app = buildApp({
      engine: fakeEngine([{ organization_id: "org-real", platform_role: "member", vertical_role: "frontdesk" }]),
      audit,
      rateLimiter,
    });
    const res = await app.request("/admin/usuarios", { headers: { authorization: `Bearer ${await tokenFor("user-sin-permiso")}` } });

    expect(res.status).toBe(403);
    expect(audit.entries).toHaveLength(1);
    const entry = audit.entries[0]!;
    expect(entry.decision).toBe("denied");
    expect(entry.reason).toBe("insufficient_role");
    expect(entry.actorUserId).toBe("user-sin-permiso");
    expect(entry.route).toBe("/admin/usuarios");
    expect(entry.action).toBe("admin:access");
  });

  it("sin fila de membership (usuario ni siquiera pertenece a la organización) -> 403 auditado como 'no_membership', nunca 'member' por default", async () => {
    const audit = new InMemoryAuditSink();
    const rateLimiter = new InMemoryRateLimiter({ capacity: 5, refillPerSecond: 1 });
    const app = buildApp({ engine: fakeEngine([]), audit, rateLimiter });
    const res = await app.request("/admin/usuarios", { headers: { authorization: `Bearer ${await tokenFor("user-ajeno")}` } });

    expect(res.status).toBe(403);
    expect(audit.entries[0]!.reason).toBe("no_membership");
  });

  it("intentos denegados repetidos del MISMO actor agotan el rate limiter y terminan en 429 — auditado Y rate-limitado, no solo rechazado", async () => {
    const audit = new InMemoryAuditSink();
    // Capacidad 2: los primeros 2 intentos denegados consumen el bucket, el 3ro ya lo encuentra vacío.
    const rateLimiter = new InMemoryRateLimiter({ capacity: 2, refillPerSecond: 0.001 });
    const app = buildApp({
      engine: fakeEngine([{ organization_id: "org-real", platform_role: "viewer", vertical_role: "frontdesk" }]),
      audit,
      rateLimiter,
    });
    const headers = { authorization: `Bearer ${await tokenFor("atacante-persistente")}` };

    const primero = await app.request("/admin/usuarios", { headers });
    const segundo = await app.request("/admin/usuarios", { headers });
    const tercero = await app.request("/admin/usuarios", { headers });

    expect(primero.status).toBe(403);
    expect(segundo.status).toBe(403);
    expect(tercero.status).toBe(429); // el rate limiter ya bloqueó, no el chequeo de rol

    expect(audit.entries).toHaveLength(3); // LOS TRES intentos quedaron auditados, ninguno "en silencio"
    expect(audit.entries.map((e) => e.reason)).toEqual(["insufficient_role", "insufficient_role", "rate_limited"]);
    expect(audit.entries.every((e) => e.decision === "denied")).toBe(true);
    expect(audit.entries.every((e) => e.actorUserId === "atacante-persistente")).toBe(true);

    const respuesta429 = (await tercero.json()) as { code: string };
    expect(respuesta429.code).toBe("rate_limited");
  });

  it("el rate limiter es POR ACTOR: un usuario sin permiso agotando su cupo no bloquea a otro usuario distinto", async () => {
    const audit = new InMemoryAuditSink();
    const rateLimiter = new InMemoryRateLimiter({ capacity: 1, refillPerSecond: 0.001 });
    const app = buildApp({
      engine: fakeEngine([{ organization_id: "org-real", platform_role: "member", vertical_role: "frontdesk" }]),
      audit,
      rateLimiter,
    });

    const res1 = await app.request("/admin/usuarios", { headers: { authorization: `Bearer ${await tokenFor("user-a")}` } });
    const res2 = await app.request("/admin/usuarios", { headers: { authorization: `Bearer ${await tokenFor("user-a")}` } });
    const res3 = await app.request("/admin/usuarios", { headers: { authorization: `Bearer ${await tokenFor("user-b")}` } });

    expect(res1.status).toBe(403); // user-a, 1er intento: consume su único token
    expect(res2.status).toBe(429); // user-a, 2do intento: ya sin cupo
    expect(res3.status).toBe(403); // user-b: bucket propio, todavía con cupo -> 403 normal, no 429
  });
});

describe("requireAdminAccess — composición con route-area map (piezas 1+2 juntas)", () => {
  it("gatea por ÁREA en vez de por lista fija de roles cuando se pasa routeAreaMap", async () => {
    const routeAreaMap = createRouteAreaMap<"administracion" | "operacion">({
      areasByRole: {
        owner: ["administracion", "operacion"],
        admin: ["administracion", "operacion"],
        member: ["operacion"],
      },
      areaByRoute: { "/admin/usuarios": "administracion" },
    });
    const audit = new InMemoryAuditSink();
    const rateLimiter = new InMemoryRateLimiter({ capacity: 5, refillPerSecond: 1 });

    const app = new Hono<CoreAuthHonoEnv>();
    app.onError((err, c) => {
      if (err instanceof ApiError) return c.json({ code: err.code }, err.status as 403);
      throw err;
    });
    app.use(authMiddleware({ jwtSecret: SECRET }));
    app.use(dbSession(fakeEngine([{ organization_id: "org-real", platform_role: "member", vertical_role: "frontdesk" }])));
    app.use(requireOrganizationMembership());
    app.get("/admin/usuarios", requireAdminAccess({ routeAreaMap, audit, rateLimiter }), (c) => c.json({ ok: true }));

    const res = await app.request("/admin/usuarios", { headers: { authorization: `Bearer ${await tokenFor("member-sin-area-admin")}` } });
    expect(res.status).toBe(403); // "member" no tiene el área "administracion" -> denegado por el mapa, no por allowedRoles
    expect(audit.entries[0]!.reason).toBe("insufficient_role");
  });
});
