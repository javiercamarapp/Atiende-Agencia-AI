// Cobro por plan medido: rutas de punta a punta contra el repo en memoria (la autorizacion real en SQL se verifica en
// scripts/verify-cobro-planes-medidos/). Las cifras son de PRUEBA, no precios del producto.
import { describe, expect, it } from "vitest";
import { totpAt } from "@atiende/core-auth";
import { InMemoryCobroPlanesRepository, type TarifaPlanRow } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { mesActualEn, parsearTarifa } from "../src/routes/cobro-planes.ts";
import { jsonRequestInit } from "./fixtures.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";

type App = { request: (u: string, i?: RequestInit) => Response | Promise<Response> };

const TARIFA: TarifaPlanRow = {
  planId: "prueba-a-la-medida",
  nombre: "A la medida (prueba)",
  vertical: "restaurantes",
  activo: true,
  modeloCobro: "medido",
  cuotaFijaCentavos: 3_000_000,
  precioSucursalCentavos: null,
  sucursalesIncluidas: 7,
  minutosVozIncluidos: 9_200,
  minutosVozIncluidosPorSucursal: 0,
  precioMinutoVozExcedenteCentavos: 250,
  conversacionesWaIncluidas: 1_100,
  conversacionesWaIncluidasPorSucursal: 0,
  precioConversacionWaExcedenteCentavos: 150,
  usoJustoPct: 150,
  cuotaAltaCentavos: null,
  cuotaAltaPorSucursalCentavos: null,
  tasaIvaBp: 1600,
  organizacionExclusivaId: null,
  tramosSucursal: [],
  bandasUso: [],
  margenMinimoPct: null,
};

async function setup(opts: { sinRepo?: boolean; noMigrado?: boolean } = {}) {
  const s = await seguridadSetup();
  const cobro = new InMemoryCobroPlanesRepository();
  if (opts.noMigrado) cobro.availability = "not_migrated";
  cobro.tarifas.set(TARIFA.planId, TARIFA);
  const org = s.base.organizationId;
  cobro.organizaciones.set(org, { organizationId: org, vertical: "restaurantes", zonaHoraria: "America/Merida", sucursalesActivas: 7, plan: TARIFA });
  cobro.usos.set(org, { organizationId: org, mes: "2026-11-01", zonaHoraria: "America/Merida", desde: "", hasta: "", segundosVoz: 768_000, minutosVoz: 12_800, llamadas: 4_000, conversacionesWa: 1_100 });
  const app = buildApp(opts.sinRepo ? s.deps : { ...s.deps, cobroPlanesRepo: () => cobro });
  return {
    s,
    app,
    cobro,
    org,
    async superadmin() {
      const sa = await s.superadmin();
      cobro.superadmins.add(sa.id);
      return sa;
    },
  };
}

const req = (app: App, method: string, path: string, body: unknown, headers: Record<string, string>) => app.request(path, { ...jsonRequestInit(body, headers), method });
const get = (app: App, path: string, token: string) => app.request(path, { headers: bearer(token) });

describe("gateo", () => {
  it("staff normal: 403 en las rutas de superadmin; sin token: 401", async () => {
    const t = await setup();
    const st = await t.s.staff();
    expect((await get(t.app, "/superadmin/planes/tarifas", st.token)).status).toBe(403);
    expect((await t.app.request("/superadmin/planes/tarifas")).status).toBe(401);
    expect((await req(t.app, "PUT", `/superadmin/planes/${TARIFA.planId}/tarifa`, { usoJustoPct: 150 }, bearer(st.token))).status).toBe(403);
    expect((await t.app.request(`/billing/plan-medido?organizationId=${t.org}`)).status).toBe(401);
  });

  it("alguien que no es de la organizacion no ve su plan medido (403)", async () => {
    const t = await setup();
    const st = await t.s.staff();
    expect((await get(t.app, `/billing/plan-medido?organizationId=${t.org}`, st.token)).status).toBe(403);
  });

  it("con MFA activo, fijar la tarifa exige step-up; leer no", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    const enr = await req(t.app, "POST", "/superadmin/mfa/enrolar", {}, bearer(sa.token));
    const { secreto } = (await enr.json()) as { secreto: string };
    const ver = await req(t.app, "POST", "/superadmin/mfa/verificar", { codigo: totpAt(secreto, Date.now()) }, bearer(sa.token));
    const { stepUpToken } = (await ver.json()) as { stepUpToken: string };
    const sin = await req(t.app, "PUT", `/superadmin/planes/${TARIFA.planId}/tarifa`, { usoJustoPct: 200 }, bearer(sa.token));
    expect(sin.status).toBe(403);
    expect(await sin.json()).toMatchObject({ code: "stepup_required" });
    expect(t.cobro.tarifas.get(TARIFA.planId)?.usoJustoPct).toBe(150);
    const con = await req(t.app, "PUT", `/superadmin/planes/${TARIFA.planId}/tarifa`, { usoJustoPct: 200 }, bearer(sa.token, { "x-stepup-token": stepUpToken }));
    expect(con.status).toBe(200);
    expect(t.cobro.tarifas.get(TARIFA.planId)?.usoJustoPct).toBe(200);
    expect((await get(t.app, "/superadmin/planes/tarifas", sa.token)).status).toBe(200);
  });
});

describe("superadmin: tarifas", () => {
  it("lista las tarifas en pesos (la base guarda centavos)", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    const res = await get(t.app, "/superadmin/planes/tarifas", sa.token);
    const body = (await res.json()) as { disponible: boolean; tarifas: Array<Record<string, unknown>> };
    expect(body.disponible).toBe(true);
    expect(body.tarifas[0]).toMatchObject({ planId: TARIFA.planId, cuotaFijaMxn: 30_000, precioMinutoVozExcedenteMxn: 2.5, tasaIvaPct: 16 });
  });

  it("fija la tarifa: los pesos llegan a la base en centavos enteros", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    const res = await req(t.app, "PUT", `/superadmin/planes/${TARIFA.planId}/tarifa`, { precioMinutoVozExcedenteMxn: 2.75, cuotaAltaMxn: 5000, minutosVozIncluidos: 10_000 }, bearer(sa.token));
    expect(res.status).toBe(200);
    const t2 = t.cobro.tarifas.get(TARIFA.planId)!;
    expect(t2.precioMinutoVozExcedenteCentavos).toBe(275);
    expect(t2.cuotaAltaCentavos).toBe(500_000);
    expect(t2.minutosVozIncluidos).toBe(10_000);
  });

  it("base sin migrar: la lectura dice no disponible y la escritura responde 503", async () => {
    const t = await setup({ noMigrado: true });
    const sa = await t.superadmin();
    expect(await (await get(t.app, "/superadmin/planes/tarifas", sa.token)).json()).toMatchObject({ disponible: false });
    expect((await req(t.app, "PUT", `/superadmin/planes/${TARIFA.planId}/tarifa`, { usoJustoPct: 150 }, bearer(sa.token))).status).toBe(503);
  });

  it("sin repositorio configurado: no disponible, nunca 500", async () => {
    const t = await setup({ sinRepo: true });
    const sa = await t.s.superadmin();
    expect(await (await get(t.app, "/superadmin/planes/tarifas", sa.token)).json()).toMatchObject({ disponible: false });
  });
});

describe("parsearTarifa", () => {
  it("rechaza campos desconocidos, decimales de mas, uso justo fuera de rango y un cuerpo vacio", () => {
    expect(() => parsearTarifa({ descuentoMagico: 1 })).toThrow();
    expect(() => parsearTarifa({ precioSucursalMxn: 1.234 })).toThrow();
    expect(() => parsearTarifa({ usoJustoPct: 90 })).toThrow();
    expect(() => parsearTarifa({ minutosVozIncluidos: 1.5 })).toThrow();
    expect(() => parsearTarifa({ organizacionExclusivaId: "no-uuid" })).toThrow();
    expect(() => parsearTarifa({})).toThrow();
  });

  it("convierte pesos a centavos y el IVA a puntos base; null deja el excedente sin cobrar", () => {
    expect(parsearTarifa({ precioSucursalMxn: 4290, tasaIvaPct: 16, precioMinutoVozExcedenteMxn: null })).toEqual({ precioSucursalCentavos: 429_000, tasaIvaBp: 1600, precioMinutoVozExcedenteCentavos: null });
  });
});

describe("GET /billing/plan-medido", () => {
  it("superadmin: tarifa, uso del mes y factura estimada con excedente e IVA", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    const res = await get(t.app, `/billing/plan-medido?organizationId=${t.org}&mes=2026-11`, sa.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { factura: { subtotalMxn: number; ivaMxn: number; totalMxn: number; voz: { excedenteCobrado: number } }; estimada: boolean };
    expect(body.estimada).toBe(true);
    expect(body.factura.voz.excedenteCobrado).toBe(3_600);
    expect(body.factura.subtotalMxn).toBe(39_000);
    expect(body.factura.ivaMxn).toBe(6_240);
    expect(body.factura.totalMxn).toBe(45_240);
  });

  it("organizacion sin plan: lo dice, sin inventar factura", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    t.cobro.organizaciones.set(t.org, { organizationId: t.org, vertical: "restaurantes", zonaHoraria: "America/Merida", sucursalesActivas: 1, plan: null });
    const body = (await (await get(t.app, `/billing/plan-medido?organizationId=${t.org}`, sa.token)).json()) as { factura: unknown; motivo: string };
    expect(body.factura).toBeNull();
    expect(body.motivo).toMatch(/no tiene plan/);
  });

  it("valida organizationId y mes", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    expect((await get(t.app, "/billing/plan-medido?organizationId=x", sa.token)).status).toBe(400);
    expect((await get(t.app, `/billing/plan-medido?organizationId=${t.org}&mes=2026-13`, sa.token)).status).toBe(400);
  });

  it("base sin migrar: disponible false, nunca 500", async () => {
    const t = await setup({ noMigrado: true });
    const sa = await t.superadmin();
    expect(await (await get(t.app, `/billing/plan-medido?organizationId=${t.org}`, sa.token)).json()).toMatchObject({ disponible: false });
  });
});

describe("mesActualEn", () => {
  it("usa la zona del negocio: 23:30 de Merida del 31-oct sigue siendo octubre", () => {
    expect(mesActualEn("America/Merida", new Date("2026-11-01T05:30:00Z"))).toBe("2026-10-01");
    expect(mesActualEn("America/Merida", new Date("2026-11-01T06:30:00Z"))).toBe("2026-11-01");
  });
});
