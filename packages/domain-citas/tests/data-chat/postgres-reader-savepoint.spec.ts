// Compatibilidad con la base SIN MIGRAR: el lector de "Chatea con tus datos" (citas) corre dentro de la transaccion
// UNICA de la request (`dbSession`). Un 42P01/42703/42883 sin SAVEPOINT dejaria la transaccion abortada (25P02 en la
// consulta siguiente y COMMIT -> ROLLBACK silencioso). Se prueba con AbortAwareFakeSession, que reproduce ese estado
// abortado (una sesion falsa plana no sirve).
import { describe, expect, it } from "vitest";
import { buildCitasDataChatTools, CitasDataChatUnavailableError, PostgresCitasDataChatReader, type CitasDataChatWindow } from "../../src/data-chat/index.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";
import { NOW, ORG_A, OWNER_SCOPE } from "./support.ts";

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const SET_TIMEOUT = { match: /^\s*set local statement_timeout = 8000/i, respond: () => [] };
const NEXT = { match: /select 1 as siguiente_query_del_request|insert into core\.data_chat_query_log/i, respond: () => [{ ok: true }] };

const WINDOW: CitasDataChatWindow = {
  organizationId: ORG_A,
  propertyIds: null,
  start: new Date("2026-09-01T06:00:00.000Z"),
  end: new Date("2026-10-01T06:00:00.000Z"),
  fromDate: "2026-09-01",
  toDate: "2026-09-30",
  timezone: "America/Merida",
  limit: 51,
};

describe("PostgresCitasDataChatReader — base sin migrar", () => {
  it("funcion de la migracion 027 inexistente (42883) -> CitasDataChatUnavailableError y la transaccion queda UTILIZABLE (sin 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      SET_TIMEOUT,
      { match: /citas\.data_chat_reminder_delivery/i, respond: () => pgError("42883", "function citas.data_chat_reminder_delivery(uuid, uuid[], timestamp with time zone, timestamp with time zone) does not exist") },
      NEXT,
    ]);
    const reader = new PostgresCitasDataChatReader(session);
    await expect(reader.reminderDelivery(WINDOW)).rejects.toBeInstanceOf(CitasDataChatUnavailableError);
    // La "siguiente consulta del request" (p.ej. la bitacora o el COMMIT) funciona: no hay 25P02.
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    expect(session.calls.filter((c) => c.startsWith("savepoint"))).toHaveLength(1);
  });

  it("tabla inexistente (42P01) y columna inexistente (42703) tambien degradan a 'no disponible'", async () => {
    for (const err of [pgError("42P01", 'relation "citas.availability_overrides" does not exist'), pgError("42703", "column a.reminder_24h_sent_at does not exist")]) {
      const session = new AbortAwareFakeSession([SET_TIMEOUT, { match: /from citas\.(availability_overrides|appointments)/i, respond: () => err }]);
      const reader = new PostgresCitasDataChatReader(session);
      await expect(reader.freeSlots(WINDOW, NOW)).rejects.toBeInstanceOf(CitasDataChatUnavailableError);
      await expect(reader.pendingReminders(WINDOW, NOW)).rejects.toBeInstanceOf(CitasDataChatUnavailableError);
    }
  });

  it("un error real (statement timeout 57014) NO se enmascara como 'no disponible', pero la sesion igual se recupera", async () => {
    const session = new AbortAwareFakeSession([
      SET_TIMEOUT,
      { match: /from citas\.appointments a\s+join citas\.services/i, respond: () => pgError("57014", "canceling statement due to statement timeout") },
      NEXT,
    ]);
    const reader = new PostgresCitasDataChatReader(session);
    await expect(reader.revenueByService(WINDOW)).rejects.toMatchObject({ code: "57014" });
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toBeDefined();
  });

  it("el tope de tiempo se aplica UNA vez por lector y cada consulta va en su propio SAVEPOINT", async () => {
    const session = new AbortAwareFakeSession([SET_TIMEOUT, { match: /from citas\.appointments a/i, respond: () => [] }]);
    const reader = new PostgresCitasDataChatReader(session);
    await reader.attendanceByProvider(WINDOW);
    await reader.customers(WINDOW);
    expect(session.calls.filter((c) => /set local statement_timeout/i.test(c))).toHaveLength(1);
    expect(session.calls.filter((c) => c.startsWith("savepoint"))).toHaveLength(2);
  });

  it("de punta a punta: 'recordatorios' responde lo pendiente aunque falte la funcion, y la transaccion sigue sirviendo a la bitacora", async () => {
    const session = new AbortAwareFakeSession([
      SET_TIMEOUT,
      { match: /from core\.property p\s+where p\.organization_id = \$1 and p\.vertical = 'citas'/i, respond: () => [{ property_id: "p1", name: "Centro", slug: "Centro" }] },
      { match: /reminder_24h_sent_at is null/i, respond: () => [{ pending: "3", next_24h: "2" }] },
      { match: /citas\.data_chat_reminder_delivery/i, respond: () => pgError("42883", "function citas.data_chat_reminder_delivery(uuid, uuid[], timestamp with time zone, timestamp with time zone) does not exist") },
      NEXT,
    ]);
    const tool = buildCitasDataChatTools(new PostgresCitasDataChatReader(session)).find((t) => t.name === "recordatorios")!;
    const r = await tool.run({ scope: OWNER_SCOPE, now: NOW, signal: new AbortController().signal, maxRows: 50 }, { periodo: "proximos_7_dias" });
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("3 citas por atender");
    expect(r.summary).toContain("todavía no está disponible");
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toBeDefined();
  });

  it("de punta a punta: una herramienta sin su tabla responde 'unavailable' (no un 500) y la transaccion sigue sirviendo", async () => {
    const session = new AbortAwareFakeSession([
      SET_TIMEOUT,
      { match: /from core\.property p\s+where p\.organization_id = \$1 and p\.vertical = 'citas'/i, respond: () => [{ property_id: "p1", name: "Centro", slug: "Centro" }] },
      { match: /from citas\.appointments a/i, respond: () => pgError("42P01", "relation does not exist") },
      NEXT,
    ]);
    const tool = buildCitasDataChatTools(new PostgresCitasDataChatReader(session)).find((t) => t.name === "citas_por_dia")!;
    const r = await tool.run({ scope: OWNER_SCOPE, now: NOW, signal: new AbortController().signal, maxRows: 50 }, { periodo: "hoy" });
    expect(r.status).toBe("unavailable");
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toBeDefined();
  });

  it("mapea filas reales (bigint/numeric de pg llegan como cadena) y manda alcance, ventana y zona como parametros", async () => {
    const seen: unknown[][] = [];
    class Capturing extends AbortAwareFakeSession {
      override async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        seen.push([...(params ?? [])]);
        return super.query<T>(sql, params);
      }
    }
    const session = new Capturing([
      SET_TIMEOUT,
      { match: /with prov as/i, respond: () => [{ provider: "Ana", branch: "Centro", available_minutes: "960.0000000000000000", booked_minutes: "150", total_available: "2100", total_booked: "360", total_providers: "3" }] },
    ]);
    const rows = await new PostgresCitasDataChatReader(session).occupancyByProvider({ ...WINDOW, propertyIds: ["p1"] });
    expect(rows).toEqual([{ provider: "Ana", branch: "Centro", availableMinutes: 960, bookedMinutes: 150, totalAvailable: 2100, totalBooked: 360, totalProviders: 3 }]);
    expect(seen[seen.length - 1]).toEqual([ORG_A, ["p1"], "2026-09-01", "2026-09-30", "America/Merida", 51]);
  });

  it("freeSlots manda 'ahora' como instante ISO en $6 y el tope en $7", async () => {
    const seen: unknown[][] = [];
    class Capturing extends AbortAwareFakeSession {
      override async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        seen.push([...(params ?? [])]);
        return super.query<T>(sql, params);
      }
    }
    const session = new Capturing([SET_TIMEOUT, { match: /live as/i, respond: () => [{ day: "2026-09-30", provider: "Ana", branch: "Centro", free_minutes: "90", total_free: "90" }] }]);
    const rows = await new PostgresCitasDataChatReader(session).freeSlots(WINDOW, NOW);
    expect(rows).toEqual([{ day: "2026-09-30", provider: "Ana", branch: "Centro", freeMinutes: 90, totalFree: 90 }]);
    expect(seen[seen.length - 1]).toEqual([ORG_A, null, "2026-09-01", "2026-09-30", "America/Merida", NOW.toISOString(), 51]);
  });
});
