// R-16 -- preferencias de avisos del staff. AbortAwareFakeSession reproduce el estado abortado (25P02) de una
// transaccion real de Postgres: una sesion falsa plana NO demostraria que el fallback contra la base sin migrar
// deja utilizable la transaccion del request.
import { describe, expect, it } from "vitest";
import { CATALOGO_NOTIFICACIONES, eventoPorId } from "@atiende/db";
import {
  AvisosNoDisponiblesError,
  AvisosPermisoError,
  AvisosValidacionError,
  EVENTOS_AVISO,
  guardarPreferenciaAviso,
  guardarUmbralEntrega,
  listarPreferenciasAvisos,
  listarUmbralesEntrega,
} from "../src/avisos-preferencias.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-00000000a001";
const USER = "00000000-0000-0000-0000-00000000b001";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("catalogo de avisos que se pueden apagar", () => {
  it("cada aviso existe en el catalogo de notificaciones, es de restaurantes y tiene productor conectado", () => {
    for (const a of EVENTOS_AVISO) {
      const e = eventoPorId(a.tipo);
      expect(e, a.tipo).toBeDefined();
      expect(e!.ambito, a.tipo).toBe("restaurantes");
      expect(e!.productor.estado, a.tipo).toBe("conectado");
    }
    expect(new Set(EVENTOS_AVISO.map((a) => a.tipo)).size).toBe(EVENTOS_AVISO.length);
  });

  it("incluye los siete avisos de operacion y los dos nuevos de R-16", () => {
    const tipos = EVENTOS_AVISO.map((a) => a.tipo);
    expect(tipos).toContain("restaurantes.pedido.entrega_tardia");
    expect(tipos).toContain("restaurantes.pedido.programado_por_vencer");
    expect(tipos).toContain("restaurantes.pedido.incidencia_repartidor");
    expect(CATALOGO_NOTIFICACIONES.filter((e) => tipos.includes(e.id))).toHaveLength(tipos.length);
  });

  it("solo el pedido nuevo declara sonido (el unico con sonido real en el navegador)", () => {
    expect(EVENTOS_AVISO.filter((a) => a.sonidoAplica).map((a) => a.tipo)).toEqual(["restaurantes.pedido.nuevo"]);
  });
});

describe("listarPreferenciasAvisos", () => {
  it("devuelve las filas conocidas, descarta tipos ajenos al catalogo de avisos y pasa `todos`", async () => {
    let params: unknown[] = [];
    const session = new AbortAwareFakeSession([
      {
        match: /core\.list_notification_preferences/,
        respond: () => [
          { user_id: USER, tipo: "restaurantes.pedido.nuevo", enabled: false, sonido: false },
          { user_id: USER, tipo: "restaurantes.plan.mensajes_80", enabled: false, sonido: true },
        ],
      },
    ]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, p?: unknown[]) => {
      params = p ?? [];
      return original(sql, p);
    }) as typeof session.query;

    const r = await listarPreferenciasAvisos(session, ORG, { todos: true });
    expect(r).toEqual({ disponible: true, filas: [{ userId: USER, tipo: "restaurantes.pedido.nuevo", enabled: false, sonido: false }] });
    expect(params).toEqual([ORG, true]);
  });

  it("base sin migrar (42883): disponible=false y la transaccion sigue utilizable (SAVEPOINT)", async () => {
    let tabla = 0;
    const session = new AbortAwareFakeSession([
      { match: /core\.list_notification_preferences/, respond: () => pgError("42883", "function core.list_notification_preferences(uuid, boolean) does not exist") },
      { match: /select 1 as despues/, respond: () => { tabla += 1; return [{ despues: 1 }]; } },
    ]);
    const r = await listarPreferenciasAvisos(session, ORG);
    expect(r).toEqual({ disponible: false, filas: [] });
    // Sin el SAVEPOINT esta consulta fallaria con 25P02.
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ despues: 1 }] });
    expect(tabla).toBe(1);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("un permiso insuficiente (42501) se traduce a AvisosPermisoError sin el prefijo de la funcion", async () => {
    const session = new AbortAwareFakeSession([
      { match: /core\.list_notification_preferences/, respond: () => pgError("42501", "list_notification_preferences: ver las de todo el equipo requiere owner/admin") },
    ]);
    await expect(listarPreferenciasAvisos(session, ORG, { todos: true })).rejects.toThrow(AvisosPermisoError);
    await expect(listarPreferenciasAvisos(session, ORG, { todos: true })).rejects.toThrow("ver las de todo el equipo requiere owner/admin");
  });
});

describe("guardarPreferenciaAviso", () => {
  it("manda la preferencia a la funcion de la base con los parametros exactos", async () => {
    let params: unknown[] = [];
    const session = new AbortAwareFakeSession([{ match: /core\.set_notification_preference/, respond: () => [] }]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, p?: unknown[]) => {
      params = p ?? [];
      return original(sql, p);
    }) as typeof session.query;
    await guardarPreferenciaAviso(session, { organizationId: ORG, userId: USER, tipo: "restaurantes.pedido.nuevo", enabled: false, sonido: true });
    expect(params).toEqual([ORG, USER, "restaurantes.pedido.nuevo", false, true]);
  });

  it("rechaza un tipo fuera del catalogo de avisos sin tocar la base", async () => {
    const session = new AbortAwareFakeSession([]);
    await expect(guardarPreferenciaAviso(session, { organizationId: ORG, userId: null, tipo: "hoteles.ticket.sla_vencido", enabled: false, sonido: true })).rejects.toThrow(AvisosValidacionError);
    expect(session.calls).toEqual([]);
  });

  it("base sin migrar: lanza AvisosNoDisponiblesError y deja la transaccion utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /core\.set_notification_preference/, respond: () => pgError("42883", "function core.set_notification_preference(uuid, uuid, text, boolean, boolean) does not exist") },
      { match: /select 1 as despues/, respond: () => [{ despues: 1 }] },
    ]);
    await expect(guardarPreferenciaAviso(session, { organizationId: ORG, userId: null, tipo: "restaurantes.pedido.nuevo", enabled: false, sonido: true })).rejects.toThrow(AvisosNoDisponiblesError);
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ despues: 1 }] });
  });

  it("42501 y 22023 de la base se traducen a permiso y validacion", async () => {
    const permiso = new AbortAwareFakeSession([{ match: /core\.set_notification_preference/, respond: () => pgError("42501", "set_notification_preference: un admin no edita las de un owner") }]);
    await expect(guardarPreferenciaAviso(permiso, { organizationId: ORG, userId: USER, tipo: "restaurantes.pedido.nuevo", enabled: false, sonido: true })).rejects.toThrow(AvisosPermisoError);
    const valida = new AbortAwareFakeSession([{ match: /core\.set_notification_preference/, respond: () => pgError("22023", "set_notification_preference: tipo invalido para esta organizacion") }]);
    await expect(guardarPreferenciaAviso(valida, { organizationId: ORG, userId: USER, tipo: "restaurantes.pedido.nuevo", enabled: false, sonido: true })).rejects.toThrow(AvisosValidacionError);
  });
});

describe("umbral de entrega tardia", () => {
  it("lista las sucursales con su umbral (null = sin configurar)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from core\.property p/, respond: () => [{ property_id: "p1", name: "Centro", entrega_tardia_min: 30 }, { property_id: "p2", name: "Norte", entrega_tardia_min: null }] },
    ]);
    expect(await listarUmbralesEntrega(session, ORG)).toEqual({
      disponible: true,
      sucursales: [{ propertyId: "p1", nombre: "Centro", entregaTardiaMin: 30 }, { propertyId: "p2", nombre: "Norte", entregaTardiaMin: null }],
    });
  });

  it("base sin migrar (42P01): disponible=false y la transaccion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from core\.property p/, respond: () => pgError("42P01", 'relation "restaurantes.sucursal_avisos_config" does not exist') },
      { match: /select 1 as despues/, respond: () => [{ despues: 1 }] },
    ]);
    expect(await listarUmbralesEntrega(session, ORG)).toEqual({ disponible: false, sucursales: [] });
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ despues: 1 }] });
  });

  it("valida el rango en el servidor antes de llamar a la base", async () => {
    const session = new AbortAwareFakeSession([]);
    for (const malo of [9, 241, 12.5, Number.NaN]) {
      await expect(guardarUmbralEntrega(session, "p1", malo), String(malo)).rejects.toThrow(AvisosValidacionError);
    }
    expect(session.calls).toEqual([]);
  });

  it("guarda el umbral y, sin migracion, lanza AvisosNoDisponiblesError", async () => {
    const ok = new AbortAwareFakeSession([{ match: /restaurantes\.set_umbral_entrega_tardia/, respond: () => [] }]);
    await expect(guardarUmbralEntrega(ok, "p1", 30)).resolves.toBeUndefined();
    const viejo = new AbortAwareFakeSession([{ match: /restaurantes\.set_umbral_entrega_tardia/, respond: () => pgError("42883", "function restaurantes.set_umbral_entrega_tardia(uuid, integer) does not exist") }]);
    await expect(guardarUmbralEntrega(viejo, "p1", 30)).rejects.toThrow(AvisosNoDisponiblesError);
  });
});
