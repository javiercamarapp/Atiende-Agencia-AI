// Efectos best-effort tras cancelar (botón de WhatsApp) / modificar_cita (agente): corren en la
// ÚNICA transacción del request del webhook, así que un error real de Postgres dentro de
// ellos NO puede dejarla abortada (25P02) ni revertir la cancelación/cambio ya hecho. Se
// reproduce el estado abortado con `AbortAwareFakeSession` (una sesión falsa plana no sirve).
import { describe, expect, it } from "vitest";
import { runAfterCancelEffects, runAfterReassignEffects, resolveProviderTimeZone } from "../src/appointment-effects.ts";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import type { AppointmentRecord } from "../src/types.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-0000000000e1";
const PROVIDER = "00000000-0000-0000-0000-0000000000e2";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const appointment: AppointmentRecord = {
  id: "00000000-0000-0000-0000-0000000000e3",
  organizationId: ORG,
  propertyId: null,
  providerId: PROVIDER,
  serviceId: "00000000-0000-0000-0000-0000000000e4",
  customerId: "00000000-0000-0000-0000-0000000000e5",
  startsAt: "2030-01-01T16:00:00.000Z",
  endsAt: "2030-01-01T16:30:00.000Z",
  status: "cancelled",
  source: "whatsapp",
  notes: null,
  dedupeFingerprint: null,
  idempotencyKey: null,
  reminder24hSentAt: null,
  createdAt: "2029-12-01T00:00:00.000Z",
  googleEventId: null,
  googleSyncStatus: "skipped",
  googleSyncAttempts: 0,
  googleSyncNextRetryAt: null,
  googleSyncError: null,
};

describe("efectos best-effort tras cancelar/modificar (AbortAwareFakeSession)", () => {
  it("un deadlock (40P01) al leer el proveedor se aísla con SAVEPOINT: se usa la zona por defecto y la sesión queda utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from citas\.providers/, respond: () => pgError("40P01", "deadlock detected") },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    await expect(resolveProviderTimeZone(repo, ORG, PROVIDER)).resolves.toBe("America/Mexico_City");

    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("runAfterCancelEffects / runAfterReassignEffects NUNCA lanzan aunque cada paso falle con un error real de Postgres, y dejan la sesión sana", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from citas\.providers/, respond: () => pgError("40P01", "deadlock detected") },
      { match: /system_load_live_waitlist_candidates|from citas\.appointment_waitlist/, respond: () => pgError("57014", "canceling statement due to statement timeout") },
      { match: /citas\.messaging_outbox|citas\.email_outbox|citas\.customers|from citas\.appointments/, respond: () => pgError("40001", "could not serialize access") },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    await expect(runAfterCancelEffects(repo, ORG, appointment)).resolves.toBeUndefined();
    await expect(runAfterReassignEffects(repo, ORG, { appointment, previousProviderId: PROVIDER, previousServiceId: appointment.serviceId })).resolves.toBeUndefined();

    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });
});
