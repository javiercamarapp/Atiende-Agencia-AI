// Organizaciones / Clientes (SA-L-20), Ficha 360 (SA-07) y onboarding medido (SA-18): rutas de punta a punta contra los repos en memoria.
// La autorizacion real y los conteos en SQL se verifican en scripts/verify-superadmin-organizaciones-ficha/ (Postgres real).
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCfoZoneRepository, InMemoryCoreRepository, InMemoryCostosPlanesRepository, InMemoryOrgFichaRepository } from "@atiende/db";
import type { OrgFicha } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

afterEach(() => vi.useRealTimers());

const T = new Date("2026-09-30T18:00:00.000Z");
const ORG_A = "11111111-1111-4111-8111-111111111111"; // restaurantes, completa, con plan
const ORG_B = "22222222-2222-4222-8222-222222222222"; // despachos: la primera operacion no se puede medir
const ORG_C = "33333333-3333-4333-8333-333333333333"; // hoteles, vacia
const INEXISTENTE = "99999999-9999-4999-8999-999999999999";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function fichaDe(id: string, nombre: string, vertical: string, parche: Partial<OrgFicha> = {}): OrgFicha {
  return {
    organizacion: { id, nombre, slug: nombre.toLowerCase().replace(/\s+/g, "-"), vertical, estado: "active", creadaEn: "2026-09-01T00:00:00.000Z" },
    uso: { operaciones30d: { valor: 12, razon: null }, conversaciones30d: { valor: 40, razon: null }, minutosVoz30d: { valor: 2.5, razon: null } },
    costo: { llm30dMicroUsd: 3_500_000, eventos30dMicroUsd: 900_000, eventos30dTotal: 3, razon: null },
    membresias: { porRol: [{ rol: "owner / staff", cantidad: 1 }, { rol: "member / staff", cantidad: 2 }], ultimosAccesos: [{ rol: "member", ultimoAcceso: "2026-09-30T10:00:00.000Z" }], ultimosAccesosRazon: null },
    errores: {
      outboxMuerto: { valor: 2, razon: null },
      denegaciones30d: { valor: 1, ultimas: [{ ruta: "/v1/restaurantes/x/admin/config", motivo: "insufficient_role", cuando: "2026-09-29T10:00:00.000Z" }], razon: null },
      crons: { valor: null, razon: "sin_fuente_por_organizacion" },
    },
    facturacion: { plan: { id: "restaurantes-estandar", nombre: "Restaurantes" }, cobro: { estado: "activa", periodoHasta: "2026-10-30T00:00:00.000Z", asientos: 3 }, contrato: { contractId: "c-1", version: 2 } },
    onboarding: [
      { paso: "whatsapp", titulo: "WhatsApp configurado", estado: "hecho", razon: null },
      { paso: "primera_operacion", titulo: "Primera operación real", estado: "no_se_pudo_medir", razon: "sin_fuente" },
      { paso: "plan_asignado", titulo: "Plan asignado", estado: "pendiente", razon: null },
    ],
    ...parche,
  };
}

async function setup(opciones: { ficha?: InMemoryOrgFichaRepository | null; costos?: InMemoryCostosPlanesRepository | null; zona?: InMemoryCfoZoneRepository | null } = {}) {
  const s = await seguridadSetup();
  const core = s.base.deps.coreRepo as InMemoryCoreRepository;
  core.addOrganization({ id: ORG_A, slug: "org-a", name: "Org A", vertical: "restaurantes", status: "active", createdAt: "2026-09-01T00:00:00.000Z" });
  core.addOrganization({ id: ORG_B, slug: "org-b", name: "Org B", vertical: "despachos", status: "trial", createdAt: "2026-09-02T00:00:00.000Z" });
  core.addOrganization({ id: ORG_C, slug: "org-c", name: "Org C", vertical: "hoteles", status: "active", createdAt: "2026-09-03T00:00:00.000Z" });
  const ficha = opciones.ficha === undefined ? new InMemoryOrgFichaRepository() : opciones.ficha;
  const costos = opciones.costos === undefined ? new InMemoryCostosPlanesRepository() : opciones.costos;
  const zona = opciones.zona === undefined ? new InMemoryCfoZoneRepository() : opciones.zona;
  const deps = { ...s.deps, ...(ficha ? { orgFichaRepo: () => ficha } : {}), ...(costos ? { costosPlanesRepo: () => costos } : {}), ...(zona ? { cfoZoneRepo: () => zona } : {}) };
  const app = buildApp(deps);
  return {
    s, ficha, costos, zona, app, deps,
    async superadmin() {
      const sa = await s.superadmin();
      ficha?.seedSuperadmin(sa.id);
      costos?.seedSuperadmin(sa.id);
      zona?.seedSuperadmin(sa.id);
      return sa;
    },
  };
}
const get = (app: ReturnType<typeof buildApp>, path: string, token: string) => app.request(path, { headers: bearer(token) });

function sembrarResumen(r: InMemoryOrgFichaRepository): void {
  r.seed({
    metricas: {
      ok: true,
      data: [
        { organizationId: ORG_A, operaciones30d: 12, operacionesRazon: null, llm30dMicroUsd: 3_500_000, eventos30dMicroUsd: 900_000, planId: "restaurantes-estandar", planNombre: "Restaurantes", planRazon: null },
        { organizationId: ORG_B, operaciones30d: null, operacionesRazon: "sin_fuente", llm30dMicroUsd: 0, eventos30dMicroUsd: 0, planId: null, planNombre: null, planRazon: null },
        { organizationId: ORG_C, operaciones30d: 0, operacionesRazon: null, llm30dMicroUsd: 8_000_000, eventos30dMicroUsd: 0, planId: null, planNombre: null, planRazon: null },
      ],
    },
    onboardingResumen: {
      ok: true,
      data: [
        { organizationId: ORG_A, hechos: 6, total: 6, noMedibles: 0 },
        { organizationId: ORG_B, hechos: 1, total: 4, noMedibles: 1 },
        { organizationId: ORG_C, hechos: 0, total: 6, noMedibles: 0 },
      ],
    },
  });
}

describe("seguridad", () => {
  it("sin sesion 401, staff normal 403 y el superadmin lee las tres rutas", async () => {
    const t = await setup();
    t.ficha!.seed({ fichas: new Map([[ORG_A, fichaDe(ORG_A, "Org A", "restaurantes")]]) });
    const st = await t.s.staff();
    const sa = await t.superadmin();
    for (const ruta of ["/superadmin/organizaciones/resumen", "/superadmin/organizaciones/margen", `/superadmin/organizaciones/${ORG_A}/ficha`]) {
      expect((await t.app.request(ruta)).status, ruta).toBe(401);
      expect((await get(t.app, ruta, st.token)).status, ruta).toBe(403);
      expect((await get(t.app, ruta, sa.token)).status, ruta).toBe(200);
    }
  });

  it("son de solo lectura: un POST sobre la ficha no existe", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    const res = await t.app.request(`/superadmin/organizaciones/${ORG_A}/ficha`, { method: "POST", headers: bearer(sa.token) });
    expect([404, 405]).toContain(res.status);
  });

  it("el margen es de la zona CFO: el rol finanzas lo lee y queda en la bitacora; el resumen y la ficha (no financieros) le dan 403", async () => {
    const t = await setup();
    t.ficha!.seed({ fichas: new Map([[ORG_A, fichaDe(ORG_A, "Org A", "restaurantes")]]) });
    const sa = await t.superadmin();
    t.zona!.seedRole(sa.id);
    // finanzas exige step-up obligatorio en las rutas financieras: sin token de step-up responde 403 y lo deja denegado.
    const margen = await get(t.app, "/superadmin/organizaciones/margen", sa.token);
    expect(margen.status).toBe(403);
    expect(t.zona!.entries().some((e) => e.accion === "denegado" && e.recurso.includes("organizaciones/margen"))).toBe(true);
    for (const ruta of ["/superadmin/organizaciones/resumen", `/superadmin/organizaciones/${ORG_A}/ficha`]) {
      expect((await get(t.app, ruta, sa.token)).status, ruta).toBe(403);
    }
  });
});

describe("GET /superadmin/organizaciones/resumen", () => {
  it("compone la tabla: operaciones, costo de IA en USD, plan y onboarding x/y; la lista de organizaciones sale de la funcion que ya existe", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    const t = await setup();
    sembrarResumen(t.ficha!);
    const sa = await t.superadmin();
    const b = (await (await get(t.app, "/superadmin/organizaciones/resumen", sa.token)).json()) as Json;
    expect(b.disponible).toBe(true);
    expect(b.ventanaDias).toBe(30);
    const a = b.organizaciones.find((o: Json) => o.id === ORG_A);
    expect(a).toMatchObject({ nombre: "Org A", vertical: "restaurantes", estado: "active" });
    expect(a.operaciones30d).toEqual({ valor: 12, razon: null });
    expect(a.costoIa30dUsd).toEqual({ valor: 3.5, razon: null });
    expect(a.plan.valor).toEqual({ id: "restaurantes-estandar", nombre: "Restaurantes" });
    expect(a.onboarding.valor).toEqual({ hechos: 6, total: 6, noMedibles: 0 });
    expect(t.ficha!.llamadas.metricas).toEqual(["2026-09-30"]);
  });

  it("lo que no se puede medir es null con su razon, nunca 0 (despachos sin operaciones; organizacion sin plan)", async () => {
    const t = await setup();
    sembrarResumen(t.ficha!);
    const sa = await t.superadmin();
    const b = (await (await get(t.app, "/superadmin/organizaciones/resumen", sa.token)).json()) as Json;
    const despachos = b.organizaciones.find((o: Json) => o.id === ORG_B);
    expect(despachos.operaciones30d.valor).toBeNull();
    expect(despachos.operaciones30d.razon).toContain("Sin fuente");
    expect(despachos.onboarding.valor).toEqual({ hechos: 1, total: 4, noMedibles: 1 });
    const sinPlan = b.organizaciones.find((o: Json) => o.id === ORG_C);
    expect(sinPlan.plan).toEqual({ valor: null, razon: expect.stringContaining("plan") });
    expect(sinPlan.operaciones30d).toEqual({ valor: 0, razon: null });
  });

  it("base sin la 0052: 200 con disponible:false, la lista completa y las columnas nuevas en null con su razon (nunca un 500)", async () => {
    const t = await setup(); // sin sembrar: el repo responde no_migrado
    const sa = await t.superadmin();
    const res = await get(t.app, "/superadmin/organizaciones/resumen", sa.token);
    expect(res.status).toBe(200);
    const b = (await res.json()) as Json;
    expect(b.disponible).toBe(false);
    expect(b.mensaje).toContain("0052");
    // La lista completa sale de la funcion que ya existe en produccion (incluye cualquier otra organizacion sembrada por la fixture).
    const ids = b.organizaciones.map((o: Json) => o.id) as string[];
    for (const id of [ORG_A, ORG_B, ORG_C]) expect(ids).toContain(id);
    for (const o of b.organizaciones) {
      expect(o.operaciones30d.valor).toBeNull();
      expect(o.costoIa30dUsd.valor).toBeNull();
      expect(o.onboarding.valor).toBeNull();
      expect(o.onboarding.razon).toContain("0052");
    }
  });

  it("sin repositorio en deps (despliegue viejo) tambien responde 200 disponible:false", async () => {
    const t = await setup({ ficha: null });
    const sa = await t.superadmin();
    const res = await get(t.app, "/superadmin/organizaciones/resumen", sa.token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).disponible).toBe(false);
  });

  it("una fuente que falla (error SQL) deja ese campo en null sin tumbar la otra", async () => {
    const t = await setup();
    t.ficha!.seed({ metricas: { ok: false, razon: "error" }, onboardingResumen: { ok: true, data: [{ organizationId: ORG_A, hechos: 2, total: 6, noMedibles: 0 }] } });
    const sa = await t.superadmin();
    const b = (await (await get(t.app, "/superadmin/organizaciones/resumen", sa.token)).json()) as Json;
    expect(b.disponible).toBe(true);
    const a = b.organizaciones.find((o: Json) => o.id === ORG_A);
    expect(a.operaciones30d.valor).toBeNull();
    expect(a.onboarding.valor).toEqual({ hechos: 2, total: 6, noMedibles: 0 });
  });
});

describe("GET /superadmin/organizaciones/margen", () => {
  it("calcula el margen del mes con el mismo motor que Costos y margen (plan asignado + tipo de cambio)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    const costos = new InMemoryCostosPlanesRepository({ now: () => T.getTime() });
    const t = await setup({ costos });
    const sa = await t.superadmin();
    costos.seedOrganization(ORG_A, { vertical: "restaurantes", name: "Org A", slug: "org-a", sucursalesActivas: 3 });
    costos.seedOrganization(ORG_C, { vertical: "hoteles", name: "Org C", slug: "org-c", sucursalesActivas: 2 });
    await costos.setFxRate(sa.id, "2026-09-01", 20, "Banxico FIX");
    const sol = await costos.requestAssignment(sa.id, ORG_A, "restaurantes-estandar", "Plan inicial acordado con el cliente.");
    await costos.confirmAssignment(sa.id, sol.assignment!.id);
    costos.seedLlmUsage(ORG_A, "2026-09", 5_000_000);

    const b = (await (await get(t.app, "/superadmin/organizaciones/margen", sa.token)).json()) as Json;
    expect(b.disponible).toBe(true);
    expect(b.mes).toBe("2026-09");
    // (3 sucursales - 1 incluida) x 799 = 1,598 MXN de ingreso; costo 5 USD x 20 = 100 MXN.
    expect(b.margenes[ORG_A].valor).toMatchObject({ ingresoMxn: 1598, mxn: 1498 });
    expect(Math.round(b.margenes[ORG_A].valor.pct)).toBe(94);
    // Sin plan: no hay ingreso contra el cual medir -> null con razon, nunca 0.
    expect(b.margenes[ORG_C].valor).toBeNull();
    expect(b.margenes[ORG_C].razon).toContain("plan");
  });

  it("sin tipo de cambio configurado el margen es null con su razon", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    const costos = new InMemoryCostosPlanesRepository({ now: () => T.getTime() });
    const t = await setup({ costos });
    const sa = await t.superadmin();
    costos.seedOrganization(ORG_A, { vertical: "restaurantes", name: "Org A", slug: "org-a", sucursalesActivas: 3 });
    const sol = await costos.requestAssignment(sa.id, ORG_A, "restaurantes-estandar", "Plan inicial acordado con el cliente.");
    await costos.confirmAssignment(sa.id, sol.assignment!.id);
    const b = (await (await get(t.app, "/superadmin/organizaciones/margen", sa.token)).json()) as Json;
    expect(b.margenes[ORG_A].valor).toBeNull();
    expect(b.margenes[ORG_A].razon).toContain("tipo de cambio");
  });

  it("sin repositorio de costos (0028 sin aplicar): 200 disponible:false con mensaje, nunca un 500", async () => {
    const t = await setup({ costos: null });
    const sa = await t.superadmin();
    const res = await get(t.app, "/superadmin/organizaciones/margen", sa.token);
    expect(res.status).toBe(200);
    const b = (await res.json()) as Json;
    expect(b.disponible).toBe(false);
    expect(b.mensaje).toContain("0028");
  });
});

describe("GET /superadmin/organizaciones/:id/ficha", () => {
  it("devuelve la ficha 360: uso, costo (con costo por evento), membresias, errores, facturacion y onboarding", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    const t = await setup();
    t.ficha!.seed({ fichas: new Map([[ORG_A, fichaDe(ORG_A, "Org A", "restaurantes")]]) });
    const sa = await t.superadmin();
    const res = await get(t.app, `/superadmin/organizaciones/${ORG_A}/ficha`, sa.token);
    expect(res.status).toBe(200);
    const b = (await res.json()) as Json;
    expect(b.disponible).toBe(true);
    expect(b.organizacion).toMatchObject({ id: ORG_A, nombre: "Org A" });
    expect(b.uso.operaciones30d).toEqual({ valor: 12, razon: null });
    expect(b.uso.minutosVoz30d.valor).toBe(2.5);
    expect(b.costo.llm30dUsd.valor).toBe(3.5);
    expect(b.costo.eventos30dUsd.valor).toBe(0.9);
    expect(b.costo.costoPorEventoUsd.valor).toBeCloseTo(0.3, 6); // 0.9 USD / 3 eventos
    expect(b.membresias.porRol).toHaveLength(2);
    expect(b.membresias.ultimosAccesos.valor).toHaveLength(1);
    expect(b.errores.outboxMuerto.valor).toBe(2);
    expect(b.errores.denegaciones30d.valor).toBe(1);
    expect(b.errores.denegaciones30d.ultimas).toHaveLength(1);
    expect(b.errores.crons.valor).toBeNull();
    expect(b.errores.crons.razon).toContain("Sin fuente por organización");
    expect(b.facturacion.contrato.version).toBe(2);
    expect(t.ficha!.llamadas.ficha).toEqual([{ organizationId: ORG_A, hoy: "2026-09-30" }]);
  });

  it("un paso no medible sale 'no_se_pudo_medir' con su razon, DISTINTO de 'pendiente'", async () => {
    const t = await setup();
    t.ficha!.seed({ fichas: new Map([[ORG_B, fichaDe(ORG_B, "Org B", "despachos")]]) });
    const sa = await t.superadmin();
    const b = (await (await get(t.app, `/superadmin/organizaciones/${ORG_B}/ficha`, sa.token)).json()) as Json;
    const noMedible = b.onboarding.find((p: Json) => p.paso === "primera_operacion");
    expect(noMedible).toMatchObject({ estado: "no_se_pudo_medir", razon: "sin_fuente" });
    expect(noMedible.razonTexto).toContain("Sin fuente");
    expect(b.onboarding.find((p: Json) => p.paso === "plan_asignado").estado).toBe("pendiente");
  });

  it("sin eventos de costo en 30 dias el costo por evento es null con razon (no 0 ni division por cero)", async () => {
    const t = await setup();
    t.ficha!.seed({ fichas: new Map([[ORG_C, fichaDe(ORG_C, "Org C", "hoteles", { costo: { llm30dMicroUsd: 0, eventos30dMicroUsd: 0, eventos30dTotal: 0, razon: null } })]]) });
    const sa = await t.superadmin();
    const b = (await (await get(t.app, `/superadmin/organizaciones/${ORG_C}/ficha`, sa.token)).json()) as Json;
    expect(b.costo.costoPorEventoUsd.valor).toBeNull();
    expect(b.costo.costoPorEventoUsd.razon).toContain("Sin eventos");
    expect(b.costo.llm30dUsd.valor).toBe(0);
  });

  it("una organizacion inexistente devuelve 404 honesto (id valido que no existe e id mal formado)", async () => {
    const t = await setup();
    t.ficha!.seed({ fichas: new Map([[ORG_A, fichaDe(ORG_A, "Org A", "restaurantes")]]) });
    const sa = await t.superadmin();
    expect((await get(t.app, `/superadmin/organizaciones/${INEXISTENTE}/ficha`, sa.token)).status).toBe(404);
    expect((await get(t.app, "/superadmin/organizaciones/no-es-un-uuid/ficha", sa.token)).status).toBe(404);
  });

  it("base sin la 0052: organizacion existente -> 200 disponible:false con su cabecera; inexistente -> 404 (no se confunden)", async () => {
    const t = await setup(); // sin sembrar -> no_migrado
    const sa = await t.superadmin();
    const ok = await get(t.app, `/superadmin/organizaciones/${ORG_A}/ficha`, sa.token);
    expect(ok.status).toBe(200);
    const b = (await ok.json()) as Json;
    expect(b.disponible).toBe(false);
    expect(b.mensaje).toContain("0052");
    expect(b.organizacion).toMatchObject({ id: ORG_A, nombre: "Org A" });
    expect((await get(t.app, `/superadmin/organizaciones/${INEXISTENTE}/ficha`, sa.token)).status).toBe(404);
  });

  it("la respuesta de la ficha no trae nombres de personas, correos ni telefonos", async () => {
    const t = await setup();
    t.ficha!.seed({ fichas: new Map([[ORG_A, fichaDe(ORG_A, "Org A", "restaurantes")]]) });
    const sa = await t.superadmin();
    const texto = await (await get(t.app, `/superadmin/organizaciones/${ORG_A}/ficha`, sa.token)).text();
    expect(texto).not.toMatch(/@/u);
    // Sin telefonos: se descuentan los uuid (cuyo ultimo grupo tiene 12 digitos) antes de buscar rachas largas de digitos.
    expect(texto.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, "")).not.toMatch(/\+?\d{10,}/u);
  });
});

describe("cron de mantenimiento: aviso 'organizacion lista' (nunca desde un GET)", () => {
  const CRON = "/internal/superadmin/mantenimiento";
  const cron = (app: ReturnType<typeof buildApp>, secreto: string) => app.request(CRON, { method: "POST", headers: { "x-atiende-internal-secret": secreto } });

  it("el cron emite UNA notificacion de plataforma por organizacion marcada (clave = id, enlace a su ficha, sin PII); los GET de la pantalla no emiten nada", async () => {
    const t = await setup();
    t.ficha!.seed({ avisar: { ok: true, data: [ORG_A, ORG_C] }, fichas: new Map([[ORG_A, fichaDe(ORG_A, "Org A", "restaurantes")]]) });
    sembrarResumen(t.ficha!);
    const { deps, emisiones } = conEmisiones(t.deps);
    const app = buildApp(deps);
    const sa = await t.superadmin();
    for (const ruta of ["/superadmin/organizaciones/resumen", `/superadmin/organizaciones/${ORG_A}/ficha`]) await get(app, ruta, sa.token);
    expect(t.ficha!.llamadas.avisar).toBe(0);
    expect(emisiones).toHaveLength(0);

    const res = await cron(app, deps.env.internalSecret);
    expect(res.status).toBe(200);
    const b = (await res.json()) as Json;
    expect(b.ok).toBe(true);
    expect(b.organizacionesAvisadas).toBe(2);
    expect(t.ficha!.llamadas.avisar).toBe(1);
    expect(emisiones).toHaveLength(2);
    expect(emisiones[0]).toMatchObject({
      evento: "superadmin.organizacion.onboarding_listo",
      organizationId: null,
      categoria: "onboarding",
      severidad: "info",
      enlace: `/superadmin/organizaciones/${ORG_A}`,
      dedupeKey: `superadmin.organizacion.onboarding_listo:${ORG_A}`,
    });
    expect(emisiones[1]?.dedupeKey).toBe(`superadmin.organizacion.onboarding_listo:${ORG_C}`);
    expect(JSON.stringify(emisiones)).not.toContain("Org A");
  });

  it("sin organizaciones nuevas listas no emite nada", async () => {
    const t = await setup();
    t.ficha!.seed({ avisar: { ok: true, data: [] } });
    const { deps, emisiones } = conEmisiones(t.deps);
    const res = await cron(buildApp(deps), deps.env.internalSecret);
    expect(((await res.json()) as Json).organizacionesAvisadas).toBe(0);
    expect(emisiones).toHaveLength(0);
  });

  it("si la emision falla el cron lanza dentro de la transaccion (revierte el marcador) y responde 200 sin inventar avisos; el resto del cron sigue", async () => {
    const t = await setup();
    t.ficha!.seed({ avisar: { ok: true, data: [ORG_A] } });
    const { deps } = conEmisiones(t.deps, {
      alEmitir: () => {
        throw Object.assign(new Error("statement timeout"), { code: "57014" });
      },
    });
    const res = await cron(buildApp(deps), deps.env.internalSecret);
    expect(res.status).toBe(200);
    const b = (await res.json()) as Json;
    expect(b.ok).toBe(true);
    expect(b.organizacionesAvisadas).toBeNull();
  });

  it("base sin la 0052: el cron sigue 200 ok y no inventa avisos", async () => {
    const t = await setup(); // avisar = no_migrado
    const { deps, emisiones } = conEmisiones(t.deps);
    const res = await cron(buildApp(deps), deps.env.internalSecret);
    expect(res.status).toBe(200);
    const b = (await res.json()) as Json;
    expect(b.ok).toBe(true);
    expect(b.organizacionesAvisadas).toBeNull();
    expect(emisiones).toHaveLength(0);
  });
});
