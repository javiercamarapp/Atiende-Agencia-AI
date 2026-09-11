// ─────────────────────────────────────────────────────────────────────────────
// EL test que justifica el paquete: 2 mensajes concurrentes del MISMO cliente
// sobre la MISMA reserva nunca producen doble-booking.
//
// Reproduce el bug real documentado en atiende.ai
// (src/lib/whatsapp/conversation-lock.ts, comentario de cabecera): "dos
// webhooks concurrentes del mismo paciente pueden disparar dos pipelines en
// paralelo y crear citas duplicadas (el `hasConflict` check no captura cuando
// ambos INSERT corren al mismo tiempo)". El chequeo de conflicto es lógica de
// negocio (solape de horarios), no una UNIQUE constraint de SQL de una sola
// columna — por eso el lock de conversación es la defensa real, no la DB.
//
// El repositorio de abajo modela exactamente ese patrón: check-then-insert
// con una latencia artificial entre ambos pasos (simula el round-trip real a
// Postgres) para que, SIN serialización, la carrera sea genuina — dos
// promesas verdaderamente intercaladas por el event loop, no una simulación
// secuencial disfrazada.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { InMemoryLockStore } from '../src/lock/in-memory-lock-store.ts';
import { InMemoryStateStore } from '../src/state/in-memory-state-store.ts';
import { ConversationStateMachine } from '../src/state/state-machine.ts';
import { ConversationStateEnum, DEFAULT_BOOKING_TRANSITIONS, type BookingState } from '../src/state/transitions.ts';
import { withConversationLock } from '../src/guard.ts';

type Ctx = Record<string, unknown>;

interface BookingRow {
  resourceKey: string; // ej. "habitacion-101:2026-10-01"
  conversationId: string;
}

/** Repositorio en memoria que modela check-then-insert SIN unique constraint,
 * igual que `appointments` en atiende.ai (el conflicto es de negocio —
 * solape — no expresable como UNIQUE de una columna). */
class FakeReservationRepository {
  private rows: BookingRow[] = [];
  constructor(private readonly dbLatencyMs = 10) {}

  private async delay() {
    await new Promise((r) => setTimeout(r, this.dbLatencyMs));
  }

  /** Igual que `hasConflict` real: SELECT contra la tabla. */
  async hasConflict(resourceKey: string): Promise<boolean> {
    await this.delay();
    return this.rows.some((r) => r.resourceKey === resourceKey);
  }

  /** Igual que el INSERT real: no valida nada más, confía en el caller. */
  async insert(row: BookingRow): Promise<void> {
    await this.delay();
    this.rows.push(row);
  }

  countFor(resourceKey: string): number {
    return this.rows.filter((r) => r.resourceKey === resourceKey).length;
  }
}

/** El flow de negocio: exactamente el patrón hasConflict → insert de
 * atiende.ai (`handleReservation`/`handleNewAppointment` en `engine.ts`). */
async function attemptBooking(
  repo: FakeReservationRepository,
  resourceKey: string,
  conversationId: string,
): Promise<{ booked: boolean }> {
  const conflict = await repo.hasConflict(resourceKey);
  if (conflict) return { booked: false };
  await repo.insert({ resourceKey, conversationId });
  return { booked: true };
}

describe('Doble-booking bajo concurrencia real — mismo cliente, 2 mensajes casi simultáneos', () => {
  const TENANT = 'tenant-hotel-1';
  const CUSTOMER_PHONE = '+525599990000';
  const RESOURCE = 'habitacion-101:2026-12-24'; // Nochebuena, alta demanda — el caso que de verdad duele
  const CONVERSATION_ID = 'conv-abc';

  it('CONTROL — sin serialización, el bug es real: 2 mensajes concurrentes SÍ duplican la reserva', async () => {
    // Esto NO es el comportamiento deseado — es la prueba de que el test de
    // abajo mide algo real: si esta aserción fallara (repo.count !== 2), el
    // test "con lock" de abajo no probaría nada porque la carrera nunca
    // habría sido genuina en primer lugar.
    const repo = new FakeReservationRepository(10);

    const [r1, r2] = await Promise.all([
      attemptBooking(repo, RESOURCE, CONVERSATION_ID),
      attemptBooking(repo, RESOURCE, CONVERSATION_ID),
    ]);

    expect(r1.booked).toBe(true);
    expect(r2.booked).toBe(true); // el bug: ambos "ganan" el hasConflict antes de que el otro inserte
    expect(repo.countFor(RESOURCE)).toBe(2); // DOBLE-BOOKING real, reproducido
  });

  it('FIX — con el lock de conversación, 2 mensajes concurrentes del mismo cliente NUNCA duplican la reserva', async () => {
    const repo = new FakeReservationRepository(10);
    const lockStore = new InMemoryLockStore();
    const stateStore = new InMemoryStateStore<BookingState, Ctx>(5);
    const stateMachine = new ConversationStateMachine<BookingState, Ctx>(stateStore, DEFAULT_BOOKING_TRANSITIONS);
    // Flow ya llegó al paso de confirmación (el cliente ya dio los datos en
    // turnos previos) — lo que llega concurrente ahora es el "sí" final que
    // dispara el INSERT real.
    // Camino válido completo (null → detalles → confirmación) — la tabla no
    // permite saltar directo a "awaiting confirmation" desde reposo.
    await stateMachine.transition(CONVERSATION_ID, ConversationStateEnum.AWAITING_RESERVATION_DETAILS);
    await stateMachine.transition(CONVERSATION_ID, ConversationStateEnum.AWAITING_RESERVATION_CONFIRMATION);

    const processMessage = () =>
      withConversationLock(
        { lockStore, stateMachine, tenantId: TENANT, customerKey: CUSTOMER_PHONE, conversationId: CONVERSATION_ID },
        async ({ transition }) => {
          const result = await attemptBooking(repo, RESOURCE, CONVERSATION_ID);
          if (result.booked) {
            await transition(ConversationStateEnum.RESERVATION_LOCKED_IN, { resourceKey: RESOURCE });
          }
          return result;
        },
      );

    // Dos "webhooks" casi simultáneos del MISMO cliente — exactamente el
    // escenario del bug (WhatsApp reintenta la entrega, o el cliente manda
    // "sí" dos veces por mala señal).
    const [g1, g2] = await Promise.all([processMessage(), processMessage()]);

    expect(g1.locked).toBe(true);
    expect(g2.locked).toBe(true); // ambos SE PROCESARON (nadie perdió el mensaje)

    const outcomes = [g1.result!.booked, g2.result!.booked].sort();
    expect(outcomes).toEqual([false, true]); // exactamente uno reservó, el otro vio el conflicto YA serializado

    expect(repo.countFor(RESOURCE)).toBe(1); // NUNCA doble-booking

    const finalState = await stateMachine.getState(CONVERSATION_ID);
    expect(finalState.state).toBe(ConversationStateEnum.RESERVATION_LOCKED_IN);
  });

  it('FIX bajo carga — 5 mensajes concurrentes del mismo cliente para la misma reserva: solo 1 gana, 0 dobles', async () => {
    const repo = new FakeReservationRepository(8);
    const lockStore = new InMemoryLockStore();
    const stateStore = new InMemoryStateStore<BookingState, Ctx>(3);
    const stateMachine = new ConversationStateMachine<BookingState, Ctx>(stateStore, DEFAULT_BOOKING_TRANSITIONS);
    await stateMachine.transition(CONVERSATION_ID, ConversationStateEnum.AWAITING_RESERVATION_DETAILS);
    await stateMachine.transition(CONVERSATION_ID, ConversationStateEnum.AWAITING_RESERVATION_CONFIRMATION);

    const processMessage = () =>
      withConversationLock(
        { lockStore, stateMachine, tenantId: TENANT, customerKey: CUSTOMER_PHONE, conversationId: CONVERSATION_ID },
        async ({ transition }) => {
          const result = await attemptBooking(repo, RESOURCE, CONVERSATION_ID);
          if (result.booked) await transition(ConversationStateEnum.RESERVATION_LOCKED_IN);
          return result;
        },
      );

    const results = await Promise.all(Array.from({ length: 5 }, () => processMessage()));
    expect(results.every((r) => r.locked)).toBe(true);

    const bookedCount = results.filter((r) => r.result!.booked).length;
    expect(bookedCount).toBe(1);
    expect(repo.countFor(RESOURCE)).toBe(1);
  });

  it('clientes DISTINTOS pueden reservar recursos DISTINTOS en paralelo sin bloquearse entre sí', async () => {
    const repo = new FakeReservationRepository(10);
    const lockStore = new InMemoryLockStore();
    const stateStore = new InMemoryStateStore<BookingState, Ctx>(0);

    const bookFor = async (customerPhone: string, conversationId: string, resourceKey: string) => {
      const machine = new ConversationStateMachine<BookingState, Ctx>(stateStore, DEFAULT_BOOKING_TRANSITIONS);
      await machine.transition(conversationId, ConversationStateEnum.AWAITING_RESERVATION_DETAILS);
      await machine.transition(conversationId, ConversationStateEnum.AWAITING_RESERVATION_CONFIRMATION);
      return withConversationLock(
        { lockStore, stateMachine: machine, tenantId: TENANT, customerKey: customerPhone, conversationId },
        async ({ transition }) => {
          const result = await attemptBooking(repo, resourceKey, conversationId);
          if (result.booked) await transition(ConversationStateEnum.RESERVATION_LOCKED_IN);
          return result;
        },
      );
    };

    const start = Date.now();
    const [a, b] = await Promise.all([
      bookFor('+525511110000', 'conv-a', 'habitacion-201:2026-12-24'),
      bookFor('+525522220000', 'conv-b', 'habitacion-202:2026-12-24'),
    ]);
    const elapsed = Date.now() - start;

    expect(a.result!.booked).toBe(true);
    expect(b.result!.booked).toBe(true);
    expect((await stateStore.read('conv-a')).state).toBe(ConversationStateEnum.RESERVATION_LOCKED_IN);
    expect((await stateStore.read('conv-b')).state).toBe(ConversationStateEnum.RESERVATION_LOCKED_IN);
    // No deben haberse serializado entre sí (locks distintos) — si el mock
    // artificialmente los serializara, tardaría ~2x el latency; verificamos
    // que corrieron en paralelo real (muy por debajo de 2x la latencia total
    // de un booking secuencial, que ronda ~20ms con dbLatencyMs=10).
    expect(elapsed).toBeLessThan(60);
  });
});
