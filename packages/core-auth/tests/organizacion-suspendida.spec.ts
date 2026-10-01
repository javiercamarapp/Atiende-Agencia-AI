// Una organizacion suspendida por el back office pierde el acceso del staff a su
// panel (requirePropertyMembership). Otra organizacion del mismo usuario y las
// filas sin `organization_status` (dobles antiguos) siguen funcionando.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { ApiError, authMiddleware, dbSession, requirePropertyMembership, signAccessToken } from "../src/index.ts";
import type { CoreAuthHonoEnv } from "../src/types.ts";

const SECRET = "test-secret";

function engineWithRows(rows: readonly unknown[], seenSql: string[] = []): TenancyEngine {
  return {
    async withAppSession(_claims, fn) {
      const session: TenantDbSession = {
        query: async (sql: string) => {
          seenSql.push(sql);
          return { rows: rows as never[] };
        },
        exec: async () => undefined,
      };
      return fn(session);
    },
  };
}

function app(engine: TenancyEngine) {
  const a = new Hono<CoreAuthHonoEnv>();
  a.onError((err, c) => (err instanceof ApiError ? c.json({ code: err.code, message: err.message }, err.status as 400 | 401 | 403) : c.json({ code: "internal_error" }, 500)));
  a.use(authMiddleware({ jwtSecret: SECRET }));
  a.use(dbSession(engine));
  a.get("/properties/:propertyId/ping", requirePropertyMembership("propertyId"), (c) => c.json({ ok: true }));
  return a;
}

const token = () => signAccessToken({ sub: "u1", org_id: "o", vertical: "hoteles", property_ids: null, email: "a@b.com" }, SECRET, 60);
const call = async (a: ReturnType<typeof app>) => a.request("/properties/p1/ping", { headers: { authorization: `Bearer ${await token()}` } });

describe("requirePropertyMembership + organizacion suspendida", () => {
  it("403 organization_suspended con codigo propio", async () => {
    const res = await call(app(engineWithRows([{ organization_id: "o", platform_role: "owner", vertical_role: "gm", organization_status: "suspended" }])));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "organization_suspended" });
  });

  it("trial y active pasan; una fila sin organization_status (doble antiguo) tambien", async () => {
    for (const organization_status of ["trial", "active", undefined]) {
      const res = await call(app(engineWithRows([{ organization_id: "o", platform_role: "owner", vertical_role: "gm", organization_status }])));
      expect(res.status, String(organization_status)).toBe(200);
    }
  });

  it("la consulta une core.organization y pide su status (la fuente real del bloqueo)", async () => {
    const seen: string[] = [];
    await call(app(engineWithRows([{ organization_id: "o", platform_role: "owner", vertical_role: "gm", organization_status: "active" }], seen)));
    expect(seen.join("\n")).toMatch(/join core\.organization o on o\.id = m\.organization_id/);
    expect(seen.join("\n")).toMatch(/o\.status as organization_status/);
  });
});
