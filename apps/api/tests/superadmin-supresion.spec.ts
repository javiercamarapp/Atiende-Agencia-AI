// SA-L-46: rutas del superadmin de la lista de supresion -- solo conteos, "no contactar" hasheado, base sin
// migrar (200/503 honestos, sesion sana con AbortAwareFakeSession) y step-up MFA declarado.
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { ApiError } from "@atiende/core-auth";
import { AbortAwareFakeSession } from "../../../packages/db/tests/support/aborting-fake-session.ts";
import type { FakeSessionHandler } from "../../../packages/db/tests/support/aborting-fake-session.ts";
import { superadminSupresionRoutes } from "../src/routes/superadmin-supresion.ts";
import { isSensitiveRoute } from "../src/superadmin-seguridad/step-up.ts";
import { hashearContacto } from "../src/supresion/index.ts";
import type { AppDeps } from "../src/deps.ts";

const CALLER = "00000000-0000-4000-8000-0000000000aa";

function pgError(code: string): Error & { code: string } {
  const e = new Error("x") as Error & { code: string };
  e.code = code;
  return e;
}

function montar(handlers: readonly FakeSessionHandler[]) {
  const session = new AbortAwareFakeSession(handlers);
  const deps = { engine: { withAppSession: async (_c: unknown, fn: (db: AbortAwareFakeSession) => Promise<unknown>) => fn(session) } } as unknown as AppDeps;
  const app = new Hono<CoreAuthHonoEnv>();
  app.use("*", async (c, next) => {
    c.set("userId", CALLER);
    await next();
  });
  app.onError((err, c) => (err instanceof ApiError ? c.json({ error: err.message }, err.status as 400) : c.json({ error: "interno" }, 500)));
  app.route("/", superadminSupresionRoutes(deps));
  return { app, session };
}

const post = (app: Hono<CoreAuthHonoEnv>, body: unknown) => app.request("/superadmin/supresion/no-contactar", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("GET /superadmin/supresion", () => {
  it("devuelve conteos por motivo y origen, sin valores ni hashes", async () => {
    const { app } = montar([
      {
        match: /list_supresiones_for_superadmin/,
        respond: () => [
          { tipo: "telefono", motivo: "baja", origen: "whatsapp.citas", total: "3", ultimo_en: "2026-10-01T10:00:00Z" },
          { tipo: "correo", motivo: "rebote", origen: "resend", total: 2, ultimo_en: null },
          { tipo: "telefono", motivo: "baja", origen: "whatsapp.hoteles", total: 1, ultimo_en: "2026-09-30T10:00:00Z" },
        ],
      },
    ]);
    const res = await app.request("/superadmin/supresion");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; total: number; porMotivo: unknown[]; porOrigen: unknown[]; grupos: unknown[] };
    expect(body.disponible).toBe(true);
    expect(body.total).toBe(6);
    expect(body.porMotivo).toEqual([{ clave: "baja", total: 4 }, { clave: "rebote", total: 2 }]);
    expect(body.porOrigen).toHaveLength(3);
    expect(JSON.stringify(body)).not.toMatch(/valor|hash/iu);
  });

  it("base sin migrar (42883): 200 honesto con disponible=false y la sesion sigue sana", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app, session } = montar([{ match: /list_supresiones_for_superadmin/, respond: () => pgError("42883") }, { match: /select 1/, respond: () => [] }]);
    const res = await app.request("/superadmin/supresion");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: false, total: 0, grupos: [] });
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("otro error de lectura (no 'no migrada') NO se disfraza de vacio: 500", async () => {
    const { app } = montar([{ match: /list_supresiones_for_superadmin/, respond: () => pgError("42501") }]);
    expect((await app.request("/superadmin/supresion")).status).toBe(500);
  });
});

describe("POST /superadmin/supresion/no-contactar", () => {
  it("hashea el valor, lo registra y responde registrada; el valor en claro nunca llega a la base", async () => {
    const { app, session } = montar([{ match: /agregar_no_contactar_for_superadmin/, respond: () => [{ nueva: true }] }]);
    const spy = vi.spyOn(session, "query");
    const res = await post(app, { tipo: "telefono", valor: "044 55 1234 5678" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ registrada: true, yaExistia: false });
    const [, params] = spy.mock.calls[0]!;
    expect(params).toEqual([CALLER, "telefono", hashearContacto("telefono", "+525512345678")]);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("5512345678");
  });

  it("es idempotente: repetir devuelve yaExistia", async () => {
    const { app } = montar([{ match: /agregar_no_contactar_for_superadmin/, respond: () => [{ nueva: false }] }]);
    expect(await (await post(app, { tipo: "correo", valor: " Ana@Example.com " })).json()).toEqual({ registrada: false, yaExistia: true });
  });

  it("valida tipo y valor sin tocar la base", async () => {
    const { app, session } = montar([]);
    expect((await post(app, { tipo: "otro", valor: "x" })).status).toBe(400);
    expect((await post(app, { tipo: "telefono", valor: "" })).status).toBe(400);
    expect((await post(app, { tipo: "telefono", valor: "abc" })).status).toBe(400);
    expect((await post(app, { tipo: "correo", valor: "sin-arroba" })).status).toBe(400);
    expect(session.calls).toEqual([]);
  });

  it("base sin migrar: 503 honesto, nunca un 500", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app } = montar([{ match: /agregar_no_contactar_for_superadmin/, respond: () => pgError("42883") }]);
    expect((await post(app, { tipo: "telefono", valor: "5512345678" })).status).toBe(503);
  });
});

describe("step-up", () => {
  it("agregar un no contactar exige step-up MFA; la lectura no", () => {
    expect(isSensitiveRoute("POST", "/superadmin/supresion/no-contactar")).toBe(true);
    expect(isSensitiveRoute("GET", "/superadmin/supresion")).toBe(false);
  });
});
