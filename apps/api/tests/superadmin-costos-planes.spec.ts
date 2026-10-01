// Costo por evento / margen (SA-02) y catalogo de planes + asignacion (SA-03) del
// superadmin: rutas de punta a punta contra el repo en memoria (la autorizacion real en SQL
// se verifica en scripts/verify-superadmin-costos-planes/). Reloj de `Date` controlado cuando
// el mes del reporte importa.
import { afterEach, describe, expect, it, vi } from "vitest";
import { totpAt } from "@atiende/core-auth";
import { InMemoryCostosPlanesRepository } from "@atiende/db";
import type { CostosPlanesRepository, FxRateRow } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { elegirTipoCambio } from "../src/routes/superadmin-costos.ts";
import { jsonRequestInit } from "./fixtures.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";

afterEach(() => vi.useRealTimers());

const T0 = new Date("2026-09-30T12:00:00.000Z").getTime();
const MOTIVO = "Cliente firmo contrato anual del plan estandar, se asigna el plan.";
type App = { request: (u: string, i?: RequestInit) => Response | Promise<Response> };

async function setup(options: { reloj?: () => number } = {}) {
  const s = await seguridadSetup();
  const costos = new InMemoryCostosPlanesRepository(options.reloj ? { now: options.reloj } : {});
  const deps = { ...s.deps, costosPlanesRepo: () => costos as CostosPlanesRepository };
  const app = buildApp(deps);
  const org = s.base.organizationId;
  costos.seedOrganization(org, { vertical: "restaurantes", name: "Los Taquitos de PM", slug: "los-taquitos-de-pm", sucursalesActivas: 3 });
  return {
    s,
    app,
    costos,
    org,
    async superadmin() {
      const sa = await s.superadmin();
      costos.seedSuperadmin(sa.id);
      return sa;
    },
  };
}

const req = (app: App, method: string, path: string, body: unknown, headers: Record<string, string>) => app.request(path, { ...jsonRequestInit(body, headers), method });
const get = (app: App, path: string, token: string) => app.request(path, { headers: bearer(token) });

describe("superadmin costos y planes -- gateo", () => {
  it("un staff normal recibe 403 en todas las rutas; sin token, 401", async () => {
    const t = await setup();
    const st = await t.s.staff();
    for (const path of ["/superadmin/costos/resumen", "/superadmin/costos/tipo-cambio", `/superadmin/costos/organizaciones/${t.org}/eventos`, "/superadmin/planes", "/superadmin/planes/asignaciones"]) {
      expect((await get(t.app, path, st.token)).status, path).toBe(403);
      expect((await t.app.request(path)).status, path).toBe(401);
    }
    expect((await req(t.app, "PUT", "/superadmin/costos/tipo-cambio", { fecha: "2026-09-01", mxnPorUsd: 18, fuente: "Banxico" }, bearer(st.token))).status).toBe(403);
    expect((await req(t.app, "PUT", "/superadmin/planes/plan-x", { nombre: "Plan X", vertical: "citas" }, bearer(st.token))).status).toBe(403);
    expect((await req(t.app, "POST", "/superadmin/planes/asignaciones", { organizationId: t.org, planId: "restaurantes-estandar", motivo: MOTIVO }, bearer(st.token))).status).toBe(403);
  });
});

describe("GET /superadmin/costos/resumen", () => {
  it("sin tipo de cambio: costo USD visible, costo MXN y margen null (nunca inventados), con el supuesto declarado", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const t = await setup();
    const sa = await t.superadmin();
    await t.costos.recordEvent({ organizationId: t.org, categoria: "voz", proveedor: "livekit", unidad: "minuto", cantidad: 10, costoMicroUsd: 2_000_000, refTipo: "voice_call", refId: "c1" });
    t.costos.seedLlmUsage(t.org, "2026-09", 3_000_000);

    const res = await get(t.app, "/superadmin/costos/resumen", sa.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; mes: string; tipoCambio: unknown; organizaciones: Array<Record<string, unknown>>; supuestos: string[]; resumen: Record<string, unknown> };
    expect(body.disponible).toBe(true);
    expect(body.mes).toBe("2026-09");
    expect(body.tipoCambio).toBeNull();
    const fila = body.organizaciones[0]!;
    expect(fila).toMatchObject({ costoUsd: 5, costoMxn: null, margenMxn: null, ingresoMxn: null, ingresoRazon: "sin_plan", minutosVoz: 10 });
    expect(body.resumen).toMatchObject({ costoMxn: null, margenMxn: null });
    expect(body.supuestos.join(" ")).toContain("No hay tipo de cambio configurado");
  });

  it("con plan + tipo de cambio: ingreso del plan, costo en MXN, margen, alerta de margen bajo y consumo contra limites", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const t = await setup();
    const sa = await t.superadmin();
    // Plan Pro: base $5,900 + $799 por asiento (1 incluido); 3 sucursales -> 2 facturables = $7,498
    await t.costos.upsertPlan(sa.id, { id: "restaurantes-pro", nombre: "Restaurantes Pro", vertical: "restaurantes", precioBaseCentavos: 590_000, precioAsientoCentavos: 79_900, asientosIncluidos: 1, activo: true });
    await t.costos.setPlanLimit(sa.id, "restaurantes-pro", "minutos_voz_mes", 100, "cobrar");
    const sol = await t.costos.requestAssignment(sa.id, t.org, "restaurantes-pro", MOTIVO);
    await t.costos.confirmAssignment(sa.id, sol.assignment!.id);
    await t.costos.setFxRate(sa.id, "2026-09-01", 20, "Banxico FIX");
    // costo: 300 USD -> 6,000 MXN sobre 7,498 => margen 20% (< 30)
    t.costos.seedLlmUsage(t.org, "2026-09", 290_000_000);
    await t.costos.recordEvent({ organizationId: t.org, categoria: "voz", proveedor: "livekit", unidad: "minuto", cantidad: 150, costoMicroUsd: 10_000_000, refTipo: "voice_call", refId: "c2" });

    const body = (await (await get(t.app, "/superadmin/costos/resumen", sa.token)).json()) as { tipoCambio: { mxnPorUsd: number }; organizaciones: Array<Record<string, any>>; resumen: Record<string, number> };
    expect(body.tipoCambio).toMatchObject({ mxnPorUsd: 20, fuente: "Banxico FIX" });
    const f = body.organizaciones[0]!;
    expect(f).toMatchObject({ planId: "restaurantes-pro", ingresoMxn: 7498, costoMxn: 6000, margenMxn: 1498, margenPct: 19.98, riesgo: "alto" });
    const codigos = f.alertas.map((a: { codigo: string }) => a.codigo);
    expect(codigos).toContain("margen_bajo");
    expect(codigos).toContain("tope_llm_agotado");
    expect(codigos).toContain("limite_excedido");
    expect(f.consumo[0]).toMatchObject({ metrica: "minutos_voz_mes", estado: "excedido", aplicadoPorSistema: false });
    expect(body.resumen).toMatchObject({ ingresoMxn: 7498, costoMxn: 6000, enRiesgoAlto: 1 });
  });

  it("el tipo de cambio de un mes pasado no usa uno posterior a ese mes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const t = await setup();
    const sa = await t.superadmin();
    await t.costos.setFxRate(sa.id, "2026-08-15", 19, "Banxico FIX (agosto)");
    await t.costos.setFxRate(sa.id, "2026-09-10", 21, "Banxico FIX (septiembre)");
    const ago = (await (await get(t.app, "/superadmin/costos/resumen?mes=2026-08", sa.token)).json()) as { tipoCambio: { mxnPorUsd: number } };
    expect(ago.tipoCambio.mxnPorUsd).toBe(19);
    const sep = (await (await get(t.app, "/superadmin/costos/resumen?mes=2026-09", sa.token)).json()) as { tipoCambio: { mxnPorUsd: number } };
    expect(sep.tipoCambio.mxnPorUsd).toBe(21);
    const jul = (await (await get(t.app, "/superadmin/costos/resumen?mes=2026-07", sa.token)).json()) as { tipoCambio: unknown };
    expect(jul.tipoCambio).toBeNull();
  });

  it("valida mes y umbral (400)", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    expect((await get(t.app, "/superadmin/costos/resumen?mes=2026-13", sa.token)).status).toBe(400);
    expect((await get(t.app, "/superadmin/costos/resumen?mes=septiembre", sa.token)).status).toBe(400);
    expect((await get(t.app, "/superadmin/costos/resumen?umbralMargenPct=150", sa.token)).status).toBe(400);
  });

  it("sin repo cableado o con la base sin migrar: disponible=false con listas vacias (nunca 500) y escrituras 503", async () => {
    const s = await seguridadSetup();
    const sa = await s.superadmin();
    const sinRepo = buildApp({ ...s.deps });
    const body = (await (await get(sinRepo, "/superadmin/costos/resumen", sa.token)).json()) as { disponible: boolean; organizaciones: unknown[] };
    expect(body).toMatchObject({ disponible: false, organizaciones: [] });
    expect((await req(sinRepo, "PUT", "/superadmin/costos/tipo-cambio", { fecha: "2026-09-01", mxnPorUsd: 18, fuente: "Banxico" }, bearer(sa.token))).status).toBe(503);
    expect((await get(sinRepo, "/superadmin/planes", sa.token).then((r) => r.json())) as { disponible: boolean }).toMatchObject({ disponible: false, planes: [] });

    const noMigrado: CostosPlanesRepository = {
      recordEvent: async () => ({ availability: "not_migrated", inserted: null }),
      getReport: async () => ({ availability: "not_migrated", rows: [] }),
      listEvents: async () => ({ availability: "not_migrated", events: [] }),
      listFxRates: async () => ({ availability: "not_migrated", rates: [] }),
      setFxRate: async () => ({ availability: "not_migrated" }),
      listPlans: async () => ({ availability: "not_migrated", plans: [] }),
      upsertPlan: async () => ({ availability: "not_migrated" }),
      setPlanLimit: async () => ({ availability: "not_migrated" }),
      deletePlanLimit: async () => ({ availability: "not_migrated" }),
      requestAssignment: async () => ({ availability: "not_migrated", assignment: null }),
      confirmAssignment: async () => ({ availability: "not_migrated", assignment: null }),
      cancelAssignment: async () => ({ availability: "not_migrated", assignment: null }),
      listAssignments: async () => ({ availability: "not_migrated", assignments: [] }),
    };
    const appNoMig = buildApp({ ...s.deps, costosPlanesRepo: () => noMigrado });
    expect(await (await get(appNoMig, "/superadmin/costos/resumen", sa.token)).json()).toMatchObject({ disponible: false, organizaciones: [], resumen: null });
    expect(await (await get(appNoMig, "/superadmin/planes", sa.token)).json()).toMatchObject({ disponible: false, planes: [] });
    expect((await req(appNoMig, "PUT", "/superadmin/costos/tipo-cambio", { fecha: "2026-09-01", mxnPorUsd: 18, fuente: "Banxico" }, bearer(sa.token))).status).toBe(503);
    expect((await req(appNoMig, "PUT", "/superadmin/planes/plan-x", { nombre: "Plan X", vertical: "citas" }, bearer(sa.token))).status).toBe(503);
    expect((await req(appNoMig, "POST", "/superadmin/planes/asignaciones", { organizationId: "00000000-0000-4000-8000-000000000001", planId: "plan-x", motivo: MOTIVO }, bearer(sa.token))).status).toBe(503);
  });
});

describe("eventos y tipo de cambio", () => {
  it("lista los eventos de una organizacion; id no-UUID -> 400", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    await t.costos.recordEvent({ organizationId: t.org, categoria: "whatsapp", proveedor: "meta", unidad: "mensaje", cantidad: 50, costoMicroUsd: 400_000, costoEstimado: false, refTipo: "whatsapp_msg", refId: "w1" });
    const body = (await (await get(t.app, `/superadmin/costos/organizaciones/${t.org}/eventos`, sa.token)).json()) as { eventos: Array<Record<string, unknown>> };
    expect(body.eventos).toHaveLength(1);
    expect(body.eventos[0]).toMatchObject({ categoria: "whatsapp", costoMicroUsd: 400_000, costoEstimado: false });
    expect((await get(t.app, "/superadmin/costos/organizaciones/no-es-uuid/eventos", sa.token)).status).toBe(400);
  });

  it("PUT tipo-cambio valida fecha, monto y fuente; guarda y aparece en el listado", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    const put = (body: unknown) => req(t.app, "PUT", "/superadmin/costos/tipo-cambio", body, bearer(sa.token));
    expect((await put({ fecha: "ayer", mxnPorUsd: 18, fuente: "Banxico FIX" })).status).toBe(400);
    expect((await put({ fecha: "2026-09-01", mxnPorUsd: -1, fuente: "Banxico FIX" })).status).toBe(400);
    expect((await put({ fecha: "2026-09-01", mxnPorUsd: "18", fuente: "Banxico FIX" })).status).toBe(400);
    expect((await put({ fecha: "2026-09-01", mxnPorUsd: 18, fuente: "x" })).status).toBe(400);
    expect((await put({ fecha: "2026-09-01", mxnPorUsd: 18.25, fuente: "Banxico FIX" })).status).toBe(200);
    const lista = (await (await get(t.app, "/superadmin/costos/tipo-cambio", sa.token)).json()) as { tiposDeCambio: FxRateRow[] };
    expect(lista.tiposDeCambio).toEqual([{ fecha: "2026-09-01", mxnPorUsd: 18.25, fuente: "Banxico FIX" }]);
  });

  it("elegirTipoCambio: el mas reciente que no pase del fin de mes (o de hoy en el mes en curso)", () => {
    const rates: FxRateRow[] = [
      { fecha: "2026-09-25", mxnPorUsd: 20, fuente: "a" },
      { fecha: "2026-09-02", mxnPorUsd: 19, fuente: "b" },
      { fecha: "2026-08-20", mxnPorUsd: 18, fuente: "c" },
    ];
    expect(elegirTipoCambio(rates, "2026-09", "2026-09-10")?.mxnPorUsd).toBe(19);
    expect(elegirTipoCambio(rates, "2026-08", "2026-09-10")?.mxnPorUsd).toBe(18);
    expect(elegirTipoCambio(rates, "2026-07", "2026-09-10")).toBeNull();
  });
});

describe("catalogo de planes", () => {
  it("lista los seeds de las 6 verticales; las 3 sin precio conocido quedan en null", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    const body = (await (await get(t.app, "/superadmin/planes", sa.token)).json()) as { disponible: boolean; planes: Array<{ id: string; vertical: string; precioAsientoMxn: number | null }>; catalogo: { verticales: string[] } };
    expect(body.disponible).toBe(true);
    expect(body.planes.map((p) => p.vertical).sort()).toEqual(["citas", "despachos", "hoteles", "licitaciones", "rentas", "restaurantes"]);
    expect(body.planes.find((p) => p.id === "hoteles-estandar")?.precioAsientoMxn).toBe(89);
    expect(body.planes.find((p) => p.id === "rentas-estandar")?.precioAsientoMxn).toBeNull();
    expect(body.catalogo.verticales).toHaveLength(6);
  });

  it("PUT plan valida id, vertical, decimales y negativos; guarda en pesos y los muestra en pesos", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    const put = (id: string, body: unknown) => req(t.app, "PUT", `/superadmin/planes/${id}`, body, bearer(sa.token));
    expect((await put("X", { nombre: "Plan X", vertical: "citas" })).status).toBe(400);
    expect((await put("plan-x", { nombre: "P", vertical: "citas" })).status).toBe(400);
    expect((await put("plan-x", { nombre: "Plan X", vertical: "gimnasios" })).status).toBe(400);
    expect((await put("plan-x", { nombre: "Plan X", vertical: "citas", precioBaseMxn: -5 })).status).toBe(400);
    expect((await put("plan-x", { nombre: "Plan X", vertical: "citas", precioBaseMxn: 10.123 })).status).toBe(400);
    expect((await put("plan-x", { nombre: "Plan X", vertical: "citas", asientosIncluidos: 1.5 })).status).toBe(400);
    expect((await put("plan-x", { nombre: "Plan X", vertical: "citas", precioBaseMxn: 1999.5, precioAsientoMxn: 599 })).status).toBe(200);
    const body = (await (await get(t.app, "/superadmin/planes", sa.token)).json()) as { planes: Array<{ id: string; precioBaseMxn: number | null; precioAsientoMxn: number | null; activo: boolean }> };
    expect(body.planes.find((p) => p.id === "plan-x")).toMatchObject({ precioBaseMxn: 1999.5, precioAsientoMxn: 599, activo: true });
  });

  it("limites: valida metrica/accion/entero; un limite LLM pausar en 0 se rechaza; borrar uno inexistente 404", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    const put = (metrica: string, body: unknown) => req(t.app, "PUT", `/superadmin/planes/restaurantes-estandar/limites/${metrica}`, body, bearer(sa.token));
    expect((await put("cafes_mes", { limite: 5, accion: "avisar" })).status).toBe(400);
    expect((await put("mensajes_mes", { limite: 5.5, accion: "avisar" })).status).toBe(400);
    expect((await put("mensajes_mes", { limite: 5, accion: "destruir" })).status).toBe(400);
    expect((await put("llm_costo_micro_usd_mes", { limite: 0, accion: "pausar" })).status).toBe(400);
    expect((await put("mensajes_mes", { limite: 5000, accion: "avisar" })).status).toBe(200);
    expect((await req(t.app, "PUT", "/superadmin/planes/no-existe/limites/mensajes_mes", { limite: 1, accion: "avisar" }, bearer(sa.token))).status).toBe(404);
    expect((await req(t.app, "DELETE", "/superadmin/planes/restaurantes-estandar/limites/mensajes_mes", {}, bearer(sa.token))).status).toBe(200);
    expect((await req(t.app, "DELETE", "/superadmin/planes/restaurantes-estandar/limites/mensajes_mes", {}, bearer(sa.token))).status).toBe(404);
  });
});

describe("asignacion de plan en dos pasos", () => {
  type Asig = { id: string; estado: string; resultado: Record<string, unknown> | null };
  const solicitar = (t: Awaited<ReturnType<typeof setup>>, token: string, body: unknown) => req(t.app, "POST", "/superadmin/planes/asignaciones", body, bearer(token));
  const confirmar = (t: Awaited<ReturnType<typeof setup>>, token: string, id: string) => req(t.app, "POST", `/superadmin/planes/asignaciones/${id}/confirmar`, {}, bearer(token));

  it("solicitar NO asigna; confirmar asigna y aplica el tope LLM del plan (pausar); el reporte lo refleja", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    await t.costos.setPlanLimit(sa.id, "restaurantes-estandar", "llm_costo_micro_usd_mes", 25_000_000, "pausar");
    const sol = await solicitar(t, sa.token, { organizationId: t.org, planId: "restaurantes-estandar", motivo: MOTIVO });
    expect(sol.status).toBe(201);
    const { asignacion } = (await sol.json()) as { asignacion: Asig };
    expect(asignacion.estado).toBe("pending");
    expect(t.costos.organizationPlanId(t.org)).toBeUndefined();

    const conf = await confirmar(t, sa.token, asignacion.id);
    expect(conf.status).toBe(200);
    expect(((await conf.json()) as { asignacion: Asig }).asignacion).toMatchObject({ estado: "executed", resultado: { plan: "restaurantes-estandar", llm_tope_aplicado_micro_usd: 25_000_000 } });
    expect(t.costos.organizationPlanId(t.org)).toBe("restaurantes-estandar");
    expect(t.costos.organizationLlmCap(t.org)).toBe(25_000_000);
  });

  it("un limite LLM con 'avisar' NO toca el tope", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    await t.costos.setPlanLimit(sa.id, "restaurantes-estandar", "llm_costo_micro_usd_mes", 25_000_000, "avisar");
    const { asignacion } = (await (await solicitar(t, sa.token, { organizationId: t.org, planId: "restaurantes-estandar", motivo: MOTIVO })).json()) as { asignacion: Asig };
    await confirmar(t, sa.token, asignacion.id);
    expect(t.costos.organizationLlmCap(t.org)).toBeNull();
  });

  it("valida body: UUID, planId, motivo corto", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    expect((await solicitar(t, sa.token, { organizationId: "x", planId: "restaurantes-estandar", motivo: MOTIVO })).status).toBe(400);
    expect((await solicitar(t, sa.token, { organizationId: t.org, planId: "X", motivo: MOTIVO })).status).toBe(400);
    expect((await solicitar(t, sa.token, { organizationId: t.org, planId: "restaurantes-estandar", motivo: "corto" })).status).toBe(400);
  });

  it("reglas de negocio: vertical distinta 400, plan inexistente 404, una pendiente por organizacion 409, mismo plan 409", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    expect((await solicitar(t, sa.token, { organizationId: t.org, planId: "hoteles-estandar", motivo: MOTIVO })).status).toBe(400);
    expect((await solicitar(t, sa.token, { organizationId: t.org, planId: "plan-que-no-existe", motivo: MOTIVO })).status).toBe(404);
    const ok = await solicitar(t, sa.token, { organizationId: t.org, planId: "restaurantes-estandar", motivo: MOTIVO });
    expect(ok.status).toBe(201);
    expect((await solicitar(t, sa.token, { organizationId: t.org, planId: "restaurantes-estandar", motivo: MOTIVO })).status).toBe(409);
    const { asignacion } = (await ok.json()) as { asignacion: Asig };
    await confirmar(t, sa.token, asignacion.id);
    expect((await solicitar(t, sa.token, { organizationId: t.org, planId: "restaurantes-estandar", motivo: MOTIVO })).status).toBe(409);
  });

  it("solo el solicitante confirma/cancela (otro superadmin 403); no se confirma dos veces ni tras cancelar", async () => {
    const t = await setup();
    const ana = await t.superadmin();
    const beto = await t.superadmin();
    const { asignacion } = (await (await solicitar(t, ana.token, { organizationId: t.org, planId: "restaurantes-estandar", motivo: MOTIVO })).json()) as { asignacion: Asig };
    expect((await confirmar(t, beto.token, asignacion.id)).status).toBe(403);
    expect((await req(t.app, "POST", `/superadmin/planes/asignaciones/${asignacion.id}/cancelar`, {}, bearer(beto.token))).status).toBe(403);
    expect(t.costos.organizationPlanId(t.org)).toBeUndefined();
    expect((await req(t.app, "POST", `/superadmin/planes/asignaciones/${asignacion.id}/cancelar`, {}, bearer(ana.token))).status).toBe(200);
    expect((await confirmar(t, ana.token, asignacion.id)).status).toBe(409);
    expect((await confirmar(t, ana.token, "no-es-uuid")).status).toBe(400);
  });

  it("una solicitud vencida responde 409 al confirmar y no asigna; una pendiente vencida no bloquea una nueva", async () => {
    let ahora = T0;
    const t = await setup({ reloj: () => ahora });
    const sa = await t.superadmin();
    const { asignacion } = (await (await solicitar(t, sa.token, { organizationId: t.org, planId: "restaurantes-estandar", motivo: MOTIVO })).json()) as { asignacion: Asig };
    ahora += 11 * 60_000;
    const lista = (await (await get(t.app, "/superadmin/planes/asignaciones", sa.token)).json()) as { asignaciones: Asig[] };
    expect(lista.asignaciones[0]!.estado).toBe("expired");
    expect((await confirmar(t, sa.token, asignacion.id)).status).toBe(409);
    expect(t.costos.organizationPlanId(t.org)).toBeUndefined();
    expect((await solicitar(t, sa.token, { organizationId: t.org, planId: "restaurantes-estandar", motivo: MOTIVO })).status).toBe(201);
  });

  it("organizacion suspendida: no se le asigna plan", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    t.costos.seedOrganization("00000000-0000-4000-8000-0000000000aa", { vertical: "citas", name: "Clinica suspendida", slug: "clinica-suspendida", status: "suspended" });
    expect((await solicitar(t, sa.token, { organizationId: "00000000-0000-4000-8000-0000000000aa", planId: "citas-estandar", motivo: MOTIVO })).status).toBe(409);
  });
});

describe("step-up en las acciones sensibles del catalogo", () => {
  async function conFactorActivo() {
    const t = await setup();
    const sa = await t.superadmin();
    const enr = await req(t.app, "POST", "/superadmin/mfa/enrolar", {}, bearer(sa.token));
    const { secreto } = (await enr.json()) as { secreto: string };
    const ver = await req(t.app, "POST", "/superadmin/mfa/verificar", { codigo: totpAt(secreto, Date.now()) }, bearer(sa.token));
    const { stepUpToken } = (await ver.json()) as { stepUpToken: string };
    return { t, sa, stepUpToken };
  }

  it("con factor ACTIVO: tipo de cambio, editar plan, limites y confirmar asignacion exigen x-stepup-token; las lecturas y solicitar no", async () => {
    const { t, sa, stepUpToken } = await conFactorActivo();
    const sin = bearer(sa.token);
    const con = bearer(sa.token, { "x-stepup-token": stepUpToken });

    for (const [method, path, body] of [
      ["PUT", "/superadmin/costos/tipo-cambio", { fecha: "2026-09-01", mxnPorUsd: 18, fuente: "Banxico FIX" }],
      ["PUT", "/superadmin/planes/plan-x", { nombre: "Plan X", vertical: "citas" }],
      ["PUT", "/superadmin/planes/restaurantes-estandar/limites/mensajes_mes", { limite: 5, accion: "avisar" }],
      ["DELETE", "/superadmin/planes/restaurantes-estandar/limites/mensajes_mes", {}],
    ] as const) {
      const r = await req(t.app, method, path, body, sin);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(await r.json()).toMatchObject({ code: "stepup_required" });
    }

    // solicitar y leer no son sensibles
    expect((await get(t.app, "/superadmin/planes", sa.token)).status).toBe(200);
    const sol = await req(t.app, "POST", "/superadmin/planes/asignaciones", { organizationId: t.org, planId: "restaurantes-estandar", motivo: MOTIVO }, sin);
    expect(sol.status).toBe(201);
    const { asignacion } = (await sol.json()) as { asignacion: { id: string } };

    // confirmar SI: sin token 403 y nada se asigna; con token, 200
    const noConf = await req(t.app, "POST", `/superadmin/planes/asignaciones/${asignacion.id}/confirmar`, {}, sin);
    expect(noConf.status).toBe(403);
    expect(t.costos.organizationPlanId(t.org)).toBeUndefined();
    expect((await req(t.app, "POST", `/superadmin/planes/asignaciones/${asignacion.id}/confirmar`, {}, con)).status).toBe(200);
    expect(t.costos.organizationPlanId(t.org)).toBe("restaurantes-estandar");
    expect((await req(t.app, "PUT", "/superadmin/costos/tipo-cambio", { fecha: "2026-09-01", mxnPorUsd: 18, fuente: "Banxico FIX" }, con)).status).toBe(200);
  });
});
