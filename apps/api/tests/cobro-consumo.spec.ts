// Consumo, cotizador y avisos de bolsa: rutas de punta a punta contra repos en memoria (la autorizacion real en SQL se verifica en
// scripts/verify-cobro-tabulador-consumo/). Cifras de PRUEBA.
import { describe, expect, it } from "vitest";
import { InMemoryCobroPlanesRepository, InMemoryCostosPlanesRepository, type CostosPlanesRepository, type TarifaPlanRow } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { ejecutarAvisosBolsa } from "../src/plan-topes/aviso-bolsa.ts";
import { costosDesdeFilas, documentoCotizacion, hoyEn } from "../src/routes/cobro-consumo.ts";
import { jsonRequestInit } from "./fixtures.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";

type App = { request: (u: string, i?: RequestInit) => Response | Promise<Response> };

const PLAN: TarifaPlanRow = {
  planId: "prueba-pro",
  nombre: "Pro (prueba)",
  vertical: "restaurantes",
  activo: true,
  modeloCobro: "medido",
  cuotaFijaCentavos: null,
  precioSucursalCentavos: 769_000,
  sucursalesIncluidas: 0,
  minutosVozIncluidos: 0,
  minutosVozIncluidosPorSucursal: 1_500,
  precioMinutoVozExcedenteCentavos: 340,
  conversacionesWaIncluidas: 0,
  conversacionesWaIncluidasPorSucursal: 2_000,
  precioConversacionWaExcedenteCentavos: 150,
  usoJustoPct: 150,
  cuotaAltaCentavos: null,
  cuotaAltaPorSucursalCentavos: null,
  tasaIvaBp: 1600,
  organizacionExclusivaId: null,
  tramosSucursal: [],
  bandasUso: [],
  margenMinimoPct: 60,
};

const dias = (n: number, segundos: number) => Array.from({ length: 30 }, (_, i) => ({ dia: `2026-11-${String(i + 1).padStart(2, "0")}`, segundosVoz: i < n ? segundos : 0, llamadas: i < n ? 10 : 0, conversacionesWa: i < n ? 20 : 0 }));

async function setup() {
  const s = await seguridadSetup();
  const cobro = new InMemoryCobroPlanesRepository();
  const costos = new InMemoryCostosPlanesRepository();
  const org = s.base.organizationId;
  costos.seedOrganization(org, { vertical: "restaurantes", name: "Resto prueba", slug: "resto-prueba", sucursalesActivas: 1 });
  cobro.organizaciones.set(org, { organizationId: org, vertical: "restaurantes", zonaHoraria: "America/Merida", sucursalesActivas: 1, plan: PLAN });
  cobro.consumos.set(org, {
    organizationId: org,
    mes: "2026-11-01",
    zonaHoraria: "America/Merida",
    totales: { llamadas: 100, segundosVoz: 60 * 1_400, minutosVoz: 1_400, duracionPromedioS: 140, conversacionesWa: 200, pedidosAgentes: 40 },
    dias: dias(10, 60 * 140),
    sucursales: [{ propertyId: "p1", nombre: "Centro", activa: true, llamadas: 100, minutosVoz: 1_400, duracionPromedioS: 140, pedidosAgentes: 40 }],
    historial: [{ mes: "2026-10-01", llamadas: 90, minutosVoz: 1_200, conversacionesWa: 150 }],
  });
  for (const [clave, costoMxn] of [["minuto_voz", 1.2], ["conversacion_wa", 0.35], ["fijo_mensual_sucursal", 150], ["numero_voz_mensual_sucursal", 116], ["comision_tarjeta_pct", 3.6], ["comision_tarjeta_fijo_mxn", 3]] as const) {
    cobro.costos.set(clave, { clave, costoMxn, fuente: "prueba", actualizadoEnMs: 0 });
  }
  const app = buildApp({ ...s.deps, cobroPlanesRepo: () => cobro, costosPlanesRepo: () => costos as CostosPlanesRepository });
  return {
    s,
    app,
    cobro,
    costos,
    org,
    async superadmin() {
      const sa = await s.superadmin();
      cobro.superadmins.add(sa.id);
      costos.seedSuperadmin(sa.id);
      return sa;
    },
  };
}

const req = (app: App, method: string, path: string, body: unknown, headers: Record<string, string>) => app.request(path, { ...jsonRequestInit(body, headers), method });
const get = (app: App, path: string, token: string) => app.request(path, { headers: bearer(token) });

const PROPUESTA = {
  tarifa: { cuotaFijaMxn: 30_030, sucursalesIncluidas: 7, minutosVozIncluidos: 8_750, conversacionesWaIncluidas: 2_100, precioMinutoVozExcedenteMxn: 2.9, precioConversacionWaExcedenteMxn: 1.5, usoJustoPct: 150 },
  supuestos: { sucursales: 7, llamadasMes: 4_000, minutosPorLlamada: 2.3, conversacionesWa: 1_100 },
};

describe("gateo", () => {
  it("staff normal: 403 en cotizador, costos y vista de organizaciones", async () => {
    const t = await setup();
    const st = await t.s.staff();
    expect((await req(t.app, "POST", "/superadmin/cotizador/calcular", PROPUESTA, bearer(st.token))).status).toBe(403);
    expect((await get(t.app, "/superadmin/cobro/organizaciones", st.token)).status).toBe(403);
    expect((await get(t.app, "/superadmin/cobro/costos-unitarios", st.token)).status).toBe(403);
    expect((await get(t.app, `/billing/consumo?organizationId=${t.org}`, st.token)).status).toBe(403);
  });
});

describe("cotizador", () => {
  it("calcula costo, factura y margen (esperado y peor punto) sin escribir nada", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    const res = await req(t.app, "POST", "/superadmin/cotizador/calcular", PROPUESTA, bearer(sa.token));
    expect(res.status).toBe(200);
    const { evaluacion } = (await res.json()) as { evaluacion: { esperado: { factura: { subtotalMxn: number } }; margenMinimoPct: number; margenControlPct: number; bajoMinimo: boolean } };
    expect(evaluacion.esperado.factura.subtotalMxn).toBeCloseTo(30_030 + 450 * 2.9, 2);
    expect(evaluacion.margenMinimoPct).toBe(55);
    expect(evaluacion.bajoMinimo).toBe(false);
    expect(t.cobro.cotizaciones).toHaveLength(0);
  });

  it("debajo del minimo NO crea el plan sin motivo; con motivo si, y queda la cotizacion", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    const barata = { ...PROPUESTA, organizationId: t.org, planId: "pm-medida", nombre: "PM a la medida", tarifa: { ...PROPUESTA.tarifa, cuotaFijaMxn: 12_000 } };
    const sin = await req(t.app, "POST", "/superadmin/cotizador/crear-plan", barata, bearer(sa.token));
    expect(sin.status).toBe(400);
    expect(t.cobro.cotizaciones).toHaveLength(0);
    t.cobro.tarifas.set("pm-medida", { ...PLAN, planId: "pm-medida" });
    const con = await req(t.app, "POST", "/superadmin/cotizador/crear-plan", { ...barata, motivoExcepcion: "Cliente ancla del piloto, autorizado por el dueño" }, bearer(sa.token));
    expect(con.status).toBe(201);
    expect(t.cobro.cotizaciones).toHaveLength(1);
    expect(t.cobro.cotizaciones[0]!.motivoExcepcion).toMatch(/piloto/);
  });

  it("sin costos unitarios capturados no inventa el margen (409)", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    t.cobro.costos.clear();
    expect((await req(t.app, "POST", "/superadmin/cotizador/calcular", PROPUESTA, bearer(sa.token))).status).toBe(409);
  });

  it("el documento para el cliente no muestra costos ni margenes", () => {
    const html = documentoCotizacion({ folio: 7, creadoEn: "2026-11-07T00:00:00Z", detalle: { tarifa: null, evaluacion: { esperado: {} }, costoMxn: 999 } }, "Resto <b>");
    expect(html).toContain("Cotización 7");
    expect(html).toContain("Resto &lt;b&gt;");
    expect(html).not.toMatch(/margen|costo/i);
  });
});

describe("GET /billing/consumo", () => {
  it("superadmin: totales, bolsa, proyeccion con rango, sucursales e historial", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    const res = await get(t.app, `/billing/consumo?organizationId=${t.org}&mes=2026-11`, sa.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bolsa: { voz: { incluido: number; porcentaje: number } }; proyeccion: { factura: { central: { subtotalMxn: number } } | null }; sucursales: unknown[]; historial: unknown[] };
    expect(body.bolsa.voz.incluido).toBe(1_500);
    expect(body.bolsa.voz.porcentaje).toBeCloseTo(93.3, 1);
    expect(body.proyeccion.factura).not.toBeNull();
    expect(body.sucursales).toHaveLength(1);
    expect(body.historial).toHaveLength(1);
  });
});

describe("GET /superadmin/cobro/organizaciones", () => {
  it("ingreso proyectado, costo y margen por organizacion con los costos capturados", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    const body = (await (await get(t.app, "/superadmin/cobro/organizaciones?mes=2026-11", sa.token)).json()) as { organizaciones: Array<{ ingresoProyectadoMxn: number; costoProyectadoMxn: number; margenPct: number }> };
    expect(body.organizaciones).toHaveLength(1);
    expect(body.organizaciones[0]!.ingresoProyectadoMxn).toBeGreaterThan(0);
    expect(body.organizaciones[0]!.costoProyectadoMxn).toBeGreaterThan(0);
  });
});

describe("avisos de bolsa", () => {
  it("al 93 % de la bolsa de voz sale el aviso de 80 % UNA sola vez", async () => {
    const t = await setup();
    const deps = { ...t.s.deps, cobroPlanesRepo: () => t.cobro };
    const a = await ejecutarAvisosBolsa(deps);
    const b = await ejecutarAvisosBolsa(deps);
    expect(a.disponible).toBe(true);
    expect(a.errores).toBe(0);
    expect([...t.cobro.avisosReclamados].filter((k) => k.endsWith(":minutos_voz:80"))).toHaveLength(1);
    expect(b.errores).toBe(0);
  });
});

describe("utilidades", () => {
  it("costosDesdeFilas: un costo faltante no se inventa", () => {
    expect(costosDesdeFilas([]).costos).toBeNull();
    expect(costosDesdeFilas([]).faltan).toContain("minuto_voz");
  });
  it("hoyEn usa la zona del negocio", () => {
    expect(hoyEn("America/Merida", new Date("2026-11-01T05:30:00Z")).dia).toBe("2026-10-31");
  });
});
