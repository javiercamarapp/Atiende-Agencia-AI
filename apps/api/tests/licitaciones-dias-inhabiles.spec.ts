// L-22 -- calendario de dias inhabiles de licitaciones, HTTP real (Hono + auth + roles) sobre el
// repositorio en memoria (mismas reglas que la base). El aislamiento real por RLS/definer se prueba
// contra Postgres real en scripts/verify-licitaciones-dias-inhabiles/. Cubre: lectura (oficiales,
// sugeridos, declarados), roles de escritura, validacion, duplicado, convocatoria inexistente, base
// sin migrar (available:false / 503) y los plazos de pago, inconformidad, sala de guerra y junta
// calculados CON el calendario (y con solo los oficiales cuando no hay repositorio).
import { DiaInhabilNotAvailableError, InMemoryDiasInhabilesRepository } from "@atiende/domain-licitaciones";
import type { DiasInhabilesRepository } from "@atiende/domain-licitaciones";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedJson, buildLicitacionesTestContext } from "./licitaciones-fixtures.ts";
import { InMemorySalaGuerraRepository } from "@atiende/domain-licitaciones";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const UNMIGRATED: DiasInhabilesRepository = {
  async list() {
    throw new DiaInhabilNotAvailableError();
  },
  async create() {
    throw new DiaInhabilNotAvailableError();
  },
  async remove() {
    throw new DiaInhabilNotAvailableError();
  },
  // Igual que Postgres sin la migracion: el calendario efectivo NUNCA falla, cae a los oficiales.
  async resolveCalendario() {
    const { officialOnlyCalendar } = await import("@atiende/domain-licitaciones");
    return officialOnlyCalendar();
  },
};

async function setup(opts: { repo?: DiasInhabilesRepository | null } = {}) {
  const ctx = await buildLicitacionesTestContext(buildApp);
  const repo = opts.repo === undefined ? new InMemoryDiasInhabilesRepository() : opts.repo;
  const sala = new InMemorySalaGuerraRepository();
  const deps: AppDeps = { ...ctx.deps, licitacionesSalaGuerraRepo: () => sala, ...(repo ? { licitacionesDiasInhabilesRepo: () => repo } : {}) };
  const app = buildApp(deps);
  const lic = `/licitaciones/${ctx.propertyId}`;

  async function call(method: string, path: string, who: keyof typeof ctx.staff, body?: unknown): Promise<{ status: number; json: Json }> {
    const init: RequestInit = body === undefined ? { method, headers: { authorization: `Bearer ${ctx.staff[who].token}` } } : { ...authedJson(ctx.staff[who].token, body), method };
    const res = await app.request(`${lic}${path}`, init);
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
  return { ctx, repo, call, app, sala, lic };
}

describe("dias inhabiles (HTTP)", () => {
  it("GET: cualquier rol ve los oficiales 2026-2027, los sugeridos por validar y la nota; viewer no puede editar", async () => {
    const { call } = await setup();
    const r = await call("GET", "/dias-inhabiles", "viewer");
    expect(r.status).toBe(200);
    expect(r.json.available).toBe(true);
    expect(r.json.timeZone).toBe("America/Mexico_City");
    expect(r.json.coberturaOficial).toEqual([2026, 2027]);
    expect(r.json.oficiales).toHaveLength(14);
    expect(r.json.sugeridos.map((s: Json) => s.nombre)).toEqual(["Jueves Santo", "Viernes Santo", "Jueves Santo", "Viernes Santo"]);
    expect(r.json.nota).toMatch(/fiscalista\/abogado/);
    expect(r.json.puedeEditar).toBe(false);
    expect((await call("GET", "/dias-inhabiles", "analyst")).json.puedeEditar).toBe(true);
  });

  it("POST/DELETE: owner y analyst si; writer, reviewer y viewer 403", async () => {
    const { call } = await setup();
    for (const who of ["writer", "reviewer", "viewer"] as const) {
      expect((await call("POST", "/dias-inhabiles", who, { fecha: "2026-04-02", nombre: "Jueves Santo" })).status, who).toBe(403);
    }
    const a = await call("POST", "/dias-inhabiles", "owner", { fecha: "2026-04-02", nombre: "Jueves Santo", publicadoPor: "SHCP", fuente: "DOF 2026-01-10" });
    expect(a.status).toBe(201);
    expect(a.json).toMatchObject({ fecha: "2026-04-02", alcance: "organizacion", verificacion: "por_validar", publicadoPor: "SHCP" });
    const b = await call("POST", "/dias-inhabiles", "analyst", { fecha: "2026-04-03", nombre: "Viernes Santo" });
    expect(b.status).toBe(201);
    const list = await call("GET", "/dias-inhabiles", "viewer");
    expect(list.json.declarados).toHaveLength(2);
    expect(list.json.efectivos).toContain("2026-04-02");
    expect((await call("DELETE", `/dias-inhabiles/${a.json.id}`, "writer")).status).toBe(403);
    expect((await call("DELETE", `/dias-inhabiles/${a.json.id}`, "owner")).status).toBe(200);
    expect((await call("DELETE", `/dias-inhabiles/${a.json.id}`, "owner")).status).toBe(404);
    expect((await call("GET", "/dias-inhabiles", "viewer")).json.efectivos).not.toContain("2026-04-02");
  });

  it("validacion: fecha imposible, nombre corto, UUID malo, duplicado -> 400/409; convocatoria inexistente -> 404", async () => {
    const { call, ctx } = await setup();
    expect((await call("POST", "/dias-inhabiles", "owner", { fecha: "2026-02-30", nombre: "Dia inventado" })).status).toBe(400);
    expect((await call("POST", "/dias-inhabiles", "owner", { fecha: "2026-04-02", nombre: "ab" })).status).toBe(400);
    expect((await call("POST", "/dias-inhabiles", "owner", { fecha: "2026-04-02", nombre: "Dia valido", tenderId: "no-uuid" })).status).toBe(400);
    expect((await call("POST", "/dias-inhabiles", "owner", [1, 2])).status).toBe(400);
    expect((await call("DELETE", "/dias-inhabiles/no-uuid", "owner")).status).toBe(400);
    expect((await call("GET", "/dias-inhabiles?tenderId=no-uuid", "owner")).status).toBe(400);
    expect((await call("POST", "/dias-inhabiles", "owner", { fecha: "2026-04-02", nombre: "Dia valido" })).status).toBe(201);
    expect((await call("POST", "/dias-inhabiles", "owner", { fecha: "2026-04-02", nombre: "Dia valido otra vez" })).status).toBe(409);
    const ghost = "00000000-0000-4000-8000-000000000999";
    expect((await call("POST", "/dias-inhabiles", "owner", { fecha: "2026-05-04", nombre: "Dia de otra convocatoria", tenderId: ghost })).status).toBe(404);
    expect((await call("GET", `/dias-inhabiles?tenderId=${ghost}`, "owner")).status).toBe(404);
    // convocatoria real: se declara y solo cuenta para esa convocatoria
    const ok = await call("POST", "/dias-inhabiles", "owner", { fecha: "2026-05-04", nombre: "Dia de la convocante", tenderId: ctx.tenderId });
    expect(ok.status).toBe(201);
    expect(ok.json.alcance).toBe("convocatoria");
    expect((await call("GET", `/dias-inhabiles?tenderId=${ctx.tenderId}`, "viewer")).json.efectivos).toContain("2026-05-04");
    expect((await call("GET", "/dias-inhabiles", "viewer")).json.efectivos).not.toContain("2026-05-04");
  });

  it("base SIN migrar: la lectura responde available:false (con oficiales) y las escrituras 503, nunca 500", async () => {
    const { call } = await setup({ repo: UNMIGRATED });
    const r = await call("GET", "/dias-inhabiles", "viewer");
    expect(r.status).toBe(200);
    expect(r.json.available).toBe(false);
    expect(r.json.declarados).toEqual([]);
    expect(r.json.oficiales).toHaveLength(14);
    expect((await call("POST", "/dias-inhabiles", "owner", { fecha: "2026-04-02", nombre: "Jueves Santo" })).status).toBe(503);
    expect((await call("DELETE", "/dias-inhabiles/00000000-0000-4000-8000-000000000001", "owner")).status).toBe(503);
  });

  it("sin repositorio inyectado: available:false y 503 en escrituras", async () => {
    const { call } = await setup({ repo: null });
    expect((await call("GET", "/dias-inhabiles", "viewer")).json.available).toBe(false);
    expect((await call("POST", "/dias-inhabiles", "owner", { fecha: "2026-04-02", nombre: "Jueves Santo" })).status).toBe(503);
  });

  it("sin sesion -> 401", async () => {
    const { app, lic } = await setup();
    expect((await app.request(`${lic}/dias-inhabiles`)).status).toBe(401);
  });
});

describe("plazos calculados CON el calendario (pago, inconformidad, sala de guerra, junta)", () => {
  async function createContract(app: ReturnType<typeof buildApp>, lic: string, tenderId: string, token: string) {
    const res = await app.request(`${lic}/tenders/${tenderId}/contract`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(201);
  }

  it("pago art. 73: 17 habiles desde 2026-01-20 saltan el 2-feb (Constitucion) aunque nadie declare nada", async () => {
    const { ctx, app, lic } = await setup({ repo: null });
    await createContract(app, lic, ctx.tenderId, ctx.staff.owner.token);
    const res = await app.request(`${lic}/tenders/${ctx.tenderId}/contract/invoices`, authedJson(ctx.staff.writer.token, { concepto: "Primera exhibicion", amount: "100.00", invoiceVerifiedOn: "2026-01-20" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as Json;
    // sin feriados: 2026-02-12; con el 2-feb inhabil: 2026-02-13
    expect(body.dueDate).toBe("2026-02-13");
    expect(body.calendario.nota).toMatch(/oficiales de plataforma/);
  });

  it("pago art. 73: un dia declarado por la organizacion alarga mas el plazo y lo dice la nota", async () => {
    const { ctx, app, lic, call } = await setup();
    await createContract(app, lic, ctx.tenderId, ctx.staff.owner.token);
    expect((await call("POST", "/dias-inhabiles", "owner", { fecha: "2026-02-05", nombre: "Dia que publica la dependencia", tenderId: ctx.tenderId })).status).toBe(201);
    const res = await app.request(`${lic}/tenders/${ctx.tenderId}/contract/invoices`, authedJson(ctx.staff.writer.token, { concepto: "Primera exhibicion", amount: "100.00", invoiceVerifiedOn: "2026-01-20" }));
    const body = (await res.json()) as Json;
    expect(body.dueDate).toBe("2026-02-16");
    expect(body.calendario.nota).toMatch(/1 declarados/);
  });

  it("inconformidad art. 95: cruce de fin de anio con 25-dic y 1-ene inhabiles -> 2027-01-05", async () => {
    const { ctx, app, lic } = await setup({ repo: null });
    const res = await app.request(
      `${lic}/tenders/${ctx.tenderId}/inconformidad`,
      authedJson(ctx.staff.writer.token, { hechos: ["h"], agravios: ["a"], falloNotifiedOn: "2026-12-24", bajoTratados: false }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Json;
    expect(body.plazo.fechaLimite).toBe("2027-01-05");
    expect(body.calendario.avisos).toEqual([]);
  });

  it("inconformidad: un plazo que toca un anio sin calendario avisa", async () => {
    const { ctx, app, lic } = await setup({ repo: null });
    const res = await app.request(
      `${lic}/tenders/${ctx.tenderId}/inconformidad`,
      authedJson(ctx.staff.writer.token, { hechos: ["h"], agravios: ["a"], falloNotifiedOn: "2028-01-03", bajoTratados: false }),
    );
    const body = (await res.json()) as Json;
    expect(body.calendario.avisos[0]).toMatch(/2028/);
  });

  it("base sin migrar: el pago y la inconformidad se calculan igual con los oficiales (no 500)", async () => {
    const { ctx, app, lic } = await setup({ repo: UNMIGRATED });
    await createContract(app, lic, ctx.tenderId, ctx.staff.owner.token);
    const inv = await app.request(`${lic}/tenders/${ctx.tenderId}/contract/invoices`, authedJson(ctx.staff.writer.token, { concepto: "x", amount: "1.00", invoiceVerifiedOn: "2026-01-20" }));
    expect(inv.status).toBe(201);
    expect(((await inv.json()) as Json).dueDate).toBe("2026-02-13");
  });

  it("sala de guerra y junta: dias habiles restantes y aviso de anio sin calendario", async () => {
    const { ctx, call } = await setup();
    // el fixture fija la fecha limite de la convocatoria: se pisa con un feriado conocido via la junta
    const cfg = await call("PUT", `/tenders/${ctx.tenderId}/junta/config`, "writer", { questionsDeadlineAt: "2099-01-01T12:00:00Z", meetingAt: "2099-01-05T12:00:00Z" });
    expect(cfg.status).toBe(200);
    const junta = await call("GET", `/tenders/${ctx.tenderId}/junta`, "viewer");
    expect(junta.status).toBe(200);
    expect(junta.json.plazos.preguntas.fechaLimite).toBe("2099-01-01");
    expect(junta.json.plazos.preguntas.diasHabilesRestantes).toBeGreaterThan(0);
    expect(junta.json.plazos.preguntas.avisos.some((a: string) => /2099/.test(a))).toBe(true);
    const board = await call("GET", `/tenders/${ctx.tenderId}/sala-guerra`, "viewer");
    expect(board.status).toBe(200);
    expect(board.json).toHaveProperty("plazoPresentacion");
  });
});
