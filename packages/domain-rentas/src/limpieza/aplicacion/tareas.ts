// Capa de aplicación transaccional de limpieza/mantenimiento (Fase 8, BACKLOG E08,
// H-049 a H-055 del origen) — port de
// rentas/packages/domain/src/limpieza/aplicacion/tareas.ts. Mismo patrón exacto que
// ../../aplicacion/reservas.ts: cada función abre/cierra su propia transacción sobre
// un `EjecutorTransaccional` ya conectado, nunca importa nada de infraestructura
// concreta (structural typing).
//
// Diferencias deliberadas frente al port literal (mismo criterio documentado en la
// cabecera de ../../aplicacion/reservas.ts):
//  1. Tablas calificadas por schema (`rentas.*`) e incluyen `organization_id`/
//     `property_id` directos en `tarea_operativa`/`item_inventario`/
//     `incidencia_mantenimiento` (top-level, mismo criterio que
//     `rentas.conversacion` de ../../mensajeria/*: evita un join extra en cada
//     policy de RLS) — el origen (mono-vertical) no los necesitaba.
//  2. `throw new Error(string)` genérico -> `RentasDomainError` con código (ver
//     ../../errors.ts) para que la ruta HTTP distinga el código sin parsear el
//     mensaje.
//  3. La configuración operativa por property (buffer/SLA) vive en columnas nuevas
//     de `rentas.property_config` (migración 010), NUNCA en una tabla propia — el
//     origen sí tenía una tabla dedicada (`configuracion_operativa_propiedad`)
//     porque no existía ya una fila de configuración por property; aquí sí existe
//     desde la Fase 1.
//  4. `propuesta_bloqueo_rango` del origen (una columna `daterange`) se separa en
//     dos columnas `date` (`propuesta_bloqueo_inicio`/`_fin`) — la tabla no
//     participa de ningún EXCLUDE de Postgres (a diferencia de `rentas.ocupacion`),
//     así que no hay ninguna razón operativa para pagar la complejidad de parsear
//     un `daterange` aquí.
//  5. EL CAMBIO MÁS IMPORTANTE — `procesarEventosCheckoutPendientes` del origen
//     consumía `outbox_evento` (tabla de seguimiento propia del Lote 5 del origen).
//     `../../aplicacion/reservas.ts` de ESTE monorepo NO escribe a ningún
//     `outbox_evento` (ver su comentario de cabecera, punto 3: "sin consumidor en
//     esta fase, tabla fuera del esquema mapeado") — no hay ningún evento que
//     consumir. `procesarCheckoutsPendientes` (abajo) reemplaza ese consumidor por
//     un POLL idempotente directo sobre `rentas.ocupacion` (reservas confirmadas
//     cuyo checkout ya llegó y que todavía no tienen una tarea de limpieza
//     vinculada), disparado explícitamente — mismo patrón exacto que
//     `apps/api/src/routes/verticals/rentas/ical-sync-cron.ts` (cron interno,
//     guardado por `x-atiende-internal-secret`, nunca un trigger de base de datos).
//     La reprogramación/cancelación de la tarea vinculada al modificar/cancelar una
//     reserva SÍ se conserva como una llamada síncrona explícita, pero ahora desde
//     la RUTA HTTP de reservas (después de que `modificarFechasReserva`/
//     `cancelarOcupacion` ya hicieron commit) — ver
//     apps/api/src/routes/verticals/rentas/reservas.ts — en vez de un consumidor de
//     eventos, porque aquí no existe ningún bus de eventos del que colgarse.
import { bloquearUnidadEnTransaccion, type EjecutorTransaccional } from "../../ejecutor.ts";
import { cancelarOcupacion, crearBloqueo } from "../../aplicacion/reservas.ts";
import { RentasDomainError } from "../../errors.ts";
import { calcularRangoBuffer } from "../buffer.ts";
import { checklistCompleto, plantillaChecklistPorTipo } from "../checklist.ts";
import { requiereConfirmacionHumanaParaBloqueo } from "../incidencias.ts";
import { aplicarConsumo } from "../inventario.ts";
import { calcularVencimientoSla } from "../sla.ts";
import { CONFIGURACION_OPERATIVA_DEFECTO } from "../tipos.ts";
import type { ConsumoInventario, PrioridadTareaOperativa, SeveridadIncidencia, TipoTareaOperativa } from "../tipos.ts";

interface ConfiguracionResuelta {
  organizationId: string;
  propertyId: string;
  bufferLimpiezaNoches: number;
  slaLimpiezaHoras: number;
  slaMantenimientoHoras: number;
}

async function obtenerConfiguracion(ejecutor: EjecutorTransaccional, unidadId: string): Promise<ConfiguracionResuelta> {
  const unidad = await ejecutor.query<{ organization_id: string; property_id: string }>(`SELECT organization_id, property_id FROM rentas.unidad WHERE id = $1`, [unidadId]);
  if (unidad.rows.length === 0) throw new RentasDomainError("unidad_no_encontrada", `rentas.unidad ${unidadId} no existe`);
  const { organization_id: organizationId, property_id: propertyId } = unidad.rows[0]!;

  const config = await ejecutor.query<{ buffer_limpieza_noches: number; sla_limpieza_horas: number; sla_mantenimiento_horas: number }>(
    `SELECT buffer_limpieza_noches, sla_limpieza_horas, sla_mantenimiento_horas FROM rentas.property_config WHERE property_id = $1`,
    [propertyId],
  );
  if (config.rows.length === 0) {
    return { organizationId, propertyId, ...CONFIGURACION_OPERATIVA_DEFECTO };
  }
  const fila = config.rows[0]!;
  return {
    organizationId,
    propertyId,
    bufferLimpiezaNoches: fila.buffer_limpieza_noches,
    slaLimpiezaHoras: fila.sla_limpieza_horas,
    slaMantenimientoHoras: fila.sla_mantenimiento_horas,
  };
}

async function insertarChecklistPlantilla(ejecutor: EjecutorTransaccional, tareaId: string, tipo: TipoTareaOperativa): Promise<void> {
  const plantilla = plantillaChecklistPorTipo(tipo);
  for (let i = 0; i < plantilla.length; i += 1) {
    await ejecutor.query(`INSERT INTO rentas.checklist_item_tarea (tarea_id, descripcion, orden) VALUES ($1, $2, $3)`, [tareaId, plantilla[i], i]);
  }
}

// ---------------------------------------------------------------------------
// H-049/H-050: creación de tarea de limpieza + buffer al confirmarse el checkout
// ---------------------------------------------------------------------------

export interface ResultadoCrearTareaCheckout {
  readonly tareaId: string;
  readonly bufferOcupacionId: string | null;
}

/** Crea la tarea de limpieza vinculada a una reserva (H-049) y, si la property tiene
 * buffer configurado (>0 noches), el bloqueo `BUFFER_LIMPIEZA` real de calendario
 * (H-050) — vía `crearBloqueo`, la MISMA función transaccional de
 * `../../aplicacion/reservas.ts`, nunca reimplementada aquí. */
export async function crearTareaLimpiezaPorCheckout(
  ejecutor: EjecutorTransaccional,
  entrada: { unidadId: string; ocupacionUnidadId: string; fechaCheckout: string },
): Promise<ResultadoCrearTareaCheckout> {
  const config = await obtenerConfiguracion(ejecutor, entrada.unidadId);

  await ejecutor.exec("BEGIN");
  let tareaId: string;
  try {
    await bloquearUnidadEnTransaccion(ejecutor, entrada.unidadId);

    const prioridad: PrioridadTareaOperativa = "media";
    const creadaEn = new Date().toISOString();
    const slaVenceEn = calcularVencimientoSla(creadaEn, "limpieza", prioridad, config);

    const insertado = await ejecutor.query<{ id: string }>(
      `INSERT INTO rentas.tarea_operativa
         (organization_id, property_id, unidad_id, ocupacion_unidad_id, tipo, estado, prioridad, programada_para, sla_vence_en)
       VALUES ($1, $2, $3, $4, 'limpieza', 'pendiente', $5, $6, $7)
       RETURNING id`,
      [config.organizationId, config.propertyId, entrada.unidadId, entrada.ocupacionUnidadId, prioridad, entrada.fechaCheckout, slaVenceEn],
    );
    tareaId = insertado.rows[0]!.id;
    await insertarChecklistPlantilla(ejecutor, tareaId, "limpieza");

    await ejecutor.exec("COMMIT");
  } catch (error) {
    await ejecutor.exec("ROLLBACK");
    throw error;
  }

  // `crearBloqueo` gestiona su PROPIA transacción (BEGIN/COMMIT interno) — se
  // invoca DESPUÉS del COMMIT de arriba, nunca anidada dentro de la transacción de
  // la tarea (mismo criterio documentado en el origen: `EjecutorTransaccional` no
  // soporta transacciones anidadas reales).
  const rangoBuffer = calcularRangoBuffer(entrada.fechaCheckout, config.bufferLimpiezaNoches);
  let bufferOcupacionId: string | null = null;
  if (rangoBuffer) {
    const bufferResultado = await crearBloqueo(ejecutor, {
      organizationId: config.organizationId,
      propertyId: config.propertyId,
      unidadId: entrada.unidadId,
      rango: rangoBuffer,
      razon: "BUFFER_LIMPIEZA",
    });
    bufferOcupacionId = bufferResultado.ocupacionId;
    await ejecutor.query(`UPDATE rentas.tarea_operativa SET buffer_ocupacion_id = $1 WHERE id = $2`, [bufferOcupacionId, tareaId]);
  }

  return { tareaId, bufferOcupacionId };
}

/** H-049: reprograma la tarea vinculada cuando la reserva de origen cambia de fecha
 * — preserva SIEMPRE `asignado_a` (nunca se toca esa columna). Si había un buffer,
 * se cancela el bloqueo anterior y se crea uno nuevo en la nueva fecha (nunca
 * reescribe el rango de un bloqueo ya insertado — mismo criterio que el resto del
 * calendario: cancela + crea). */
export async function reprogramarTareaPorCambioReserva(ejecutor: EjecutorTransaccional, entrada: { ocupacionUnidadId: string; nuevaFechaCheckout: string }): Promise<{ tareaId: string } | null> {
  const tarea = await ejecutor.query<{ id: string; organization_id: string; property_id: string; unidad_id: string; buffer_ocupacion_id: string | null }>(
    `SELECT id, organization_id, property_id, unidad_id, buffer_ocupacion_id FROM rentas.tarea_operativa
     WHERE ocupacion_unidad_id = $1 AND estado NOT IN ('completada', 'cancelada')
     ORDER BY creado_en DESC LIMIT 1`,
    [entrada.ocupacionUnidadId],
  );
  if (tarea.rows.length === 0) return null;
  const fila = tarea.rows[0]!;

  await ejecutor.query(`UPDATE rentas.tarea_operativa SET programada_para = $1, actualizado_en = now() WHERE id = $2`, [entrada.nuevaFechaCheckout, fila.id]);

  if (fila.buffer_ocupacion_id) {
    await cancelarOcupacion(ejecutor, fila.buffer_ocupacion_id);
    const config = await obtenerConfiguracion(ejecutor, fila.unidad_id);
    const rangoBuffer = calcularRangoBuffer(entrada.nuevaFechaCheckout, config.bufferLimpiezaNoches);
    if (rangoBuffer) {
      const bufferResultado = await crearBloqueo(ejecutor, { organizationId: fila.organization_id, propertyId: fila.property_id, unidadId: fila.unidad_id, rango: rangoBuffer, razon: "BUFFER_LIMPIEZA" });
      await ejecutor.query(`UPDATE rentas.tarea_operativa SET buffer_ocupacion_id = $1 WHERE id = $2`, [bufferResultado.ocupacionId, fila.id]);
    } else {
      await ejecutor.query(`UPDATE rentas.tarea_operativa SET buffer_ocupacion_id = NULL WHERE id = $1`, [fila.id]);
    }
  }

  return { tareaId: fila.id };
}

/** Cancela la tarea (y su buffer, si tenía) cuando la reserva de origen se cancela —
 * nunca al revés: cancelar una tarea NUNCA cancela la reserva. */
export async function cancelarTareaPorCancelacionReserva(ejecutor: EjecutorTransaccional, ocupacionUnidadId: string): Promise<{ tareaId: string } | null> {
  const tarea = await ejecutor.query<{ id: string; buffer_ocupacion_id: string | null }>(
    `SELECT id, buffer_ocupacion_id FROM rentas.tarea_operativa
     WHERE ocupacion_unidad_id = $1 AND estado NOT IN ('completada', 'cancelada')
     ORDER BY creado_en DESC LIMIT 1`,
    [ocupacionUnidadId],
  );
  if (tarea.rows.length === 0) return null;
  const fila = tarea.rows[0]!;

  await ejecutor.query(`UPDATE rentas.tarea_operativa SET estado = 'cancelada', actualizado_en = now() WHERE id = $1`, [fila.id]);
  if (fila.buffer_ocupacion_id) {
    await cancelarOcupacion(ejecutor, fila.buffer_ocupacion_id);
  }
  return { tareaId: fila.id };
}

// ---------------------------------------------------------------------------
// H-049 (desviación documentada arriba, punto 5): poll idempotente que reemplaza al
// consumidor de outbox_evento del origen — ninguna reserva confirmada cuyo checkout
// ya llegó se queda sin tarea de limpieza vinculada, sin depender de un bus de
// eventos que este monorepo no tiene para `rentas.ocupacion`.
// ---------------------------------------------------------------------------

export interface ResultadoProcesarCheckouts {
  readonly procesados: number;
  readonly tareasCreadas: readonly string[];
}

export async function procesarCheckoutsPendientes(ejecutor: EjecutorTransaccional, limite = 50): Promise<ResultadoProcesarCheckouts> {
  const pendientes = await ejecutor.query<{ ocupacion_id: string; unidad_id: string; fin: string }>(
    `SELECT o.id AS ocupacion_id, o.unidad_id, upper(o.rango)::text AS fin
     FROM rentas.ocupacion o
     WHERE o.capa = 'reserva' AND o.estado = 'confirmado' AND o.bloqueante
       AND upper(o.rango) <= current_date
       AND NOT EXISTS (
         SELECT 1 FROM rentas.tarea_operativa t WHERE t.ocupacion_unidad_id = o.id AND t.tipo = 'limpieza'
       )
     ORDER BY upper(o.rango)
     LIMIT $1`,
    [limite],
  );

  const tareasCreadas: string[] = [];
  for (const fila of pendientes.rows) {
    const creada = await crearTareaLimpiezaPorCheckout(ejecutor, { unidadId: fila.unidad_id, ocupacionUnidadId: fila.ocupacion_id, fechaCheckout: fila.fin });
    tareasCreadas.push(creada.tareaId);
  }

  return { procesados: pendientes.rows.length, tareasCreadas };
}

// ---------------------------------------------------------------------------
// H-053: asignación (personal interno o proveedor externo)
// ---------------------------------------------------------------------------

export async function asignarTarea(ejecutor: EjecutorTransaccional, entrada: { tareaId: string; asignadoA: string; esProveedorExterno: boolean }): Promise<void> {
  const actualizado = await ejecutor.query<{ id: string }>(
    `UPDATE rentas.tarea_operativa
     SET asignado_a = $2, es_proveedor_externo = $3,
         estado = CASE WHEN estado = 'pendiente' THEN 'asignada' ELSE estado END,
         actualizado_en = now()
     WHERE id = $1
     RETURNING id`,
    [entrada.tareaId, entrada.asignadoA, entrada.esProveedorExterno],
  );
  if (actualizado.rows.length === 0) throw new RentasDomainError("tarea_no_encontrada", `rentas.tarea_operativa ${entrada.tareaId} no existe`);

  await ejecutor.query(`INSERT INTO rentas.notificacion_tarea (tarea_id, evento, canales) VALUES ($1, 'asignada', '{}')`, [entrada.tareaId]);
}

// ---------------------------------------------------------------------------
// H-051/H-052: checklist con fotos/timestamp + completar tarea (bloquea si el
// checklist está incompleto; descuenta inventario configurado)
// ---------------------------------------------------------------------------

export async function completarChecklistItem(
  ejecutor: EjecutorTransaccional,
  entrada: { checklistItemId: string; completadoPor: string; fotos?: readonly { rutaAlmacenamiento: string; subidaPor: string }[] },
): Promise<void> {
  const actualizado = await ejecutor.query<{ id: string }>(
    `UPDATE rentas.checklist_item_tarea SET completado = true, completado_en = now(), completado_por = $2 WHERE id = $1 RETURNING id`,
    [entrada.checklistItemId, entrada.completadoPor],
  );
  if (actualizado.rows.length === 0) {
    throw new RentasDomainError("checklist_item_no_encontrado", `rentas.checklist_item_tarea ${entrada.checklistItemId} no existe`);
  }
  for (const foto of entrada.fotos ?? []) {
    await ejecutor.query(`INSERT INTO rentas.foto_checklist_item (checklist_item_id, ruta_almacenamiento, subida_por) VALUES ($1, $2, $3)`, [
      entrada.checklistItemId,
      foto.rutaAlmacenamiento,
      foto.subidaPor,
    ]);
  }
}

/** H-051 (REQ-113): completar la tarea EXIGE checklist completo — si algún ítem
 * sigue pendiente, la tarea pasa a `bloqueada` (nunca a `completada`, nunca reabre
 * disponibilidad) y la función lanza `RentasDomainError("checklist_incompleto", …)`
 * para que la capa HTTP lo traduzca a 409. H-052: al completar, se descuenta el
 * inventario configurado y se detecta stock bajo. */
export async function completarTarea(ejecutor: EjecutorTransaccional, entrada: { tareaId: string; consumos?: readonly ConsumoInventario[] }): Promise<{ alertasStockBajo: readonly string[] }> {
  const items = await ejecutor.query<{ completado: boolean }>(`SELECT completado FROM rentas.checklist_item_tarea WHERE tarea_id = $1`, [entrada.tareaId]);
  const completo = checklistCompleto(items.rows.map((r) => ({ completado: r.completado })));

  if (!completo) {
    await ejecutor.query(`UPDATE rentas.tarea_operativa SET estado = 'bloqueada', actualizado_en = now() WHERE id = $1`, [entrada.tareaId]);
    throw new RentasDomainError("checklist_incompleto", "No se puede completar la tarea con ítems de checklist pendientes.");
  }

  const alertasStockBajo: string[] = [];
  for (const consumo of entrada.consumos ?? []) {
    const item = await ejecutor.query<{ id: string; cantidad_actual: string; umbral_minimo: string }>(
      `SELECT id, cantidad_actual, umbral_minimo FROM rentas.item_inventario WHERE id = $1 FOR UPDATE`,
      [consumo.itemInventarioId],
    );
    if (item.rows.length === 0) continue;
    const fila = item.rows[0]!;
    const resultado = aplicarConsumo({ cantidadActual: Number(fila.cantidad_actual), umbralMinimo: Number(fila.umbral_minimo) }, consumo.cantidad);
    await ejecutor.query(`UPDATE rentas.item_inventario SET cantidad_actual = $1, actualizado_en = now() WHERE id = $2`, [resultado.cantidadNueva, fila.id]);
    await ejecutor.query(`INSERT INTO rentas.movimiento_inventario (item_inventario_id, tarea_id, cantidad, motivo) VALUES ($1, $2, $3, 'consumo_checklist')`, [
      fila.id,
      entrada.tareaId,
      -consumo.cantidad,
    ]);
    if (resultado.cruzaUmbralMinimo) alertasStockBajo.push(fila.id);
  }

  await ejecutor.query(`UPDATE rentas.tarea_operativa SET estado = 'completada', completada_en = now(), actualizado_en = now() WHERE id = $1`, [entrada.tareaId]);
  await ejecutor.query(`INSERT INTO rentas.notificacion_tarea (tarea_id, evento, canales) VALUES ($1, 'completada', '{}')`, [entrada.tareaId]);

  return { alertasStockBajo };
}

// ---------------------------------------------------------------------------
// H-055: incidencias de mantenimiento + confirmación humana de bloqueo
// ---------------------------------------------------------------------------

export async function registrarIncidencia(
  ejecutor: EjecutorTransaccional,
  entrada: {
    unidadId: string;
    tareaOrigenId?: string | null;
    severidad: SeveridadIncidencia;
    titulo: string;
    descripcion?: string | null;
    reportadoPor: string;
    propuestaBloqueoRango?: { inicio: string; fin: string } | null;
  },
): Promise<{ incidenciaId: string; requiereConfirmacionHumana: boolean }> {
  const unidad = await ejecutor.query<{ organization_id: string; property_id: string }>(`SELECT organization_id, property_id FROM rentas.unidad WHERE id = $1`, [entrada.unidadId]);
  if (unidad.rows.length === 0) throw new RentasDomainError("unidad_no_encontrada", `rentas.unidad ${entrada.unidadId} no existe`);
  const { organization_id: organizationId, property_id: propertyId } = unidad.rows[0]!;

  const requiereConfirmacion = requiereConfirmacionHumanaParaBloqueo(entrada.severidad);
  const estadoInicial = requiereConfirmacion && entrada.propuestaBloqueoRango ? "bloqueo_propuesto" : "abierta";

  const insertado = await ejecutor.query<{ id: string }>(
    `INSERT INTO rentas.incidencia_mantenimiento
       (organization_id, property_id, unidad_id, tarea_origen_id, severidad, titulo, descripcion, reportado_por, estado, propuesta_bloqueo_inicio, propuesta_bloqueo_fin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      organizationId,
      propertyId,
      entrada.unidadId,
      entrada.tareaOrigenId ?? null,
      entrada.severidad,
      entrada.titulo,
      entrada.descripcion ?? null,
      entrada.reportadoPor,
      estadoInicial,
      entrada.propuestaBloqueoRango?.inicio ?? null,
      entrada.propuestaBloqueoRango?.fin ?? null,
    ],
  );

  return { incidenciaId: insertado.rows[0]!.id, requiereConfirmacionHumana: requiereConfirmacion };
}

export interface ResultadoConfirmarBloqueoMantenimiento {
  readonly ocupacionId: string;
  readonly conflictosCapaCruzada: number;
}

/** H-055 (REQ-118): confirma el bloqueo de mantenimiento propuesto por una
 * incidencia GRAVE — exige un `confirmadoPor` humano explícito (nunca se invoca
 * desde ningún trigger/webhook automático) y delega en `crearBloqueo`
 * (../../aplicacion/reservas.ts), que NUNCA cancela ni toca reservas existentes
 * (D-011): un solape con una reserva confirmada se registra como conflicto
 * `capa_cruzada`, nunca rechaza la operación ni cancela nada. */
export async function confirmarBloqueoMantenimiento(
  ejecutor: EjecutorTransaccional,
  entrada: { incidenciaId: string; confirmadoPor: string; rango?: { inicio: string; fin: string } },
): Promise<ResultadoConfirmarBloqueoMantenimiento> {
  const incidencia = await ejecutor.query<{
    id: string;
    organization_id: string;
    property_id: string;
    unidad_id: string;
    severidad: SeveridadIncidencia;
    estado: string;
    inicio: string | null;
    fin: string | null;
  }>(
    `SELECT id, organization_id, property_id, unidad_id, severidad, estado,
            propuesta_bloqueo_inicio::text AS inicio, propuesta_bloqueo_fin::text AS fin
     FROM rentas.incidencia_mantenimiento WHERE id = $1`,
    [entrada.incidenciaId],
  );
  if (incidencia.rows.length === 0) throw new RentasDomainError("incidencia_no_encontrada", `rentas.incidencia_mantenimiento ${entrada.incidenciaId} no existe`);
  const fila = incidencia.rows[0]!;

  if (!requiereConfirmacionHumanaParaBloqueo(fila.severidad)) {
    throw new RentasDomainError("bloqueo_mantenimiento_no_aplicable", "Solo una incidencia de severidad 'grave' admite propuesta de bloqueo de mantenimiento.");
  }
  if (fila.estado === "bloqueo_confirmado") {
    throw new RentasDomainError("bloqueo_mantenimiento_ya_confirmado", "Esta incidencia ya tiene un bloqueo de mantenimiento confirmado.");
  }

  const rango = entrada.rango ?? (fila.inicio && fila.fin ? { inicio: fila.inicio, fin: fila.fin } : null);
  if (!rango) {
    throw new RentasDomainError("bloqueo_mantenimiento_sin_rango", "No hay un rango de bloqueo propuesto ni provisto explícitamente para confirmar.");
  }

  const bloqueo = await crearBloqueo(ejecutor, { organizationId: fila.organization_id, propertyId: fila.property_id, unidadId: fila.unidad_id, rango, razon: "MANTENIMIENTO" });

  await ejecutor.query(
    `UPDATE rentas.incidencia_mantenimiento
     SET estado = 'bloqueo_confirmado', bloqueo_ocupacion_id = $2, confirmado_por = $3, confirmado_en = now(),
         actualizado_en = now(), propuesta_bloqueo_inicio = $4, propuesta_bloqueo_fin = $5
     WHERE id = $1`,
    [entrada.incidenciaId, bloqueo.ocupacionId, entrada.confirmadoPor, rango.inicio, rango.fin],
  );

  return { ocupacionId: bloqueo.ocupacionId, conflictosCapaCruzada: bloqueo.conflictosCapaCruzada.length };
}
