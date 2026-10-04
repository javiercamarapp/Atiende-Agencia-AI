// SA-L-42/43 (mapa y ficha del Cerebro) en el API: la lista trae por prospecto si su telefono/correo estan en la lista de supresion de
// plataforma (funcion SOLO de sistema, sesion propia, solo hashes hacia la base), y POST /superadmin/cerebro/exportaciones deja el
// rastro de una exportacion en la bitacora ANTES de que el navegador arme el CSV. Base sin migrar y sesion abortada cubiertos.
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { AbortAwareFakeSession } from "../../../packages/db/tests/support/aborting-fake-session.ts";
import { sanearExportacion, suprimidosPorProspecto } from "../src/cerebro/index.ts";
import { hashearContacto } from "../src/supresion/index.ts";
import { superadminCerebroRoutes } from "../src/routes/superadmin-cerebro.ts";
import type { AppDeps } from "../src/deps.ts";
import { CALLER, PROSPECTO_ID, enviar, filaProspecto, filaTaxonomia, pgError } from "./cerebro-fixtures.ts";

/** Sesion que registra las consultas y sus parametros; responde `esta_suprimido` con los hashes que se le indiquen. */
function sesionConSupresion(suprimidos: ReadonlySet<string>): TenantDbSession & { consultas: Array<{ sql: string; params: unknown[] }> } {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  return {
    consultas,
    async query<T>(sql: string, params: unknown[] = []) {
      consultas.push({ sql, params });
      const [tipos, hashes] = params as [string[], string[]];
      return { rows: tipos.map((tipo, i) => ({ tipo, hash: hashes[i]!, suprimido: suprimidos.has(`${tipo}:${hashes[i]}`) })) as T[] };
    },
    async exec() {
      return undefined;
    },
  } as unknown as TenantDbSession & { consultas: Array<{ sql: string; params: unknown[] }> };
}

describe("suprimidosPorProspecto", () => {
  it("marca por prospecto SOLO los destinos suprimidos y manda hashes, nunca el telefono ni el correo en claro", async () => {
    const hashTel = hashearContacto("telefono", "9991234567")!;
    const db = sesionConSupresion(new Set([`telefono:${hashTel}`]));
    const r = await suprimidosPorProspecto(db, [
      { id: "a", telefono: "999 123 4567", correo: "a@ejemplo.mx" },
      { id: "b", telefono: "5512345678", correo: null },
      { id: "c", telefono: null, correo: null },
      { id: "d", telefono: "no es telefono", correo: "tampoco" },
    ]);
    expect(r?.get("a")).toEqual({ telefono: true, correo: false });
    expect(r?.get("b")).toEqual({ telefono: false, correo: false });
    expect(r?.get("c")).toEqual({ telefono: false, correo: false });
    expect(r?.get("d")).toEqual({ telefono: false, correo: false });
    const enviado = JSON.stringify(db.consultas.map((q) => q.params));
    expect(enviado).not.toContain("9991234567");
    expect(enviado).not.toContain("a@ejemplo.mx");
    expect(db.consultas).toHaveLength(1);
  });

  it("deduplica destinos repetidos y sin destinos no consulta la base", async () => {
    const db = sesionConSupresion(new Set());
    await suprimidosPorProspecto(db, [{ id: "a", telefono: "9991234567", correo: null }, { id: "b", telefono: "+52 999 123 4567", correo: null }]);
    expect((db.consultas[0]!.params as string[][])[0]).toHaveLength(1);
    const vacio = sesionConSupresion(new Set());
    expect((await suprimidosPorProspecto(vacio, [{ id: "a", telefono: null, correo: null }]))?.get("a")).toEqual({ telefono: false, correo: false });
    expect(vacio.consultas).toHaveLength(0);
  });

  it("base sin migrar (42883): null = no se pudo verificar, y la sesion queda sana (SAVEPOINT, no transaccion abortada)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = new AbortAwareFakeSession([
      { match: /esta_suprimido/, respond: () => pgError("42883") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const r = await suprimidosPorProspecto(session, [{ id: "a", telefono: "9991234567", correo: null }]);
    expect(r).toBeNull();
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("otro error de Postgres NO se traga: se propaga", async () => {
    const session = new AbortAwareFakeSession([{ match: /esta_suprimido/, respond: () => pgError("42501") }]);
    await expect(suprimidosPorProspecto(session, [{ id: "a", telefono: "9991234567", correo: null }])).rejects.toMatchObject({ code: "42501" });
  });
});

function montar(handlers: ConstructorParameters<typeof AbortAwareFakeSession>[0], extra: Partial<AppDeps> = {}) {
  const session = new AbortAwareFakeSession(handlers);
  const sesiones: Array<unknown> = [];
  const deps = {
    engine: {
      withAppSession: async (ctx: { userId: string | null }, fn: (db: AbortAwareFakeSession) => Promise<unknown>) => {
        sesiones.push(ctx.userId);
        return fn(session);
      },
    },
    coreRepo: { listProspectosForSuperadmin: async () => [] },
    ...extra,
  } as unknown as AppDeps;
  const app = new Hono<CoreAuthHonoEnv>();
  app.use("*", async (c, next) => {
    c.set("userId", CALLER);
    await next();
  });
  app.onError((err, c) => (err instanceof ApiError ? c.json({ code: err.code, error: err.message }, err.status as 400) : c.json({ error: "interno" }, 500)));
  app.route("/", superadminCerebroRoutes(deps, { ahora: () => new Date("2026-10-03T12:00:00.000Z") }));
  return { app, session, sesiones };
}

const LISTA = { match: /list_prospectos_cerebro_for_superadmin/, respond: () => [filaProspecto({ telefono: "9991234567", base_licitud: "fuente_publica_b2b" })] };
const TAX = { match: /list_cerebro_taxonomia_for_superadmin/, respond: () => [filaTaxonomia()] };

describe("GET /superadmin/cerebro/prospectos con supresion", () => {
  it("agrega `suprimido` por prospecto y la verificacion corre en una sesion de SISTEMA (userId null), no con el superadmin", async () => {
    const hash = hashearContacto("telefono", "9991234567")!;
    const { app, sesiones } = montar([
      LISTA,
      TAX,
      { match: /esta_suprimido/, respond: () => [{ tipo: "telefono", hash, suprimido: true }] },
    ]);
    const body = (await (await enviar(app, "GET", "/superadmin/cerebro/prospectos")).json()) as { prospectos: Array<{ id: string; suprimido?: { telefono: boolean; correo: boolean } }> };
    expect(body.prospectos[0]).toMatchObject({ id: PROSPECTO_ID, suprimido: { telefono: true, correo: false } });
    expect(sesiones).toEqual([CALLER, null]);
  });

  it("si la supresion no se puede verificar (0043 sin aplicar) la lista sigue en 200 SIN `suprimido`: la pantalla no ofrece contactar", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app } = montar([LISTA, TAX, { match: /esta_suprimido/, respond: () => pgError("42883") }]);
    const res = await enviar(app, "GET", "/superadmin/cerebro/prospectos");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; prospectos: Array<Record<string, unknown>> };
    expect(body.disponible).toBe(true);
    expect(body.prospectos[0]).not.toHaveProperty("suprimido");
  });

  it("si la lectura de supresion LANZA (error inesperado) la lista tampoco da 500", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app } = montar([LISTA, TAX, { match: /esta_suprimido/, respond: () => pgError("57014") }]);
    const res = await enviar(app, "GET", "/superadmin/cerebro/prospectos");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { prospectos: Array<Record<string, unknown>> }).prospectos[0]).not.toHaveProperty("suprimido");
  });
});

describe("sanearExportacion", () => {
  it("solo pasan las llaves conocidas con valores acotados; `__proto__` y el resto se descartan", () => {
    const crudo = JSON.parse('{"total":12,"filtros":{"verticales":["hoteles"],"minUrgencia":70,"soloTel":true,"busqueda":"Juan Perez","__proto__":{"x":1},"constructor":"y","orden":"cierre","etapas":{"a":1}}}');
    const r = sanearExportacion(crudo);
    expect(r).toEqual({ ok: true, total: 12, filtros: { verticales: ["hoteles"], minUrgencia: 70, soloTel: true, orden: "cierre" } });
    expect(Object.getPrototypeOf((r as { filtros: object }).filtros)).toBe(Object.prototype);
  });
  it("acota listas y textos largos", () => {
    const r = sanearExportacion({ total: 1, filtros: { fuentes: Array.from({ length: 100 }, () => "x".repeat(500)), orden: "y".repeat(500) } });
    expect(r.ok && (r.filtros.fuentes as string[]).length).toBe(40);
    expect(r.ok && (r.filtros.fuentes as string[])[0]!.length).toBe(80);
    expect(r.ok && (r.filtros.orden as string).length).toBe(80);
  });
  it("total invalido o cuerpo que no es objeto se rechaza", () => {
    for (const malo of [null, [], "x", { total: -1 }, { total: 1.5 }, { total: "3" }, { total: 2_000_000 }, {}]) expect(sanearExportacion(malo).ok).toBe(false);
  });
});

describe("POST /superadmin/cerebro/exportaciones", () => {
  const cuerpo = { total: 25, filtros: { verticales: ["hoteles"], minUrgencia: 70, busqueda: "no debe viajar" } };

  it("registra la exportacion en la bitacora (accion exportacion, recurso cerebro_prospectos) con la FORMA de la consulta y el total", async () => {
    const logAccess = vi.fn(async () => ({ availability: "ok" as const, seq: 7 }));
    const { app, sesiones } = montar([], { cfoZoneRepo: () => ({ logAccess }) } as unknown as Partial<AppDeps>);
    const res = await enviar(app, "POST", "/superadmin/cerebro/exportaciones", cuerpo);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ registrada: true });
    expect(logAccess).toHaveBeenCalledWith(CALLER, "exportacion", "cerebro_prospectos", { verticales: ["hoteles"], minUrgencia: 70, total: 25, _ruta: "/superadmin/cerebro/exportaciones" });
    expect(sesiones).toEqual([CALLER]);
  });

  it("sin bitacora configurada o sin la migracion 0034: 200 con registrada=false (la pantalla lo avisa), nunca un exito simulado", async () => {
    const sin = montar([]);
    expect(await (await enviar(sin.app, "POST", "/superadmin/cerebro/exportaciones", cuerpo)).json()).toEqual({ registrada: false, motivo: "bitacora_no_disponible" });
    const noMig = montar([], { cfoZoneRepo: () => ({ logAccess: async () => ({ availability: "not_migrated" as const, seq: null }) }) } as unknown as Partial<AppDeps>);
    expect(await (await enviar(noMig.app, "POST", "/superadmin/cerebro/exportaciones", cuerpo)).json()).toEqual({ registrada: false, motivo: "bitacora_no_disponible" });
  });

  it("si REGISTRAR lanza, la ruta falla (500) para que la pantalla NO arme el archivo", async () => {
    const { app } = montar([], { cfoZoneRepo: () => ({ logAccess: async () => { throw new Error("falla"); } }) } as unknown as Partial<AppDeps>);
    expect((await enviar(app, "POST", "/superadmin/cerebro/exportaciones", cuerpo)).status).toBe(500);
  });

  it("cuerpo invalido: 400/422 y no toca la bitacora", async () => {
    const logAccess = vi.fn();
    const { app } = montar([], { cfoZoneRepo: () => ({ logAccess }) } as unknown as Partial<AppDeps>);
    const res = await enviar(app, "POST", "/superadmin/cerebro/exportaciones", { total: -3 });
    expect([400, 422]).toContain(res.status);
    expect(logAccess).not.toHaveBeenCalled();
  });
});
