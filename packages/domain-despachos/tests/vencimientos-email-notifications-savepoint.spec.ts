// Auditoría a3 (hallazgos confirmados #5 y #2) — regresión para el SAVEPOINT que
// faltaba alrededor de `tryEnqueueEscalationEmail` (único `try*` real de este
// dominio -- ver por qué `cobranza/email-notifications.ts::tryEnqueueCollection
// ReminderEmail`/`...ForSystem` quedaron FUERA de este barrido: el auditor confirmó
// que no tienen ningún caller de producción, así que no hay camino de falla que
// proteger).
//
// `enqueueEscalationEmailCore` termina en
// `select despachos.enqueue_messaging_outbox(...)`, llamado SIEMPRE en la MISMA
// transacción de sesión de STAFF que ya hizo `insertEscalation` +
// `updateDeadlineEstado` (apps/api/src/routes/verticals/despachos/vencimientos.ts,
// `POST .../escalar`): un `try/catch` plano sin SAVEPOINT deja esa transacción
// COMPLETA abortada (25P02) si el encolado falla, y el escalamiento ya persistido se
// pierde con el `commit;` convertido en `ROLLBACK` silencioso
// (`AbortedTransactionCommitError`, managed-postgres-engine.ts).
//
// `DespachosRepository` NO tenía `runWithRowSavepoint` antes de esta ronda (a
// diferencia de hoteles/restaurantes/citas) -- se agregó en `repository.ts`/
// `postgres-repository.ts`/`in-memory-repository.ts` como parte de este mismo fix.
// Se prueba contra `PostgresDespachosRepository` real (no el doble en memoria, cuyo
// `runWithRowSavepoint` es un no-op que no reproduce el estado abortado de Postgres)
// + `AbortAwareFakeSession` (packages/domain-despachos/tests/support, copiado a
// propósito del mismo doble de restaurantes/hoteles). Cada test de este archivo
// FALLA contra el código anterior (try/catch sin `repo.runWithRowSavepoint`, que ni
// siquiera existía): sin el SAVEPOINT, la consulta posterior sobre la MISMA sesión
// lanza 25P02 en vez de resolver.
import { describe, expect, it, vi } from "vitest";
import { PostgresDespachosRepository } from "../src/postgres-repository.ts";
import { tryEnqueueEscalationEmail } from "../src/vencimientos/email-notifications.ts";
import { decidirEscalamiento } from "../src/vencimientos/engine.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";
import type { FiscalDeadlineRecord } from "../src/types.ts";

const ORGANIZATION_ID = "00000000-0000-0000-0000-0000000000o1";

const DEADLINE: FiscalDeadlineRecord = {
  id: "00000000-0000-0000-0000-0000000000d1",
  organizationId: ORGANIZATION_ID,
  propertyId: "00000000-0000-0000-0000-0000000000p1",
  tipo: "ISR",
  periodo: "2026-06",
  fechaLimite: "2026-07-17",
  prioridad: "critica",
  estado: "pendiente",
  fechaPresentacion: null,
  comprobanteUrl: null,
  createdAt: new Date().toISOString(),
};

const DECISION = decidirEscalamiento(DEADLINE.tipo, DEADLINE.fechaLimite, -5);

function pgPermissionDenied(): Error & { code: string } {
  const err = new Error("permission denied for function enqueue_messaging_outbox") as Error & { code: string };
  err.code = "42501";
  return err;
}

function buildRepo(session: AbortAwareFakeSession) {
  const repo = new PostgresDespachosRepository(session);
  vi.spyOn(repo, "listOrganizationNotificationRecipients").mockResolvedValue([{ email: "owner@despacho.mx", fullName: "Owner" }]);
  return repo;
}

describe("tryEnqueueEscalationEmail — SAVEPOINT (auditoría a3, hallazgo confirmado #5)", () => {
  it("un 42501 real de enqueue_messaging_outbox NUNCA deja la sesión abortada -- el escalamiento ya persistido sobrevive", async () => {
    const session = new AbortAwareFakeSession([
      { match: /enqueue_messaging_outbox/, respond: () => pgPermissionDenied() },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = buildRepo(session);

    // No lanza -- best-effort real.
    const result = await tryEnqueueEscalationEmail(repo, DEADLINE, DECISION, "Despacho de Prueba SC", -5);
    expect(result).toEqual({ recipients: 0, enqueued: 0 });

    // La prueba real: el SAVEPOINT interno recuperó la transacción -- una consulta
    // POSTERIOR sobre la MISMA sesión (aquí, la que haría el `commit;` real de
    // managed-postgres-engine.ts) resuelve en vez de lanzar 25P02
    // (AbortedTransactionCommitError). Contra el código anterior (try/catch sin
    // `repo.runWithRowSavepoint`, que ni siquiera existía) esta aserción falla: la
    // sesión queda abortada.
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);
  });

  it("éxito real: encola el correo de escalamiento sin dejar rastro de SAVEPOINT sin liberar", async () => {
    const session = new AbortAwareFakeSession([{ match: /enqueue_messaging_outbox/, respond: () => [] }]);
    const repo = buildRepo(session);

    const result = await tryEnqueueEscalationEmail(repo, DEADLINE, DECISION, "Despacho de Prueba SC", -5);

    expect(result).toEqual({ recipients: 1, enqueued: 1 });
    expect(session.calls.some((c) => c.startsWith("release savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(false);
  });

  it("sin ningún staff owner/admin en la organización: nunca llama a enqueue_messaging_outbox, nunca deja un SAVEPOINT abierto", async () => {
    const session = new AbortAwareFakeSession([{ match: /enqueue_messaging_outbox/, respond: () => pgPermissionDenied() }]);
    const repo = new PostgresDespachosRepository(session);
    vi.spyOn(repo, "listOrganizationNotificationRecipients").mockResolvedValue([]);

    const result = await tryEnqueueEscalationEmail(repo, DEADLINE, DECISION, "Despacho de Prueba SC", -5);

    expect(result).toEqual({ recipients: 0, enqueued: 0 });
    expect(session.calls.some((c) => c.startsWith("release savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(false);
  });
});
