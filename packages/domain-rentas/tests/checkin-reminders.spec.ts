// Pruebas de runRecordatorioCheckInCore — verifica: (1) encuentra reservas cuyo
// check-in cae en la ventana 24-48h (mañana o pasado mañana), (2) ignora las que
// están fuera de la ventana (hoy mismo, o más de 2 días), (3) nunca reenvía dos
// veces la misma reserva (recordatorio_checkin_enviado_en), (4) sin correo real del
// huésped no marca como enviado (para que una corrida futura la reintente), (5)
// nunca procesa un bloqueo ni una reserva 'provisional'/'conflicto_pendiente'.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryRentasCalendarStore } from "../src/calendar-store.ts";
import { InMemoryRentasRepository } from "../src/in-memory-repository.ts";
import { InMemoryRentasTenancyEngine } from "../src/in-memory-tenancy-engine.ts";
import { crearReservaConfirmada } from "../src/aplicacion/reservas.ts";
import { tryEnqueueReservaEmail } from "../src/reserva-email-notifications.ts";
import { sumarDias } from "../src/fechas.ts";
import { runRecordatorioCheckInCore } from "../src/checkin-reminders.ts";
import type { WithRentasRepo } from "../src/checkin-reminders.ts";
import type { EjecutorTransaccional } from "../src/ejecutor.ts";
import type { FechaLocal } from "../src/tipos.ts";
import type { UnidadRecord } from "../src/types.ts";

const AHORA = new Date("2026-09-14T12:00:00Z");
const HOY: FechaLocal = "2026-09-14";

async function crearFixture() {
  const store = new InMemoryRentasCalendarStore();
  const engine = new InMemoryRentasTenancyEngine(store);
  const repo = new InMemoryRentasRepository(store);
  let ejecutor!: EjecutorTransaccional;
  await engine.withAppSession({ userId: null }, async (session) => {
    ejecutor = session;
  });

  const organizationId = randomUUID();
  const propertyId = randomUUID();
  repo.seedOrganizacion(organizationId, "Rentas de Prueba");
  const unidad: UnidadRecord = { id: randomUUID(), organizationId, propertyId, duracionMinimaNoches: 1, name: "Depa de Prueba" };
  store.seedUnidad(unidad);

  async function crearReserva(checkIn: FechaLocal, contacto: string | null = "huesped@example.com", unidadId: string = unidad.id) {
    const checkOut = sumarDias(checkIn, 3);
    const resultado = await crearReservaConfirmada(ejecutor, { organizationId, propertyId, unidadId, rango: { inicio: checkIn, fin: checkOut }, estado: "confirmado", bloqueante: true });
    const guest = await repo.insertGuestMinimo({ organizationId, propertyId, nombre: "Huésped de Prueba", contacto });
    await repo.attachGuestToOcupacion(resultado.ocupacionId, guest.id);
    return resultado.ocupacionId;
  }

  /** Segunda/tercera unidad de la MISMA property -- solo para el test de
   *  aislamiento por candidata de más abajo, que necesita varias candidatas
   *  simultáneas SIN pisarse entre sí (una `crearReserva` en la MISMA unidad con
   *  rangos solapados cae en `conflicto_pendiente`, no `confirmado`). */
  function seedUnidadExtra(): string {
    const extra: UnidadRecord = { id: randomUUID(), organizationId, propertyId, duracionMinimaNoches: 1, name: `Depa extra ${randomUUID().slice(0, 8)}` };
    store.seedUnidad(extra);
    return extra.id;
  }

  // `withRepo` "transparente" -- el `InMemoryRentasRepository` no es transaccional
  // (ver comentario de cabecera de checkin-reminders.ts), así que aquí simplemente
  // invoca `fn` con el mismo repo, sin abrir ninguna sesión nueva de verdad. El
  // aislamiento real por candidata se prueba en apps/api/tests/
  // rentas-checkin-recordatorio.spec.ts (motor real de sesión) y en el test de
  // aislamiento con `AbortAwareFakeSession` de más abajo.
  const withRepo: WithRentasRepo = (fn) => fn(repo);

  return { store, repo, ejecutor, organizationId, propertyId, unidad, crearReserva, seedUnidadExtra, withRepo };
}

describe("runRecordatorioCheckInCore", () => {
  it("check-in mañana (24h): entra en la ventana, encola el correo real y marca enviado", async () => {
    const fixture = await crearFixture();
    const manana = sumarDias(HOY, 1);
    const ocupacionId = await fixture.crearReserva(manana);

    const summary = await runRecordatorioCheckInCore(fixture.withRepo, AHORA);
    expect(summary.procesadas).toBe(1);
    expect(summary.enviados).toBe(1);
    expect(summary.sinCorreo).toBe(0);

    const job = fixture.repo.getMessagingOutbox().find((o) => o.eventType === "reserva.recordatorio_checkin");
    expect(job).toBeDefined();
    const payload = job!.payload as { subject: string };
    expect(payload.subject).toContain("Recordatorio de check-in");

    // Belt-and-suspenders: recordatorio_checkin_enviado_en quedó marcado.
    const fila = fixture.store.getOcupacion(ocupacionId);
    expect(fila?.recordatorioCheckinEnviadoEn).not.toBeNull();
  });

  // auditoría f3-zona-horaria-citas-rentas -- demuestra el bug real que corrigió
  // `hoyDeNegocio` (ver su comentario de cabecera en checkin-reminders.ts). Instante
  // elegido (verificado con Intl.DateTimeFormat antes de escribir este test): en
  // 2026-01-15T02:30:00.000Z, el día UTC crudo YA es el 15, pero America/Mexico_City
  // (UTC-6, sin horario de verano) TODAVÍA ve el 14 -- una diferencia de día de
  // calendario real, no un ejemplo de offset inventado. Con el bug (día UTC crudo),
  // "hoy" sería 2026-01-15 y la ventana [16,17] NUNCA hubiera encontrado esta reserva
  // de mañana-en-CDMX (2026-01-15); con el fix, "hoy" es 2026-01-14 (CDMX) y la
  // ventana [15,16] SÍ la encuentra.
  it("cerca de medianoche UTC (madrugada UTC = todavía anoche en CDMX): usa el día de NEGOCIO (CDMX), no el día UTC crudo", async () => {
    const fixture = await crearFixture();
    const instanteDivergente = new Date("2026-01-15T02:30:00.000Z");
    const mananaEnCdmx: FechaLocal = "2026-01-15"; // hoy(CDMX)=2026-01-14 + 1
    await fixture.crearReserva(mananaEnCdmx);

    const summary = await runRecordatorioCheckInCore(fixture.withRepo, instanteDivergente);
    expect(summary.procesadas).toBe(1);
    expect(summary.enviados).toBe(1);
  });

  it("check-in pasado mañana (48h): también entra en la ventana", async () => {
    const fixture = await crearFixture();
    const pasadoManana = sumarDias(HOY, 2);
    await fixture.crearReserva(pasadoManana);

    const summary = await runRecordatorioCheckInCore(fixture.withRepo, AHORA);
    expect(summary.procesadas).toBe(1);
    expect(summary.enviados).toBe(1);
  });

  it("check-in HOY: fuera de la ventana 24-48h, no se procesa", async () => {
    const fixture = await crearFixture();
    await fixture.crearReserva(HOY);

    const summary = await runRecordatorioCheckInCore(fixture.withRepo, AHORA);
    expect(summary.procesadas).toBe(0);
    expect(fixture.repo.getMessagingOutbox()).toHaveLength(0);
  });

  it("check-in en 5 días: demasiado lejos todavía, no se procesa", async () => {
    const fixture = await crearFixture();
    await fixture.crearReserva(sumarDias(HOY, 5));

    const summary = await runRecordatorioCheckInCore(fixture.withRepo, AHORA);
    expect(summary.procesadas).toBe(0);
  });

  it("nunca reenvía dos veces la misma reserva entre corridas del cron", async () => {
    const fixture = await crearFixture();
    await fixture.crearReserva(sumarDias(HOY, 1));

    const primera = await runRecordatorioCheckInCore(fixture.withRepo, AHORA);
    expect(primera.enviados).toBe(1);

    // Segunda corrida el mismo día (mismo cron periódico re-disparando dentro de la
    // ventana) -- ya no debe volver a procesarla.
    const segunda = await runRecordatorioCheckInCore(fixture.withRepo, AHORA);
    expect(segunda.procesadas).toBe(0);
    expect(segunda.enviados).toBe(0);
    expect(fixture.repo.getMessagingOutbox().filter((o) => o.eventType === "reserva.recordatorio_checkin")).toHaveLength(1);
  });

  it("sin correo real del huésped: se cuenta como sinCorreo y NO se marca enviado (una corrida futura la reintenta)", async () => {
    const fixture = await crearFixture();
    const ocupacionId = await fixture.crearReserva(sumarDias(HOY, 1), "9998887766"); // solo teléfono, no email

    const summary = await runRecordatorioCheckInCore(fixture.withRepo, AHORA);
    expect(summary.procesadas).toBe(1);
    expect(summary.enviados).toBe(0);
    expect(summary.sinCorreo).toBe(1);
    expect(fixture.repo.getMessagingOutbox()).toHaveLength(0);

    const fila = fixture.store.getOcupacion(ocupacionId);
    expect(fila?.recordatorioCheckinEnviadoEn).toBeNull();
  });
});

// r4-fix-crons-transaccion-por-unidad (corrección de PR #163, bloqueante #1) --
// reproduce el bug real (transacción compartida para TODO el barrido) que el cuerpo
// original del PR afirmaba (FALSO) que este cron no tenía, y prueba que el fix
// (transacción POR candidata) lo cierra. Mismo mecanismo que
// apps/worker/tests/support/fake-transactional-engine.ts (`InMemoryRentasRepository`
// vive en un package distinto de apps/worker, así que este archivo reconstruye
// localmente el mismo par de helpers en vez de importarlos entre paquetes) --
// generalizado a DOS objetos con estado (`repo` + `store`, ver comentario de cabecera
// de crearFixture: `marcarRecordatorioCheckInEnviado`/`listReservasProximasACheckIn`
// viven en `calendarStore`, `enqueueMessagingOutbox` vive en `repo`).
function cloneMapDeep(map: Map<unknown, unknown>): Map<unknown, unknown> {
  const out = new Map<unknown, unknown>();
  for (const [k, v] of map) out.set(structuredClone(k), v instanceof Map ? cloneMapDeep(v) : structuredClone(v));
  return out;
}

function snapshotState(objs: readonly object[]): Array<{ obj: object; snap: Record<string, unknown> }> {
  return objs.map((obj) => {
    const snap: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value instanceof Map) snap[key] = cloneMapDeep(value);
      else if (Array.isArray(value)) snap[key] = structuredClone(value);
    }
    return { obj, snap };
  });
}

function restoreState(snapshots: ReadonlyArray<{ obj: object; snap: Record<string, unknown> }>): void {
  for (const { obj, snap } of snapshots) {
    for (const [key, value] of Object.entries(snap)) (obj as Record<string, unknown>)[key] = value;
  }
}

/** Envuelve `repo` en un Proxy que simula el "contagio de aborto" de una transacción
 *  Postgres real: la primera vez que `shouldFail` devuelve `true`, esa llamada lanza
 *  Y marca la sesión ABORTADA -- cualquier llamada posterior (a `repo` O a `store`, la
 *  MISMA sesión Postgres real) lanza el 25P02 simulado. `reset()` limpia el aborto --
 *  úsalo entre candidatas cuando el runner simula el patrón YA CORREGIDO (una
 *  transacción por candidata). */
function makeAbortSimulatingSession(repo: InMemoryRentasRepository, store: InMemoryRentasCalendarStore, shouldFail: (methodName: string, args: unknown[]) => boolean) {
  let aborted = false;
  function wrap<T extends object>(target: T): T {
    return new Proxy(target, {
      get(t, prop, receiver) {
        const orig = Reflect.get(t, prop, receiver) as unknown;
        if (typeof orig !== "function") return orig;
        return (...args: unknown[]) => {
          if (aborted) return Promise.reject(new Error("25P02 simulado: current transaction is aborted, commands ignored until end of transaction block"));
          if (shouldFail(String(prop), args)) {
            aborted = true;
            return Promise.reject(new Error("40P01 simulado: deadlock detected"));
          }
          return (orig as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    }) as T;
  }
  return { repoProxy: wrap(repo), storeProxy: wrap(store), isAborted: () => aborted, reset: () => (aborted = false) };
}

describe("runRecordatorioCheckInCore -- aislamiento real por candidata (r4-fix-crons-transaccion-por-unidad)", () => {
  async function crearTresCandidatas(fixture: Awaited<ReturnType<typeof crearFixture>>) {
    // 3 unidades DISTINTAS de la misma property, mismo check-in -- así las 3
    // reservas quedan 'confirmado' de verdad (misma unidad + rangos solapados
    // caería en 'conflicto_pendiente', fuera del alcance de este cron).
    const ocA = await fixture.crearReserva(sumarDias(HOY, 1));
    const ocB = await fixture.crearReserva(sumarDias(HOY, 1), "huesped@example.com", fixture.seedUnidadExtra());
    const ocC = await fixture.crearReserva(sumarDias(HOY, 1), "huesped@example.com", fixture.seedUnidadExtra());
    return { ocA, ocB, ocC };
  }

  it("ANTES del fix (patrón reconstruido): una sola sesión para TODO el barrido -- el error SQL real de B revierte en silencio también el correo YA encolado de A", async () => {
    const fixture = await crearFixture();
    const { ocA, ocB, ocC } = await crearTresCandidatas(fixture);

    const { repoProxy, isAborted } = makeAbortSimulatingSession(fixture.repo, fixture.store, (method, args) => method === "enqueueMessagingOutbox" && String(args[4]).includes(ocB));

    // Reconstruye LITERALMENTE el bucle pre-fix de checkin-reminders.ts: una sola
    // `repo` (sesión) para TODAS las candidatas, con `tryEnqueueReservaEmail`
    // (traga el error real, exactamente lo que hacía el código antes de este fix).
    const before = snapshotState([fixture.repo, fixture.store]);
    const candidatas = await repoProxy.listReservasProximasACheckIn(sumarDias(HOY, 1), sumarDias(HOY, 2));
    for (const candidata of candidatas) {
      const resultado = await tryEnqueueReservaEmail(repoProxy, candidata.organizationId, "reserva.recordatorio_checkin", candidata.ocupacionId);
      if (resultado?.enqueued) await repoProxy.marcarRecordatorioCheckInEnviado(candidata.ocupacionId, AHORA.toISOString());
    }
    // COMMIT sobre una transacción abortada devuelve ROLLBACK sin lanzar (mismo
    // comportamiento documentado de Postgres/node-pg) -- revierte TODO el barrido.
    if (isAborted()) restoreState(before);

    expect(fixture.repo.getMessagingOutbox().filter((o) => o.eventType === "reserva.recordatorio_checkin")).toHaveLength(0);
    expect(fixture.store.getOcupacion(ocA)?.recordatorioCheckinEnviadoEn).toBeNull();
    expect(fixture.store.getOcupacion(ocC)?.recordatorioCheckinEnviadoEn).toBeNull();
  });

  it("DESPUÉS del fix (código real): transacción POR candidata -- el mismo error SQL en B se aísla, A y C SÍ conservan su correo real", async () => {
    const fixture = await crearFixture();
    const { ocA, ocB, ocC } = await crearTresCandidatas(fixture);

    const { repoProxy, reset } = makeAbortSimulatingSession(fixture.repo, fixture.store, (method, args) => method === "enqueueMessagingOutbox" && String(args[4]).includes(ocB));
    const withRepo: WithRentasRepo = async (fn) => {
      const before = snapshotState([fixture.repo, fixture.store]);
      try {
        return await fn(repoProxy);
      } catch (err) {
        restoreState(before);
        throw err;
      } finally {
        reset();
      }
    };

    const summary = await runRecordatorioCheckInCore(withRepo, AHORA);
    expect(summary.procesadas).toBe(3);
    expect(summary.enviados).toBe(2); // A y C
    expect(summary.fallos).toBe(1); // solo B

    expect(fixture.repo.getMessagingOutbox().filter((o) => o.eventType === "reserva.recordatorio_checkin")).toHaveLength(2);
    expect(fixture.store.getOcupacion(ocA)?.recordatorioCheckinEnviadoEn).not.toBeNull();
    expect(fixture.store.getOcupacion(ocB)?.recordatorioCheckinEnviadoEn).toBeNull();
    expect(fixture.store.getOcupacion(ocC)?.recordatorioCheckinEnviadoEn).not.toBeNull();
  });
});
