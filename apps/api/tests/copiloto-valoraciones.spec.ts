// Valoraciones «Útil / No fue útil» del Copiloto (migracion 0076): (1) validacion del cuerpo y suma de conteos; (2) rutas por HTTP real
// (app.request) sobre la ruta compartida de hoteles con un repositorio EN MEMORIA que aplica el mismo alcance que la RLS (autor +
// organizacion + vertical): la organizacion y la vertical salen de la sesion, nunca del cuerpo; (3) el repositorio Postgres contra una
// sesion que reproduce la transaccion abortada de Postgres (base sin migrar y rechazo de RLS con SAVEPOINT); (4) el agrupado del back office.
// El aislamiento real (RLS, GRANT, cross-tenant, anon) lo prueba scripts/verify-copiloto-valoraciones/ contra Postgres real.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import type { DataChatDeps } from "../src/data-chat/deps.ts";
import type { ConversacionScope } from "../src/data-chat/conversaciones.ts";
import {
  PostgresValoracionesRepository,
  parseDiasResumen,
  parseValoracion,
  sumarFilas,
  type ResultadoValoracion,
  type ResumenValoraciones,
  type Valoracion,
  type ValoracionesRepository,
} from "../src/data-chat/valoraciones.ts";
import { agruparPorOrganizacion } from "../src/routes/superadmin-copiloto-valoraciones.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "../../../packages/domain-restaurantes/tests/support/aborting-fake-session.ts";
import { buildHotelesTestContext } from "./hoteles-fixtures.ts";

const pgError = (code: string, message = code): Error & { code: string } => Object.assign(new Error(message), { code });

describe("cuerpo y conteos", () => {
  it("acepta util con o sin motivo de la lista cerrada; rechaza campos extra, texto libre y motivo con «Útil»", () => {
    expect(parseValoracion({ util: true })).toEqual({ util: true, motivo: null });
    expect(parseValoracion({ util: false, motivo: "dato_incorrecto" })).toEqual({ util: false, motivo: "dato_incorrecto" });
    expect(parseValoracion({ util: false, motivo: null })).toEqual({ util: false, motivo: null });
    expect(() => parseValoracion({ util: "si" })).toThrow();
    expect(() => parseValoracion({ util: false, motivo: "mi teléfono es 9991234567" })).toThrow();
    expect(() => parseValoracion({ util: true, motivo: "otro" })).toThrow();
    expect(() => parseValoracion({ util: true, organizationId: "x" })).toThrow();
    expect(() => parseValoracion([])).toThrow();
  });

  it("dias: 30 por omision, 1..365", () => {
    expect(parseDiasResumen(undefined)).toBe(30);
    expect(parseDiasResumen("7")).toBe(7);
    expect(() => parseDiasResumen("0")).toThrow();
    expect(() => parseDiasResumen("400")).toThrow();
    expect(() => parseDiasResumen("7;drop")).toThrow();
  });

  it("suma filas (util, motivo, total) con totales en texto (bigint de Postgres)", () => {
    expect(sumarFilas([{ util: true, motivo: null, total: "5" }, { util: false, motivo: "dato_incorrecto", total: "2" }, { util: false, motivo: null, total: 1 }])).toEqual({
      utiles: 5,
      noUtiles: 3,
      motivos: { dato_incorrecto: 2, incompleta: 0, no_entendio: 0, otro: 0, sin_motivo: 1 },
    });
  });
});

interface Mensaje {
  readonly scope: ConversacionScope;
  readonly conversationId: string;
  readonly seq: number;
}

/** Doble en memoria con el mismo alcance que la RLS: solo mensajes del asistente de conversaciones del MISMO autor, organizacion y vertical. */
class MemoriaValoraciones implements ValoracionesRepository {
  readonly guardadas = new Map<string, { scope: ConversacionScope; v: Valoracion }>();
  disponible = true;
  constructor(readonly mensajes: Mensaje[], readonly admins: ReadonlySet<string>) {}
  async guardar(scope: ConversacionScope, conversationId: string, seq: number, v: Valoracion): Promise<ResultadoValoracion> {
    if (!this.disponible) return "no_disponible";
    const m = this.mensajes.find((x) => x.conversationId === conversationId && x.seq === seq && x.scope.userId === scope.userId && x.scope.organizationId === scope.organizationId && x.scope.vertical === scope.vertical);
    if (!m) return "no_encontrado";
    this.guardadas.set(`${conversationId}|${seq}|${scope.userId}`, { scope, v });
    return "ok";
  }
  async resumen(organizationId: string): Promise<ResumenValoraciones | null> {
    if (!this.admins.has(organizationId)) return null;
    const filas = [...this.guardadas.values()].filter((g) => g.scope.organizationId === organizationId).map((g) => ({ util: g.v.util, motivo: g.v.motivo, total: 1 }));
    return { disponible: this.disponible, ...sumarFilas(filas) };
  }
}

async function harness() {
  const ctx = await buildHotelesTestContext(buildApp);
  const conv = randomUUID();
  const convGm = randomUUID();
  const ownerId = ctx.staff.owner.id;
  const gmId = ctx.staff.gm.id;
  const mensajes: Mensaje[] = [
    { scope: { organizationId: ctx.organizationId, userId: ownerId, vertical: "hoteles" }, conversationId: conv, seq: 2 },
    { scope: { organizationId: ctx.organizationId, userId: gmId, vertical: "hoteles" }, conversationId: convGm, seq: 2 },
  ];
  const repo = new MemoriaValoraciones(mensajes, new Set([ctx.organizationId]));
  const dataChat: DataChatDeps = {
    restaurantesReader: () => {
      throw new Error("no se usa en hoteles");
    },
    audit: () => ({ record: async () => undefined }),
    rateLimiter: { allow: async () => true },
    completion: undefined,
    valoraciones: () => repo,
  };
  const app = buildApp({ ...ctx.deps, dataChat });
  const url = (id: string, seq: number | string = 2) => `/hoteles/${ctx.propertyId}/chat-datos/conversaciones/${id}/mensajes/${seq}/valoracion`;
  const put = (token: string, body: unknown): RequestInit => ({ method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ctx, app, repo, conv, convGm, url, put, ownerToken: ctx.staff.owner.token, gmToken: ctx.staff.gm.token };
}

describe("rutas de valoracion (hoteles)", () => {
  it("el autor valora su respuesta y puede cambiarla; la organizacion y la vertical salen de la sesion", async () => {
    const h = await harness();
    const r1 = await h.app.request(h.url(h.conv), h.put(h.ownerToken, { util: true }));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ util: true, motivo: null });
    const r2 = await h.app.request(h.url(h.conv), h.put(h.ownerToken, { util: false, motivo: "incompleta" }));
    expect(r2.status).toBe(200);
    expect(h.repo.guardadas.size).toBe(1);
    const g = [...h.repo.guardadas.values()][0]!;
    expect(g.v).toEqual({ util: false, motivo: "incompleta" });
    expect(g.scope).toEqual({ organizationId: h.ctx.organizationId, userId: h.ctx.staff.owner.id, vertical: "hoteles" });
  });

  it("la respuesta de OTRA persona (aunque sea su staff), un id mal formado o un seq fuera de rango responden 404", async () => {
    const h = await harness();
    expect((await h.app.request(h.url(h.convGm), h.put(h.ownerToken, { util: true }))).status).toBe(404);
    expect((await h.app.request(h.url("no-es-uuid"), h.put(h.ownerToken, { util: true }))).status).toBe(404);
    expect((await h.app.request(h.url(h.conv, 0), h.put(h.ownerToken, { util: true }))).status).toBe(404);
    expect((await h.app.request(h.url(h.conv, "2;x"), h.put(h.ownerToken, { util: true }))).status).toBe(404);
    expect(h.repo.guardadas.size).toBe(0);
  });

  it("cuerpo invalido -> 400; sin token -> 401; base sin migrar -> 503 honesto", async () => {
    const h = await harness();
    expect((await h.app.request(h.url(h.conv), h.put(h.ownerToken, { util: true, motivo: "otro" }))).status).toBe(400);
    expect((await h.app.request(h.url(h.conv), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ util: true }) })).status).toBe(401);
    h.repo.disponible = false;
    const r = await h.app.request(h.url(h.conv), h.put(h.ownerToken, { util: true }));
    expect(r.status).toBe(503);
    expect(JSON.stringify(await r.json())).toContain("0076");
  });

  it("el resumen de la organizacion: conteos para el owner, 403 para quien la funcion rechaza", async () => {
    const h = await harness();
    await h.app.request(h.url(h.conv), h.put(h.ownerToken, { util: false, motivo: "dato_incorrecto" }));
    await h.app.request(h.url(h.convGm), h.put(h.gmToken, { util: true }));
    const r = await h.app.request(`/hoteles/${h.ctx.propertyId}/chat-datos/valoraciones/resumen?dias=7`, { headers: { authorization: `Bearer ${h.ownerToken}` } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ disponible: true, dias: 7, utiles: 1, noUtiles: 1, motivos: { dato_incorrecto: 1, incompleta: 0, no_entendio: 0, otro: 0, sin_motivo: 0 } });
    (h.repo.admins as Set<string>).clear();
    expect((await h.app.request(`/hoteles/${h.ctx.propertyId}/chat-datos/valoraciones/resumen`, { headers: { authorization: `Bearer ${h.gmToken}` } })).status).toBe(403);
  });

  it("las 6 verticales exponen la valoracion y el resumen bajo la misma base que su chat de datos", async () => {
    const h = await harness();
    const put = new Set(h.app.routes.filter((r) => r.method === "PUT").map((r) => r.path));
    const get = new Set(h.app.routes.filter((r) => r.method === "GET").map((r) => r.path));
    for (const base of ["/v1/restaurantes/:propertyId/admin/chat-datos", "/hoteles/:propertyId/chat-datos", "/rentas/:propertyId/chat-datos", "/despachos/:propertyId/chat-datos", "/licitaciones/:propertyId/chat-datos", "/citas/:propertyId/chat-datos"]) {
      expect(put.has(`${base}/conversaciones/:conversationId/mensajes/:seq/valoracion`), `valoracion ${base}`).toBe(true);
      expect(get.has(`${base}/valoraciones/resumen`), `resumen ${base}`).toBe(true);
    }
    expect(get.has("/superadmin/copiloto/valoraciones")).toBe(true);
  });
});

describe("repositorio Postgres con la transaccion real de Postgres (SAVEPOINT)", () => {
  const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente/, respond: () => [{ ok: 1 }] };
  const scope: ConversacionScope = { organizationId: randomUUID(), userId: randomUUID(), vertical: "restaurantes" };
  const id = randomUUID();

  it("base sin migrar (42P01): «no disponible» y la transaccion sigue utilizable", async () => {
    const s = new AbortAwareFakeSession([{ match: /data_chat_message/, respond: () => [{ ok: 1 }] }, { match: /data_chat_feedback/, respond: () => pgError("42P01") }, SIGUIENTE]);
    expect(await new PostgresValoracionesRepository(s).guardar(scope, id, 2, { util: true, motivo: null })).toBe("no_disponible");
    await expect(s.query("select 1 as siguiente;")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("la RLS rechaza la fila (42501): «no encontrado» (como un mensaje ajeno) y la transaccion sigue utilizable", async () => {
    const s = new AbortAwareFakeSession([{ match: /data_chat_message/, respond: () => [{ ok: 1 }] }, { match: /data_chat_feedback/, respond: () => pgError("42501") }, SIGUIENTE]);
    expect(await new PostgresValoracionesRepository(s).guardar(scope, id, 2, { util: true, motivo: null })).toBe("no_encontrado");
    await expect(s.query("select 1 as siguiente;")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("mensaje que no es del autor: no intenta escribir", async () => {
    const s = new AbortAwareFakeSession([{ match: /data_chat_message/, respond: () => [] }, { match: /data_chat_feedback/, respond: () => pgError("XX000") }]);
    expect(await new PostgresValoracionesRepository(s).guardar(scope, id, 2, { util: false, motivo: "otro" })).toBe("no_encontrado");
    expect(s.calls.some((c) => c.includes("insert into core.data_chat_feedback"))).toBe(false);
  });

  it("resumen: 42883 -> disponible false; 42501 -> null (sin permiso); otro error se propaga", async () => {
    const sinFuncion = new AbortAwareFakeSession([{ match: /data_chat_feedback_resumen/, respond: () => pgError("42883", "function core.data_chat_feedback_resumen(uuid, timestamp with time zone) does not exist") }]);
    expect(await new PostgresValoracionesRepository(sinFuncion).resumen(scope.organizationId!, 30)).toMatchObject({ disponible: false, utiles: 0, noUtiles: 0 });
    const sinPermiso = new AbortAwareFakeSession([{ match: /data_chat_feedback_resumen/, respond: () => pgError("42501") }]);
    expect(await new PostgresValoracionesRepository(sinPermiso).resumen(scope.organizationId!, 30)).toBeNull();
    const roto = new AbortAwareFakeSession([{ match: /data_chat_feedback_resumen/, respond: () => pgError("XX000") }]);
    await expect(new PostgresValoracionesRepository(roto).resumen(scope.organizationId!, 30)).rejects.toThrow();
  });
});

describe("back office: agrupado por vertical y organizacion", () => {
  it("una fila por organizacion, primero las que tienen mas «No fue útil»; plataforma sin organizacion", () => {
    const filas = agruparPorOrganizacion([
      { vertical: "hoteles", organization_id: "a", organization_name: "Hotel A", util: true, motivo: null, total: "3" },
      { vertical: "restaurantes", organization_id: "b", organization_name: "PM", util: false, motivo: "dato_incorrecto", total: "2" },
      { vertical: "restaurantes", organization_id: "b", organization_name: "PM", util: true, motivo: null, total: "4" },
      { vertical: "plataforma", organization_id: null, organization_name: null, util: false, motivo: null, total: "1" },
    ]);
    expect(filas.map((f) => [f.vertical, f.organizacion, f.utiles, f.noUtiles])).toEqual([
      ["restaurantes", "PM", 4, 2],
      ["plataforma", null, 0, 1],
      ["hoteles", "Hotel A", 3, 0],
    ]);
  });
});
