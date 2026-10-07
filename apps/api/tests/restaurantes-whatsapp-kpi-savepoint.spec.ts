// REGLA DURA de compatibilidad con la base SIN migrar (migración 040, KPI de WhatsApp), a nivel HTTP: el request corre dentro de
// UNA transacción (`withAppSession`); con el repositorio Postgres REAL y una sesión que reproduce el estado ABORTADO de Postgres
// (25P02), la ruta debe degradar a "no disponible" y dejar la MISMA sesión utilizable (`ROLLBACK TO SAVEPOINT`).
import { describe, expect, it } from "vitest";
import { PostgresWhatsappKpiRepository } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "../../../packages/domain-restaurantes/tests/support/aborting-fake-session.ts";
import { authedGet, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resp = Omit<Response, "json"> & { json(): Promise<any> };
function envolver(app: ReturnType<typeof buildApp>): { request(input: string, init?: RequestInit): Promise<Resp> } {
  return { request: (input, init) => Promise.resolve(app.request(input, init)) as Promise<Resp> };
}

const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };
/** La ruta tambien lee la entrega de los avisos de pedido (migracion 066): por defecto "migrada y sin datos", salvo que el caso la sobreescriba. */
const ENTREGA_SIN_DATOS: FakeSessionHandler = { match: /whatsapp_entrega_diaria/i, respond: () => [] };

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

async function construir(handlers: readonly FakeSessionHandler[]) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const session = new AbortAwareFakeSession([...handlers, ENTREGA_SIN_DATOS, SIGUIENTE]);
  const deps: AppDeps = { ...ctx.deps, whatsappKpiRepo: () => new PostgresWhatsappKpiRepository(session) };
  return { ctx, session, app: envolver(buildApp(deps)), url: `/v1/restaurantes/${ctx.propertyIdA}/admin/whatsapp/kpi` };
}

describe("ruta de KPI de WhatsApp contra la base sin migrar, con la transacción del request en estado abortado", () => {
  it.each([
    ["42883", "function restaurantes.whatsapp_kpis_diarios does not exist"],
    ["42P01", 'relation "restaurantes.demo_organization" does not exist'],
    ["42703", 'column "role" does not exist'],
  ])("SQLSTATE %s: 200 con disponible=false y la sesión sigue viva", async (code, msg) => {
    const { ctx, app, url, session } = await construir([{ match: /whatsapp_kpis_diarios/i, respond: () => { throw pgError(code, msg); } }]);
    const res = await app.request(url, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: false, serie: [] });
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("base migrada: devuelve las filas mapeadas (micro-USD y centavos como enteros, NULL se conserva)", async () => {
    const fila = {
      fecha: "2026-03-10", zona_horaria: "America/Mexico_City", conversaciones: 4, conversaciones_con_pedido: 1, conversaciones_con_handoff: 2,
      pedidos: 2, handoffs: 1, pedidos_org: "3", org_es_demo: false, costo_llm_org_micro_usd: "3000000", costo_llm_org_centavos_mxn: null,
    };
    const { ctx, app, url } = await construir([{ match: /whatsapp_kpis_diarios/i, respond: () => [fila] }]);
    const r = await (await app.request(`${url}?dias=1`, authedGet(ctx.staff.owner.token))).json();
    expect(r.disponible).toBe(true);
    expect(r.serie[0]).toMatchObject({ conversaciones: 4, conversionPct: 25, handoffPct: 50, pedidos: 2, pedidosOrg: 3, costoLlmOrgCentavosMxn: null, costoLlmPorPedidoCentavosMxn: null });
  });

  it("un error de Postgres que NO es de base sin migrar (42501) no se traga: la ruta falla en vez de mostrar ceros", async () => {
    const { ctx, app, url } = await construir([{ match: /whatsapp_kpis_diarios/i, respond: () => { throw pgError("42501", "sin acceso a la sucursal"); } }]);
    const res = await app.request(url, authedGet(ctx.staff.owner.token));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("base con la 040 y SIN la 066: el KPI de siempre sigue disponible, entrega.disponible=false y la sesion sigue viva (SAVEPOINT)", async () => {
    const fila = {
      fecha: "2026-03-10", zona_horaria: "America/Mexico_City", conversaciones: 4, conversaciones_con_pedido: 1, conversaciones_con_handoff: 2,
      pedidos: 2, handoffs: 1, pedidos_org: "3", org_es_demo: false, costo_llm_org_micro_usd: "3000000", costo_llm_org_centavos_mxn: null,
    };
    const { ctx, app, url, session } = await construir([
      { match: /whatsapp_kpis_diarios/i, respond: () => [fila] },
      { match: /whatsapp_entrega_diaria/i, respond: () => { throw pgError("42883", "function restaurantes.whatsapp_entrega_diaria(uuid, uuid, date, date) does not exist"); } },
    ]);
    const res = await app.request(`${url}?dias=1`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.disponible).toBe(true);
    expect(r.entrega).toMatchObject({ disponible: false, serie: [] });
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("base migrada (066): entrega mapea la serie y calcula las tasas", async () => {
    const { ctx, app, url } = await construir([
      { match: /whatsapp_kpis_diarios/i, respond: () => [] },
      { match: /whatsapp_entrega_diaria/i, respond: () => [{ fecha: "2026-03-10", enviados: 4, entregados: 2, leidos: 1, fallidos: 1, sin_estado: 1, fallos_por_motivo: { numero_no_entregable: 1 } }] },
    ]);
    const r = await (await app.request(`${url}?dias=1`, authedGet(ctx.staff.owner.token))).json();
    expect(r.entrega.disponible).toBe(true);
    expect(r.entrega.resumen).toMatchObject({ enviados: 4, entregaPct: 50, lecturaPct: 50, fallosPorMotivo: { numero_no_entregable: 1 } });
  });

  it("un 42501 en la lectura de entrega no se traga: la ruta falla en vez de mostrar ceros", async () => {
    const { ctx, app, url } = await construir([
      { match: /whatsapp_kpis_diarios/i, respond: () => [] },
      { match: /whatsapp_entrega_diaria/i, respond: () => { throw pgError("42501", "sin acceso a la sucursal"); } },
    ]);
    const res = await app.request(url, authedGet(ctx.staff.owner.token));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
