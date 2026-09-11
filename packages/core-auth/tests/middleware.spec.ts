import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import {
  ApiError,
  authMiddleware,
  assertVerticalRole,
  dbSession,
  requestId,
  requirePropertyMembership,
  signAccessToken,
} from "../src/index.ts";
import type { CoreAuthHonoEnv } from "../src/types.ts";

const SECRET = "test-secret";

/**
 * Motor de tenancy en memoria: no habla con Postgres real (eso es responsabilidad de
 * `packages/db`, fuera de este paquete) — simula el MISMO contrato (`withAppSession`
 * abre "sesión" con los claims, `query` responde según lo que el test configuró) para
 * poder probar la LÓGICA del middleware (qué hace con lo que la sesión devuelve, qué
 * errores lanza, qué escribe en el contexto) sin levantar una base real.
 */
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

function buildApp(engine: TenancyEngine, allowedRoles?: readonly ("owner" | "admin" | "member" | "viewer")[]) {
  const app = new Hono<CoreAuthHonoEnv>();
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ code: err.code, message: err.message }, err.status as 400 | 401 | 403);
    }
    return c.json({ code: "internal_error", message: "error interno" }, 500);
  });
  app.use(requestId());
  app.use(authMiddleware({ jwtSecret: SECRET }));
  app.use(dbSession(engine));
  app.get("/properties/:propertyId/ping", requirePropertyMembership("propertyId", allowedRoles), (c) => {
    return c.json({
      ok: true,
      organizationId: c.get("organizationId"),
      propertyIds: c.get("propertyIds"),
      platformRole: c.get("platformRole"),
      verticalRole: c.get("verticalRole"),
    });
  });
  app.get("/properties/:propertyId/vertical-only", requirePropertyMembership("propertyId"), (c) => {
    assertVerticalRole(c, ["frontdesk"]);
    return c.json({ ok: true });
  });
  return app;
}

async function validToken(): Promise<string> {
  return signAccessToken(
    { sub: "user-1", org_id: "org-claim-obsoleto", vertical: "hoteles", property_ids: null, email: "a@b.com" },
    SECRET,
    60,
  );
}

describe("authMiddleware", () => {
  it("401 sin header Authorization", async () => {
    const app = buildApp(fakeEngine([]));
    const res = await app.request("/properties/p1/ping");
    expect(res.status).toBe(401);
  });

  it("401 con un token con secreto incorrecto", async () => {
    const app = buildApp(fakeEngine([]));
    const badToken = await signAccessToken(
      { sub: "user-1", org_id: "org-1", vertical: "hoteles", property_ids: null, email: "a@b.com" },
      "otro-secreto",
      60,
    );
    const res = await app.request("/properties/p1/ping", { headers: { authorization: `Bearer ${badToken}` } });
    expect(res.status).toBe(401);
  });
});

describe("requirePropertyMembership", () => {
  it("403 cuando la query de membership no devuelve filas (usuario ajeno a la property)", async () => {
    const app = buildApp(fakeEngine([]));
    const token = await validToken();
    const res = await app.request("/properties/p1/ping", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
  });

  it("200 y REESCRIBE organizationId/propertyIds/platformRole con lo resuelto en vivo (nunca el claim del JWT)", async () => {
    const app = buildApp(fakeEngine([{ organization_id: "org-real", platform_role: "admin", vertical_role: "gm" }]));
    const token = await validToken(); // claim trae org_id: "org-claim-obsoleto"
    const res = await app.request("/properties/p1/ping", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      organizationId: string;
      propertyIds: string[];
      platformRole: string;
      verticalRole: string;
    };
    expect(body.organizationId).toBe("org-real"); // NO "org-claim-obsoleto"
    expect(body.propertyIds).toEqual(["p1"]);
    expect(body.platformRole).toBe("admin");
    expect(body.verticalRole).toBe("gm");
  });

  it("403 cuando el platformRole resuelto no está en allowedRoles", async () => {
    const app = buildApp(fakeEngine([{ organization_id: "org-real", platform_role: "viewer", vertical_role: "frontdesk" }]), [
      "owner",
      "admin",
    ]);
    const token = await validToken();
    const res = await app.request("/properties/p1/ping", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
  });

  it("403 cuando el header X-Property-Id no coincide con el parámetro de ruta", async () => {
    const app = buildApp(fakeEngine([{ organization_id: "org-real", platform_role: "owner", vertical_role: "gm" }]));
    const token = await validToken();
    const res = await app.request("/properties/p1/ping", {
      headers: { authorization: `Bearer ${token}`, "x-property-id": "p2-distinta" },
    });
    expect(res.status).toBe(403);
  });
});

describe("assertVerticalRole", () => {
  it("200 cuando el verticalRole resuelto está en la lista permitida", async () => {
    const app = buildApp(fakeEngine([{ organization_id: "org-real", platform_role: "member", vertical_role: "frontdesk" }]));
    const token = await validToken();
    const res = await app.request("/properties/p1/vertical-only", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });

  it("403 cuando el verticalRole resuelto NO está en la lista permitida", async () => {
    const app = buildApp(
      fakeEngine([{ organization_id: "org-real", platform_role: "member", vertical_role: "housekeeping" }]),
    );
    const token = await validToken();
    const res = await app.request("/properties/p1/vertical-only", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
  });
});
