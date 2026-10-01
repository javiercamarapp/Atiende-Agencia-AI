// Rn-02 -- compatibilidad con la base SIN migrar (migración 026 pendiente) y traducción de las
// decisiones de negocio de rentas.resolver_conflicto_calendario, dentro de la transacción
// COMPARTIDA del request. AbortAwareFakeSession reproduce el estado abortado real de Postgres
// (25P02): una sesión falsa plana NO demostraría que el SAVEPOINT deja la sesión utilizable.
import { describe, expect, it } from "vitest";
import { PostgresRentasCalendarSyncRepository } from "../src/sync/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
const sinFuncion = () => pgError("42883", "function rentas.resolver_conflicto_calendario(uuid, uuid, unknown, unknown) does not exist");
const SIGUIENTE = { match: /select 1 as siguiente_query_del_request/i, respond: () => [{ ok: true }] };

async function sesionSigueUsable(session: AbortAwareFakeSession): Promise<void> {
  await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
}

const RESOLVER = { accion: "resuelto", motivo: null } as const;
const IGNORAR = { accion: "ignorado", motivo: "mismo huésped" } as const;

describe("decidirConflicto -- decisiones de la función SQL (026 aplicada)", () => {
  it.each([
    ["P0002", "no_encontrado"],
    ["55000", "solape_vigente"],
    ["42501", "sin_permiso"],
  ] as const)("SQLSTATE %s se traduce a %s y la transacción compartida queda utilizable", async (code, esperado) => {
    const session = new AbortAwareFakeSession([{ match: /resolver_conflicto_calendario/i, respond: () => pgError(code, "decisión de negocio") }, SIGUIENTE]);
    await expect(new PostgresRentasCalendarSyncRepository(session).decidirConflicto("p", "c", "u", RESOLVER)).resolves.toBe(esperado);
    expect(session.calls).toContain("savepoint sp_rentas_conflicto_decidir");
    expect(session.calls).toContain("rollback to savepoint sp_rentas_conflicto_decidir");
    await sesionSigueUsable(session);
  });

  it("devuelve la acción registrada por la función y libera el SAVEPOINT", async () => {
    const session = new AbortAwareFakeSession([{ match: /resolver_conflicto_calendario/i, respond: () => [{ accion: "ignorado" }] }, SIGUIENTE]);
    await expect(new PostgresRentasCalendarSyncRepository(session).decidirConflicto("p", "c", "u", IGNORAR)).resolves.toBe("ignorado");
    expect(session.calls).toContain("release savepoint sp_rentas_conflicto_decidir");
    await sesionSigueUsable(session);
  });

  it("un error que no es de negocio ni de migración (p. ej. timeout) se repropaga, y la sesión igual queda utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /resolver_conflicto_calendario/i, respond: () => pgError("57014", "canceling statement due to statement timeout") }, SIGUIENTE]);
    await expect(new PostgresRentasCalendarSyncRepository(session).decidirConflicto("p", "c", "u", RESOLVER)).rejects.toMatchObject({ code: "57014" });
    await sesionSigueUsable(session);
  });
});

describe("decidirConflicto -- base sin la migración 026", () => {
  it("'ignorado': 42883 -> no_disponible, sin tocar el UPDATE anterior y con la sesión utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /resolver_conflicto_calendario/i, respond: () => sinFuncion() }, SIGUIENTE]);
    await expect(new PostgresRentasCalendarSyncRepository(session).decidirConflicto("p", "c", "u", IGNORAR)).resolves.toBe("no_disponible");
    expect(session.calls.some((c) => c.startsWith("update rentas.conflicto_calendario"))).toBe(false);
    await sesionSigueUsable(session);
  });

  it("'resuelto': 42883 -> cae al UPDATE directo de 024 y lo logra (sin 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /resolver_conflicto_calendario/i, respond: () => sinFuncion() },
      { match: /update rentas\.conflicto_calendario set resuelto_en/i, respond: () => [{ id: "c" }] },
      SIGUIENTE,
    ]);
    await expect(new PostgresRentasCalendarSyncRepository(session).decidirConflicto("p", "c", "u", RESOLVER)).resolves.toBe("resuelto");
    await sesionSigueUsable(session);
  });

  it("'resuelto': 42883 y luego 42501 (tampoco hay la 024) -> no_disponible, sesión utilizable; 0 filas -> no_encontrado", async () => {
    const sin024 = new AbortAwareFakeSession([
      { match: /resolver_conflicto_calendario/i, respond: () => sinFuncion() },
      { match: /update rentas\.conflicto_calendario/i, respond: () => pgError("42501", "permission denied for table conflicto_calendario") },
      SIGUIENTE,
    ]);
    await expect(new PostgresRentasCalendarSyncRepository(sin024).decidirConflicto("p", "c", "u", RESOLVER)).resolves.toBe("no_disponible");
    await sesionSigueUsable(sin024);

    const ya = new AbortAwareFakeSession([
      { match: /resolver_conflicto_calendario/i, respond: () => sinFuncion() },
      { match: /update rentas\.conflicto_calendario/i, respond: () => [] },
      SIGUIENTE,
    ]);
    await expect(new PostgresRentasCalendarSyncRepository(ya).decidirConflicto("p", "c", "u", RESOLVER)).resolves.toBe("no_encontrado");
    await sesionSigueUsable(ya);
  });
});

describe("listarConflictos / listarHistorialConflicto -- base sin la migración 026", () => {
  const fila = {
    id: "k1", unidad_id: "u1", unidad_nombre: "Casa", tipo: "overbooking_confirmado", detectado_en: "2026-10-01 05:30:00+00", resuelto_en: "2026-10-02 05:30:00+00", resuelto_por: "staff",
    resolucion: null, motivo_resolucion: null,
    a_id: "a", a_inicio: "2027-05-10", a_fin: "2027-05-14", a_estado: "confirmado", a_capa: "reserva", a_canal: "airbnb",
    b_id: null, b_inicio: null, b_fin: null, b_estado: null, b_capa: null, b_canal: null,
  };

  it("42703 en resolucion/motivo_resolucion repite la consulta con NULL::text y los cerrados salen como 'resuelto' (sin 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /k\.resolucion AS resolucion/i, respond: () => pgError("42703", "column k.resolucion does not exist") },
      { match: /NULL::text AS resolucion/i, respond: () => [fila] },
      { match: /count\(\*\)::text AS total/i, respond: () => [{ total: "0" }] },
    ]);
    const listado = await new PostgresRentasCalendarSyncRepository(session).listarConflictos("p", { estado: "todos", limite: 10 });
    expect(listado.conflictos).toEqual([expect.objectContaining({ id: "k1", estado: "resuelto", motivoResolucion: null })]);
    expect(listado.totalAbiertos).toBe(0);
  });

  it("el estado y el límite viajan como parámetros (nunca interpolados en el SQL)", async () => {
    const vistos: unknown[][] = [];
    const session = new AbortAwareFakeSession([
      { match: /k\.resolucion AS resolucion/i, respond: () => [] },
      { match: /count\(\*\)::text AS total/i, respond: () => [{ total: "0" }] },
    ]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, params?: unknown[]) => {
      if (params) vistos.push(params);
      return original(sql, params);
    }) as typeof session.query;
    await new PostgresRentasCalendarSyncRepository(session).listarConflictos("p", { estado: "ignorados", limite: 7 });
    expect(vistos[0]).toEqual(["p", "ignorados", 7]);
  });

  it("listarHistorialConflicto: 42P01 -> disponible: false con lista vacía y sesión utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /from rentas\.conflicto_calendario_bitacora/i, respond: () => pgError("42P01", 'relation "rentas.conflicto_calendario_bitacora" does not exist') }, SIGUIENTE]);
    await expect(new PostgresRentasCalendarSyncRepository(session).listarHistorialConflicto("p", "c")).resolves.toEqual({ disponible: false, entradas: [] });
    await sesionSigueUsable(session);
  });

  it("listarHistorialConflicto mapea las filas de la bitácora", async () => {
    const session = new AbortAwareFakeSession([{ match: /from rentas\.conflicto_calendario_bitacora/i, respond: () => [{ id: "h1", accion: "ignorado", motivo: "mismo huésped", actor_user_id: "u", creado_en: "2027-01-01 05:30:00+00" }] }]);
    await expect(new PostgresRentasCalendarSyncRepository(session).listarHistorialConflicto("p", "c")).resolves.toEqual({
      disponible: true,
      entradas: [{ id: "h1", accion: "ignorado", motivo: "mismo huésped", actorUserId: "u", creadoEn: "2027-01-01 05:30:00+00" }],
    });
  });
});
