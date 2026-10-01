// Contrato por cliente (SA-43) del superadmin: rutas de punta a punta contra los repos en memoria (la autorizacion
// real en SQL se verifica en scripts/verify-superadmin-contratos/ contra Postgres real). Reloj de `Date` controlado
// porque el mes de la estimacion y "no editar el pasado" dependen de la fecha.
import { afterEach, describe, expect, it, vi } from "vitest";
import { totpAt } from "@atiende/core-auth";
import { InMemoryCfoZoneRepository, InMemoryContratosRepository } from "@atiende/db";
import type { ContratosRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { SENSITIVE_ROUTES, isSensitiveRoute } from "../src/superadmin-seguridad/step-up.ts";
import { jsonRequestInit } from "./fixtures.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";

afterEach(() => vi.useRealTimers());

const T0 = new Date("2026-10-20T18:00:00.000Z").getTime();
const MOTIVO = "Alta del contrato segun la propuesta firmada con el cliente.";
const ORG_SIN_CONTRATO = "00000000-0000-4000-8000-0000000000b1";
const ORG_INEXISTENTE = "00000000-0000-4000-8000-0000000000ff";

function fakeTime(ms: number): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ms);
}

const CONTRATO = {
  vigenteDesde: "2026-01-01",
  vigenteHasta: null as string | null,
  baseCentavos: 590_000,
  porSucursalCentavos: 400_000,
  sucursalesIncluidas: 1,
  bolsaMinutos: 10_000,
  excedenteCentavosMinuto: 300,
  instalacionCentavos: 4_500_000,
  descuentoBp: 0,
  descuentoFijoCentavos: 0,
  motivo: MOTIVO,
};

async function setup(opciones: { repo?: ContratosRepository | null; zona?: InMemoryCfoZoneRepository } = {}) {
  fakeTime(T0);
  const s = await seguridadSetup();
  const contratos = new InMemoryContratosRepository({ now: () => T0 });
  const org = s.base.organizationId;
  contratos.seedOrganization(org, "Los Taquitos de PM", 3);
  contratos.seedOrganization(ORG_SIN_CONTRATO, "Hotel sin contrato", 0);
  const repo = opciones.repo === undefined ? contratos : opciones.repo;
  const deps = { ...s.deps, ...(repo ? { contratosRepo: () => repo as ContratosRepository } : {}), ...(opciones.zona ? { cfoZoneRepo: () => opciones.zona as InMemoryCfoZoneRepository } : {}) };
  const app = buildApp(deps);
  return {
    s,
    app,
    contratos,
    org,
    async superadmin() {
      const sa = await s.superadmin();
      contratos.seedSuperadmin(sa.id, sa.email);
      opciones.zona?.seedSuperadmin(sa.id, sa.email);
      return sa;
    },
    async finanzas() {
      const sa = await s.superadmin();
      contratos.seedFinanzas(sa.id, sa.email);
      opciones.zona?.seedSuperadmin(sa.id, sa.email);
      opciones.zona?.seedRole(sa.id);
      return sa;
    },
    async activarMfa(sa: { token: string }) {
      const enr = await app.request("/superadmin/mfa/enrolar", jsonRequestInit({}, bearer(sa.token)));
      const { secreto } = (await enr.json()) as { secreto: string };
      const ver = await app.request("/superadmin/mfa/verificar", jsonRequestInit({ codigo: totpAt(secreto, Date.now()) }, bearer(sa.token)));
      return ((await ver.json()) as { stepUpToken: string }).stepUpToken;
    },
  };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const get = (ctx: Ctx, path: string, token: string, stepUp?: string) => ctx.app.request(path, { headers: bearer(token, stepUp ? { "x-stepup-token": stepUp } : {}) });
const send = (ctx: Ctx, method: string, path: string, body: unknown, token: string, stepUp?: string) =>
  ctx.app.request(path, { ...jsonRequestInit(body, bearer(token, stepUp ? { "x-stepup-token": stepUp } : {})), method });
const alta = (ctx: Ctx, token: string, parche: Record<string, unknown> = {}, stepUp?: string) => send(ctx, "POST", "/superadmin/contratos", { organizationId: ctx.org, ...CONTRATO, ...parche }, token, stepUp);
const enmendar = (ctx: Ctx, token: string, contractId: string, parche: Record<string, unknown> = {}, stepUp?: string) =>
  send(ctx, "POST", `/superadmin/contratos/${contractId}/enmiendas`, { ...CONTRATO, vigenteDesde: "2026-10-16", baseCentavos: 790_000, motivo: "Sube la base por el alta de la cuarta sucursal.", ...parche }, token, stepUp);

describe("contratos -- gateo: otro usuario sin acceso", () => {
  it("un staff normal recibe 403 en todas las rutas y sin token 401; nada se escribe", async () => {
    const ctx = await setup();
    const st = await ctx.s.staff();
    for (const path of ["/superadmin/contratos", `/superadmin/contratos/estimacion?organizationId=${ctx.org}&mes=2026-10`]) {
      expect((await get(ctx, path, st.token)).status, path).toBe(403);
      expect((await ctx.app.request(path)).status, path).toBe(401);
    }
    expect((await alta(ctx, st.token)).status).toBe(403);
    expect((await enmendar(ctx, st.token, "00000000-0000-4000-8000-0000000000c1")).status).toBe(403);
    const sa = await ctx.superadmin();
    expect(((await (await get(ctx, "/superadmin/contratos", sa.token)).json()) as { versiones: unknown[] }).versiones).toHaveLength(0);
  });

  it("un superadmin real SI llega, pero la base rechaza a quien no esta sembrado como superadmin aunque tenga token valido de superadmin en otra capa", async () => {
    const ctx = await setup();
    const sa = await ctx.s.superadmin(); // superadmin en core pero NO en el repo de contratos (caller-binding de la base)
    const res = await alta(ctx, sa.token);
    expect(res.status).toBe(403);
    expect(await ctx.contratos.listVersions(sa.id, ctx.org)).toEqual({ availability: "available", versions: [] });
  });
});

describe("contratos -- alta, historial y validaciones", () => {
  it("alta: 201 con contractId, version 1, y el historial muestra quien lo dio de alta (centavos enteros, MXN)", async () => {
    const ctx = await setup();
    const sa = await ctx.superadmin();
    const res = await alta(ctx, sa.token);
    expect(res.status).toBe(201);
    const { contractId, version } = (await res.json()) as { contractId: string; version: number };
    expect(version).toBe(1);
    const lista = (await (await get(ctx, `/superadmin/contratos?organizationId=${ctx.org}`, sa.token)).json()) as { disponible: boolean; versiones: Array<Record<string, unknown>> };
    expect(lista.disponible).toBe(true);
    expect(lista.versiones).toHaveLength(1);
    expect(lista.versiones[0]).toMatchObject({ contractId, version: 1, moneda: "MXN", baseCentavos: 590_000, porSucursalCentavos: 400_000, bolsaMinutos: 10_000, excedenteCentavosMinuto: 300, creadoPor: sa.id, creadoPorCorreo: sa.email, organizacion: "Los Taquitos de PM" });
    for (const v of ["baseCentavos", "porSucursalCentavos", "excedenteCentavosMinuto", "instalacionCentavos"]) expect(Number.isInteger(lista.versiones[0]?.[v])).toBe(true);
  });

  it("validaciones: decimales, negativos, descuento > 100 %, motivo corto, moneda distinta de MXN, fechas y organizacion mal formada -> 400", async () => {
    const ctx = await setup();
    const sa = await ctx.superadmin();
    const malos: Array<Record<string, unknown>> = [
      { baseCentavos: 5900.5 },
      { baseCentavos: -1 },
      { baseCentavos: "5900" },
      { descuentoBp: 10_001 },
      { motivo: "corto" },
      { moneda: "USD" },
      { vigenteDesde: "2026-02-30" },
      { vigenteDesde: "01/01/2026" },
      { vigenteDesde: "2026-05-10", vigenteHasta: "2026-05-09" },
      { organizationId: "no-es-uuid" },
    ];
    for (const m of malos) expect((await alta(ctx, sa.token, m)).status, JSON.stringify(m)).toBe(400);
    const sin = { ...CONTRATO } as Record<string, unknown>;
    delete sin.bolsaMinutos;
    expect((await send(ctx, "POST", "/superadmin/contratos", { organizationId: ctx.org, ...sin }, sa.token)).status).toBe(400);
    expect((await ctx.contratos.listVersions(sa.id, null)).versions).toHaveLength(0);
  });

  it("organizacion inexistente -> 404", async () => {
    const ctx = await setup();
    const sa = await ctx.superadmin();
    expect((await alta(ctx, sa.token, { organizationId: ORG_INEXISTENTE })).status).toBe(404);
  });

  it("vigencias traslapadas rechazadas con 409; contiguas aceptadas; el historial de otra organizacion no se mezcla", async () => {
    const ctx = await setup();
    const sa = await ctx.superadmin();
    expect((await alta(ctx, sa.token, { vigenteDesde: "2026-01-01", vigenteHasta: "2026-06-30" })).status).toBe(201);
    const choque = await alta(ctx, sa.token, { vigenteDesde: "2026-06-30", vigenteHasta: null });
    expect(choque.status).toBe(409);
    expect((await alta(ctx, sa.token, { vigenteDesde: "2026-07-01", vigenteHasta: null })).status).toBe(201);
    expect((await alta(ctx, sa.token, { vigenteDesde: "2030-01-01", vigenteHasta: null })).status).toBe(409);
    expect((await send(ctx, "POST", "/superadmin/contratos", { organizationId: ORG_SIN_CONTRATO, ...CONTRATO }, sa.token)).status).toBe(201);
    const solo = (await (await get(ctx, `/superadmin/contratos?organizationId=${ORG_SIN_CONTRATO}`, sa.token)).json()) as { versiones: unknown[] };
    expect(solo.versiones).toHaveLength(1);
    const todos = (await (await get(ctx, "/superadmin/contratos", sa.token)).json()) as { versiones: unknown[] };
    expect(todos.versiones).toHaveLength(3);
  });

  it("parametros de consulta mal formados -> 400", async () => {
    const ctx = await setup();
    const sa = await ctx.superadmin();
    expect((await get(ctx, "/superadmin/contratos?organizationId=x", sa.token)).status).toBe(400);
    expect((await get(ctx, "/superadmin/contratos?limite=0", sa.token)).status).toBe(400);
    expect((await get(ctx, "/superadmin/contratos/estimacion?organizationId=x&mes=2026-10", sa.token)).status).toBe(400);
    expect((await get(ctx, `/superadmin/contratos/estimacion?organizationId=${ctx.org}&mes=2026-13`, sa.token)).status).toBe(400);
  });
});

describe("contratos -- enmiendas (cambio a mitad de mes)", () => {
  it("version 2 con su autor, la 1 intacta; el historial va de la mas reciente a la mas antigua", async () => {
    const ctx = await setup();
    const ana = await ctx.superadmin();
    const beto = await ctx.superadmin();
    const { contractId } = (await (await alta(ctx, ana.token)).json()) as { contractId: string };
    const res = await enmendar(ctx, beto.token, contractId);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, contractId, version: 2 });
    const { versiones } = (await (await get(ctx, `/superadmin/contratos?organizationId=${ctx.org}`, ana.token)).json()) as { versiones: Array<{ version: number; baseCentavos: number; creadoPor: string; vigenteDesde: string }> };
    expect(versiones.map((v) => [v.version, v.baseCentavos, v.creadoPor, v.vigenteDesde])).toEqual([
      [2, 790_000, beto.id, "2026-10-16"],
      [1, 590_000, ana.id, "2026-01-01"],
    ]);
  });

  it("enmienda sin cambios, en un mes ya pasado, que no crece, de un contrato inexistente o que choca con otro contrato: rechazadas", async () => {
    const ctx = await setup();
    const sa = await ctx.superadmin();
    const { contractId } = (await (await alta(ctx, sa.token, { vigenteHasta: "2026-12-31" })).json()) as { contractId: string };
    expect((await enmendar(ctx, sa.token, contractId, { baseCentavos: 590_000, vigenteHasta: "2026-12-31", motivo: "Intento sin cambiar ninguna condicion." })).status).toBe(400);
    expect((await enmendar(ctx, sa.token, contractId, { vigenteDesde: "2026-09-30", vigenteHasta: "2026-12-31" })).status).toBe(400);
    expect((await enmendar(ctx, sa.token, contractId, { vigenteDesde: "2026-01-01", vigenteHasta: "2026-12-31" })).status).toBe(400);
    expect((await enmendar(ctx, sa.token, "00000000-0000-4000-8000-0000000000c1")).status).toBe(404);
    expect((await enmendar(ctx, sa.token, "no-es-uuid")).status).toBe(400);
    expect((await alta(ctx, sa.token, { vigenteDesde: "2027-01-01", vigenteHasta: null })).status).toBe(201);
    expect((await enmendar(ctx, sa.token, contractId, { vigenteDesde: "2026-10-16", vigenteHasta: "2027-02-01" })).status).toBe(409);
    expect((await ctx.contratos.listVersions(sa.id, ctx.org)).versions).toHaveLength(2);
  });
});

describe("contratos -- facturacion estimada del mes", () => {
  async function conVoz(ctx: Ctx, minutos: number, eventos: number) {
    ctx.contratos.seedVoz(ctx.org, "2026-10", minutos, eventos);
  }

  it("mes completo: recurrente (base + sucursales extra), bolsa y excedente en centavos enteros; no cobra ni envia nada", async () => {
    const ctx = await setup();
    const sa = await ctx.superadmin();
    await alta(ctx, sa.token);
    await conVoz(ctx, 10_500, 12);
    const res = await get(ctx, `/superadmin/contratos/estimacion?organizationId=${ctx.org}&mes=2026-10`, sa.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; insumos: Record<string, unknown>; estimacion: Record<string, unknown> };
    expect(body.insumos).toEqual({ sucursalesActivas: 3, minutosVoz: 10_500, eventosVoz: 12 });
    expect(body.estimacion).toMatchObject({ estado: "estimado", moneda: "MXN", recurrenteCentavos: 1_390_000, bolsaMinutos: 10_000, minutosExcedentes: 500, excedenteCentavos: 150_000, totalCentavos: 1_540_000, razonTotal: null });
  });

  it("sin minutos medidos (0 eventos de voz): el total es null con su razon, no un cero inventado", async () => {
    const ctx = await setup();
    const sa = await ctx.superadmin();
    await alta(ctx, sa.token);
    const body = (await (await get(ctx, `/superadmin/contratos/estimacion?organizationId=${ctx.org}&mes=2026-10`, sa.token)).json()) as { insumos: { minutosVoz: unknown }; estimacion: Record<string, unknown> };
    expect(body.insumos.minutosVoz).toBeNull();
    expect(body.estimacion).toMatchObject({ recurrenteCentavos: 1_390_000, excedenteCentavos: null, totalCentavos: null });
    expect(String(body.estimacion.razonTotal)).toMatch(/minutos/);
  });

  it("cambio a mitad de mes: prorratea 15 + 16 dias de 31 y cobra el excedente a la tarifa de la ultima version", async () => {
    const ctx = await setup();
    const sa = await ctx.superadmin();
    const { contractId } = (await (await alta(ctx, sa.token)).json()) as { contractId: string };
    await enmendar(ctx, sa.token, contractId);
    await conVoz(ctx, 10_500, 12);
    const body = (await (await get(ctx, `/superadmin/contratos/estimacion?organizationId=${ctx.org}&mes=2026-10`, sa.token)).json()) as { estimacion: { segmentos: Array<Record<string, unknown>> } & Record<string, unknown> };
    expect(body.estimacion.segmentos.map((s) => [s.version, s.desde, s.hasta, s.dias, s.mensualCentavos, s.proporcionalCentavos])).toEqual([
      [1, "2026-10-01", "2026-10-15", 15, 1_390_000, 672_581],
      [2, "2026-10-16", "2026-10-31", 16, 1_590_000, 820_645],
    ]);
    expect(body.estimacion).toMatchObject({ recurrenteCentavos: 1_493_226, excedenteCentavos: 150_000, totalCentavos: 1_643_226 });
  });

  it("sin contrato vigente en el mes: estado sin_contrato y todo null; un mes anterior al inicio tambien", async () => {
    const ctx = await setup();
    const sa = await ctx.superadmin();
    await alta(ctx, sa.token);
    const sin = (await (await get(ctx, `/superadmin/contratos/estimacion?organizationId=${ORG_SIN_CONTRATO}&mes=2026-10`, sa.token)).json()) as { estimacion: Record<string, unknown> };
    expect(sin.estimacion).toMatchObject({ estado: "sin_contrato", recurrenteCentavos: null, totalCentavos: null });
    const antes = (await (await get(ctx, `/superadmin/contratos/estimacion?organizationId=${ctx.org}&mes=2025-12`, sa.token)).json()) as { estimacion: Record<string, unknown> };
    expect(antes.estimacion).toMatchObject({ estado: "sin_contrato" });
  });

  it("sin `mes` usa el mes en curso (hora de Mexico); organizacion inexistente -> 404", async () => {
    const ctx = await setup();
    const sa = await ctx.superadmin();
    await alta(ctx, sa.token);
    const body = (await (await get(ctx, `/superadmin/contratos/estimacion?organizationId=${ctx.org}`, sa.token)).json()) as { mes: string };
    expect(body.mes).toBe("2026-10");
    expect((await get(ctx, `/superadmin/contratos/estimacion?organizationId=${ORG_INEXISTENTE}&mes=2026-10`, sa.token)).status).toBe(404);
  });

  it("el rol finanzas (solo lectura) puede leer la estimacion pero no escribir", async () => {
    const zona = new InMemoryCfoZoneRepository({ now: () => T0 });
    const ctx = await setup({ zona });
    const sa = await ctx.superadmin();
    await alta(ctx, sa.token);
    const fin = await ctx.finanzas();
    const stepUp = await ctx.activarMfa(fin);
    expect((await get(ctx, `/superadmin/contratos/estimacion?organizationId=${ctx.org}&mes=2026-10`, fin.token, stepUp)).status).toBe(200);
    expect((await get(ctx, "/superadmin/contratos", fin.token, stepUp)).status).toBe(200);
    expect(zona.entries().filter((e) => e.actorUserId === fin.id).map((e) => `${e.accion}:${e.recurso}`)).toEqual(["consulta:contratos/estimacion", "consulta:contratos"]);
    const intento = await alta(ctx, fin.token, { vigenteDesde: "2031-01-01" }, stepUp);
    expect(intento.status).toBe(403);
    expect(await intento.json()).toMatchObject({ code: "rol_finanzas_solo_lectura" });
    expect((await ctx.contratos.listVersions(sa.id, ctx.org)).versions).toHaveLength(1);
  });
});

describe("contratos -- step-up en las escrituras", () => {
  it("con factor ACTIVO: alta y enmienda exigen x-stepup-token; las lecturas no", async () => {
    const ctx = await setup();
    const sa = await ctx.superadmin();
    const stepUp = await ctx.activarMfa(sa);

    const sin = await alta(ctx, sa.token);
    expect(sin.status).toBe(403);
    expect(await sin.json()).toMatchObject({ code: "stepup_required" });
    expect((await ctx.contratos.listVersions(sa.id, null)).versions).toHaveLength(0);
    const con = await alta(ctx, sa.token, {}, stepUp);
    expect(con.status).toBe(201);
    const { contractId } = (await con.json()) as { contractId: string };

    const enmSin = await enmendar(ctx, sa.token, contractId);
    expect(enmSin.status).toBe(403);
    expect((await ctx.contratos.listVersions(sa.id, null)).versions).toHaveLength(1);
    expect((await enmendar(ctx, sa.token, contractId, {}, stepUp)).status).toBe(201);

    expect((await get(ctx, "/superadmin/contratos", sa.token)).status).toBe(200);
    expect((await get(ctx, `/superadmin/contratos/estimacion?organizationId=${ctx.org}&mes=2026-10`, sa.token)).status).toBe(200);
  });

  it("las rutas de escritura estan en SENSITIVE_ROUTES y las de lectura no", () => {
    expect(SENSITIVE_ROUTES.filter((r) => r.pattern.source.includes("contratos")).length).toBe(2);
    expect(isSensitiveRoute("POST", "/superadmin/contratos")).toBe(true);
    expect(isSensitiveRoute("POST", "/superadmin/contratos/abc/enmiendas")).toBe(true);
    expect(isSensitiveRoute("GET", "/superadmin/contratos")).toBe(false);
    expect(isSensitiveRoute("GET", "/superadmin/contratos/estimacion")).toBe(false);
  });
});

describe("contratos -- base sin migrar y sin repositorio", () => {
  const noMigrado: ContratosRepository = {
    listVersions: async () => ({ availability: "not_migrated", versions: [] }),
    createContract: async () => ({ availability: "not_migrated", contractId: null }),
    amendContract: async () => ({ availability: "not_migrated", version: null }),
    getBillingInputs: async () => ({ availability: "not_migrated", inputs: null }),
  };

  for (const [nombre, repo] of [["migracion 0037 sin aplicar", noMigrado], ["sin repositorio", null]] as const) {
    it(`${nombre}: las lecturas dicen 'disponible: false' con su mensaje (200) y las escrituras 503, nunca un 500`, async () => {
      const ctx = await setup({ repo });
      const sa = await ctx.superadmin();
      const lista = await get(ctx, "/superadmin/contratos", sa.token);
      expect(lista.status).toBe(200);
      expect(await lista.json()).toMatchObject({ disponible: false, versiones: [], mensaje: expect.stringContaining("0037") });
      const est = await get(ctx, `/superadmin/contratos/estimacion?organizationId=${ctx.org}&mes=2026-10`, sa.token);
      expect(est.status).toBe(200);
      expect(await est.json()).toMatchObject({ disponible: false, estimacion: null });
      expect((await alta(ctx, sa.token)).status).toBe(503);
      expect((await enmendar(ctx, sa.token, "00000000-0000-4000-8000-0000000000c1")).status).toBe(503);
    });
  }
});
