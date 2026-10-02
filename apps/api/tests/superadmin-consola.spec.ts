// Consola de superadmin (SA-L-05 resumen, SA-L-06 actividad de agentes): rutas de punta a punta contra los repos en
// memoria. La autorizacion real en SQL se verifica en scripts/verify-superadmin-consola/.
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCfoRepository, InMemoryCfoZoneRepository, InMemoryConsolaRepository, InMemorySaludRepository } from "@atiende/db";
import type { CfoOrgRow, ConsolaCostoDiarioRow } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { rutasDeCronDeclaradas } from "../src/salud/cadencia.ts";
import { AGENTES_CRON } from "../src/consola/agentes-cron.ts";
import { delta7d, hoyMexico, medianocheMexicoIso, POLITICA_MRR_RESUMEN, sumarDias } from "../src/routes/superadmin-consola.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";

afterEach(() => vi.useRealTimers());

// 1-oct 05:30 UTC = 30-sep 23:30 en Ciudad de Mexico: en UTC ya es "mañana", en Mexico todavia es el 30-sep.
const T_2330_CDMX = new Date("2026-10-01T05:30:00.000Z");
const T_MEDIODIA = new Date("2026-09-30T18:00:00.000Z");

function fila(id: string, parche: Partial<CfoOrgRow> = {}): CfoOrgRow {
  return {
    organizationId: id, organizationName: `Org Secreta ${id}`, organizationSlug: `org-${id}`, vertical: "restaurantes", orgStatus: "active",
    planId: "restaurantes-estandar", planNombre: "Restaurantes", precioBaseCentavos: 0, precioAsientoCentavos: 79900, asientosIncluidos: 1,
    billingStatus: null, billingSeats: null, sucursalesActivas: 3, // (3 - 1) x 799 = 1,598 MXN
    llmMicroUsd: 0, vozMicroUsd: 0, whatsappMicroUsd: 0, telefoniaMicroUsd: 0, otrosMicroUsd: 0,
    eventosTotal: 0, eventosEstimados: 0, minutosVoz: 0, mensajes: 0, llmCapMicroUsd: 900_000_000, llmAlertPct: 80,
    billingPeriodEndMs: null, limites: [], mxnPorUsd: 20, fxFecha: "2026-09-01", fxFuente: "Banxico FIX", ...parche,
  };
}
const FILAS: CfoOrgRow[] = [
  fila("a"),
  fila("b", { vertical: "hoteles", planId: "hoteles-estandar", precioAsientoCentavos: 8900, asientosIncluidos: 5, sucursalesActivas: 15 }), // 890 MXN
  fila("d", { vertical: "rentas", planId: "rentas-estandar", precioBaseCentavos: null, precioAsientoCentavos: null, asientosIncluidos: 0 }), // sin precio
  fila("e", { vertical: "despachos", planId: null, planNombre: null, precioBaseCentavos: null, precioAsientoCentavos: null, asientosIncluidos: null }), // sin plan -> sin precio
  fila("f", { orgStatus: "trial" }), // en prueba: no cuenta
];

const dia = (d: string, llm: number, ev: number, tokens: number): ConsolaCostoDiarioRow => ({ dia: d, llmMicroUsd: llm, eventosMicroUsd: ev, tokens });

async function setup(opciones: { consola?: InMemoryConsolaRepository | null; cfo?: InMemoryCfoRepository | null; zona?: InMemoryCfoZoneRepository | null } = {}) {
  const s = await seguridadSetup();
  const consola = opciones.consola === undefined ? new InMemoryConsolaRepository() : opciones.consola;
  const cfo = opciones.cfo === undefined ? new InMemoryCfoRepository() : opciones.cfo;
  const zona = opciones.zona === undefined ? new InMemoryCfoZoneRepository() : opciones.zona;
  cfo?.seedRows(FILAS);
  const deps = { ...s.deps, ...(consola ? { consolaRepo: () => consola } : {}), ...(cfo ? { cfoRepo: () => cfo } : {}), ...(zona ? { cfoZoneRepo: () => zona } : {}) };
  const app = buildApp(deps);
  return {
    s, consola, cfo, zona, app, deps,
    async superadmin() {
      const sa = await s.superadmin();
      consola?.seedSuperadmin(sa.id);
      cfo?.seedSuperadmin(sa.id);
      zona?.seedSuperadmin(sa.id);
      (deps.saludRepo as InMemorySaludRepository).addPlatformSuperadmin(sa.id);
      return sa;
    },
  };
}
const get = (app: ReturnType<typeof buildApp>, path: string, token: string) => app.request(path, { headers: bearer(token) });

function sembrarTodo(c: InMemoryConsolaRepository): void {
  c.seed({
    organizaciones: { ok: true, data: [{ vertical: "restaurantes", total: 3, demo: 1, activas: 2 }, { vertical: "hoteles", total: 1, demo: 0, activas: 1 }] },
    costoDiario: { ok: true, data: [dia("2026-09-30", 2_000_000, 500_000, 150)] },
    costoHistorico: {
      ok: true,
      data: [
        { fuente: "llm", costoMicroUsd: 4_000_000, tokensIn: 1000, tokensOut: 500, eventos: 10, minutosVoz: null },
        { fuente: "voz", costoMicroUsd: 600_000, tokensIn: null, tokensOut: null, eventos: 2, minutosVoz: 12.5 },
        { fuente: "whatsapp", costoMicroUsd: 400_000, tokensIn: null, tokensOut: null, eventos: 40, minutosVoz: null },
      ],
    },
    operaciones: {
      ok: true,
      data: [
        { vertical: "restaurantes", dia: null, cantidad: 30, razon: null },
        { vertical: "restaurantes", dia: "2026-09-30", cantidad: 4, razon: null },
        { vertical: "hoteles", dia: null, cantidad: 5, razon: null },
        { vertical: "hoteles", dia: "2026-09-30", cantidad: 1, razon: null },
        { vertical: "citas", dia: null, cantidad: null, razon: "fuente_no_migrada" },
        { vertical: "despachos", dia: null, cantidad: null, razon: "sin_fuente" },
      ],
    },
    alcance: { ok: true, data: { sucursalesActivas: 7, staffConMembresia: 9, superadmins: 2, usuariosConAcceso: 10 } },
    conversacionesWa: {
      ok: true,
      data: [
        { vertical: "restaurantes", total: 20, razon: null },
        { vertical: "hoteles", total: 5, razon: null },
        { vertical: "rentas", total: null, razon: "sin_whatsapp" },
      ],
    },
    resueltasSinHumano: { ok: true, data: { total: 8, resueltasSinHumano: 6, razon: null } },
    agentesActividad: { ok: true, data: [] },
  });
}

describe("seguridad", () => {
  it("sin sesion 401, staff normal 403, y el superadmin lee sin step-up", async () => {
    const t = await setup();
    const st = await t.s.staff();
    for (const ruta of ["/superadmin/consola/resumen", "/superadmin/consola/agentes-actividad"]) {
      expect((await t.app.request(ruta)).status).toBe(401);
      expect((await get(t.app, ruta, st.token)).status).toBe(403);
    }
    const sa = await t.superadmin();
    expect((await get(t.app, "/superadmin/consola/resumen", sa.token)).status).toBe(200);
    expect((await get(t.app, "/superadmin/consola/agentes-actividad", sa.token)).status).toBe(200);
  });

  it("son rutas de solo lectura: un POST no existe (el guard de impersonacion bloquea escrituras en /superadmin/*)", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    const res = await t.app.request("/superadmin/consola/resumen", { method: "POST", headers: bearer(sa.token) });
    expect([404, 405]).toContain(res.status);
  });

  it("el rol finanzas queda fuera (la zona CFO es lista blanca) y su intento queda denegado en la bitacora", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    t.zona!.seedRole(sa.id);
    const res = await get(t.app, "/superadmin/consola/resumen", sa.token);
    expect(res.status).toBe(403);
    expect(t.zona!.entries().some((e) => e.accion === "denegado")).toBe(true);
  });
});

describe("GET /superadmin/consola/resumen", () => {
  it("compone cada campo desde su fuente (sin desglose por cliente en el MRR)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T_MEDIODIA);
    const t = await setup();
    sembrarTodo(t.consola!);
    const sa = await t.superadmin();
    const res = await get(t.app, "/superadmin/consola/resumen", sa.token);
    const texto = await res.text();
    const b = JSON.parse(texto);
    expect(b.disponible).toBe(true);
    expect(b.hoy).toBe("2026-09-30");
    expect(b.organizaciones.valor.total).toBe(4);
    expect(b.organizaciones.valor.demo).toBe(1);
    expect(b.organizaciones.valor.porVertical).toHaveLength(6);
    expect(b.gastoIa.valor.totalUsd).toBe(5);
    expect(b.gastoIa.valor.llmUsd).toBe(4);
    expect(b.gastoIa.valor.porCategoria).toEqual([{ categoria: "voz", usd: 0.6 }, { categoria: "whatsapp", usd: 0.4 }]);
    expect(b.tokens.valor).toEqual({ total: 1500, entrada: 1000, salida: 500 });
    expect(b.vozMinutos.valor).toBe(12.5);
    expect(b.sucursales.valor).toBe(7);
    expect(b.usuarios.valor).toEqual({ total: 10, staff: 9, superadmins: 2 });
    expect(b.conversacionesWa.valor.total).toBe(25);
    expect(b.resueltasSinHumano.valor).toMatchObject({ resueltas: 6, total: 8, porcentaje: 75, nota: "medido solo en restaurantes" });
    // Operaciones: suma solo las verticales con fuente y marca el resto con su razon (nunca un 0).
    expect(b.operaciones.valor.total).toBe(35);
    expect(b.operaciones.valor.verticalesSinFuente.sort()).toEqual(["citas", "despachos", "licitaciones", "rentas"]);
    const despachos = b.operaciones.valor.porVertical.find((v: { vertical: string }) => v.vertical === "despachos");
    expect(despachos).toMatchObject({ total: null, codigo: "sin_fuente" });
    expect(b.operaciones.valor.serie14d).toHaveLength(14);
    expect(b.operaciones.valor.serie14d.at(-1)).toEqual({ dia: "2026-09-30", cantidad: 5 });
    // MRR: solo el total; 1,598 + 890; rentas y despachos sin precio se cuentan aparte; el trial no cuenta.
    expect(b.mrr.valor).toEqual({ totalMxn: 2488, organizacionesConPrecio: 2, organizacionesSinPrecio: 2 });
    expect(texto).not.toMatch(/Org Secreta/);
    expect(b.politicaMrr).toEqual({ requiereStepUp: false, recursoBitacora: "resumen_mrr", desglosePorCliente: false });
  });

  it("una fuente que falla deja SOLO ese campo en null con su razon; las demas siguen", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T_MEDIODIA);
    const t = await setup();
    sembrarTodo(t.consola!);
    t.consola!.seed({ costoHistorico: { ok: false, razon: "error" }, alcance: { ok: false, razon: "no_migrado" } });
    const sa = await t.superadmin();
    const b = await (await get(t.app, "/superadmin/consola/resumen", sa.token)).json();
    for (const campo of ["gastoIa", "tokens", "vozMinutos"]) expect(b[campo]).toMatchObject({ valor: null, codigo: "error" });
    for (const campo of ["sucursales", "usuarios"]) expect(b[campo]).toMatchObject({ valor: null, codigo: "no_migrado" });
    expect(b.organizaciones.valor.total).toBe(4);
    expect(b.operaciones.valor.total).toBe(35);
    expect(b.conversacionesWa.valor.total).toBe(25);
    expect(b.mrr.valor.totalMxn).toBe(2488);
    expect(b.disponible).toBe(true);
  });

  it("la serie de gasto falla pero el historico no: el total sigue y solo serie y delta quedan null", async () => {
    const t = await setup();
    sembrarTodo(t.consola!);
    t.consola!.seed({ costoDiario: { ok: false, razon: "error" } });
    const sa = await t.superadmin();
    const b = await (await get(t.app, "/superadmin/consola/resumen", sa.token)).json();
    expect(b.gastoIa.valor.totalUsd).toBe(5);
    expect(b.gastoIa.valor.serie14d.valor).toBeNull();
    expect(b.gastoIa.valor.delta7d.valor).toBeNull();
  });

  it("base sin migrar: 200 con disponible false y mensaje, todo en null, nunca 500 ni ceros", async () => {
    for (const consola of [null, new InMemoryConsolaRepository()]) {
      const t = await setup({ consola, cfo: null, zona: null });
      const sa = await t.superadmin();
      const res = await get(t.app, "/superadmin/consola/resumen", sa.token);
      expect(res.status).toBe(200);
      const b = await res.json();
      expect(b.disponible).toBe(false);
      expect(b.mensaje).toMatch(/0042_superadmin_consola_resumen/);
      for (const campo of ["organizaciones", "gastoIa", "tokens", "operaciones", "vozMinutos", "sucursales", "usuarios", "conversacionesWa", "resueltasSinHumano", "mrr"]) {
        expect(b[campo].valor).toBeNull();
        expect(b[campo].razon).toBeTruthy();
      }
    }
  });

  it("conversaciones resueltas: sin conversaciones hoy no hay porcentaje (null), nunca 0%", async () => {
    const t = await setup();
    sembrarTodo(t.consola!);
    t.consola!.seed({ resueltasSinHumano: { ok: true, data: { total: 0, resueltasSinHumano: 0, razon: null } } });
    const sa = await t.superadmin();
    const b = await (await get(t.app, "/superadmin/consola/resumen", sa.token)).json();
    expect(b.resueltasSinHumano.valor).toMatchObject({ resueltas: 0, total: 0, porcentaje: null });
  });
});

describe("delta de 7 dias contra los 7 anteriores, con reloj fijo", () => {
  it("23:30 de Mexico: 'hoy' es el 30-sep (no el 1-oct de UTC) y se pide la ventana de 14 dias que termina ahi", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T_2330_CDMX);
    const t = await setup();
    sembrarTodo(t.consola!);
    const sa = await t.superadmin();
    const b = await (await get(t.app, "/superadmin/consola/resumen", sa.token)).json();
    expect(b.hoy).toBe("2026-09-30");
    expect(t.consola!.llamadas.costoDiario).toEqual([{ desde: "2026-09-17", hasta: "2026-09-30" }]);
    expect(t.consola!.llamadas.operaciones).toEqual([{ desde: "2026-09-17", hasta: "2026-09-30" }]);
    // El dia de "resueltas sin humano" va de la medianoche de Mexico del 30-sep a la del 1-oct (06:00 UTC).
    expect(t.consola!.llamadas.resueltasSinHumano).toEqual([{ desdeIso: "2026-09-30T06:00:00.000Z", hastaIso: "2026-10-01T06:00:00.000Z" }]);
  });

  it("delta7d: el consumo de hoy entra en la ventana actual; el dia 8 atras entra en la previa", () => {
    const filas: ConsolaCostoDiarioRow[] = [
      dia("2026-09-17", 1_000_000, 0, 0), // dia 14 atras (el mas viejo de la ventana previa)
      dia("2026-09-23", 1_000_000, 0, 0), // dia 8 atras (previa)
      dia("2026-09-24", 3_000_000, 0, 0), // dia 7 atras: primer dia de la ventana actual
      dia("2026-09-30", 1_000_000, 1_000_000, 0), // hoy
    ];
    const r = delta7d(filas, "2026-09-30");
    expect(r.valor).toEqual({ actualUsd: 5, previoUsd: 2, deltaUsd: 3, pct: 150 });
  });

  it("el mismo consumo contado con el 'hoy' de UTC (1-oct) daria otra ventana: el dia de Mexico es el que manda", () => {
    expect(hoyMexico(T_2330_CDMX)).toBe("2026-09-30");
    expect(T_2330_CDMX.toISOString().slice(0, 10)).toBe("2026-10-01");
    expect(hoyMexico(new Date("2026-10-01T06:00:00.000Z"))).toBe("2026-10-01");
    const filas = [dia("2026-10-01", 9_000_000, 0, 0), dia("2026-09-30", 1_000_000, 0, 0)];
    expect(delta7d(filas, "2026-09-30").valor?.actualUsd).toBe(1);
  });

  it("sin consumo en los 7 previos el porcentaje es null (sin base), no infinito ni 0", () => {
    expect(delta7d([dia("2026-09-30", 2_000_000, 0, 0)], "2026-09-30").valor).toEqual({ actualUsd: 2, previoUsd: 0, deltaUsd: 2, pct: null });
  });

  it("helpers de fecha: sumarDias cruza mes y medianoche de Mexico es 06:00 UTC", () => {
    expect(sumarDias("2026-10-01", -1)).toBe("2026-09-30");
    expect(sumarDias("2026-03-01", -1)).toBe("2026-02-28");
    expect(medianocheMexicoIso("2026-09-30")).toBe("2026-09-30T06:00:00.000Z");
  });
});

describe("MRR del Resumen", () => {
  it("excluye las organizaciones sin precio, las cuenta aparte y deja una fila resumen_mrr por lectura", async () => {
    const t = await setup();
    sembrarTodo(t.consola!);
    const sa = await t.superadmin();
    const a = await (await get(t.app, "/superadmin/consola/resumen", sa.token)).json();
    expect(a.mrr.valor).toEqual({ totalMxn: 2488, organizacionesConPrecio: 2, organizacionesSinPrecio: 2 });
    await get(t.app, "/superadmin/consola/resumen", sa.token);
    const filas = t.zona!.entries().filter((e) => e.recurso === POLITICA_MRR_RESUMEN.recursoBitacora);
    expect(filas).toHaveLength(2);
    expect(filas[0]).toMatchObject({ accion: "consulta", actorUserId: sa.id, actorRol: "superadmin" });
  });

  it("sin huella no hay lectura: si la bitacora falla el MRR sale null (sin_bitacora) y el resto del resumen sigue", async () => {
    const t = await setup();
    sembrarTodo(t.consola!);
    t.zona!.fallarAlRegistrar = true;
    const sa = await t.superadmin();
    const res = await get(t.app, "/superadmin/consola/resumen", sa.token);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.mrr).toMatchObject({ valor: null, codigo: "sin_bitacora" });
    expect(b.organizaciones.valor.total).toBe(4);
  });

  it("0030 sin aplicar: MRR null con su razon, nunca 0", async () => {
    const t = await setup({ cfo: new InMemoryCfoRepository({ migrado: false }) });
    sembrarTodo(t.consola!);
    const sa = await t.superadmin();
    const b = await (await get(t.app, "/superadmin/consola/resumen", sa.token)).json();
    expect(b.mrr).toMatchObject({ valor: null, codigo: "mrr_sin_repositorio" });
  });

  it("la politica (sin step-up, recurso de bitacora) vive en una sola constante", () => {
    expect(POLITICA_MRR_RESUMEN).toEqual({ requiereStepUp: false, recursoBitacora: "resumen_mrr" });
  });
});

describe("GET /superadmin/consola/agentes-actividad", () => {
  it("agrega por rol (historico y 30 dias) y nombra la ultima corrida de cada cron; las tareas x/y salen 'no medido'", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T_MEDIODIA);
    const t = await setup();
    t.consola!.seed({
      agentesActividad: {
        ok: true,
        data: [{ vertical: "restaurantes", role: "restaurantes:whatsapp_agent", llamadasHist: 100, costoHistMicroUsd: 2_500_000, fallbackHist: 4, llamadas30d: 40, costo30dMicroUsd: 1_000_000, fallback30d: 1 }],
      },
    });
    const sa = await t.superadmin();
    const salud = t.deps.saludRepo as InMemorySaludRepository;
    await salud.recordCronHeartbeat({ cronName: "/internal/citas/confirmacion-cita", status: "ok", error: null, startedAt: "2026-09-30T17:00:00.000Z", finishedAt: "2026-09-30T17:00:02.000Z", durationMs: 2000 });
    await salud.recordCronHeartbeat({ cronName: "/internal/rentas/ical-sync", status: "error", error: "x", startedAt: "2026-09-30T17:00:00.000Z", finishedAt: "2026-09-30T17:00:01.000Z", durationMs: 1000 });
    await salud.recordCronHeartbeat({ cronName: "/internal/cron/inexistente", status: "ok", error: null, startedAt: "2026-09-30T17:00:00.000Z", finishedAt: "2026-09-30T17:00:01.000Z", durationMs: 1000 });
    const b = await (await get(t.app, "/superadmin/consola/agentes-actividad", sa.token)).json();
    expect(b.disponible).toBe(true);
    expect(t.consola!.llamadas.agentesActividad).toEqual(["2026-09-30"]);
    expect(b.agentes.valor).toEqual([
      { vertical: "restaurantes", role: "restaurantes:whatsapp_agent", historico: { llamadas: 100, costoUsd: 2.5, fallbacks: 4 }, ultimos30Dias: { llamadas: 40, costoUsd: 1, fallbacks: 1 } },
    ]);
    const corridas = b.ultimaCorrida.valor as Array<{ cron: string; nombre: string; vertical: string; estado: string; tareas: string }>;
    expect(corridas.find((c) => c.cron === "/internal/citas/confirmacion-cita")).toMatchObject({ nombre: "Recordatorios de citas", vertical: "citas", estado: "ok", tareas: "no medido" });
    expect(corridas.find((c) => c.cron === "/internal/rentas/ical-sync")).toMatchObject({ nombre: "Sincronización iCal de rentas", estado: "error" });
    expect(corridas.find((c) => c.cron === "/internal/cron/inexistente")).toMatchObject({ vertical: "plataforma", nombre: "/internal/cron/inexistente" });
  });

  it("sin la migracion: agentes null con razon pero la ultima corrida (que viene de otra fuente) sigue; 200", async () => {
    const t = await setup({ consola: new InMemoryConsolaRepository() });
    const sa = await t.superadmin();
    const res = await get(t.app, "/superadmin/consola/agentes-actividad", sa.token);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.agentes).toMatchObject({ valor: null, codigo: "no_migrado" });
    expect(b.ultimaCorrida.valor).toEqual([]);
  });

  it("todo cron declarado en vercel.json tiene nombre humano (un cron nuevo obliga a nombrarlo)", () => {
    const sinNombre = rutasDeCronDeclaradas().filter((r) => !(r in AGENTES_CRON));
    expect(sinNombre).toEqual([]);
    expect(AGENTES_CRON["/internal/licitaciones/discover-tenders"]?.nombre).toBe("Descubrimiento de convocatorias");
    expect(AGENTES_CRON["/internal/superadmin/resumen-diario"]?.nombre).toBe("Parte diario");
  });
});
