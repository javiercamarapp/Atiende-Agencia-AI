// Hallazgo de auditoría (a3, rentas — parte de los elementos "best-effort sin
// SAVEPOINT" de citas/rentas/hoteles/despachos/restaurantes) — regresión para el
// SAVEPOINT de `tryEnqueueReservaEmail` (ver src/reserva-email-notifications.ts),
// mismo patrón EXACTO que
// `@atiende/domain-restaurantes::order-notifications-savepoint.spec.ts` (Blocker A,
// revisión de PR #169) y `NOTIFY_SAVEPOINT_NAME`/`runNotifyBestEffort`.
//
// El bloqueante real: `POST .../rentas/.../reservas` (reservas.ts:158) llama a
// `tryEnqueueReservaEmail` con el MISMO `TenantDbSession`/transacción que ya corrió
// `crearReservaConfirmada` + `insertGuestMinimo`. Un try/catch plano alrededor de
// `enqueueReservaEmailCore` (que hace varias consultas reales, incluida
// `enqueueMessagingOutbox`) dejaba la transacción COMPLETA abortada ante cualquier
// error real de Postgres — el `commit;` posterior de
// `packages/db/src/managed-postgres-engine.ts` se convertía en un ROLLBACK silencioso
// y la reserva, ya "persistida" antes en la misma transacción, se perdía con una
// respuesta 2xx.
//
// Mismo `AbortAwareFakeSession` (reproduce el estado ABORTADO real de Postgres) que
// el resto del monorepo usa para este tipo de regresión.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { InMemoryRentasCalendarStore } from "../src/calendar-store.ts";
import { InMemoryRentasRepository } from "../src/in-memory-repository.ts";
import { InMemoryRentasTenancyEngine } from "../src/in-memory-tenancy-engine.ts";
import { crearReservaConfirmada } from "../src/aplicacion/reservas.ts";
import { tryEnqueueReservaEmail } from "../src/reserva-email-notifications.ts";
import type { EjecutorTransaccional } from "../src/ejecutor.ts";
import type { UnidadRecord } from "../src/types.ts";

function pgPermissionDenied(): Error & { code: string } {
  const err = new Error("permission denied for function rentas.enqueue_messaging_outbox") as Error & { code: string };
  err.code = "42501";
  return err;
}

function pg25P02(): Error & { code: string } {
  const err = new Error("current transaction is aborted, commands ignored until end of transaction block") as Error & { code: string };
  err.code = "25P02";
  return err;
}

/** Doble mínimo de `TenantDbSession` que reproduce el estado ABORTADO real de
 *  Postgres — idéntico en espíritu al de `order-notifications-savepoint.spec.ts`: el
 *  mock del encolado pone `aborted = true` ANTES de lanzar, y `query()`/`exec()`
 *  lanzan 25P02 mientras la sesión siga abortada, salvo `ROLLBACK TO SAVEPOINT` (que
 *  además exige que el savepoint exista de verdad). */
class AbortAwareFakeSession implements TenantDbSession {
  aborted = false;
  private savepointEstablished = false;
  readonly execCalls: string[] = [];

  async query<T>(): Promise<{ rows: T[] }> {
    if (this.aborted) throw pg25P02();
    return { rows: [] as T[] };
  }

  async exec(sql: string): Promise<void> {
    const n = sql.trim().toLowerCase();
    this.execCalls.push(n);
    if (n.startsWith("rollback to savepoint")) {
      if (!this.savepointEstablished) throw new Error(`AbortAwareFakeSession: no existe el savepoint a revertir (${sql})`);
      this.aborted = false;
      return;
    }
    if (this.aborted) throw pg25P02();
    if (n.startsWith("savepoint")) {
      this.savepointEstablished = true;
      return;
    }
    if (n.startsWith("release savepoint")) {
      this.savepointEstablished = false;
      return;
    }
    throw new Error(`AbortAwareFakeSession: exec no soportado: ${sql}`);
  }
}

async function crearFixtureConReserva(contacto = "cliente@example.com") {
  const store = new InMemoryRentasCalendarStore();
  const engine = new InMemoryRentasTenancyEngine(store);
  const repo = new InMemoryRentasRepository(store);
  let ejecutor!: EjecutorTransaccional;
  await engine.withAppSession({ userId: null }, async (session) => {
    ejecutor = session;
  });

  const organizationId = randomUUID();
  const propertyId = randomUUID();
  repo.seedOrganizacion(organizationId, "Casa Sol de Prueba");
  const unidad: UnidadRecord = { id: randomUUID(), organizationId, propertyId, duracionMinimaNoches: 1, name: "Depa Reforma 2" };
  store.seedUnidad(unidad);

  const resultado = await crearReservaConfirmada(ejecutor, {
    organizationId,
    propertyId,
    unidadId: unidad.id,
    rango: { inicio: "2026-10-01", fin: "2026-10-05" },
    estado: "confirmado",
    bloqueante: true,
  });
  const guest = await repo.insertGuestMinimo({ organizationId, propertyId, nombre: "María López", contacto });
  await repo.attachGuestToOcupacion(resultado.ocupacionId, guest.id);

  return { repo, organizationId, ocupacionId: resultado.ocupacionId };
}

describe("tryEnqueueReservaEmail — SAVEPOINT (auditoría a3, mismo patrón que restaurantes/PR #169)", () => {
  it("con `db` (sesión de staff): un error real de Postgres en enqueueMessagingOutbox -> SAVEPOINT -> ROLLBACK TO SAVEPOINT -> RELEASE, nunca relanza, y la sesión vuelve a estar sana", async () => {
    const fixture = await crearFixtureConReserva();
    const session = new AbortAwareFakeSession();
    vi.spyOn(fixture.repo, "enqueueMessagingOutbox").mockImplementation(async () => {
      session.aborted = true;
      throw pgPermissionDenied();
    });

    const resultado = await tryEnqueueReservaEmail(fixture.repo, fixture.organizationId, "reserva.creada", fixture.ocupacionId, session);

    expect(resultado).toBeNull();
    expect(session.execCalls).toEqual(["savepoint sp_reserva_email_best_effort", "rollback to savepoint sp_reserva_email_best_effort", "release savepoint sp_reserva_email_best_effort"]);
    expect(session.aborted).toBe(false);
    // La prueba real de que el SAVEPOINT recuperó la transacción de negocio (no solo
    // el estado interno del doble): el `commit;` posterior de
    // managed-postgres-engine.ts ya no vería una transacción abortada, así que la
    // reserva creada por crearReservaConfirmada (misma transacción real) sobrevive.
    await expect(session.query()).resolves.toEqual({ rows: [] });
  });

  it("con `db`, éxito real: SAVEPOINT -> RELEASE, sin ROLLBACK TO SAVEPOINT", async () => {
    const fixture = await crearFixtureConReserva();
    const session = new AbortAwareFakeSession();

    const resultado = await tryEnqueueReservaEmail(fixture.repo, fixture.organizationId, "reserva.creada", fixture.ocupacionId, session);

    expect(resultado).toEqual({ enqueued: true });
    expect(session.execCalls).toEqual(["savepoint sp_reserva_email_best_effort", "release savepoint sp_reserva_email_best_effort"]);
    expect(session.aborted).toBe(false);
  });

  it("sin `db` (compatibilidad hacia atrás): corre sin SAVEPOINT, igual que antes", async () => {
    const fixture = await crearFixtureConReserva();
    vi.spyOn(fixture.repo, "enqueueMessagingOutbox").mockRejectedValue(pgPermissionDenied());

    await expect(tryEnqueueReservaEmail(fixture.repo, fixture.organizationId, "reserva.creada", fixture.ocupacionId)).resolves.toBeNull();
  });

  it("si la sesión YA venía abortada de antes (causa ajena a este best-effort): nunca convierte el best-effort en una excepción NUEVA", async () => {
    const fixture = await crearFixtureConReserva();
    const session = new AbortAwareFakeSession();
    session.aborted = true; // Nadie estableció un savepoint todavía en esta transacción.

    await expect(tryEnqueueReservaEmail(fixture.repo, fixture.organizationId, "reserva.creada", fixture.ocupacionId, session)).resolves.toBeNull();

    // El propio SAVEPOINT lanza (transacción ya abortada); el intento de recuperación
    // también falla (no hay savepoint que revertir) -- ambos se tragan, nunca se
    // relanza fuera de este best-effort.
    expect(session.aborted).toBe(true);
  });
});
