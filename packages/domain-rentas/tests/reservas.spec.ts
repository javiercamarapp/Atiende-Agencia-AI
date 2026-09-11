// Tests reales (no mocks) de la capa transaccional de aplicacion/reservas.ts, contra
// InMemoryRentasCalendarStore + InMemoryRentasTenancyEngine — el mismo motor que
// ejercita apps/api/tests/rentas-reservas.spec.ts vía HTTP real. Aquí se prueba
// directo contra `EjecutorTransaccional` (sin HTTP) para poder cubrir casos de
// dominio puro (multi-unidad, capa cruzada, min-stay) sin el peso de armar un
// request completo por caso.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryRentasCalendarStore } from "../src/calendar-store.ts";
import { InMemoryRentasTenancyEngine } from "../src/in-memory-tenancy-engine.ts";
import { cancelarOcupacion, crearBloqueo, crearReservaConfirmada, modificarFechasReserva } from "../src/aplicacion/reservas.ts";
import { RentasDomainError } from "../src/errors.ts";
import type { EjecutorTransaccional } from "../src/ejecutor.ts";
import type { UnidadRecord } from "../src/types.ts";

async function crearFixture() {
  const store = new InMemoryRentasCalendarStore();
  const engine = new InMemoryRentasTenancyEngine(store);
  let ejecutor!: EjecutorTransaccional;
  await engine.withAppSession({ userId: null }, async (session) => {
    ejecutor = session;
  });

  const organizationId = randomUUID();
  const propertyId = randomUUID();

  function crearUnidad(duracionMinimaNoches = 1): UnidadRecord {
    const unidad: UnidadRecord = { id: randomUUID(), organizationId, propertyId, duracionMinimaNoches };
    store.seedUnidad(unidad);
    return unidad;
  }

  const unidad = crearUnidad();

  return { store, ejecutor, organizationId, propertyId, unidad, crearUnidad };
}

async function contarOcupaciones(store: InMemoryRentasCalendarStore, unidadId: string): Promise<number> {
  return [...store.ocupaciones.values()].filter((o) => o.unidadId === unidadId).length;
}

describe("crearReservaConfirmada", () => {
  it("inserta una reserva confirmada sin conflicto", async () => {
    const { ejecutor, organizationId, propertyId, unidad } = await crearFixture();
    const resultado = await crearReservaConfirmada(ejecutor, {
      organizationId,
      propertyId,
      unidadId: unidad.id,
      rango: { inicio: "2026-06-01", fin: "2026-06-05" },
      estado: "confirmado",
      bloqueante: true,
    });
    expect(resultado.conflicto).toBeNull();
    expect(resultado.conflictosCapaCruzada).toHaveLength(0);
  });

  it("dos rangos adyacentes (checkout=check-in) se insertan ambos sin error (caso adversarial: estancias contiguas)", async () => {
    const { ejecutor, organizationId, propertyId, unidad, store } = await crearFixture();
    const a = await crearReservaConfirmada(ejecutor, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio: "2026-06-01", fin: "2026-06-05" }, estado: "confirmado", bloqueante: true });
    const b = await crearReservaConfirmada(ejecutor, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio: "2026-06-05", fin: "2026-06-08" }, estado: "confirmado", bloqueante: true });
    expect(a.conflicto).toBeNull();
    expect(b.conflicto).toBeNull();
    expect(await contarOcupaciones(store, unidad.id)).toBe(2);
  });

  it("overbooking: dos reservas confirmadas solapadas -> 23P01 capturado, conflicto registrado, NINGUNA se cancela (REQ-000)", async () => {
    const { ejecutor, organizationId, propertyId, unidad, store } = await crearFixture();
    const primera = await crearReservaConfirmada(ejecutor, {
      organizationId,
      propertyId,
      unidadId: unidad.id,
      rango: { inicio: "2026-07-01", fin: "2026-07-05" },
      estado: "confirmado",
      bloqueante: true,
      externalId: "airbnb-abc",
    });
    expect(primera.conflicto).toBeNull();

    const segunda = await crearReservaConfirmada(ejecutor, {
      organizationId,
      propertyId,
      unidadId: unidad.id,
      rango: { inicio: "2026-07-03", fin: "2026-07-07" },
      estado: "confirmado",
      bloqueante: true,
      externalId: "booking-xyz",
    });

    expect(segunda.conflicto).not.toBeNull();
    expect(segunda.conflicto!.tipo).toBe("overbooking_confirmado");
    expect(segunda.conflicto!.ocupacionExistenteId).toBe(primera.ocupacionId);

    // Ambas filas siguen existiendo -- ninguna reserva se cancela automáticamente.
    expect(await contarOcupaciones(store, unidad.id)).toBe(2);
    expect(store.getOcupacion(primera.ocupacionId)!.estado).toBe("confirmado");
    const segundaFila = store.getOcupacion(segunda.ocupacionId)!;
    expect(segundaFila.estado).toBe("conflicto_pendiente");
    expect(segundaFila.bloqueante).toBe(false);

    const conflictos = [...store.conflictos.values()].filter((c) => c.unidadId === unidad.id);
    expect(conflictos.map((c) => c.tipo)).toEqual(["overbooking_confirmado"]);
  });

  it("una solicitud pendiente no bloqueante puede coexistir con la reserva real sin rechazo (REQ-068)", async () => {
    const { ejecutor, organizationId, propertyId, unidad, store } = await crearFixture();
    const confirmada = await crearReservaConfirmada(ejecutor, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio: "2026-08-01", fin: "2026-08-05" }, estado: "confirmado", bloqueante: true });
    const inquiry = await crearReservaConfirmada(ejecutor, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio: "2026-08-02", fin: "2026-08-04" }, estado: "provisional", bloqueante: false });
    expect(confirmada.conflicto).toBeNull();
    expect(inquiry.conflicto).toBeNull();
    expect(await contarOcupaciones(store, unidad.id)).toBe(2);
  });

  it("rechaza estado='confirmado' con bloqueante=false (regla de negocio)", async () => {
    const { ejecutor, organizationId, propertyId, unidad } = await crearFixture();
    await expect(
      crearReservaConfirmada(ejecutor, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio: "2026-06-01", fin: "2026-06-02" }, estado: "confirmado", bloqueante: false }),
    ).rejects.toThrow(RentasDomainError);
  });

  it("rechaza una estancia por debajo de la duración mínima configurada en la unidad", async () => {
    const { ejecutor, organizationId, propertyId, crearUnidad } = await crearFixture();
    const unidad = crearUnidad(3);
    await expect(
      crearReservaConfirmada(ejecutor, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio: "2026-06-01", fin: "2026-06-02" }, estado: "confirmado", bloqueante: true }),
    ).rejects.toMatchObject({ code: "duracion_minima_no_alcanzada" });
  });

  it("multi-unidad: misma fecha, dos unidades distintas, sin conflicto (el advisory lock nunca bloquea entre unidades distintas)", async () => {
    const { ejecutor, organizationId, propertyId, unidad, crearUnidad } = await crearFixture();
    const otraUnidad = crearUnidad();
    const rango = { inicio: "2026-09-01", fin: "2026-09-05" } as const;
    const a = await crearReservaConfirmada(ejecutor, { organizationId, propertyId, unidadId: unidad.id, rango, estado: "confirmado", bloqueante: true });
    const b = await crearReservaConfirmada(ejecutor, { organizationId, propertyId, unidadId: otraUnidad.id, rango, estado: "confirmado", bloqueante: true });
    expect(a.conflicto).toBeNull();
    expect(b.conflicto).toBeNull();
  });

  it("regresión capa cruzada: un bloqueo de mantenimiento ya existente + reserva de canal que lo solapa SÍ genera conflicto capa_cruzada, y la reserva se acepta igual", async () => {
    const { ejecutor, organizationId, propertyId, unidad } = await crearFixture();
    await crearBloqueo(ejecutor, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio: "2026-09-01", fin: "2026-09-10" }, razon: "MANTENIMIENTO" });

    const resultado = await crearReservaConfirmada(ejecutor, {
      organizationId,
      propertyId,
      unidadId: unidad.id,
      rango: { inicio: "2026-09-03", fin: "2026-09-06" },
      estado: "confirmado",
      bloqueante: true,
      externalId: "reserva-solapa-mantenimiento",
    });

    // La reserva de canal se acepta SIEMPRE (REQ-000) -- el EXCLUDE ni siquiera
    // dispara (capa='bloqueo' nunca participa), así que `conflicto` sigue null.
    expect(resultado.conflicto).toBeNull();
    expect(resultado.conflictosCapaCruzada).toHaveLength(1);
    expect(resultado.conflictosCapaCruzada[0]!.tipo).toBe("capa_cruzada");
  });
});

describe("cancelarOcupacion", () => {
  it("cancela una reserva y no toca otras filas", async () => {
    const { ejecutor, organizationId, propertyId, unidad, store } = await crearFixture();
    const reserva = await crearReservaConfirmada(ejecutor, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio: "2026-06-01", fin: "2026-06-05" }, estado: "confirmado", bloqueante: true });
    const resultado = await cancelarOcupacion(ejecutor, reserva.ocupacionId);
    expect(resultado.estadoAnterior).toBe("confirmado");
    expect(store.getOcupacion(reserva.ocupacionId)!.estado).toBe("cancelado");
  });

  it("cancelar la reserva con un bloqueo de propietario solapado deja la noche ocupada por el bloqueo (H-018: nunca reabre por otra causa)", async () => {
    const { ejecutor, organizationId, propertyId, unidad, store } = await crearFixture();
    const reserva = await crearReservaConfirmada(ejecutor, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio: "2026-06-01", fin: "2026-06-05" }, estado: "confirmado", bloqueante: true });
    const bloqueo = await crearBloqueo(ejecutor, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio: "2026-06-01", fin: "2026-06-05" }, razon: "BLOQUEO_PROPIETARIO" });
    expect(bloqueo.conflictosCapaCruzada).toHaveLength(1);

    await cancelarOcupacion(ejecutor, reserva.ocupacionId);

    expect(store.getOcupacion(bloqueo.ocupacionId)!.estado).toBe("confirmado");
    expect(store.getOcupacion(reserva.ocupacionId)!.estado).toBe("cancelado");
  });

  it("no permite cancelar una ocupación ya cancelada", async () => {
    const { ejecutor, organizationId, propertyId, unidad } = await crearFixture();
    const reserva = await crearReservaConfirmada(ejecutor, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio: "2026-06-01", fin: "2026-06-05" }, estado: "confirmado", bloqueante: true });
    await cancelarOcupacion(ejecutor, reserva.ocupacionId);
    await expect(cancelarOcupacion(ejecutor, reserva.ocupacionId)).rejects.toMatchObject({ code: "transicion_no_permitida" });
  });

  it("lanza ocupacion_no_encontrada para un id inexistente", async () => {
    const { ejecutor } = await crearFixture();
    await expect(cancelarOcupacion(ejecutor, randomUUID())).rejects.toMatchObject({ code: "ocupacion_no_encontrada" });
  });
});

describe("modificarFechasReserva", () => {
  it("amplía una reserva sin conflicto", async () => {
    const { ejecutor, organizationId, propertyId, unidad } = await crearFixture();
    const reserva = await crearReservaConfirmada(ejecutor, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio: "2026-06-10", fin: "2026-06-15" }, estado: "confirmado", bloqueante: true });
    const resultado = await modificarFechasReserva(ejecutor, reserva.ocupacionId, { inicio: "2026-06-08", fin: "2026-06-17" });
    expect(resultado.conflicto).toBeNull();
    expect(resultado.rangoEfectivo).toEqual({ inicio: "2026-06-08", fin: "2026-06-17" });
  });

  it("caso adversarial: ampliar hacia noches ya ocupadas por otra reserva produce conflicto y NO mueve ninguna reserva", async () => {
    const { ejecutor, organizationId, propertyId, unidad, store } = await crearFixture();
    const reservaA = await crearReservaConfirmada(ejecutor, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio: "2026-06-01", fin: "2026-06-05" }, estado: "confirmado", bloqueante: true });
    const reservaB = await crearReservaConfirmada(ejecutor, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio: "2026-06-10", fin: "2026-06-15" }, estado: "confirmado", bloqueante: true });

    const resultado = await modificarFechasReserva(ejecutor, reservaB.ocupacionId, { inicio: "2026-06-04", fin: "2026-06-20" });

    expect(resultado.conflicto).not.toBeNull();
    expect(resultado.conflicto!.ocupacionExistenteId).toBe(reservaA.ocupacionId);
    // La reserva B queda exactamente en su rango original.
    expect(resultado.rangoEfectivo).toEqual({ inicio: "2026-06-10", fin: "2026-06-15" });
    const filaB = store.getOcupacion(reservaB.ocupacionId)!;
    expect(filaB.inicio).toBe("2026-06-10");
    expect(filaB.fin).toBe("2026-06-15");
    expect(filaB.estado).toBe("confirmado");
    expect(store.getOcupacion(reservaA.ocupacionId)!.estado).toBe("confirmado");
  });

  it("reduce y mueve una reserva a fechas totalmente distintas sin conflicto", async () => {
    const { ejecutor, organizationId, propertyId, unidad } = await crearFixture();
    const reserva = await crearReservaConfirmada(ejecutor, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio: "2026-06-10", fin: "2026-06-15" }, estado: "confirmado", bloqueante: true });
    const resultado = await modificarFechasReserva(ejecutor, reserva.ocupacionId, { inicio: "2026-07-01", fin: "2026-07-06" });
    expect(resultado.conflicto).toBeNull();
    expect(resultado.rangoEfectivo).toEqual({ inicio: "2026-07-01", fin: "2026-07-06" });
  });

  it("desplazar una reserva a noches contiguas de otra (checkout=check-in) es válido, no un conflicto", async () => {
    const { ejecutor, organizationId, propertyId, unidad } = await crearFixture();
    await crearReservaConfirmada(ejecutor, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio: "2026-06-01", fin: "2026-06-05" }, estado: "confirmado", bloqueante: true });
    const reservaB = await crearReservaConfirmada(ejecutor, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio: "2026-06-10", fin: "2026-06-12" }, estado: "confirmado", bloqueante: true });

    const resultado = await modificarFechasReserva(ejecutor, reservaB.ocupacionId, { inicio: "2026-06-05", fin: "2026-06-07" });
    expect(resultado.conflicto).toBeNull();
  });

  it("solo aplica a filas capa='reserva' -- rechaza intentar mover un bloqueo con este camino", async () => {
    const { ejecutor, organizationId, propertyId, unidad } = await crearFixture();
    const bloqueo = await crearBloqueo(ejecutor, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio: "2026-06-01", fin: "2026-06-05" }, razon: "BUFFER_LIMPIEZA" });
    await expect(modificarFechasReserva(ejecutor, bloqueo.ocupacionId, { inicio: "2026-06-02", fin: "2026-06-06" })).rejects.toMatchObject({ code: "reserva_no_directa" });
  });

  it("rechaza un rango inválido (inicio >= fin)", async () => {
    const { ejecutor, organizationId, propertyId, unidad } = await crearFixture();
    const reserva = await crearReservaConfirmada(ejecutor, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio: "2026-06-10", fin: "2026-06-15" }, estado: "confirmado", bloqueante: true });
    await expect(modificarFechasReserva(ejecutor, reserva.ocupacionId, { inicio: "2026-06-15", fin: "2026-06-10" })).rejects.toMatchObject({ code: "rango_invalido" });
  });
});

describe("concurrencia real: el advisory lock serializa dos intentos simultáneos sobre la MISMA unidad", () => {
  it("de dos crearReservaConfirmada disparadas en paralelo sobre el mismo rango, exactamente una gana y la otra queda en conflicto_pendiente -- nunca las dos confirmadas, nunca un deadlock", async () => {
    const { store, organizationId, propertyId, unidad } = await crearFixture();
    const engine = new InMemoryRentasTenancyEngine(store);

    async function intentar(externalId: string) {
      return engine.withAppSession({ userId: null }, (session) =>
        crearReservaConfirmada(session, {
          organizationId,
          propertyId,
          unidadId: unidad.id,
          rango: { inicio: "2026-10-01", fin: "2026-10-05" },
          estado: "confirmado",
          bloqueante: true,
          externalId,
        }),
      );
    }

    const [a, b] = await Promise.all([intentar("canal-a"), intentar("canal-b")]);

    const resultados = [a, b];
    const sinConflicto = resultados.filter((r) => r.conflicto === null);
    const conConflicto = resultados.filter((r) => r.conflicto !== null);
    expect(sinConflicto).toHaveLength(1);
    expect(conConflicto).toHaveLength(1);
    expect(conConflicto[0]!.conflicto!.ocupacionExistenteId).toBe(sinConflicto[0]!.ocupacionId);

    // Nunca dos filas bloqueantes activas solapadas -- el invariante central.
    const activas = [...store.ocupaciones.values()].filter((o) => o.unidadId === unidad.id && o.estado !== "cancelado" && o.bloqueante);
    expect(activas).toHaveLength(1);
  });
});
