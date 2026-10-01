// Compatibilidad con la base SIN MIGRAR: el lector de "Chatea con tus datos" (rentas) corre dentro de la
// transaccion UNICA de la request (`dbSession`). Un 42P01/42703/42883 sin SAVEPOINT dejaria la transaccion
// abortada (25P02 en la consulta siguiente y COMMIT -> ROLLBACK silencioso). Se prueba con
// AbortAwareFakeSession, que reproduce ese estado abortado (una sesion falsa plana no sirve).
import { describe, expect, it } from "vitest";
import { buildRentasDataChatTools, PostgresRentasDataChatReader, RentasDataChatUnavailableError, type RentasDataChatWindow } from "../../src/data-chat/index.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";
import { NOW, ORG_A, ADMIN_SCOPE } from "./support.ts";

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const SET_TIMEOUT = { match: /^\s*set local statement_timeout = 8000/i, respond: () => [] };
const NEXT = { match: /select 1 as siguiente_query_del_request|insert into core\.data_chat_query_log/i, respond: () => [{ ok: true }] };

const WINDOW: RentasDataChatWindow = { organizationId: ORG_A, propertyIds: null, fromDate: "2026-09-01", toDate: "2026-09-30", timezone: "America/Merida", limit: 51 };

describe("PostgresRentasDataChatReader — base sin migrar", () => {
  it("tabla inexistente (42P01) -> RentasDataChatUnavailableError y la transaccion queda UTILIZABLE (sin 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      SET_TIMEOUT,
      { match: /from rentas\.conflicto_calendario/i, respond: () => pgError("42P01", 'relation "rentas.conflicto_calendario" does not exist') },
      NEXT,
    ]);
    const reader = new PostgresRentasDataChatReader(session);
    await expect(reader.openConflicts(ORG_A, null, NOW, 51)).rejects.toBeInstanceOf(RentasDataChatUnavailableError);
    // La "siguiente consulta del request" (p.ej. la bitacora o el COMMIT) funciona: no hay 25P02.
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    expect(session.calls.filter((c) => c.startsWith("savepoint"))).toHaveLength(1);
  });

  it("columna inexistente (42703) y funcion inexistente (42883) tambien degradan a 'no disponible'", async () => {
    for (const err of [pgError("42703", "column t.sla_vence_en does not exist"), pgError("42883", "function rentas.algo() does not exist")]) {
      const session = new AbortAwareFakeSession([SET_TIMEOUT, { match: /from rentas\.tarea_operativa/i, respond: () => err }]);
      await expect(new PostgresRentasDataChatReader(session).pendingTasks(ORG_A, null, { fromDate: null, toDate: "2026-09-30" }, NOW, "limpieza", 51)).rejects.toBeInstanceOf(RentasDataChatUnavailableError);
    }
  });

  it("un error real (statement timeout 57014) NO se enmascara como 'no disponible', pero la sesion igual se recupera", async () => {
    const session = new AbortAwareFakeSession([
      SET_TIMEOUT,
      { match: /from rentas\.reserva_financiero/i, respond: () => pgError("57014", "canceling statement due to statement timeout") },
      NEXT,
    ]);
    const reader = new PostgresRentasDataChatReader(session);
    await expect(reader.incomeByChannel(WINDOW)).rejects.toMatchObject({ code: "57014" });
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toBeDefined();
  });

  it("el tope de tiempo se aplica UNA vez por lector y cada consulta va en su propio SAVEPOINT", async () => {
    const session = new AbortAwareFakeSession([SET_TIMEOUT, { match: /from rentas\.owner_statement/i, respond: () => [] }, { match: /from rentas\.payout_canal/i, respond: () => [] }]);
    const reader = new PostgresRentasDataChatReader(session);
    await reader.ownerStatements(WINDOW);
    await reader.channelPayouts(WINDOW);
    expect(session.calls.filter((c) => /set local statement_timeout/i.test(c))).toHaveLength(1);
    expect(session.calls.filter((c) => c.startsWith("savepoint"))).toHaveLength(2);
  });

  it("de punta a punta: la herramienta responde 'unavailable' y la transaccion sigue sirviendo a la bitacora", async () => {
    const session = new AbortAwareFakeSession([
      SET_TIMEOUT,
      { match: /from core\.property p\s+where p\.organization_id = \$1 and p\.vertical = 'rentas'/i, respond: () => [{ property_id: "p1", name: "Casas de Playa", slug: "Casas de Playa" }] },
      { match: /from rentas\.conflicto_calendario/i, respond: () => pgError("42P01", "relation does not exist") },
      NEXT,
    ]);
    const tool = buildRentasDataChatTools(new PostgresRentasDataChatReader(session)).find((t) => t.name === "conflictos_calendario_abiertos")!;
    const r = await tool.run({ scope: ADMIN_SCOPE, now: NOW, signal: new AbortController().signal, maxRows: 50 }, {});
    expect(r.status).toBe("unavailable");
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toBeDefined();
  });

  it("mapea filas reales (bigint de pg llega como cadena) y manda el alcance como parametros, con la fecha nula del rezago", async () => {
    const seen: unknown[][] = [];
    class Capturing extends AbortAwareFakeSession {
      override async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        seen.push([...(params ?? [])]);
        return super.query<T>(sql, params);
      }
    }
    const session = new Capturing([
      SET_TIMEOUT,
      { match: /from rentas\.tarea_operativa t/i, respond: () => [{ unit_name: "Playa 1", kind: "limpieza", status: "pendiente", priority: "alta", scheduled: "2026-09-30", sla_overdue: true, total: "3" }] },
    ]);
    const rows = await new PostgresRentasDataChatReader(session).pendingTasks(ORG_A, ["p1"], { fromDate: null, toDate: "2026-09-30" }, NOW, null, 51);
    expect(rows).toEqual([{ unitName: "Playa 1", kind: "limpieza", status: "pendiente", priority: "alta", scheduled: "2026-09-30", slaOverdue: true, total: 3 }]);
    expect(seen[0]).toEqual([ORG_A, ["p1"], null, "2026-09-30", NOW.toISOString(), null, 51]);
  });
});
