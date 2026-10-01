// H-25 -- REGLA DURA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: el adaptador Postgres del agente de reservas corre en UNA transaccion
// compartida. Con AbortAwareFakeSession (reproduce el estado ABORTADO 25P02 de Postgres real; una sesion falsa plana NO sirve) se prueba que
// (1) sin la migracion 037 las lecturas degradan a vacio honesto y las escrituras a ReservasAgenteUnavailableError, (2) los errores de negocio
// se traducen a codigos estables, y (3) la sesion queda UTILIZABLE despues (ROLLBACK TO SAVEPOINT): nunca 25P02 ni AbortedTransactionCommitError.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CircuitBreaker, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway, FakeLlmProvider } from "@atiende/agent-core";
import type { LlmCompletionResult } from "@atiende/agent-core";
import { createLlmHotelesWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { PostgresHotelesRepository } from "../../src/postgres-repository.ts";
import { PostgresReservasAgenteRepository, mapReservasPgError } from "../../src/reservas-agente/postgres-repository.ts";
import { ReservasAgenteError, ReservasAgenteUnavailableError } from "../../src/reservas-agente/tipos.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const missingFn = () => pgError("42883", "function hoteles.agent_stay_options(uuid, date, date, timestamptz) does not exist");
const missingTable = () => pgError("42P01", 'relation "hoteles.booking_hold" does not exist');
const PROP = randomUUID();
const HOLD = randomUUID();

const policyRow = { holds_enabled: true, mode: "aprobacion_humana", hold_ttl_minutes: 120, max_nights: 14, max_guests: 6, max_advance_days: 365, max_active_holds: 40 };

describe("PostgresReservasAgenteRepository contra la base SIN migrar (AbortAwareFakeSession)", () => {
  it("stayOptions: degrada a 'no disponible aun' y la sesion sigue utilizable (sin 25P02)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = new AbortAwareFakeSession([{ match: /agent_stay_options/, respond: missingFn }, { match: /select 1/, respond: () => [] }]);
    const repo = new PostgresReservasAgenteRepository(session);
    const out = await repo.stayOptions(PROP, "2031-06-12", "2031-06-14");
    expect(out).toMatchObject({ disponible: false, opciones: [], nights: 2 });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
    warn.mockRestore();
  });

  it("agentPolicy / getPolicy / listHolds degradan a vacio honesto con la tabla ausente", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = new AbortAwareFakeSession([
      { match: /agent_booking_policy/, respond: missingFn },
      { match: /booking_agent_policy/, respond: missingTable },
      { match: /from hoteles\.booking_hold /, respond: missingTable },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresReservasAgenteRepository(session);
    expect((await repo.agentPolicy(PROP)).disponible).toBe(false);
    expect((await repo.getPolicy(PROP)).disponible).toBe(false);
    expect(await repo.listHolds(PROP)).toEqual({ disponible: false, holds: [] });
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
    warn.mockRestore();
  });

  it.each(["createHold", "holdStatusForContact", "cancelHoldForContact", "expireDueHolds", "upsertPolicy"] as const)("%s: la escritura responde ReservasAgenteUnavailableError y la sesion sigue utilizable", async (op) => {
    const session = new AbortAwareFakeSession([{ match: /booking_hold|booking_agent_policy/, respond: missingFn }, { match: /select 1/, respond: () => [] }]);
    const repo = new PostgresReservasAgenteRepository(session);
    const call = {
      createHold: () => repo.createHold({ propertyId: PROP, roomTypeId: randomUUID(), checkInDate: "2031-06-12", checkOutDate: "2031-06-14", guests: 2, guestName: null, contactPhone: "+5219991110001", channel: "whatsapp", idempotencyKey: "wa-1234567890", expectedTotalCents: 357_000 }),
      holdStatusForContact: () => repo.holdStatusForContact(PROP, HOLD, "+5219991110001"),
      cancelHoldForContact: () => repo.cancelHoldForContact(PROP, HOLD, "+5219991110001"),
      expireDueHolds: () => repo.expireDueHolds(null),
      upsertPolicy: () => repo.upsertPolicy(PROP, { holdsEnabled: true, mode: "link_pago", holdTtlMinutes: 60, maxNights: 7, maxGuests: 4, maxAdvanceDays: 90, maxActiveHolds: 10 }),
    }[op];
    await expect(call()).rejects.toBeInstanceOf(ReservasAgenteUnavailableError);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("control: el MISMO fallo con un catch simple (sin SAVEPOINT) deja la sesion abortada -- el bug que esto evita era real", async () => {
    const session = new AbortAwareFakeSession([{ match: /booking_hold_create/, respond: missingFn }]);
    await expect(
      (async () => {
        try {
          await session.query("select * from hoteles.booking_hold_create($1);", []);
        } catch {
          // catch simple
        }
        return session.query("select 1;", []);
      })(),
    ).rejects.toMatchObject({ code: "25P02" });
  });

  it("decideHold/confirmHold con un hold de OTRA property: no_encontrada sin llamar a la funcion", async () => {
    const session = new AbortAwareFakeSession([{ match: /select 1 as ok from hoteles\.booking_hold/, respond: () => [] }]);
    const repo = new PostgresReservasAgenteRepository(session);
    await expect(repo.decideHold(PROP, HOLD, "aprobar", "ok")).rejects.toMatchObject({ code: "no_encontrada" });
    await expect(repo.confirmHold(PROP, HOLD)).rejects.toMatchObject({ code: "no_encontrada" });
    expect(session.calls.some((c) => c.includes("booking_hold_decide"))).toBe(false);
  });
});

describe("mapReservasPgError: SQLSTATE + mensaje => codigo de negocio estable", () => {
  it.each([
    ["22023", "fechas_invalidas: la salida debe ser posterior", "fechas_invalidas"],
    ["22023", "fecha_pasada: la llegada ya paso", "fecha_pasada"],
    ["22023", "fecha_muy_lejana: mas de 365 dias", "fecha_muy_lejana"],
    ["22023", "estadia_muy_larga: maximo 14 noches", "estadia_muy_larga"],
    ["22023", "huespedes_invalidos: de 1 a 2", "huespedes_invalidos"],
    ["22023", "cotizacion_no_disponible: precio_fuera_de_guardia", "cotizacion_no_disponible"],
    ["22023", "idempotencia_conflicto: la llave", "idempotencia_conflicto"],
    ["22023", "otra cosa", "parametros_invalidos"],
    ["23514", "check", "parametros_invalidos"],
    ["55000", "holds_deshabilitados: el hotel", "holds_deshabilitados"],
    ["55000", "limite_holds_activos: demasiados", "limite_holds_activos"],
    ["55000", "limite_holds_contacto: ya tiene 2", "limite_holds_contacto"],
    ["55000", "estado_no_cancelable: x", "estado_no_valido"],
    ["P0001", "sin_disponibilidad: no hay", "sin_disponibilidad"],
    ["P0002", "tipo_habitacion_invalido: no pertenece", "tipo_habitacion_invalido"],
    ["P0002", "pre-reserva no encontrada", "no_encontrada"],
    ["23505", "duplicate key", "idempotencia_conflicto"],
    ["42501", "permission denied", "sin_permiso"],
  ])("%s %s => %s", (code, message, expected) => {
    const mapped = mapReservasPgError(pgError(code, message), "op");
    expect(mapped).toBeInstanceOf(ReservasAgenteError);
    expect((mapped as ReservasAgenteError).code).toBe(expected);
  });

  it("precio_cambio conserva el total vigente; un error desconocido se repropaga tal cual", () => {
    const m = mapReservasPgError(pgError("22023", "precio_cambio: el total vigente es 368900 centavos"), "op") as ReservasAgenteError;
    expect(m.code).toBe("precio_cambio");
    expect(m.detail).toEqual({ totalCents: 368_900 });
    const raw = new Error("boom");
    expect(mapReservasPgError(raw, "op")).toBe(raw);
  });

  it("no filtra mensajes crudos de Postgres para codigos no propios", () => {
    const m = mapReservasPgError(pgError("22023", 'invalid input syntax for type uuid: "x"'), "op") as ReservasAgenteError;
    expect(m.message).toBe("Datos invalidos (fuera de rango o formato no permitido).");
  });
});

describe("turno de WhatsApp con el repo Postgres (AbortAwareFakeSession): la herramienta falla con un error REAL de Postgres", () => {
  it("crear_pre_reserva con la funcion ausente: el huesped recibe respuesta, hay handoff y la sesion NO queda abortada (el COMMIT del turno no se degrada a ROLLBACK)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const roomType = randomUUID();
    const session = new AbortAwareFakeSession([
      { match: /agent_booking_policy/, respond: () => [policyRow] },
      { match: /from hoteles\.property_config/, respond: () => [{ timezone: "America/Mexico_City" }] },
      { match: /booking_hold_create/, respond: missingFn },
      { match: /insert into hoteles\.contacto_no_operativo/, respond: () => [{ id: randomUUID(), organization_id: randomUUID(), property_id: PROP, guest_phone: "+5219991110001", guest_name: null, reason: "x", message: null, source: "whatsapp", created_at: new Date().toISOString() }] },
      { match: /select 1/, respond: () => [] },
    ]);
    const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
    let step = 0;
    gateway.registerLadder("default", [
      new FakeLlmProvider({
        id: "p",
        script: (): LlmCompletionResult => {
          if (step++ === 0) {
            return {
              text: "",
              toolCalls: [{ id: "c1", name: "crear_pre_reserva", argumentsJson: JSON.stringify({ tipo_habitacion_id: roomType, fecha_llegada: "2031-06-12", fecha_salida: "2031-06-14", huespedes: 2, total_cotizado_centavos: 357000 }) }],
              model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0,
            };
          }
          return { text: "Una persona del hotel continuara con tu reserva.", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
        },
      }),
    ]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmHotelesWhatsAppTurnHandler(new PostgresHotelesRepository(session), gateway, {
      defaultRole: "default",
      escalatedRole: "escalated",
      reservas: new PostgresReservasAgenteRepository(session),
      now: () => new Date("2031-06-01T18:00:00Z"),
    });
    const out = await handler.handleInboundMessage({ organizationId: randomUUID(), propertyId: PROP, phone: "+5219991110001", messages: [{ role: "user", content: "quiero reservar" }] });
    expect(out.reply).toBe("Una persona del hotel continuara con tu reserva.");
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    expect(session.calls.some((c) => c.includes("insert into hoteles.contacto_no_operativo"))).toBe(true);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
    warn.mockRestore();
  });

  it("con la base sin migrar el turno NO ofrece herramientas de reservas (agentPolicy degrada) y la sesion sigue utilizable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = new AbortAwareFakeSession([{ match: /agent_booking_policy/, respond: missingFn }, { match: /select 1/, respond: () => [] }]);
    const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
    let tools: string[] = [];
    gateway.registerLadder("default", [new FakeLlmProvider({ id: "p", script: (req): LlmCompletionResult => { tools = (req.tools ?? []).map((t) => t.name); return { text: "Hola", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 }; } })]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmHotelesWhatsAppTurnHandler(new PostgresHotelesRepository(session), gateway, { defaultRole: "default", escalatedRole: "escalated", reservas: new PostgresReservasAgenteRepository(session) });
    const out = await handler.handleInboundMessage({ organizationId: randomUUID(), propertyId: PROP, phone: "+5219991110001", messages: [{ role: "user", content: "hola" }] });
    expect(out.reply).toBe("Hola");
    expect(tools).toEqual(["crear_ticket_huesped_fnb", "crear_ticket_mantenimiento", "registrar_contacto_no_operativo"]);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
    warn.mockRestore();
  });
});
