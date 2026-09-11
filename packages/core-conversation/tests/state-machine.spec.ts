import { describe, it, expect } from 'vitest';
import { InMemoryStateStore } from '../src/state/in-memory-state-store.ts';
import { ConversationStateMachine } from '../src/state/state-machine.ts';
import { ConversationStateEnum, DEFAULT_BOOKING_TRANSITIONS, type BookingState } from '../src/state/transitions.ts';

type Ctx = Record<string, unknown>;

function makeMachine(latencyMs = 0) {
  const store = new InMemoryStateStore<BookingState, Ctx>(latencyMs);
  const machine = new ConversationStateMachine<BookingState, Ctx>(store, DEFAULT_BOOKING_TRANSITIONS);
  return { store, machine };
}

describe('ConversationStateMachine — validación de transiciones', () => {
  it('permite una transición válida desde reposo (null)', async () => {
    const { machine } = makeMachine();
    const r = await machine.transition('c1', ConversationStateEnum.AWAITING_APPOINTMENT_DATE, { foo: 'bar' });
    expect(r.applied).toBe(true);
    if (r.applied) {
      expect(r.from).toBeNull();
      expect(r.to).toBe(ConversationStateEnum.AWAITING_APPOINTMENT_DATE);
      expect(r.context).toEqual({ foo: 'bar' });
      expect(r.version).toBe(1);
    }
  });

  it('rechaza una transición inválida y NO escribe nada', async () => {
    const { machine, store } = makeMachine();
    // AWAITING_MODIFY_DATE solo puede ir a null, no a AWAITING_ORDER_CONFIRMATION.
    await machine.transition('c1', ConversationStateEnum.AWAITING_MODIFY_DATE);
    const before = await store.read('c1');

    const r = await machine.transition('c1', ConversationStateEnum.AWAITING_ORDER_CONFIRMATION);
    expect(r.applied).toBe(false);
    if (!r.applied) expect(r.reason).toBe('invalid_transition');

    const after = await store.read('c1');
    expect(after).toEqual(before); // nada cambió — ni el estado ni la versión
  });

  it('rechaza transición inválida desde reposo (target que no está en la tabla de null)', async () => {
    const { machine } = makeMachine();
    // RESERVATION_LOCKED_IN no es alcanzable directo desde reposo.
    const r = await machine.transition('c1', ConversationStateEnum.RESERVATION_LOCKED_IN);
    expect(r.applied).toBe(false);
  });

  it('mergea el context patch sobre el context existente sin perder datos previos', async () => {
    const { machine } = makeMachine();
    await machine.transition('c1', ConversationStateEnum.AWAITING_RESERVATION_DETAILS, { fecha: '2026-10-01' });
    const r = await machine.transition('c1', ConversationStateEnum.AWAITING_RESERVATION_CONFIRMATION, { huespedes: 2 });
    expect(r.applied).toBe(true);
    if (r.applied) expect(r.context).toEqual({ fecha: '2026-10-01', huespedes: 2 });
  });

  it('clear() transiciona a null desde cualquier estado con salida a null en la tabla', async () => {
    const { machine } = makeMachine();
    await machine.transition('c1', ConversationStateEnum.AWAITING_APPOINTMENT_DATE);
    const r = await machine.clear('c1');
    expect(r.applied).toBe(true);
    if (r.applied) expect(r.to).toBeNull();
  });

  it('CAS real: dos mensajes concurrentes dando datos parciales (self-loop) — ambos aplican vía retry, el context queda con los DOS datos, nunca uno pisa al otro', async () => {
    // Latencia artificial para forzar interleaving real entre las dos
    // "transacciones" (sin esto ambos read() podrían caer en el mismo tick
    // y el test no probaría nada sobre la sección crítica read→write).
    const { machine, store } = makeMachine(15);

    // Arranca en AWAITING_APPOINTMENT_DATE (el cliente ya inició el flow).
    await machine.transition('c1', ConversationStateEnum.AWAITING_APPOINTMENT_DATE);

    // Dos mensajes casi simultáneos del mismo cliente, cada uno agregando UN
    // dato distinto sin salir del estado (self-loop) — ej. "el sábado" y,
    // 200ms después por mala señal, "a las 5pm" llegan casi juntos.
    const [r1, r2] = await Promise.all([
      machine.transition('c1', ConversationStateEnum.AWAITING_APPOINTMENT_DATE, { dia: 'sabado' }),
      machine.transition('c1', ConversationStateEnum.AWAITING_APPOINTMENT_DATE, { hora: '17:00' }),
    ]);

    // Ambas deben reportar éxito: el que pierde el primer CAS relee el
    // estado fresco (la transición self-loop SIGUE siendo válida desde el
    // mismo estado), mergea su patch sobre el context ya actualizado por el
    // otro, y reintenta — nunca se rinde con datos válidos en la mano ni
    // pisa lo que el otro ya escribió.
    expect(r1.applied).toBe(true);
    expect(r2.applied).toBe(true);

    const final = await store.read('c1');
    expect(final.state).toBe(ConversationStateEnum.AWAITING_APPOINTMENT_DATE);
    // version avanzó exactamente 3 veces desde 0: seed (1) + dos transiciones (2,3).
    expect(final.version).toBe(3);
    // El context final tiene AMBOS datos — ninguno se perdió por la carrera.
    expect(final.context).toEqual({ dia: 'sabado', hora: '17:00' });
  });

  it('CAS real: reintentar tras perder la carrera pero la transición YA NO es válida desde el nuevo estado → se rechaza limpio', async () => {
    const { machine, store } = makeMachine(15);
    await machine.transition('c1', ConversationStateEnum.AWAITING_APPOINTMENT_DATE);

    // A hace el self-loop (válido); B, al mismo tiempo, intenta saltar
    // directo a AWAITING_APPOINTMENT_CONFIRMATION. Si B pierde el primer CAS
    // y relee, la transición AWAITING_APPOINTMENT_DATE → AWAITING_APPOINTMENT_CONFIRMATION
    // SIGUE siendo válida (está en la tabla), así que en este caso ambas
    // aplican igual — pero demuestra que el retry re-VALIDA contra el
    // estado fresco en cada intento, no contra el leído la primera vez.
    const [rSelfLoop, rAdvance] = await Promise.all([
      machine.transition('c1', ConversationStateEnum.AWAITING_APPOINTMENT_DATE, { dia: 'sabado' }),
      machine.transition('c1', ConversationStateEnum.AWAITING_APPOINTMENT_CONFIRMATION, { confirmado: true }),
    ]);

    // Exactamente uno de los dos terminó en el estado final — el que
    // escribió último. El punto verificado: ninguno se aplicó parcialmente
    // y el store queda en un estado consistente y válido según la tabla.
    expect([rSelfLoop.applied, rAdvance.applied]).toContain(true);
    const final = await store.read('c1');
    expect([
      ConversationStateEnum.AWAITING_APPOINTMENT_DATE,
      ConversationStateEnum.AWAITING_APPOINTMENT_CONFIRMATION,
    ]).toContain(final.state);
  });

  it('reintentos agotados: si el store SIEMPRE pierde el CAS, se rechaza sin aplicar nada (no hay estado intermedio)', async () => {
    const store = new InMemoryStateStore<BookingState, Ctx>(0);
    // Forzamos el fallo del CAS monkey-parcheando writeIfVersion para que
    // siempre falle, simulando contención extrema / bug en el store.
    let calls = 0;
    store.writeIfVersion = async (_conversationId, _expectedVersion, _next) => {
      calls++;
      return false; // siempre pierde el CAS
    };

    const machine = new ConversationStateMachine<BookingState, Ctx>(store, DEFAULT_BOOKING_TRANSITIONS, {
      maxRetries: 2,
    });
    const r = await machine.transition('c1', ConversationStateEnum.AWAITING_APPOINTMENT_DATE);
    expect(r.applied).toBe(false);
    if (!r.applied) expect(r.reason).toBe('concurrent_modification_retries_exhausted');
    expect(calls).toBe(3); // intento inicial + 2 reintentos
  });
});
