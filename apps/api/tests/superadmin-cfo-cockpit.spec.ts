// CFO de la plataforma (cockpit): rutas de punta a punta contra los repos en memoria. La autorizacion
// real en SQL se verifica en scripts/verify-superadmin-cfo-cockpit/ (0085).
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCfoCockpitRepository, InMemoryCfoRepository, InMemoryPylRepository } from "@atiende/db";
import type { BillingSnapshotRow, CfoOrgRow, UsoCfoRow } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { isSensitiveRoute } from "../src/superadmin-seguridad/step-up.ts";
import { rutaFinanciera } from "../src/superadmin-seguridad/zona-cfo.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";

afterEach(() => vi.useRealTimers());

const T0 = new Date("2026-11-15T12:00:00.000Z").getTime();

function fila(id: string, parche: Partial<CfoOrgRow> = {}): CfoOrgRow {
  return {
    organizationId: id, organizationName: `Org ${id}`, organizationSlug: `org-${id}`, vertical: "restaurantes", orgStatus: "active",
    planId: "rest", planNombre: "Restaurantes", precioBaseCentavos: 300000, precioAsientoCentavos: null, asientosIncluidos: 0,
    billingStatus: "activa", billingSeats: null, sucursalesActivas: 1,
    llmMicroUsd: 0, vozMicroUsd: 0, whatsappMicroUsd: 0, telefoniaMicroUsd: 0, otrosMicroUsd: 0,
    eventosTotal: 0, eventosEstimados: 0, minutosVoz: 0, mensajes: 0, llmCapMicroUsd: 900_000_000, llmAlertPct: 80,
    billingPeriodEndMs: null, limites: [], mxnPorUsd: 20, fxFecha: "2026-11-06", fxFuente: "Banxico FIX", ...parche,
  };
}

function uso(id: string, mes: string, parche: Partial<UsoCfoRow> = {}): UsoCfoRow {
  return {
    organizationId: id, mes, vertical: "restaurantes", llmMicroUsd: 0, eventosMicroUsd: 0, llamadas: 0, segundosVoz: 0, segundosPorProveedor: {},
    pedidos: 0, pedidosVoz: 0, pedidosWhatsapp: 0, conversacionesWa: null, minutosFacturables: null, plan: null, ...parche,
  };
}

const foto = (organizationId: string, mes: string, mrrCentavos: number | null): BillingSnapshotRow => ({
  organizationId, mes, vertical: "restaurantes", orgStatus: "active", planId: "rest", billingStatus: "activa", mrrCentavos, mrrRazon: mrrCentavos === null ? "sin_plan" : null,
});

async function setup(opciones: { cockpit?: InMemoryCfoCockpitRepository | null; cfo?: InMemoryCfoRepository | null } = {}) {
  const s = await seguridadSetup();
  const cfo = opciones.cfo === undefined ? new InMemoryCfoRepository() : opciones.cfo;
  cfo?.seedRows([fila("a"), fila("b", { organizationName: "Org b", planId: null, planNombre: null, precioBaseCentavos: null })]);
  cfo?.seedSnapshots([foto("a", "2026-10-01", 300000)]);
  const cockpit = opciones.cockpit === undefined ? new InMemoryCfoCockpitRepository({ now: () => T0 }) : opciones.cockpit;
  cockpit?.seedUso([
    uso("a", "2026-11-01", { llamadas: 10, segundosVoz: 1800, segundosPorProveedor: { "elevenlabs-agents": 1800 }, pedidos: 7 }),
    uso("a", "2026-10-01", { llamadas: 31, segundosVoz: 5580, segundosPorProveedor: { "elevenlabs-agents": 5580 } }),
    uso("b", "2026-11-01"),
  ]);
  const pyl = new InMemoryPylRepository({ now: () => T0 });
  const deps = { ...s.deps, ...(cfo ? { cfoRepo: () => cfo } : {}), ...(cockpit ? { cfoCockpitRepo: () => cockpit } : {}), pylRepo: () => pyl };
  const app = buildApp(deps);
  return {
    s, cfo, cockpit, app,
    async superadmin() {
      const sa = await s.superadmin();
      cfo?.seedSuperadmin(sa.id);
      cockpit?.seedSuperadmin(sa.id);
      pyl.seedSuperadmin(sa.id);
      return sa;
    },
  };
}

const get = (app: ReturnType<typeof buildApp>, path: string, token: string) => app.request(path, { headers: bearer(token) });
const put = (app: ReturnType<typeof buildApp>, path: string, body: unknown, token: string) =>
  app.request(path, { method: "PUT", headers: { ...bearer(token), "content-type": "application/json" }, body: JSON.stringify(body) });

interface CockpitBody {
  disponible: boolean;
  mensaje?: string;
  enCurso: boolean;
  diasTranscurridos: number;
  economia: Array<{ organizationId: string; mrrMxn: number | null; ingresoMxn: number | null; costoDirectoMxn: number | null; costo: { voz: { usd: number | null; fuente: string } }; uso: { duracionPromedioMin: number | null }; proyeccion: { costoMxn: number | null } }>;
  agregados: { total: { clientes: number } };
  saas: { mrrMxn: number; serie: Array<{ mes: string; mrrMxn: number }> };
  faltantes: string[];
}

describe("gateo, rutas sensibles y zona CFO", () => {
  it("staff 403 y sin token 401 en lectura, exportacion y capturas", async () => {
    const t = await setup();
    const st = await t.s.staff();
    expect((await get(t.app, "/superadmin/cfo/cockpit", st.token)).status).toBe(403);
    expect((await get(t.app, "/superadmin/cfo/cockpit/export.csv", st.token)).status).toBe(403);
    expect((await put(t.app, "/superadmin/cfo/capturas", { mes: "2026-11", tipo: "gasto_fijo", concepto: "Nomina", montoMxn: 1 }, st.token)).status).toBe(403);
    expect((await t.app.request("/superadmin/cfo/cockpit")).status).toBe(401);
  });

  it("los PUT y la exportacion exigen step-up; las lecturas quedan en la bitacora de la zona CFO", () => {
    expect(isSensitiveRoute("PUT", "/superadmin/cfo/supuestos")).toBe(true);
    expect(isSensitiveRoute("PUT", "/superadmin/cfo/capturas")).toBe(true);
    expect(isSensitiveRoute("GET", "/superadmin/cfo/cockpit/export.csv")).toBe(true);
    expect(isSensitiveRoute("GET", "/superadmin/cfo/cockpit")).toBe(false);
    expect(rutaFinanciera("GET", "/superadmin/cfo/cockpit")).toMatchObject({ recurso: "cfo/cockpit", finanzas: true });
    expect(rutaFinanciera("GET", "/superadmin/cfo/cockpit/export.csv")).toMatchObject({ exportacion: true });
  });
});

describe("GET /superadmin/cfo/cockpit", () => {
  it("arma economia, agregados, serie de MRR y lo que falta capturar", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const t = await setup();
    const sa = await t.superadmin();
    const res = await get(t.app, "/superadmin/cfo/cockpit?mes=2026-11", sa.token);
    expect(res.status).toBe(200);
    const b = (await res.json()) as CockpitBody;
    expect(b).toMatchObject({ disponible: true, enCurso: true, diasTranscurridos: 15 });
    const a = b.economia.find((f) => f.organizationId === "a")!;
    expect(a.costo.voz).toEqual({ usd: 1.35, fuente: "modelado" }); // 30 min x 0.045 USD medidos
    expect(a.uso.duracionPromedioMin).toBe(3);
    expect(a.costoDirectoMxn).toBe(27); // 1.35 x 20
    expect(a.proyeccion.costoMxn).toBe(54); // 15 de 30 dias
    expect(b.economia.find((f) => f.organizationId === "b")!.mrrMxn).toBeNull();
    expect(b.agregados.total.clientes).toBe(2);
    expect(b.saas.mrrMxn).toBe(3000);
    expect(b.saas.serie.map((p) => p.mes)).toEqual(["2026-10", "2026-11"]);
    expect(b.faltantes.join(" ")).toMatch(/gastos fijos/);
    expect(b.faltantes.join(" ")).toMatch(/marketing/);
    expect(b.faltantes.join(" ")).toMatch(/medidor de cobro/);
  });

  it("valida el mes (formato y futuro)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const t = await setup();
    const sa = await t.superadmin();
    expect((await get(t.app, "/superadmin/cfo/cockpit?mes=2026-13", sa.token)).status).toBe(400);
    expect((await get(t.app, "/superadmin/cfo/cockpit?mes=2026-12", sa.token)).status).toBe(400);
  });

  it("sin 0030 responde «no disponible»; sin 0085 se arma igual y lo declara", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const sin = await setup({ cfo: null });
    const sa1 = await sin.superadmin();
    expect(await (await get(sin.app, "/superadmin/cfo/cockpit", sa1.token)).json()).toMatchObject({ disponible: false });
    const viejo = await setup({ cockpit: new InMemoryCfoCockpitRepository({ migrado: false }) });
    const sa2 = await viejo.superadmin();
    const b = (await (await get(viejo.app, "/superadmin/cfo/cockpit", sa2.token)).json()) as CockpitBody;
    expect(b.disponible).toBe(true);
    expect(b.faltantes[0]).toMatch(/0085/);
    expect((await put(viejo.app, "/superadmin/cfo/supuestos", { clave: "umbral_margen_pct", valor: 40, fuente: "dueño" }, sa2.token)).status).toBe(503);
  });
});

describe("supuestos y capturas", () => {
  it("un costo de voz capturado cambia el costo del cockpit y queda en la bitacora", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const t = await setup();
    const sa = await t.superadmin();
    expect((await put(t.app, "/superadmin/cfo/supuestos", { clave: "voz_usd_minuto", proveedor: "elevenlabs-agents", valor: 0.1, fuente: "Factura de octubre" }, sa.token)).status).toBe(200);
    const b = (await (await get(t.app, "/superadmin/cfo/cockpit", sa.token)).json()) as CockpitBody;
    expect(b.economia.find((f) => f.organizationId === "a")!.costo.voz.usd).toBe(3);
    expect(t.cockpit!.bitacora.at(-1)).toMatchObject({ evento: "supuesto_set", detalle: { clave: "voz_usd_minuto", valor: 0.1 } });
    const lista = (await (await get(t.app, "/superadmin/cfo/supuestos", sa.token)).json()) as { supuestos: unknown[] };
    expect(lista.supuestos).toHaveLength(1);
  });

  it("valida clave, proveedor, valor y fuente (400)", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    expect((await put(t.app, "/superadmin/cfo/supuestos", { clave: "inventada", valor: 1, fuente: "xxx" }, sa.token)).status).toBe(400);
    expect((await put(t.app, "/superadmin/cfo/supuestos", { clave: "umbral_margen_pct", proveedor: "elevenlabs-agents", valor: 1, fuente: "xxx" }, sa.token)).status).toBe(400);
    expect((await put(t.app, "/superadmin/cfo/supuestos", { clave: "umbral_margen_pct", valor: -1, fuente: "xxx" }, sa.token)).status).toBe(400);
    expect((await put(t.app, "/superadmin/cfo/supuestos", { clave: "umbral_margen_pct", valor: 30 }, sa.token)).status).toBe(400);
  });

  it("captura gasto fijo, marketing y presupuesto; rechaza gasto futuro y decimales de mas", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const t = await setup();
    const sa = await t.superadmin();
    expect((await put(t.app, "/superadmin/cfo/capturas", { mes: "2026-11", tipo: "gasto_fijo", concepto: "Nómina", montoMxn: 50000 }, sa.token)).status).toBe(200);
    expect((await put(t.app, "/superadmin/cfo/capturas", { mes: "2026-11", tipo: "marketing", concepto: "Meta Ads", montoMxn: 3000.5 }, sa.token)).status).toBe(200);
    expect((await put(t.app, "/superadmin/cfo/capturas", { mes: "2027-01", tipo: "presupuesto_ingreso", concepto: "Meta MRR", montoMxn: 10000 }, sa.token)).status).toBe(200);
    expect((await put(t.app, "/superadmin/cfo/capturas", { mes: "2026-12", tipo: "gasto_fijo", concepto: "Renta", montoMxn: 1 }, sa.token)).status).toBe(400);
    expect((await put(t.app, "/superadmin/cfo/capturas", { mes: "2026-11", tipo: "gasto_fijo", concepto: "Renta", montoMxn: 1.005 }, sa.token)).status).toBe(400);
    const caps = (await (await get(t.app, "/superadmin/cfo/capturas", sa.token)).json()) as { capturas: Array<{ tipo: string; montoMxnCentavos: number }> };
    expect(caps.capturas.map((c) => c.tipo).sort()).toEqual(["gasto_fijo", "marketing", "presupuesto_ingreso"]);
    const b = (await (await get(t.app, "/superadmin/cfo/cockpit", sa.token)).json()) as CockpitBody;
    expect(b.faltantes.join(" ")).not.toMatch(/gastos fijos/);
  });
});

describe("GET /superadmin/cfo/cockpit/export.csv", () => {
  it("CSV con BOM, cabecera estable, cifras sin fuente vacias y sin cache", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const t = await setup();
    const sa = await t.superadmin();
    const res = await get(t.app, "/superadmin/cfo/cockpit/export.csv?mes=2026-11", sa.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const [cab, ...filas] = new TextDecoder().decode(bytes).trim().split("\r\n");
    expect(cab!.split(",").slice(0, 3)).toEqual(["mes", "organizacion_id", "cliente"]);
    const b = filas.find((l) => l.includes(",b,"))!;
    expect(b.split(",")[8]).toBe(""); // mrr_mxn sin plan: vacio, nunca 0
  });
});
