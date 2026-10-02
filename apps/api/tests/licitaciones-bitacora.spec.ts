// L-29 -- GET .../tenders/:tenderId/bitacora por HTTP real: une auditoria de alta/edicion, anotaciones de la sala
// de guerra, aprobaciones y presentacion en orden temporal; pagina, filtra, aisla por organizacion (cross-tenant),
// no filtra ids/correos de otras personas y degrada a vacio honesto con la base sin migrar (SAVEPOINT real).
import { InMemorySalaGuerraRepository } from "@atiende/domain-licitaciones";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildLicitacionesTestContext } from "./licitaciones-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function setup() {
  const ctx = await buildLicitacionesTestContext(buildApp);
  const sala = new InMemorySalaGuerraRepository();
  const app = buildApp({ ...ctx.deps, licitacionesSalaGuerraRepo: () => sala });
  return { ctx, app };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const bitacoraUrl = (s: Setup, tenderId = s.ctx.tenderId) => `/licitaciones/${s.ctx.propertyId}/tenders/${tenderId}/bitacora`;
const get = (s: Setup, token: string, query = "", tenderId?: string) => s.app.request(bitacoraUrl(s, tenderId) + query, authedJson(token));
const anotar = (s: Setup, body: string, token = s.ctx.staff.writer.token) =>
  s.app.request(`/licitaciones/${s.ctx.propertyId}/tenders/${s.ctx.tenderId}/sala-guerra/entries`, authedJson(token, { entryKind: "comentario", body }));

/** Crea una convocatoria por la ruta real (deja una fila de auditoria "alta manual") y devuelve su id. */
async function crearConvocatoria(s: Setup, title: string): Promise<string> {
  const res = await s.app.request(`/licitaciones/${s.ctx.propertyId}/tenders`, authedJson(s.ctx.staff.writer.token, { title, submissionDeadline: "2026-12-15T18:00:00-06:00", externalId: `EXT-${title}` }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe("GET .../bitacora (L-29)", () => {
  it("convocatoria sin eventos: pagina vacia honesta", async () => {
    const s = await setup();
    const res = await get(s, s.ctx.staff.viewer.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ items: [], total: 0, nextOffset: null, limit: 25, offset: 0 });
  });

  it("une la auditoria de alta manual con las anotaciones de la sala, mas reciente primero, con 'esTuyo' sin ids ajenos", async () => {
    const s = await setup();
    const tenderId = await crearConvocatoria(s, "Compra de laptops");
    const alta = (await (await get(s, s.ctx.staff.viewer.token, "", tenderId)).json()) as Json;
    expect(alta.items.length).toBeGreaterThanOrEqual(1);
    expect(alta.items.every((i: Json) => i.fuente === "auditoria")).toBe(true);
    expect(alta.items.some((i: Json) => i.accion === "tender.manual_upsert.created" && i.actor.esTuyo === false)).toBe(true);

    expect((await anotar(s, "Pedir carta del fabricante")).status).toBe(201);
    const propia = (await (await get(s, s.ctx.staff.viewer.token)).json()) as Json;
    expect(propia.items.map((i: Json) => i.fuente)).toEqual(["sala_guerra"]);
    expect(propia.items[0].descripcion).toContain("Pedir carta del fabricante");
    // quien la escribio la ve como suya; el resto, no
    expect(((await (await get(s, s.ctx.staff.writer.token)).json()) as Json).items[0].actor.esTuyo).toBe(true);
    expect(propia.items[0].actor.esTuyo).toBe(false);
    const crudo = JSON.stringify(propia);
    expect(crudo).not.toContain(s.ctx.staff.writer.id);
    expect(crudo).not.toContain(s.ctx.staff.writer.email);
  });

  it("incluye aprobaciones del expediente (con el rol, nunca el id)", async () => {
    const s = await setup();
    const base = `/licitaciones/${s.ctx.propertyId}/tenders/${s.ctx.tenderId}`;
    await s.app.request(`${base}/proposal`, authedJson(s.ctx.staff.writer.token));
    expect((await s.app.request(`${base}/expediente/approval`, authedJson(s.ctx.staff.analyst.token, { stage: "tecnica_legal" }))).status).toBe(201);
    const body = (await (await get(s, s.ctx.staff.viewer.token, "?fuente=aprobacion")).json()) as Json;
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({ fuente: "aprobacion", accion: "aprobada_tecnica_legal", actor: { esTuyo: false, rol: "analyst" } });
    expect(JSON.stringify(body)).not.toContain(s.ctx.staff.analyst.id);
  });

  it("pagina sin repetir ni perder (limit/offset) y expone nextOffset", async () => {
    const s = await setup();
    for (let i = 1; i <= 5; i += 1) expect((await anotar(s, `nota ${i}`)).status).toBe(201);
    const vistos: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const body = (await (await get(s, s.ctx.staff.viewer.token, `?limit=2&offset=${offset}`)).json()) as Json;
      expect(body.total).toBe(5);
      vistos.push(...body.items.map((i: Json) => i.id));
      offset = body.nextOffset;
    }
    expect(vistos).toHaveLength(5);
    expect(new Set(vistos).size).toBe(5);
  });

  it("filtra por fuente y por rango; parametros invalidos -> 400", async () => {
    const s = await setup();
    await anotar(s, "una nota");
    expect(((await (await get(s, s.ctx.staff.viewer.token, "?fuente=go_no_go")).json()) as Json).total).toBe(0);
    expect(((await (await get(s, s.ctx.staff.viewer.token, "?fuente=sala_guerra")).json()) as Json).total).toBe(1);
    expect(((await (await get(s, s.ctx.staff.viewer.token, "?desde=2999-01-01T00:00:00Z")).json()) as Json).total).toBe(0);
    for (const q of ["?fuente=otra", "?desde=ayer", "?limit=0", "?limit=101", "?offset=-1", "?limit=abc"]) {
      expect((await get(s, s.ctx.staff.viewer.token, q)).status, q).toBe(400);
    }
  });

  it("RLS / cross-tenant: otra organizacion no ve nada (ni con el id de la convocatoria ajena) y sin sesion 401", async () => {
    const s = await setup();
    await anotar(s, "secreto de la organizacion A");
    expect((await s.app.request(bitacoraUrl(s))).status).toBe(401);
    const otra = await setup();
    const res = await get(s, otra.ctx.staff.owner.token);
    expect([403, 404]).toContain(res.status);
    expect(await res.text()).not.toContain("secreto");
    // la organizacion B pidiendo SU property pero la convocatoria de A: tampoco ve filas
    const cruzada = await otra.app.request(`/licitaciones/${otra.ctx.propertyId}/tenders/${s.ctx.tenderId}/bitacora`, authedJson(otra.ctx.staff.owner.token));
    expect(cruzada.status).toBe(404);
    expect(await cruzada.text()).not.toContain("secreto");
  });

  it("COMPATIBILIDAD base sin migrar: si la auditoria falla con 42P01 dentro de la transaccion compartida, SAVEPOINT la recupera y el resto sigue respondiendo (no 500, no 25P02)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const sala = new InMemorySalaGuerraRepository();
    let abortada = false;
    let recuperada = false;
    let consultasPostError = 0;
    const envolver = (session: TenantDbSession): TenantDbSession => ({
      exec: async (sql) => {
        if (/^\s*rollback to savepoint/i.test(sql)) {
          abortada = false;
          recuperada = true;
          return;
        }
        if (abortada) throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
        return session.exec(sql);
      },
      query: async <T>(sql: string, params?: unknown[]) => {
        if (abortada) throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
        if (/tabla_auditoria_inexistente/.test(sql)) {
          abortada = true;
          throw Object.assign(new Error('relation "licitaciones.tender_audit_log" does not exist'), { code: "42P01" });
        }
        if (/select_ok_marker/.test(sql)) {
          if (recuperada) consultasPostError += 1;
          return { rows: [] as T[] };
        }
        return session.query<T>(sql, params);
      },
    });
    const engine: TenancyEngine = { withAppSession: (claims, fn) => ctx.deps.engine.withAppSession(claims, (session) => fn(envolver(session))) };
    const app = buildApp({
      ...ctx.deps,
      engine,
      licitacionesSalaGuerraRepo: () => sala,
      licitacionesRepo: (db) => {
        const real = ctx.deps.licitacionesRepo(db);
        return new Proxy(real, {
          get(target, prop, receiver) {
            if (prop === "listTenderAuditLogPage") return async () => (await db.query("select 1 from tabla_auditoria_inexistente"), { items: [], total: 0, nextOffset: null });
            if (prop === "listGoNoGoDecisions") return async (...args: [string, string]) => (await db.query("select 1 as select_ok_marker"), target.listGoNoGoDecisions(...args));
            const v = Reflect.get(target, prop, receiver);
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
      },
    });
    await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/sala-guerra/entries`, authedJson(ctx.staff.writer.token, { entryKind: "comentario", body: "sigue funcionando" }));
    const res = await app.request(`/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/bitacora`, authedJson(ctx.staff.viewer.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(recuperada).toBe(true);
    expect(consultasPostError).toBeGreaterThan(0);
    expect(body.items.map((i: Json) => i.fuente)).toEqual(["sala_guerra"]);
  });
});
