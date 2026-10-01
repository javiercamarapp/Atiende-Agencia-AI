// Compatibilidad con la base SIN MIGRAR: el lector corre dentro de la transaccion UNICA de la request
// (`dbSession`). Un 42P01/42703/42883 sin SAVEPOINT dejaria la transaccion abortada (25P02 y COMMIT ->
// ROLLBACK silencioso). Se prueba con AbortAwareFakeSession, que reproduce el estado abortado.
import { describe, expect, it } from "vitest";
import { buildLicitacionesDataChatTools, DataChatUnavailableError, PostgresLicitacionesDataChatReader, type LicitacionesDataChatWindow } from "../../src/data-chat/index.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";
import { NOW, ORG_A, OWNER_SCOPE } from "./support.ts";

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const SET_TIMEOUT = { match: /^\s*set local statement_timeout = 8000/i, respond: () => [] };
const NEXT = { match: /select 1 as siguiente_query_del_request/i, respond: () => [{ ok: true }] };

const WINDOW: LicitacionesDataChatWindow = {
  organizationId: ORG_A,
  timezone: "America/Merida",
  ahora: NOW,
  desde: new Date("2026-09-01T06:00:00.000Z"),
  hasta: new Date("2026-09-30T06:00:00.000Z"),
  limit: 51,
};

describe("PostgresLicitacionesDataChatReader — base sin migrar", () => {
  it("tabla inexistente (42P01) -> DataChatUnavailableError y la transaccion queda UTILIZABLE (sin 25P02)", async () => {
    const session = new AbortAwareFakeSession([SET_TIMEOUT, { match: /from licitaciones\.tender t/i, respond: () => pgError("42P01", 'relation "licitaciones.tender" does not exist') }, NEXT]);
    const reader = new PostgresLicitacionesDataChatReader(session);
    await expect(reader.plazosSemaforo(WINDOW)).rejects.toBeInstanceOf(DataChatUnavailableError);
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    expect(session.calls.filter((c) => c.startsWith("savepoint"))).toHaveLength(1);
  });

  it("columna inexistente (42703: p.ej. tender.contracting_body de la 007) y funcion inexistente (42883) degradan en TODAS las consultas", async () => {
    const calls: Array<[string, (r: PostgresLicitacionesDataChatReader) => Promise<unknown>, RegExp]> = [
      ["abiertas", (r) => r.convocatoriasAbiertas(WINDOW, null), /dependencia/i],
      ["semaforo", (r) => r.plazosSemaforo(WINDOW), /group by b\.semaforo/i],
      ["gonogo", (r) => r.goNoGo(WINDOW), /go_no_go_decision/i],
      ["propuestas", (r) => r.propuestasPorEstado(WINDOW), /from licitaciones\.proposal p/i],
      ["fallos", (r) => r.fallos(WINDOW), /tender_resolution/i],
      ["renovaciones", (r) => r.renovaciones(WINDOW, 90), /from licitaciones\.contract c/i],
      ["junta", (r) => r.preguntasJunta(WINDOW), /from licitaciones\.junta_question q/i],
    ];
    for (const err of [pgError("42703", 'column t.contracting_body does not exist'), pgError("42883", "function licitaciones.algo(uuid) does not exist")]) {
      for (const [name, run, match] of calls) {
        const session = new AbortAwareFakeSession([SET_TIMEOUT, { match, respond: () => err }]);
        await expect(run(new PostgresLicitacionesDataChatReader(session)), name).rejects.toBeInstanceOf(DataChatUnavailableError);
      }
    }
  });

  it("un error real (statement timeout 57014) NO se enmascara como 'no disponible', pero la sesion igual se recupera", async () => {
    const session = new AbortAwareFakeSession([SET_TIMEOUT, { match: /from licitaciones\.proposal p/i, respond: () => pgError("57014", "canceling statement due to statement timeout") }, NEXT]);
    await expect(new PostgresLicitacionesDataChatReader(session).propuestasPorEstado(WINDOW)).rejects.toMatchObject({ code: "57014" });
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toBeDefined();
  });

  it("zona horaria: sin tenant_config (42P01) devuelve null (default de plataforma), NUNCA un error; y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([SET_TIMEOUT, { match: /licitaciones\.tenant_config/i, respond: () => pgError("42P01", "relation does not exist") }, NEXT]);
    expect(await new PostgresLicitacionesDataChatReader(session).organizationTimezone(ORG_A)).toBeNull();
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toBeDefined();
  });

  it("zona horaria configurada se devuelve; sin fila = null", async () => {
    const con = new AbortAwareFakeSession([SET_TIMEOUT, { match: /licitaciones\.tenant_config/i, respond: () => [{ timezone: "America/Cancun" }] }]);
    expect(await new PostgresLicitacionesDataChatReader(con).organizationTimezone(ORG_A)).toBe("America/Cancun");
    const sin = new AbortAwareFakeSession([SET_TIMEOUT, { match: /licitaciones\.tenant_config/i, respond: () => [] }]);
    expect(await new PostgresLicitacionesDataChatReader(sin).organizationTimezone(ORG_A)).toBeNull();
  });

  it("de punta a punta: la herramienta responde 'unavailable' y la transaccion sigue sirviendo a la bitacora", async () => {
    const session = new AbortAwareFakeSession([
      SET_TIMEOUT,
      { match: /licitaciones\.tenant_config/i, respond: () => [] },
      { match: /from licitaciones\.tender t/i, respond: () => pgError("42P01", "relation does not exist") },
      { match: /insert into core\.data_chat_query_log|select 1 as siguiente_query_del_request/i, respond: () => [{ ok: true }] },
    ]);
    const tool = buildLicitacionesDataChatTools(new PostgresLicitacionesDataChatReader(session)).find((t) => t.name === "plazos_semaforo")!;
    const r = await tool.run({ scope: OWNER_SCOPE, now: NOW, signal: new AbortController().signal, maxRows: 50 }, {});
    expect(r.status).toBe("unavailable");
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toBeDefined();
  });

  it("camino feliz: convierte numeric/bigint (texto de pg) a numeros y manda los parametros en el orden del SQL", async () => {
    const seen: unknown[][] = [];
    const base = new AbortAwareFakeSession([
      SET_TIMEOUT,
      { match: /monto_mxn/i, respond: () => [{ titulo: "Uniformes", dependencia: null, entidad: null, status: "go", fecha_limite: "2026-10-01 10:00", dias_restantes: "2", monto_mxn: "1250000.50", moneda: "MXN" }] },
      { match: /group by b\.semaforo/i, respond: () => [{ semaforo: "Rojo (3 días o menos)", convocatorias: "2" }] },
      { match: /go_no_go_decision/i, respond: () => [{ titulo: "Uniformes", decision: "go", elegibilidad: "cumple", puntaje: "87.50", fecha: "2026-09-20", motivo: null }] },
      { match: /from licitaciones\.junta_question q/i, respond: () => [{ titulo: "Uniformes", pregunta: "¿Se aceptan tallas?", tema: "tecnico", prioridad: "alta", status: "aprobada", limite_preguntas: "2026-10-02 15:00", dias_limite: "3", junta: null }] },
      { match: /from licitaciones\.contract c/i, respond: () => [{ contrato: null, titulo: "Limpieza", dependencia: null, fin_vigencia: "2026-11-15", dias_restantes: "47", opcion_renovacion: true, status: "en_ejecucion", alerta_pendiente: false }] },
    ]);
    const original = base.query.bind(base);
    base.query = (async (sql: string, params?: unknown[]) => {
      seen.push(params ?? []);
      return original(sql, params);
    }) as typeof base.query;
    const reader = new PostgresLicitacionesDataChatReader(base);

    expect(await reader.convocatoriasAbiertas(WINDOW, 7)).toEqual([
      { titulo: "Uniformes", dependencia: null, entidad: null, status: "go", fechaLimite: "2026-10-01 10:00", diasRestantes: 2, montoMxn: 1250000.5, moneda: "MXN" },
    ]);
    expect(await reader.plazosSemaforo(WINDOW)).toEqual([{ semaforo: "Rojo (3 días o menos)", convocatorias: 2 }]);
    expect(await reader.goNoGo(WINDOW)).toEqual([{ titulo: "Uniformes", decision: "go", elegibilidad: "cumple", puntaje: 87.5, fecha: "2026-09-20", motivo: null }]);
    expect(await reader.renovaciones(WINDOW, 90)).toEqual([
      { contrato: null, titulo: "Limpieza", dependencia: null, finVigencia: "2026-11-15", diasRestantes: 47, opcionRenovacion: true, status: "en_ejecucion", alertaPendiente: false },
    ]);
    expect(await reader.preguntasJunta(WINDOW)).toEqual([{ titulo: "Uniformes", pregunta: "¿Se aceptan tallas?", tema: "tecnico", prioridad: "alta", status: "aprobada", limitePreguntas: "2026-10-02 15:00", diasLimite: 3, junta: null }]);
    expect(seen[4]).toEqual([ORG_A, "America/Merida", NOW.toISOString(), 51]); // junta: org, zona, ahora, tope
    expect(seen[0]).toEqual([ORG_A, "America/Merida", NOW.toISOString(), 7, 51]); // abiertas: org, zona, ahora, horizonte, tope
    expect(seen[1]).toEqual([ORG_A, "America/Merida", NOW.toISOString(), 51]); // semaforo
    expect(seen[2]).toEqual([ORG_A, "America/Merida", "2026-09-01T06:00:00.000Z", "2026-09-30T06:00:00.000Z", 51]); // go/no-go
    expect(seen[3]).toEqual([ORG_A, "America/Merida", NOW.toISOString(), 90, 51]); // renovaciones
  });

  it("'todas las convocatorias abiertas' manda el horizonte como NULL (no 0)", async () => {
    const seen: unknown[][] = [];
    const session = new AbortAwareFakeSession([SET_TIMEOUT, { match: /monto_mxn/i, respond: () => [] }]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, params?: unknown[]) => {
      seen.push(params ?? []);
      return original(sql, params);
    }) as typeof session.query;
    await new PostgresLicitacionesDataChatReader(session).convocatoriasAbiertas(WINDOW, null);
    expect(seen[0]![3]).toBeNull();
  });
});
