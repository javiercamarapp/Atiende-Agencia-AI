// Compatibilidad con la base SIN MIGRAR: el lector de "Chatea con tus datos" (hoteles) corre dentro de la
// transaccion UNICA de la request (`dbSession`). Un 42P01/42703/42883 sin SAVEPOINT dejaria la transaccion
// abortada (25P02 en la consulta siguiente y COMMIT -> ROLLBACK silencioso). Se prueba con
// AbortAwareFakeSession, que reproduce ese estado abortado (una sesion falsa plana no sirve).
import { describe, expect, it } from "vitest";
import { buildHotelesDataChatTools, PostgresHotelesDataChatReader, HotelesDataChatUnavailableError, type HotelesDataChatWindow } from "../../src/data-chat/index.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";
import { NOW, ORG_A, OWNER_SCOPE } from "./support.ts";

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const SET_TIMEOUT = { match: /^\s*set local statement_timeout = 8000/i, respond: () => [] };
const NEXT = { match: /select 1 as siguiente_query_del_request|insert into core\.data_chat_query_log/i, respond: () => [{ ok: true }] };

const WINDOW: HotelesDataChatWindow = {
  organizationId: ORG_A,
  propertyIds: null,
  start: new Date("2026-09-29T06:00:00.000Z"),
  end: new Date("2026-09-30T06:00:00.000Z"),
  fromDate: "2026-09-29",
  toDate: "2026-09-29",
  timezone: "America/Merida",
  limit: 51,
};

describe("PostgresHotelesDataChatReader — base sin migrar", () => {
  it("tabla inexistente (42P01) -> HotelesDataChatUnavailableError y la transaccion queda UTILIZABLE (sin 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      SET_TIMEOUT,
      { match: /from hoteles\.guest_ticket/i, respond: () => pgError("42P01", 'relation "hoteles.guest_ticket" does not exist') },
      NEXT,
    ]);
    const reader = new PostgresHotelesDataChatReader(session);
    await expect(reader.openTickets(ORG_A, null, NOW, 51)).rejects.toBeInstanceOf(HotelesDataChatUnavailableError);
    // La "siguiente consulta del request" (p.ej. la bitacora o el COMMIT) funciona: no hay 25P02.
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    expect(session.calls.filter((c) => c.startsWith("savepoint"))).toHaveLength(1);
  });

  it("columna inexistente (42703) y funcion inexistente (42883) tambien degradan a 'no disponible'", async () => {
    for (const err of [pgError("42703", "column r.canceled_at does not exist"), pgError("42883", "function hoteles.algo() does not exist")]) {
      const session = new AbortAwareFakeSession([SET_TIMEOUT, { match: /from hoteles\.reservation/i, respond: () => err }]);
      await expect(new PostgresHotelesDataChatReader(session).cancellations(WINDOW, "day")).rejects.toBeInstanceOf(HotelesDataChatUnavailableError);
    }
  });

  it("un error real (statement timeout 57014) NO se enmascara como 'no disponible', pero la sesion igual se recupera", async () => {
    const session = new AbortAwareFakeSession([
      SET_TIMEOUT,
      { match: /from hoteles\.charge/i, respond: () => pgError("57014", "canceling statement due to statement timeout") },
      NEXT,
    ]);
    const reader = new PostgresHotelesDataChatReader(session);
    await expect(reader.occupancy(WINDOW, "day")).rejects.toMatchObject({ code: "57014" });
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toBeDefined();
  });

  it("el tope de tiempo se aplica UNA vez por lector y cada consulta va en su propio SAVEPOINT", async () => {
    const session = new AbortAwareFakeSession([SET_TIMEOUT, { match: /from hoteles\.charge/i, respond: () => [] }, { match: /from hoteles\.reservation/i, respond: () => [] }]);
    const reader = new PostgresHotelesDataChatReader(session);
    await reader.occupancy(WINDOW, "day");
    await reader.arrivalsDepartures(WINDOW, "day");
    expect(session.calls.filter((c) => /set local statement_timeout/i.test(c))).toHaveLength(1);
    expect(session.calls.filter((c) => c.startsWith("savepoint"))).toHaveLength(2);
  });

  it("de punta a punta: la herramienta responde 'unavailable' y la transaccion sigue sirviendo a la bitacora", async () => {
    const session = new AbortAwareFakeSession([
      SET_TIMEOUT,
      { match: /from core\.property p\s+where p\.organization_id = \$1 and p\.vertical = 'hoteles'/i, respond: () => [{ property_id: "p1", name: "Hotel Centro", slug: "Hotel Centro" }] },
      { match: /from hoteles\.housekeeping_task/i, respond: () => pgError("42P01", "relation does not exist") },
      NEXT,
    ]);
    const tool = buildHotelesDataChatTools(new PostgresHotelesDataChatReader(session)).find((t) => t.name === "housekeeping_pendiente")!;
    const r = await tool.run({ scope: OWNER_SCOPE, now: NOW, signal: new AbortController().signal, maxRows: 50 }, {});
    expect(r.status).toBe("unavailable");
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toBeDefined();
  });

  it("mapea filas reales: cadenas numericas de pg -> numeros, y manda el alcance como parametros (nunca interpolado)", async () => {
    const seen: unknown[][] = [];
    class Capturing extends AbortAwareFakeSession {
      override async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        seen.push([...(params ?? [])]);
        return super.query<T>(sql, params);
      }
    }
    const session = new Capturing([
      SET_TIMEOUT,
      { match: /from hoteles\.charge c/i, respond: () => [{ bucket: "2026-09-29", available_nights: "35", occupied_nights: "13", room_revenue: "12000.00" }] },
    ]);
    const rows = await new PostgresHotelesDataChatReader(session).occupancy({ ...WINDOW, propertyIds: ["p1"] }, "day");
    expect(rows).toEqual([{ bucket: "2026-09-29", availableNights: 35, occupiedNights: 13, roomRevenue: 12000 }]);
    expect(seen[0]).toEqual([ORG_A, ["p1"], "2026-09-29", "2026-09-29", "day", 51]);
  });
});
