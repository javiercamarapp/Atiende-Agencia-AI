// GET /superadmin/costos/uso-mensajes (PL-16): el dato del consumo de mensajes del mes contra el tope del plan que consumira SA-10.
// Gateo (staff 403 / sin token 401), mapeo de la lectura caller-bound y base sin migrar sin 500. La autorizacion real vive en
// core.superadmin_list_message_usage (scripts/verify-planes-topes-prueba).
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

async function setup(modo: "ok" | "sin_migrar" | "sin_permiso") {
  const s = await seguridadSetup();
  const llamadas: unknown[][] = [];
  const sesion = {
    async query(sql: string, params?: unknown[]) {
      if (!/superadmin_list_message_usage/.test(sql)) return { rows: [] };
      llamadas.push(params ?? []);
      if (modo === "sin_migrar") throw pgError("42883", "function core.superadmin_list_message_usage(uuid, integer) does not exist");
      if (modo === "sin_permiso") throw pgError("42501", "superadmin_list_message_usage: solo un superadmin de plataforma real puede ejecutar esta accion");
      return {
        rows: [
          { organization_id: "o1", organization_name: "Hotel A", slug: "hotel-a", vertical: "hoteles", periodo: new Date("2026-10-01T00:00:00Z"), plan_id: "p1", limite: "1000", accion: "pausar", usado: "1001", excedente: "1", proactivos_omitidos: "3" },
          { organization_id: "o2", organization_name: "Resto B", slug: "resto-b", vertical: "restaurantes", periodo: "2026-10-01", plan_id: null, limite: null, accion: null, usado: "5", excedente: "0", proactivos_omitidos: "0" },
        ],
      };
    },
    async exec() {
      return undefined;
    },
  } as unknown as TenantDbSession;
  const deps = { ...s.deps, engine: { withAppSession: async (_c: unknown, fn: (x: TenantDbSession) => Promise<unknown>) => fn(sesion) } } as unknown as typeof s.deps;
  return { s, app: buildApp(deps), llamadas };
}

describe("GET /superadmin/costos/uso-mensajes", () => {
  it("un staff normal recibe 403 y sin token 401", async () => {
    const t = await setup("ok");
    const st = await t.s.staff();
    expect((await t.app.request("/superadmin/costos/uso-mensajes", { headers: bearer(st.token) })).status).toBe(403);
    expect((await t.app.request("/superadmin/costos/uso-mensajes")).status).toBe(401);
    expect(t.llamadas).toHaveLength(0);
  });

  it("el superadmin recibe el consumo por organizacion contra su tope (numeros reales, sin tope = null)", async () => {
    const t = await setup("ok");
    const sa = await t.s.superadmin();
    const res = await t.app.request("/superadmin/costos/uso-mensajes?limite=50", { headers: bearer(sa.token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; organizaciones: Array<Record<string, unknown>> };
    expect(body.disponible).toBe(true);
    expect(body.organizaciones).toEqual([
      { organizationId: "o1", organizationName: "Hotel A", slug: "hotel-a", vertical: "hoteles", periodo: "2026-10-01", planId: "p1", limite: 1000, accion: "pausar", usado: 1001, excedente: 1, proactivosOmitidos: 3 },
      { organizationId: "o2", organizationName: "Resto B", slug: "resto-b", vertical: "restaurantes", periodo: "2026-10-01", planId: null, limite: null, accion: null, usado: 5, excedente: 0, proactivosOmitidos: 0 },
    ]);
    expect(t.llamadas[0]).toEqual([sa.id, 50]);
  });

  it("limite invalido 400", async () => {
    const t = await setup("ok");
    const sa = await t.s.superadmin();
    for (const limite of ["0", "501", "x", "1.5"]) expect((await t.app.request(`/superadmin/costos/uso-mensajes?limite=${limite}`, { headers: bearer(sa.token) })).status, limite).toBe(400);
  });

  it("base sin la migracion 0045: 200 con disponible:false y lista vacia (nunca 500)", async () => {
    const t = await setup("sin_migrar");
    const sa = await t.s.superadmin();
    const res = await t.app.request("/superadmin/costos/uso-mensajes", { headers: bearer(sa.token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disponible: false, organizaciones: [] });
  });

  it("si la base niega el permiso (42501) responde 403", async () => {
    const t = await setup("sin_permiso");
    const sa = await t.s.superadmin();
    expect((await t.app.request("/superadmin/costos/uso-mensajes", { headers: bearer(sa.token) })).status).toBe(403);
  });
});
