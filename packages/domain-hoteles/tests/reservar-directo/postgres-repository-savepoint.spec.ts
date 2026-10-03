// H-42 -- REGLA DURA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: el adaptador Postgres de la reserva directa corre en UNA transaccion compartida.
// Con AbortAwareFakeSession (reproduce el estado ABORTADO 25P02 de Postgres real; una sesion falsa plana NO sirve) se prueba que sin la migracion
// 044 las lecturas degradan a vacio honesto y las escrituras a ReservasAgenteUnavailableError, que los errores de negocio se traducen a codigos
// estables y que la sesion queda UTILIZABLE despues (ROLLBACK TO SAVEPOINT): nunca 25P02.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PostgresReservarDirectoRepository } from "../../src/reservar-directo/postgres-repository.ts";
import { ReservasAgenteUnavailableError } from "../../src/reservas-agente/tipos.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const missingFn = () => pgError("42883", "function hoteles.web_booking_policy(uuid) does not exist");
const missingCol = () => pgError("42703", 'column "channel" does not exist');
const PROP = randomUUID();
const HOLD = randomUUID();
const idle = { match: /select 1/, respond: () => [] };

describe("PostgresReservarDirectoRepository contra la base SIN migrar (AbortAwareFakeSession)", () => {
  it("webPolicy, webContext y roomNightsDirectas degradan a vacio honesto y la sesion sigue utilizable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = new AbortAwareFakeSession([{ match: /web_booking_policy/, respond: missingFn }, { match: /web_booking_context/, respond: missingFn }, { match: /from hoteles\.reservation/, respond: missingCol }, idle]);
    const repo = new PostgresReservarDirectoRepository(session);
    expect((await repo.webPolicy(PROP)).disponible).toBe(false);
    expect(await repo.webContext(PROP, HOLD)).toBeNull();
    expect(await repo.roomNightsDirectas(PROP, "2031-06-01", "2031-07-01")).toMatchObject({ disponible: false, directas: 0, total: 0, porcentaje: null });
    expect(session.calls.filter((c) => c.startsWith("rollback to savepoint")).length).toBeGreaterThanOrEqual(3);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
    warn.mockRestore();
  });

  it("stayOptions degrada a 'no disponible aun' (delegado al agente) sin 25P02", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = new AbortAwareFakeSession([{ match: /agent_stay_options/, respond: missingFn }, idle]);
    const repo = new PostgresReservarDirectoRepository(session);
    expect(await repo.stayOptions(PROP, "2031-06-12", "2031-06-14")).toMatchObject({ disponible: false, opciones: [], nights: 2 });
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
    warn.mockRestore();
  });

  it.each(["createWebHold", "getWebHold", "recordPayment", "cancelWebHold", "markRefunded"] as const)("%s: la escritura responde ReservasAgenteUnavailableError y la sesion sigue utilizable", async (op) => {
    const session = new AbortAwareFakeSession([{ match: /web_booking_/, respond: missingFn }, idle]);
    const repo = new PostgresReservarDirectoRepository(session);
    const call = {
      createWebHold: () => repo.createWebHold({ propertyId: PROP, roomTypeId: randomUUID(), checkInDate: "2031-06-12", checkOutDate: "2031-06-14", guests: 2, guestName: "Ana", contactPhone: "+5219991110001", contactEmail: "a@x.com", idempotencyKey: "web-1234567890", expectedTotalCents: 357_000, consentNoticeVersion: "v1" }),
      getWebHold: () => repo.getWebHold(PROP, HOLD),
      recordPayment: () => repo.recordPayment(PROP, HOLD, "capturado", "pi_1"),
      cancelWebHold: () => repo.cancelWebHold(PROP, HOLD),
      markRefunded: () => repo.markRefunded(PROP, HOLD, "re_1"),
    }[op];
    await expect(call()).rejects.toBeInstanceOf(ReservasAgenteUnavailableError);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("traduce errores de negocio de la base a codigos estables (sin 500 crudo) y deja la sesion utilizable", async () => {
    const cases: Array<[string, string, string, string]> = [
      ["22023", "precio_cambio: el total vigente es 400000 centavos", "precio_cambio", "web_booking_hold_create"],
      ["P0001", "sin_disponibilidad: no hay habitaciones libres", "sin_disponibilidad", "web_booking_hold_create"],
      ["55000", "web_deshabilitado: el hotel no habilito la reserva directa en linea", "web_deshabilitado", "web_booking_hold_create"],
      ["22023", "consentimiento_requerido: falta la version del aviso", "consentimiento_requerido", "web_booking_hold_create"],
      ["55000", "limite_holds_contacto: ya tiene 2 pre-reservas abiertas", "limite_holds_contacto", "web_booking_hold_create"],
      ["P0002", "reserva no encontrada", "no_encontrada", "web_booking_get"],
      ["55000", "estado_no_cancelable: la reserva ya no admite cancelacion en linea", "estado_no_valido", "web_booking_cancel"],
      ["42501", "solo la sesion de sistema", "sin_permiso", "web_booking_cancel"],
    ];
    for (const [code, message, expected, fn] of cases) {
      const session = new AbortAwareFakeSession([{ match: new RegExp(fn), respond: () => pgError(code, message) }, idle]);
      const repo = new PostgresReservarDirectoRepository(session);
      const call = fn === "web_booking_hold_create"
        ? repo.createWebHold({ propertyId: PROP, roomTypeId: randomUUID(), checkInDate: "2031-06-12", checkOutDate: "2031-06-14", guests: 2, guestName: "Ana", contactPhone: "+5219991110001", contactEmail: "a@x.com", idempotencyKey: "web-1234567890", expectedTotalCents: 357_000, consentNoticeVersion: "v1" })
        : fn === "web_booking_get" ? repo.getWebHold(PROP, HOLD) : repo.cancelWebHold(PROP, HOLD);
      await expect(call).rejects.toMatchObject({ code: expected });
      await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
    }
  });

  it("precio_cambio conserva el total vigente en el detalle", async () => {
    const session = new AbortAwareFakeSession([{ match: /web_booking_hold_create/, respond: () => pgError("22023", "precio_cambio: el total vigente es 400000 centavos") }, idle]);
    const repo = new PostgresReservarDirectoRepository(session);
    await expect(repo.createWebHold({ propertyId: PROP, roomTypeId: randomUUID(), checkInDate: "2031-06-12", checkOutDate: "2031-06-14", guests: 2, guestName: "Ana", contactPhone: "+5219991110001", contactEmail: "a@x.com", idempotencyKey: "web-1234567890", expectedTotalCents: 357_000, consentNoticeVersion: "v1" }))
      .rejects.toMatchObject({ code: "precio_cambio", detail: { totalCents: 400_000 } });
  });
});
