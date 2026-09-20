// Tests reales (no mocks) de src/limpieza/aplicacion/tareas.ts contra el
// EjecutorTransaccional de ./helpers.ts — mismo criterio que tests/reservas.spec.ts:
// se prueba directo contra `EjecutorTransaccional` (sin HTTP) para cubrir los casos
// de dominio (buffer configurable, checklist bloqueante, alerta de stock, bloqueo de
// mantenimiento con confirmación humana) sin el peso de armar un request completo.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  asignarTarea,
  cancelarTareaPorCancelacionReserva,
  completarChecklistItem,
  completarTarea,
  confirmarBloqueoMantenimiento,
  crearTareaLimpiezaPorCheckout,
  crearTareaOperativaManual,
  procesarCheckoutsPendientes,
  registrarIncidencia,
  reprogramarTareaPorCambioReserva,
} from "../../src/limpieza/aplicacion/tareas.ts";
import { RentasDomainError } from "../../src/errors.ts";
import { PLANTILLA_CHECKLIST_LIMPIEZA_DEFECTO, PLANTILLA_CHECKLIST_MANTENIMIENTO_DEFECTO } from "../../src/limpieza/checklist.ts";
import { crearFixtureLimpieza } from "./helpers.ts";

describe("crearTareaLimpiezaPorCheckout", () => {
  it("crea la tarea con la plantilla de checklist de limpieza y SIN buffer cuando la property no tiene una fila de configuración (usa el default)", async () => {
    const { ejecutor, unidad, getTarea, listChecklistItems } = await crearFixtureLimpieza();

    const resultado = await crearTareaLimpiezaPorCheckout(ejecutor, { unidadId: unidad.id, ocupacionUnidadId: randomUUID(), fechaCheckout: "2026-06-05" });

    const tarea = getTarea(resultado.tareaId);
    expect(tarea?.tipo).toBe("limpieza");
    expect(tarea?.estado).toBe("pendiente");
    expect(tarea?.prioridad).toBe("media");
    expect(tarea?.programadaPara).toBe("2026-06-05");

    const items = listChecklistItems(resultado.tareaId);
    expect(items).toHaveLength(PLANTILLA_CHECKLIST_LIMPIEZA_DEFECTO.length);
    expect(items[0]?.descripcion).toBe(PLANTILLA_CHECKLIST_LIMPIEZA_DEFECTO[0]);
    expect(items.every((i) => !i.completado)).toBe(true);

    // Default de CONFIGURACION_OPERATIVA_DEFECTO: bufferLimpiezaNoches = 1 -> SÍ crea buffer.
    expect(resultado.bufferOcupacionId).not.toBeNull();
  });

  it("NO crea bloqueo BUFFER_LIMPIEZA cuando la property tiene bufferLimpiezaNoches = 0", async () => {
    const { ejecutor, propertyId, unidad, seedPropertyConfig } = await crearFixtureLimpieza();
    seedPropertyConfig(propertyId, { bufferLimpiezaNoches: 0, slaLimpiezaHoras: 4, slaMantenimientoHoras: 24 });

    const resultado = await crearTareaLimpiezaPorCheckout(ejecutor, { unidadId: unidad.id, ocupacionUnidadId: randomUUID(), fechaCheckout: "2026-06-05" });
    expect(resultado.bufferOcupacionId).toBeNull();
  });

  it("con buffer > 0, crea el bloqueo BUFFER_LIMPIEZA en [checkout, checkout+n) vinculado a la tarea", async () => {
    const { ejecutor, propertyId, unidad, seedPropertyConfig, getTarea } = await crearFixtureLimpieza();
    seedPropertyConfig(propertyId, { bufferLimpiezaNoches: 2, slaLimpiezaHoras: 4, slaMantenimientoHoras: 24 });

    const resultado = await crearTareaLimpiezaPorCheckout(ejecutor, { unidadId: unidad.id, ocupacionUnidadId: randomUUID(), fechaCheckout: "2026-06-05" });

    expect(resultado.bufferOcupacionId).not.toBeNull();
    expect(getTarea(resultado.tareaId)?.bufferOcupacionId).toBe(resultado.bufferOcupacionId);
  });

  it("lanza unidad_no_encontrada si la unidad no existe", async () => {
    const { ejecutor } = await crearFixtureLimpieza();
    await expect(crearTareaLimpiezaPorCheckout(ejecutor, { unidadId: randomUUID(), ocupacionUnidadId: randomUUID(), fechaCheckout: "2026-06-05" })).rejects.toMatchObject({
      code: "unidad_no_encontrada",
    });
  });
});

describe("reprogramarTareaPorCambioReserva / cancelarTareaPorCancelacionReserva", () => {
  it("reprogramarTareaPorCambioReserva mueve programada_para y recrea el buffer en la nueva fecha", async () => {
    const { ejecutor, propertyId, unidad, seedPropertyConfig, getTarea } = await crearFixtureLimpieza();
    seedPropertyConfig(propertyId, { bufferLimpiezaNoches: 1, slaLimpiezaHoras: 4, slaMantenimientoHoras: 24 });
    const ocupacionUnidadId = randomUUID();
    const creada = await crearTareaLimpiezaPorCheckout(ejecutor, { unidadId: unidad.id, ocupacionUnidadId, fechaCheckout: "2026-06-05" });
    const bufferOriginal = creada.bufferOcupacionId;

    const resultado = await reprogramarTareaPorCambioReserva(ejecutor, { ocupacionUnidadId, nuevaFechaCheckout: "2026-06-08" });

    expect(resultado?.tareaId).toBe(creada.tareaId);
    const tarea = getTarea(creada.tareaId);
    expect(tarea?.programadaPara).toBe("2026-06-08");
    expect(tarea?.bufferOcupacionId).not.toBe(bufferOriginal);
    expect(tarea?.bufferOcupacionId).not.toBeNull();
  });

  it("reprogramarTareaPorCambioReserva retorna null si no hay ninguna tarea activa vinculada (idempotente, defensa en profundidad)", async () => {
    const { ejecutor } = await crearFixtureLimpieza();
    const resultado = await reprogramarTareaPorCambioReserva(ejecutor, { ocupacionUnidadId: randomUUID(), nuevaFechaCheckout: "2026-06-08" });
    expect(resultado).toBeNull();
  });

  it("cancelarTareaPorCancelacionReserva marca la tarea cancelada y cancela su buffer, SIN tocar la reserva de origen", async () => {
    const { ejecutor, propertyId, unidad, seedPropertyConfig, getTarea } = await crearFixtureLimpieza();
    seedPropertyConfig(propertyId, { bufferLimpiezaNoches: 1, slaLimpiezaHoras: 4, slaMantenimientoHoras: 24 });
    const ocupacionUnidadId = randomUUID();
    const creada = await crearTareaLimpiezaPorCheckout(ejecutor, { unidadId: unidad.id, ocupacionUnidadId, fechaCheckout: "2026-06-05" });

    const resultado = await cancelarTareaPorCancelacionReserva(ejecutor, ocupacionUnidadId);

    expect(resultado?.tareaId).toBe(creada.tareaId);
    expect(getTarea(creada.tareaId)?.estado).toBe("cancelada");
  });
});

describe("procesarCheckoutsPendientes (reemplazo del consumidor de outbox_evento del origen)", () => {
  // `asOfDate` explícito en las 3 pruebas de abajo -- nunca `Date.now()` -- mismo
  // criterio que `hoteles-reservas.spec.ts::procesar-no-show`: un test que calcula
  // "ayer"/"en un año" contra el reloj real es SIEMPRE correcto de casualidad (no
  // ejercita el default `hoyFechaNegocio()`, ver la prueba dedicada de abajo para eso)
  // y, tras este fix, quedaría además expuesto a la ventana 18:00-23:59 CDMX donde el
  // día UTC y el día de negocio difieren.
  it("crea una tarea de limpieza para una reserva confirmada cuyo checkout ya llegó y aún no tiene tarea vinculada", async () => {
    const { ejecutor, unidad, seedOcupacionConfirmada, getTarea } = await crearFixtureLimpieza();
    const { id: ocupacionId } = seedOcupacionConfirmada({ unidadId: unidad.id, inicio: "2020-01-01", fin: "2025-06-01" });

    const resultado = await procesarCheckoutsPendientes(ejecutor, 50, "2025-06-02");

    expect(resultado.procesados).toBe(1);
    expect(resultado.tareasCreadas).toHaveLength(1);
    const tarea = getTarea(resultado.tareasCreadas[0]!);
    expect(tarea?.ocupacionUnidadId).toBe(ocupacionId);
  });

  it("es idempotente: una segunda pasada no crea una tarea duplicada para la misma reserva", async () => {
    const { ejecutor, unidad, seedOcupacionConfirmada } = await crearFixtureLimpieza();
    seedOcupacionConfirmada({ unidadId: unidad.id, inicio: "2020-01-01", fin: "2025-06-01" });

    const primera = await procesarCheckoutsPendientes(ejecutor, 50, "2025-06-02");
    const segunda = await procesarCheckoutsPendientes(ejecutor, 50, "2025-06-02");

    expect(primera.tareasCreadas).toHaveLength(1);
    expect(segunda.tareasCreadas).toHaveLength(0);
  });

  it("ignora una reserva cuyo checkout todavía no llega", async () => {
    const { ejecutor, unidad, seedOcupacionConfirmada } = await crearFixtureLimpieza();
    seedOcupacionConfirmada({ unidadId: unidad.id, inicio: "2020-01-01", fin: "2026-06-01" });

    const resultado = await procesarCheckoutsPendientes(ejecutor, 50, "2025-06-02");
    expect(resultado.tareasCreadas).toHaveLength(0);
  });

  // REQ-r6/f2-current-date-fecha-negocio: sin `asOfDate` explícito (mismo caso que el
  // cron real, `checkout-sweep-cron.ts`, siempre lo omite -- ver su comentario de
  // cabecera), el default debe ser el día de NEGOCIO (`hoyFechaNegocio()`), nunca el
  // día UTC crudo del proceso. A las 19:30 CDMX el día UTC YA es mañana -- si el sweep
  // usara ese día UTC, procesaría un checkout que en CDMX todavía no llega.
  it("sin asOfDate, a las 19:30 CDMX, NO procesa un checkout programado para MAÑANA (día de negocio), aunque el día UTC ya sea mañana", async () => {
    const { ejecutor, unidad, seedOcupacionConfirmada } = await crearFixtureLimpieza();
    // 2026-01-02T01:30:00Z = 2026-01-01T19:30:00 en America/Mexico_City (UTC-6 fijo).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T01:30:00.000Z"));
    try {
      seedOcupacionConfirmada({ unidadId: unidad.id, inicio: "2026-01-01", fin: "2026-01-02" });

      const resultado = await procesarCheckoutsPendientes(ejecutor);

      expect(resultado.tareasCreadas).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("crearTareaOperativaManual", () => {
  it("crea la tarea con ocupacion_unidad_id NULL, SIN ningún buffer de calendario, y con la plantilla de checklist de su tipo", async () => {
    const { ejecutor, unidad, getTarea, listChecklistItems } = await crearFixtureLimpieza();

    const resultado = await crearTareaOperativaManual(ejecutor, { unidadId: unidad.id, tipo: "mantenimiento", programadaPara: "2026-08-01" });

    const tarea = getTarea(resultado.tareaId);
    expect(tarea?.tipo).toBe("mantenimiento");
    expect(tarea?.estado).toBe("pendiente");
    expect(tarea?.prioridad).toBe("media");
    expect(tarea?.ocupacionUnidadId).toBeNull();
    expect(tarea?.bufferOcupacionId).toBeNull();

    const items = listChecklistItems(resultado.tareaId);
    expect(items.map((i) => i.descripcion)).toEqual([...PLANTILLA_CHECKLIST_MANTENIMIENTO_DEFECTO]);
  });

  it("usa 'media' como prioridad por defecto, y respeta la prioridad explícita cuando se provee", async () => {
    const { ejecutor, unidad, getTarea } = await crearFixtureLimpieza();

    const defecto = await crearTareaOperativaManual(ejecutor, { unidadId: unidad.id, tipo: "limpieza", programadaPara: "2026-08-01" });
    expect(getTarea(defecto.tareaId)?.prioridad).toBe("media");

    const urgente = await crearTareaOperativaManual(ejecutor, { unidadId: unidad.id, tipo: "limpieza", prioridad: "urgente", programadaPara: "2026-08-01" });
    expect(getTarea(urgente.tareaId)?.prioridad).toBe("urgente");
  });

  it("una tarea de tipo 'inspeccion' nace sin checklist (sin plantilla definida para ese tipo)", async () => {
    const { ejecutor, unidad, listChecklistItems } = await crearFixtureLimpieza();
    const resultado = await crearTareaOperativaManual(ejecutor, { unidadId: unidad.id, tipo: "inspeccion", programadaPara: "2026-08-01" });
    expect(listChecklistItems(resultado.tareaId)).toHaveLength(0);
  });

  it("lanza unidad_no_encontrada si la unidad no existe", async () => {
    const { ejecutor } = await crearFixtureLimpieza();
    await expect(crearTareaOperativaManual(ejecutor, { unidadId: randomUUID(), tipo: "limpieza", programadaPara: "2026-08-01" })).rejects.toMatchObject({
      code: "unidad_no_encontrada",
    });
  });
});

describe("asignarTarea", () => {
  it("pasa la tarea de 'pendiente' a 'asignada' y registra la notificación", async () => {
    const { ejecutor, unidad, getTarea, listNotificaciones } = await crearFixtureLimpieza();
    const { tareaId } = await crearTareaLimpiezaPorCheckout(ejecutor, { unidadId: unidad.id, ocupacionUnidadId: randomUUID(), fechaCheckout: "2026-06-05" });

    const staffId = randomUUID();
    await asignarTarea(ejecutor, { tareaId, asignadoA: staffId, esProveedorExterno: false });

    const tarea = getTarea(tareaId);
    expect(tarea?.estado).toBe("asignada");
    expect(tarea?.asignadoA).toBe(staffId);
    expect(listNotificaciones(tareaId).map((n) => n.evento)).toContain("asignada");
  });

  it("lanza tarea_no_encontrada si la tarea no existe", async () => {
    const { ejecutor } = await crearFixtureLimpieza();
    await expect(asignarTarea(ejecutor, { tareaId: randomUUID(), asignadoA: randomUUID(), esProveedorExterno: false })).rejects.toMatchObject({ code: "tarea_no_encontrada" });
  });
});

describe("completarChecklistItem / completarTarea (H-051/H-052)", () => {
  it("checklist incompleto: completarTarea la marca 'bloqueada' y lanza checklist_incompleto — nunca la deja 'completada'", async () => {
    const { ejecutor, unidad, getTarea } = await crearFixtureLimpieza();
    const { tareaId } = await crearTareaLimpiezaPorCheckout(ejecutor, { unidadId: unidad.id, ocupacionUnidadId: randomUUID(), fechaCheckout: "2026-06-05" });

    await expect(completarTarea(ejecutor, { tareaId })).rejects.toMatchObject({ code: "checklist_incompleto" });
    expect(getTarea(tareaId)?.estado).toBe("bloqueada");
  });

  it("checklist completo: completarTarea marca la tarea 'completada' y registra la notificación", async () => {
    const { ejecutor, unidad, getTarea, listChecklistItems, listNotificaciones } = await crearFixtureLimpieza();
    const { tareaId } = await crearTareaLimpiezaPorCheckout(ejecutor, { unidadId: unidad.id, ocupacionUnidadId: randomUUID(), fechaCheckout: "2026-06-05" });

    const staffId = randomUUID();
    for (const item of listChecklistItems(tareaId)) {
      await completarChecklistItem(ejecutor, { checklistItemId: item.id, completadoPor: staffId });
    }

    const resultado = await completarTarea(ejecutor, { tareaId });

    expect(resultado.alertasStockBajo).toHaveLength(0);
    expect(getTarea(tareaId)?.estado).toBe("completada");
    expect(getTarea(tareaId)?.completadaEn).not.toBeNull();
    expect(listNotificaciones(tareaId).map((n) => n.evento)).toContain("completada");
  });

  it("consume inventario configurado y detecta cuando cruza el umbral mínimo de stock (H-052)", async () => {
    const { ejecutor, unidad, seedItemInventario, getItemInventario, listMovimientosInventario, listChecklistItems } = await crearFixtureLimpieza();
    const { tareaId } = await crearTareaLimpiezaPorCheckout(ejecutor, { unidadId: unidad.id, ocupacionUnidadId: randomUUID(), fechaCheckout: "2026-06-05" });
    const { id: itemId } = seedItemInventario({ unidadId: unidad.id, nombre: "Toallas", categoria: "ropa_blanca", cantidadActual: 10, umbralMinimo: 5 });

    // Completa el checklist real de la tarea antes de poder completarla.
    for (const item of listChecklistItems(tareaId)) {
      await completarChecklistItem(ejecutor, { checklistItemId: item.id, completadoPor: randomUUID() });
    }

    const resultado = await completarTarea(ejecutor, { tareaId, consumos: [{ itemInventarioId: itemId, cantidad: 6 }] });

    expect(resultado.alertasStockBajo).toEqual([itemId]);
    expect(getItemInventario(itemId)?.cantidadActual).toBe(4);
    expect(listMovimientosInventario(itemId)).toHaveLength(1);
    expect(listMovimientosInventario(itemId)[0]?.cantidad).toBe(-6);
  });
});

describe("registrarIncidencia / confirmarBloqueoMantenimiento (H-055)", () => {
  it("severidad 'grave' con propuesta de rango queda en 'bloqueo_propuesto' (requiere confirmación humana)", async () => {
    const { ejecutor, unidad, getIncidencia } = await crearFixtureLimpieza();
    const reportadoPor = randomUUID();

    const resultado = await registrarIncidencia(ejecutor, {
      unidadId: unidad.id,
      severidad: "grave",
      titulo: "Fuga de agua en baño principal",
      reportadoPor,
      propuestaBloqueoRango: { inicio: "2026-07-01", fin: "2026-07-03" },
    });

    expect(resultado.requiereConfirmacionHumana).toBe(true);
    expect(getIncidencia(resultado.incidenciaId)?.estado).toBe("bloqueo_propuesto");
  });

  it("severidad 'leve'/'moderada' nunca requiere confirmación humana y queda 'abierta'", async () => {
    const { ejecutor, unidad, getIncidencia } = await crearFixtureLimpieza();
    const resultado = await registrarIncidencia(ejecutor, { unidadId: unidad.id, severidad: "leve", titulo: "Foco fundido", reportadoPor: randomUUID() });
    expect(resultado.requiereConfirmacionHumana).toBe(false);
    expect(getIncidencia(resultado.incidenciaId)?.estado).toBe("abierta");
  });

  it("confirmarBloqueoMantenimiento crea el bloqueo MANTENIMIENTO real vía crearBloqueo y marca 'bloqueo_confirmado'", async () => {
    const { ejecutor, unidad, getIncidencia } = await crearFixtureLimpieza();
    const registrada = await registrarIncidencia(ejecutor, {
      unidadId: unidad.id,
      severidad: "grave",
      titulo: "Fuga de agua",
      reportadoPor: randomUUID(),
      propuestaBloqueoRango: { inicio: "2026-07-01", fin: "2026-07-03" },
    });

    const confirmadoPor = randomUUID();
    const resultado = await confirmarBloqueoMantenimiento(ejecutor, { incidenciaId: registrada.incidenciaId, confirmadoPor });

    expect(resultado.ocupacionId).toBeTruthy();
    const incidencia = getIncidencia(registrada.incidenciaId);
    expect(incidencia?.estado).toBe("bloqueo_confirmado");
    expect(incidencia?.bloqueoOcupacionId).toBe(resultado.ocupacionId);
    expect(incidencia?.confirmadoPor).toBe(confirmadoPor);
  });

  it("rechaza confirmar el bloqueo de una incidencia que no es 'grave'", async () => {
    const { ejecutor, unidad } = await crearFixtureLimpieza();
    const registrada = await registrarIncidencia(ejecutor, { unidadId: unidad.id, severidad: "moderada", titulo: "Aire acondicionado ruidoso", reportadoPor: randomUUID() });

    await expect(confirmarBloqueoMantenimiento(ejecutor, { incidenciaId: registrada.incidenciaId, confirmadoPor: randomUUID() })).rejects.toMatchObject({
      code: "bloqueo_mantenimiento_no_aplicable",
    });
  });

  it("rechaza confirmar dos veces la misma incidencia", async () => {
    const { ejecutor, unidad } = await crearFixtureLimpieza();
    const registrada = await registrarIncidencia(ejecutor, {
      unidadId: unidad.id,
      severidad: "grave",
      titulo: "Fuga de agua",
      reportadoPor: randomUUID(),
      propuestaBloqueoRango: { inicio: "2026-07-01", fin: "2026-07-03" },
    });
    await confirmarBloqueoMantenimiento(ejecutor, { incidenciaId: registrada.incidenciaId, confirmadoPor: randomUUID() });

    await expect(confirmarBloqueoMantenimiento(ejecutor, { incidenciaId: registrada.incidenciaId, confirmadoPor: randomUUID() })).rejects.toMatchObject({
      code: "bloqueo_mantenimiento_ya_confirmado",
    });
  });

  it("rechaza confirmar sin ningún rango propuesto ni provisto explícitamente", async () => {
    const { ejecutor, unidad } = await crearFixtureLimpieza();
    const registrada = await registrarIncidencia(ejecutor, { unidadId: unidad.id, severidad: "grave", titulo: "Fuga de agua", reportadoPor: randomUUID() });

    await expect(confirmarBloqueoMantenimiento(ejecutor, { incidenciaId: registrada.incidenciaId, confirmadoPor: randomUUID() })).rejects.toMatchObject({
      code: "bloqueo_mantenimiento_sin_rango",
    });
  });

  it("registrarIncidencia lanza unidad_no_encontrada si la unidad no existe", async () => {
    const { ejecutor } = await crearFixtureLimpieza();
    await expect(registrarIncidencia(ejecutor, { unidadId: randomUUID(), severidad: "leve", titulo: "x", reportadoPor: randomUUID() })).rejects.toMatchObject({
      code: "unidad_no_encontrada",
    });
  });

  it("confirmarBloqueoMantenimiento lanza incidencia_no_encontrada si el id no existe", async () => {
    const { ejecutor } = await crearFixtureLimpieza();
    await expect(confirmarBloqueoMantenimiento(ejecutor, { incidenciaId: randomUUID(), confirmadoPor: randomUUID() })).rejects.toMatchObject({ code: "incidencia_no_encontrada" });
  });
});

// Confirma que RentasDomainError efectivamente trae el código en `.code` (sanity
// check del helper `.rejects.toMatchObject`, mismo criterio que tests/reservas.spec.ts
// no repite pero que aquí vale la pena dejar explícito por lo nuevos que son estos
// códigos).
describe("RentasDomainError", () => {
  it("tiene .code y .message", () => {
    const err = new RentasDomainError("checklist_incompleto", "mensaje");
    expect(err.code).toBe("checklist_incompleto");
    expect(err.message).toBe("mensaje");
    expect(err).toBeInstanceOf(Error);
  });
});
