// QA-citas-R1-features-12 (correccion tras revision): la inscripcion del AGENTE corre en la sesion de sistema (rol `authenticated`, auth.uid() NULL,
// sujeta a RLS: NO es service_role). El INSERT directo no funciona ahi; el agente debe usar `insertWaitlistEntryAsSystem` (funcion security definer 034).
import { describe, expect, it } from "vitest";
import { AppointmentConflictError } from "../src/errors.ts";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { enrollInWaitlist } from "../src/waitlist-enrollment.ts";
import { ejecutarToolVozCitas } from "../src/voz/tools-servidor.ts";
import { executeToolCall } from "../src/whatsapp/llm-turn-handler.ts";
import type { NewWaitlistEntryInput } from "../src/waitlist-enrollment.ts";
import { InMemoryCitasRepository } from "../src/in-memory-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";
import { buildCitasFixture } from "./fixtures.ts";

const ORG = "00000000-0000-0000-0000-0000000000e1";
const PHONE = "9991234567";
const ENTRADA: NewWaitlistEntryInput = { organizationId: ORG, customerPhone: PHONE, customerName: "Ana", providerId: null, serviceId: null, preferredDateFrom: "2027-09-13", preferredDateTo: null, preferredTimeWindow: "morning" };

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const filaCreada = {
  out_outcome: "created",
  out_id: "00000000-0000-0000-0000-0000000000e2",
  out_customer_phone: PHONE,
  out_customer_name: "Ana",
  out_notified_count: 0,
  out_provider_id: null,
  out_service_id: null,
  out_preferred_date_from: "2027-09-13",
  out_preferred_date_to: null,
  out_preferred_time_window: "morning",
  out_created_at: "2027-09-01T00:00:00.000Z",
};

describe("PostgresCitasRepository.insertWaitlistEntryAsSystem (AbortAwareFakeSession)", () => {
  it("llama a citas.system_enroll_waitlist con los 9 parametros y mapea la fila creada", async () => {
    const session = new AbortAwareFakeSession([{ match: /citas\.system_enroll_waitlist/, respond: () => [filaCreada] }]);
    const result = await new PostgresCitasRepository(session).insertWaitlistEntryAsSystem(ENTRADA, 5);
    expect(result).toEqual({
      outcome: "created",
      entry: { id: filaCreada.out_id, customerPhone: PHONE, customerName: "Ana", notifiedCount: 0, providerId: null, serviceId: null, preferredDateFrom: "2027-09-13", preferredDateTo: null, preferredTimeWindow: "morning", createdAt: filaCreada.out_created_at },
    });
    // Una sola consulta de datos, ningun SELECT/INSERT directo contra la tabla (que la RLS de sistema rechazaria).
    expect(session.calls.filter((c) => /appointment_waitlist/.test(c))).toEqual([]);
  });

  it("already_waiting devuelve la fila existente y too_many no trae fila", async () => {
    const ya = new AbortAwareFakeSession([{ match: /citas\.system_enroll_waitlist/, respond: () => [{ ...filaCreada, out_outcome: "already_waiting" }] }]);
    await expect(new PostgresCitasRepository(ya).insertWaitlistEntryAsSystem(ENTRADA, 5)).resolves.toMatchObject({ outcome: "already_waiting", entry: { id: filaCreada.out_id } });
    const tope = new AbortAwareFakeSession([{ match: /citas\.system_enroll_waitlist/, respond: () => [{ out_outcome: "too_many" }] }]);
    await expect(new PostgresCitasRepository(tope).insertWaitlistEntryAsSystem(ENTRADA, 5)).resolves.toEqual({ outcome: "too_many" });
  });

  it("REGLA DURA de compatibilidad: la funcion aun no existe (42883, migracion 034 pendiente) -> 'unavailable' y la sesion compartida queda utilizable (sin 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.system_enroll_waitlist/, respond: () => pgError("42883", "function citas.system_enroll_waitlist(uuid, text, text, uuid, uuid, date, date, text, integer) does not exist") },
      { match: /select 1/, respond: () => [] },
    ]);
    const result = await new PostgresCitasRepository(session).insertWaitlistEntryAsSystem(ENTRADA, 5);
    expect(result).toEqual({ outcome: "unavailable" });
    expect(session.calls.some((c) => c.startsWith("savepoint sp_citas_system_enroll_waitlist"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_citas_system_enroll_waitlist"))).toBe(true);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("un error distinto (42501) NUNCA se enmascara: se repropaga con la sesion ya recuperada", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.system_enroll_waitlist/, respond: () => pgError("42501", "system_enroll_waitlist es solo para la sesión de sistema") },
      { match: /select 1/, respond: () => [] },
    ]);
    await expect(new PostgresCitasRepository(session).insertWaitlistEntryAsSystem(ENTRADA, 5)).rejects.toMatchObject({ code: "42501" });
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("enrollInWaitlist con sistema:true y la base sin migrar: error honesto para el agente (no un 500) y la sesion sigue sirviendo", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.system_enroll_waitlist/, respond: () => pgError("42883", "function citas.system_enroll_waitlist(uuid, text, text, uuid, uuid, date, date, text, integer) does not exist") },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);
    await expect(enrollInWaitlist(repo, { organizationId: ORG, customerPhone: PHONE }, { sistema: true })).rejects.toThrow(/aún no está disponible/);
    await expect(enrollInWaitlist(repo, { organizationId: ORG, customerPhone: PHONE }, { sistema: true })).rejects.toBeInstanceOf(AppointmentConflictError);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });
});

/** El INSERT directo (ruta de staff) falla como lo hace la RLS real en la sesion de sistema; la ruta de sistema sigue siendo la del repositorio en memoria. */
function conInsertDirectoBloqueado(base: InMemoryCitasRepository): InMemoryCitasRepository {
  const insertar = base.insertWaitlistEntry.bind(base);
  base.insertWaitlistEntryAsSystem = (entrada, tope) => insertar(entrada, tope);
  base.insertWaitlistEntry = async () => {
    throw pgError("42501", 'new row violates row-level security policy for table "appointment_waitlist"');
  };
  return base;
}

describe("la herramienta anotar_lista_espera usa la ruta de sistema", () => {
  it("WhatsApp y voz: anotan aunque el INSERT directo este bloqueado por RLS (el agente ya no lo usa)", async () => {
    const f = buildCitasFixture();
    const repo = conInsertDirectoBloqueado(f.repo);
    const wa = await executeToolCall(repo, { organizationId: f.organizationId, phone: PHONE, name: "anotar_lista_espera", input: { time_window: "evening" } });
    expect(wa.result).toMatchObject({ waitlist: { already_on_list: false } });
    const voz = await ejecutarToolVozCitas({ repo, organizationId: f.organizationId, telefono: "9990001111" }, "anotar_lista_espera", { time_window: "morning" });
    expect(voz.resultado).toMatchObject({ waitlist: { already_on_list: false } });
  });

  it("la ruta de staff (sin sistema) sigue usando el INSERT directo", async () => {
    const f = buildCitasFixture();
    const repo = conInsertDirectoBloqueado(f.repo);
    await expect(enrollInWaitlist(repo, { organizationId: f.organizationId, customerPhone: PHONE })).rejects.toMatchObject({ code: "42501" });
  });
});

describe("la herramienta anotar_lista_espera responde con honestidad si la funcion no esta disponible", () => {
  it("WhatsApp y voz: 'unavailable' llega al modelo como error (sin excepcion ni escritura)", async () => {
    const f = buildCitasFixture();
    f.repo.insertWaitlistEntryAsSystem = async () => ({ outcome: "unavailable" });
    const wa = await executeToolCall(f.repo, { organizationId: f.organizationId, phone: PHONE, name: "anotar_lista_espera", input: {} });
    expect(wa.result).toMatchObject({ error: expect.stringMatching(/aún no está disponible/) });
    const voz = await ejecutarToolVozCitas({ repo: f.repo, organizationId: f.organizationId, telefono: PHONE }, "anotar_lista_espera", {});
    expect(JSON.stringify(voz.resultado)).toMatch(/aún no está disponible/);
    expect(await f.repo.loadLiveWaitlistCandidates(f.organizationId)).toHaveLength(0);
  });
});
