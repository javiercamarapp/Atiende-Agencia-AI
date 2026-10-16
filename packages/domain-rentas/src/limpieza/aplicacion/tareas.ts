// Capa de aplicación transaccional de limpieza/mantenimiento (Fase 8, BACKLOG E08,
// H-049 a H-055 del origen) — port de
// rentas/packages/domain/src/limpieza/aplicacion/tareas.ts. Mismo patrón exacto que
// ../../aplicacion/reservas.ts: cada función abre/cierra su propia SUB-transacción
// (`SAVEPOINT`/`RELEASE SAVEPOINT`/`ROLLBACK TO SAVEPOINT`, nunca `BEGIN`/`COMMIT`/
// `ROLLBACK` — ver el comentario de cabecera de ../../aplicacion/reservas.ts para el
// porqué: el único caller real, `dbSession`, ya corre dentro de una transacción
// externa por request, y un `BEGIN`/`COMMIT` propio la confirmaría/revertiría de
// verdad) sobre un `EjecutorTransaccional` ya conectado, nunca importa nada de
// infraestructura concreta (structural typing).
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
//     consumir. Desde paridad3 el ciclo de la tarea es SINCRONO, igual que en el origen:
//     `crearReservaConfirmada`, `modificarFechasReserva` y `cancelarOcupacion` (y por
//     tanto el motor iCal, que las reutiliza) invocan los ganchos
//     `crearTareaLimpiezaAlConfirmar`/`reprogramarTareaAlModificarReserva`/
//     `cancelarTareaAlCancelarReserva` de este archivo, como EFECTOS ACCESORIOS aislados
//     por SAVEPOINT (un fallo de la tarea nunca revierte ni rechaza la reserva).
//     `barrerLimpiezaPendiente` (abajo) es la RED DE SEGURIDAD periodica: cubre las
//     reservas anteriores al cambio y repara lo que un gancho no alcanzo a hacer.
import { hoyFechaNegocio, resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import { isMigrationPendingError } from "@atiende/db";
import { bloquearUnidadEnTransaccion, conSavepoint, conSavepointMejorEsfuerzo, type EjecutorTransaccional } from "../../ejecutor.ts";
import { cancelarOcupacion, crearBloqueo } from "../../aplicacion/reservas.ts";
import { RentasDomainError } from "../../errors.ts";
import { sumarDias } from "../../fechas.ts";
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

export interface EntradaCrearTareaCheckout {
  readonly unidadId: string;
  readonly ocupacionUnidadId: string;
  readonly fechaCheckout: string;
  /** `false` al confirmar la reserva: el bloqueo `BUFFER_LIMPIEZA` de calendario se materializa el DIA del checkout
   *  (`materializarBuffersPendientes`), nunca antes -- crearlo dias antes bloquearia el calendario de canales y
   *  registraria conflictos contra cada reserva pegada. Default `true` (comportamiento historico del barrido). */
  readonly conBuffer?: boolean;
}

export interface ResultadoCrearTareaCheckout {
  readonly tareaId: string;
  readonly bufferOcupacionId: string | null;
  /** Responsable por omision de la unidad con el que nacio la tarea (`null` = cola "Sin asignar"). */
  readonly asignadoA: string | null;
  /** `false` si la reserva ya tenia una tarea de limpieza (idempotente: no se duplica). */
  readonly creada: boolean;
}

/** Responsable de limpieza por omision de la unidad (migracion 033), solo si sigue siendo miembro operativo con acceso a
 *  la propiedad. Contra la base SIN migrar (42883/42P01/42703) devuelve `null`: la tarea nace en "Sin asignar" como antes.
 *  Corre en su propio SAVEPOINT: el error de la base vieja no aborta la transaccion compartida. */
async function leerResponsablePorOmision(ejecutor: EjecutorTransaccional, unidadId: string): Promise<string | null> {
  try {
    return await conSavepoint(ejecutor, "sp_responsable_limpieza", async () => {
      const r = await ejecutor.query<{ responsable: string | null }>(`SELECT rentas.responsable_limpieza_vigente($1::uuid) AS responsable`, [unidadId]);
      return r.rows[0]?.responsable ?? null;
    });
  } catch (error) {
    if (isMigrationPendingError(error, "rentas.responsable_limpieza_vigente")) return null;
    throw error;
  }
}

/** Crea la tarea de limpieza vinculada a una reserva (H-049) y, si la property tiene
 * buffer configurado (>0 noches) y `conBuffer` no es `false`, el bloqueo `BUFFER_LIMPIEZA`
 * real de calendario (H-050) — vía `crearBloqueo`, la MISMA función transaccional de
 * `../../aplicacion/reservas.ts`, nunca reimplementada aquí. Idempotente por reserva (misma
 * guarda `NOT EXISTS` del barrido, ahora tambien aqui): una segunda llamada devuelve la tarea
 * existente con `creada: false`. La tarea nace asignada al responsable por omision de la unidad. */
export async function crearTareaLimpiezaPorCheckout(ejecutor: EjecutorTransaccional, entrada: EntradaCrearTareaCheckout): Promise<ResultadoCrearTareaCheckout> {
  const config = await obtenerConfiguracion(ejecutor, entrada.unidadId);

  await ejecutor.exec("SAVEPOINT sp_crear_tarea_limpieza_checkout");
  let tareaId: string;
  let asignadoA: string | null = null;
  try {
    await bloquearUnidadEnTransaccion(ejecutor, entrada.unidadId);

    const existente = await ejecutor.query<{ id: string; asignado_a: string | null }>(
      `SELECT id, asignado_a FROM rentas.tarea_operativa WHERE tipo = 'limpieza' AND ocupacion_unidad_id = $1 ORDER BY creado_en DESC LIMIT 1`,
      [entrada.ocupacionUnidadId],
    );
    if (existente.rows.length > 0) {
      await ejecutor.exec("RELEASE SAVEPOINT sp_crear_tarea_limpieza_checkout");
      return { tareaId: existente.rows[0]!.id, bufferOcupacionId: null, asignadoA: existente.rows[0]!.asignado_a, creada: false };
    }

    const responsable = await leerResponsablePorOmision(ejecutor, entrada.unidadId);

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
    if (responsable) {
      // Mismo camino que una asignacion manual: estado `asignada` y fila de aviso en `rentas.notificacion_tarea`.
      await asignarTarea(ejecutor, { tareaId, asignadoA: responsable, esProveedorExterno: false });
      asignadoA = responsable;
    }

    await ejecutor.exec("RELEASE SAVEPOINT sp_crear_tarea_limpieza_checkout");
  } catch (error) {
    await ejecutor.exec("ROLLBACK TO SAVEPOINT sp_crear_tarea_limpieza_checkout");
    await ejecutor.exec("RELEASE SAVEPOINT sp_crear_tarea_limpieza_checkout");
    throw error;
  }

  // `crearBloqueo` gestiona su PROPIA sub-transacción (SAVEPOINT/RELEASE SAVEPOINT
  // interno, ver ../../aplicacion/reservas.ts) — se invoca DESPUÉS del RELEASE
  // SAVEPOINT de arriba, nunca anidada dentro de la sub-transacción de la tarea.
  // Ninguna de las dos toca la transacción EXTERNA de la request (la que abrió
  // `dbSession`): un `BEGIN`/`COMMIT` propio aquí la confirmaría/revertiría de
  // verdad y perdería `set local role`/`set_config` para el resto del handler (ver
  // el comentario de cabecera de ../../aplicacion/reservas.ts).
  let bufferOcupacionId: string | null = null;
  if (entrada.conBuffer !== false) {
    bufferOcupacionId = await crearBufferParaTarea(ejecutor, tareaId, config, entrada.unidadId, entrada.fechaCheckout);
  }

  return { tareaId, bufferOcupacionId, asignadoA, creada: true };
}

async function crearBufferParaTarea(ejecutor: EjecutorTransaccional, tareaId: string, config: ConfiguracionResuelta, unidadId: string, fechaCheckout: string): Promise<string | null> {
  const rangoBuffer = calcularRangoBuffer(fechaCheckout, config.bufferLimpiezaNoches);
  if (!rangoBuffer) return null;
  const bufferResultado = await crearBloqueo(ejecutor, {
    organizationId: config.organizationId,
    propertyId: config.propertyId,
    unidadId,
    rango: rangoBuffer,
    razon: "BUFFER_LIMPIEZA",
  });
  await ejecutor.query(`UPDATE rentas.tarea_operativa SET buffer_ocupacion_id = $1 WHERE id = $2`, [bufferResultado.ocupacionId, tareaId]);
  return bufferResultado.ocupacionId;
}

/** Al confirmarse una reserva (`crearReservaConfirmada`): deja la tarea de limpieza del checkout en la MISMA transaccion,
 *  como EFECTO ACCESORIO -- ningun fallo de la tarea (RLS, base sin migrar, tabla ausente) revierte ni rechaza la reserva;
 *  el barrido de checkouts (`barrerLimpiezaPendiente`) es la red de seguridad. Devuelve `null` si no pudo crearla. */
export async function crearTareaLimpiezaAlConfirmar(
  ejecutor: EjecutorTransaccional,
  entrada: { unidadId: string; ocupacionUnidadId: string; fechaCheckout: string },
): Promise<ResultadoCrearTareaCheckout | null> {
  const r = await conSavepointMejorEsfuerzo(ejecutor, "sp_limpieza_al_confirmar", () => crearTareaLimpiezaPorCheckout(ejecutor, { ...entrada, conBuffer: false }));
  return r.ok ? r.valor : null;
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

/** Gancho de `modificarFechasReserva`: mueve la tarea al nuevo checkout conservando al responsable. EFECTO ACCESORIO (no
 *  revierte el cambio de fechas si falla; el barrido corrige la deriva). */
export async function reprogramarTareaAlModificarReserva(ejecutor: EjecutorTransaccional, entrada: { ocupacionUnidadId: string; nuevaFechaCheckout: string }): Promise<void> {
  await conSavepointMejorEsfuerzo(ejecutor, "sp_limpieza_reprogramar", () => reprogramarTareaPorCambioReserva(ejecutor, entrada));
}

/** Gancho de `cancelarOcupacion`: cancela la tarea (y su buffer) de la reserva cancelada. EFECTO ACCESORIO (el barrido
 *  cancela las tareas huerfanas si esto falla). */
export async function cancelarTareaAlCancelarReserva(ejecutor: EjecutorTransaccional, ocupacionUnidadId: string): Promise<void> {
  await conSavepointMejorEsfuerzo(ejecutor, "sp_limpieza_cancelar", () => cancelarTareaPorCancelacionReserva(ejecutor, ocupacionUnidadId));
}

// ---------------------------------------------------------------------------
// H-049 (desviación documentada arriba, punto 5): barrido idempotente que reemplaza al
// consumidor de outbox_evento del origen. Desde paridad3 la tarea nace AL CONFIRMAR la
// reserva (`crearTareaLimpiezaAlConfirmar`, gancho de `crearReservaConfirmada`); este barrido
// es la RED DE SEGURIDAD y ademas:
//   1. crea la tarea de las reservas que no la tienen (anteriores al cambio, o cuyo gancho fallo)
//      cuyo checkout ya llego en la zona horaria de SU propiedad;
//   2. materializa el bloqueo BUFFER_LIMPIEZA el dia del checkout;
//   3. cancela las tareas de reservas ya canceladas y reprograma las que quedaron desfasadas de la
//      fecha de salida de su reserva (cualquier camino de escritura, incluido el motor iCal);
//   4. detecta las propiedades con tareas de MAÑANA sin responsable pasadas las 18:00 locales (el que
//      llama emite el aviso: este modulo no conoce la bandeja de notificaciones).
// Justo entre propiedades: tope por propiedad y orden por la salida mas antigua, de modo que una
// organizacion con 120 salidas atrasadas no deja sin turno a las demas (ver `limitePorPropiedad`).
// ---------------------------------------------------------------------------

export interface OpcionesBarridoLimpieza {
  /** Tope de tareas nuevas por corrida entre TODAS las propiedades. Default 200. */
  readonly limiteTotal?: number;
  /** Tope de tareas nuevas por propiedad y corrida. Default 40. */
  readonly limitePorPropiedad?: number;
  /** Tope de filas por fase de mantenimiento (buffers, cancelaciones, reprogramaciones). Default 100. */
  readonly limitePorFase?: number;
  /** Hora local (0-23) desde la que una tarea de mañana sin responsable se avisa. Default 18. */
  readonly horaAvisoSinAsignar?: number;
}

export interface SinAsignarManana {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly fecha: string;
  readonly cantidad: number;
}

export interface ResultadoBarridoLimpieza {
  /** Reservas con checkout llegado y sin tarea que se intentaron procesar. */
  readonly procesados: number;
  readonly tareasCreadas: readonly string[];
  readonly buffersCreados: number;
  readonly tareasCanceladas: number;
  readonly tareasReprogramadas: number;
  /** Reservas/tareas cuyo procesamiento fallo (cada una aislada: no tumba al resto). */
  readonly fallidos: number;
  readonly sinAsignarManana: readonly SinAsignarManana[];
}

function fechaNegocioDe(zona: string | null): string {
  return hoyFechaNegocio(resolverZonaHorariaNegocio(zona));
}

function horaNegocioDe(zona: string | null): number {
  const partes = new Intl.DateTimeFormat("en-US", { timeZone: resolverZonaHorariaNegocio(zona), hour: "numeric", hourCycle: "h23" }).formatToParts(new Date());
  return Number(partes.find((p) => p.type === "hour")?.value ?? "0");
}

export async function barrerLimpiezaPendiente(ejecutor: EjecutorTransaccional, opciones: OpcionesBarridoLimpieza = {}): Promise<ResultadoBarridoLimpieza> {
  const limiteTotal = opciones.limiteTotal ?? 200;
  const limitePorPropiedad = opciones.limitePorPropiedad ?? 40;
  const limitePorFase = opciones.limitePorFase ?? 100;
  const horaAviso = opciones.horaAvisoSinAsignar ?? 18;

  // El "hoy" real es el de CADA propiedad (property_config.zona_horaria); la cota UTC+1 solo acota la consulta (ninguna
  // zona del mundo va mas de un dia por delante de UTC+0 mas 14 h) y el filtro fino se hace en TS por propiedad.
  const hoyUtc = new Date().toISOString().slice(0, 10);
  const cotaUtc = sumarDias(hoyUtc, 1);

  let fallidos = 0;
  const tareasCreadas: string[] = [];
  let procesados = 0;

  // --- 1. reservas sin tarea cuyo checkout ya llego, por propiedad ---
  const propiedades = await ejecutor.query<{ property_id: string; zona_horaria: string | null }>(
    `SELECT o.property_id, pc.zona_horaria, min(upper(o.rango))::text AS primer_fin
     FROM rentas.ocupacion o
     LEFT JOIN rentas.property_config pc ON pc.property_id = o.property_id
     WHERE o.capa = 'reserva' AND o.estado = 'confirmado' AND o.bloqueante
       AND upper(o.rango) <= $1::date
       AND NOT EXISTS (SELECT 1 FROM rentas.tarea_operativa t WHERE t.ocupacion_unidad_id = o.id AND t.tipo = 'limpieza')
     GROUP BY o.property_id, pc.zona_horaria
     ORDER BY min(upper(o.rango)), o.property_id`,
    [cotaUtc],
  );
  for (const propiedad of propiedades.rows) {
    const restante = limiteTotal - tareasCreadas.length;
    if (restante <= 0) break;
    const hoyLocal = fechaNegocioDe(propiedad.zona_horaria);
    const pendientes = await ejecutor.query<{ ocupacion_id: string; unidad_id: string; fin: string }>(
      `SELECT o.id AS ocupacion_id, o.unidad_id, upper(o.rango)::text AS fin
       FROM rentas.ocupacion o
       WHERE o.property_id = $1 AND o.capa = 'reserva' AND o.estado = 'confirmado' AND o.bloqueante
         AND upper(o.rango) <= $2::date
         AND NOT EXISTS (SELECT 1 FROM rentas.tarea_operativa t WHERE t.ocupacion_unidad_id = o.id AND t.tipo = 'limpieza')
       ORDER BY upper(o.rango), o.id
       LIMIT $3`,
      [propiedad.property_id, hoyLocal, Math.min(limitePorPropiedad, restante)],
    );
    for (const fila of pendientes.rows) {
      procesados += 1;
      try {
        // Una transaccion de sistema por corrida, pero CADA reserva aislada por SAVEPOINT: una fila venenosa no tumba al resto.
        const creada = await conSavepoint(ejecutor, "sp_barrido_limpieza_reserva", () =>
          crearTareaLimpiezaPorCheckout(ejecutor, { unidadId: fila.unidad_id, ocupacionUnidadId: fila.ocupacion_id, fechaCheckout: fila.fin }),
        );
        if (creada.creada) tareasCreadas.push(creada.tareaId);
      } catch {
        fallidos += 1;
      }
    }
  }

  // --- 2. bloqueo BUFFER_LIMPIEZA de las tareas creadas al confirmar, el dia del checkout ---
  let buffersCreados = 0;
  const sinBuffer = await ejecutor.query<{ tarea_id: string; unidad_id: string; fecha: string; zona_horaria: string | null }>(
    `SELECT t.id AS tarea_id, t.unidad_id, t.programada_para::text AS fecha, pc.zona_horaria
     FROM rentas.tarea_operativa t
     JOIN rentas.ocupacion o ON o.id = t.ocupacion_unidad_id
     LEFT JOIN rentas.property_config pc ON pc.property_id = t.property_id
     WHERE t.tipo = 'limpieza' AND t.estado NOT IN ('completada', 'cancelada') AND t.buffer_ocupacion_id IS NULL
       AND o.capa = 'reserva' AND o.estado = 'confirmado'
       AND COALESCE(pc.buffer_limpieza_noches, ${CONFIGURACION_OPERATIVA_DEFECTO.bufferLimpiezaNoches}) > 0
       AND t.programada_para <= $1::date
     ORDER BY t.programada_para, t.id
     LIMIT $2`,
    [cotaUtc, limitePorFase],
  );
  for (const fila of sinBuffer.rows) {
    if (fila.fecha > fechaNegocioDe(fila.zona_horaria)) continue;
    try {
      const id = await conSavepoint(ejecutor, "sp_barrido_limpieza_buffer", async () => {
        const config = await obtenerConfiguracion(ejecutor, fila.unidad_id);
        return crearBufferParaTarea(ejecutor, fila.tarea_id, config, fila.unidad_id, fila.fecha);
      });
      if (id) buffersCreados += 1;
    } catch {
      fallidos += 1;
    }
  }

  // --- 3a. tareas de reservas ya canceladas ---
  let tareasCanceladas = 0;
  const huerfanas = await ejecutor.query<{ ocupacion_id: string }>(
    `SELECT t.ocupacion_unidad_id AS ocupacion_id
     FROM rentas.tarea_operativa t
     JOIN rentas.ocupacion o ON o.id = t.ocupacion_unidad_id
     WHERE t.tipo = 'limpieza' AND t.estado NOT IN ('completada', 'cancelada') AND o.estado = 'cancelado'
     ORDER BY t.creado_en, t.id
     LIMIT $1`,
    [limitePorFase],
  );
  for (const fila of huerfanas.rows) {
    try {
      const r = await conSavepoint(ejecutor, "sp_barrido_limpieza_cancelar", () => cancelarTareaPorCancelacionReserva(ejecutor, fila.ocupacion_id));
      if (r) tareasCanceladas += 1;
    } catch {
      fallidos += 1;
    }
  }

  // --- 3b. tareas desfasadas de la fecha de salida de su reserva ---
  let tareasReprogramadas = 0;
  const desfasadas = await ejecutor.query<{ ocupacion_id: string; fin: string }>(
    `SELECT t.ocupacion_unidad_id AS ocupacion_id, upper(o.rango)::text AS fin
     FROM rentas.tarea_operativa t
     JOIN rentas.ocupacion o ON o.id = t.ocupacion_unidad_id
     WHERE t.tipo = 'limpieza' AND t.estado NOT IN ('completada', 'cancelada')
       AND o.capa = 'reserva' AND o.estado = 'confirmado' AND t.programada_para <> upper(o.rango)
     ORDER BY t.creado_en, t.id
     LIMIT $1`,
    [limitePorFase],
  );
  for (const fila of desfasadas.rows) {
    try {
      const r = await conSavepoint(ejecutor, "sp_barrido_limpieza_reprogramar", () => reprogramarTareaPorCambioReserva(ejecutor, { ocupacionUnidadId: fila.ocupacion_id, nuevaFechaCheckout: fila.fin }));
      if (r) tareasReprogramadas += 1;
    } catch {
      fallidos += 1;
    }
  }

  // --- 4. tareas de MAÑANA sin responsable pasadas las 18:00 locales de su propiedad ---
  const sinAsignarManana: SinAsignarManana[] = [];
  const candidatas = await ejecutor.query<{ organization_id: string; property_id: string; zona_horaria: string | null; fecha: string; cantidad: number }>(
    `SELECT t.organization_id, t.property_id, pc.zona_horaria, t.programada_para::text AS fecha, count(*)::int AS cantidad
     FROM rentas.tarea_operativa t
     LEFT JOIN rentas.property_config pc ON pc.property_id = t.property_id
     WHERE t.tipo = 'limpieza' AND t.estado = 'pendiente' AND t.asignado_a IS NULL
       AND t.programada_para BETWEEN $1::date AND $2::date
     GROUP BY t.organization_id, t.property_id, pc.zona_horaria, t.programada_para
     ORDER BY t.property_id, t.programada_para`,
    [sumarDias(hoyUtc, -1), sumarDias(hoyUtc, 2)],
  );
  for (const fila of candidatas.rows) {
    if (horaNegocioDe(fila.zona_horaria) < horaAviso) continue;
    if (fila.fecha !== sumarDias(fechaNegocioDe(fila.zona_horaria), 1)) continue;
    sinAsignarManana.push({ organizationId: fila.organization_id, propertyId: fila.property_id, fecha: fila.fecha, cantidad: Number(fila.cantidad) });
  }

  return { procesados, tareasCreadas, buffersCreados, tareasCanceladas, tareasReprogramadas, fallidos, sinAsignarManana };
}

// ---------------------------------------------------------------------------
// Creación MANUAL de una tarea (fuera del sweep automático de checkout de arriba) --
// cierra el segundo hallazgo de la ronda que expuso el barrido de checkouts
// por HTTP: admin_gestora/operador necesitan poder dar de alta una tarea de
// limpieza/mantenimiento/inspección ad-hoc (una reparación reportada por el
// propietario, una inspección programada) sin esperar a que un checkout real la
// dispare. `ocupacion_unidad_id` es NULL a propósito -- la propia migración 010 ya
// documenta esa columna como "NULL para tareas creadas manualmente
// (mantenimiento/inspección ad-hoc)", así que el esquema ya estaba listo para este
// caso sin ningún cambio de columna. A diferencia de `crearTareaLimpiezaPorCheckout`,
// esta función NUNCA crea ni toca ningún bloqueo de calendario (`buffer_ocupacion_id`
// se queda NULL): una tarea manual no reserva disponibilidad por sí sola, eso sigue
// siendo una decisión de calendario aparte (ESCRITURA_CALENDARIO_ROLES).
// ---------------------------------------------------------------------------

export interface EntradaCrearTareaManual {
  readonly unidadId: string;
  readonly tipo: TipoTareaOperativa;
  /** Default `"media"`, mismo default que la columna `prioridad` de la migración. */
  readonly prioridad?: PrioridadTareaOperativa;
  readonly programadaPara: string;
}

export interface ResultadoCrearTareaManual {
  readonly tareaId: string;
}

export async function crearTareaOperativaManual(ejecutor: EjecutorTransaccional, entrada: EntradaCrearTareaManual): Promise<ResultadoCrearTareaManual> {
  const config = await obtenerConfiguracion(ejecutor, entrada.unidadId);
  const prioridad: PrioridadTareaOperativa = entrada.prioridad ?? "media";
  const creadaEn = new Date().toISOString();
  const slaVenceEn = calcularVencimientoSla(creadaEn, entrada.tipo, prioridad, config);

  await ejecutor.exec("SAVEPOINT sp_crear_tarea_operativa_manual");
  let tareaId: string;
  try {
    const insertado = await ejecutor.query<{ id: string }>(
      `INSERT INTO rentas.tarea_operativa
         (organization_id, property_id, unidad_id, ocupacion_unidad_id, tipo, estado, prioridad, programada_para, sla_vence_en)
       VALUES ($1, $2, $3, NULL, $4, 'pendiente', $5, $6, $7)
       RETURNING id`,
      [config.organizationId, config.propertyId, entrada.unidadId, entrada.tipo, prioridad, entrada.programadaPara, slaVenceEn],
    );
    tareaId = insertado.rows[0]!.id;
    await insertarChecklistPlantilla(ejecutor, tareaId, entrada.tipo);

    await ejecutor.exec("RELEASE SAVEPOINT sp_crear_tarea_operativa_manual");
  } catch (error) {
    await ejecutor.exec("ROLLBACK TO SAVEPOINT sp_crear_tarea_operativa_manual");
    await ejecutor.exec("RELEASE SAVEPOINT sp_crear_tarea_operativa_manual");
    throw error;
  }

  return { tareaId };
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
