// Capa de aplicación transaccional sobre `rentas.ocupacion` — port ~literal de
// rentas/packages/domain/src/aplicacion/reservas.ts (ver diseño Fase 1 §3, tabla
// src/aplicacion/reservas.ts). Cada función gestiona su propia SUB-transacción de
// principio a fin: recibe un `EjecutorTransaccional` ya conectado (una conexión SQL
// abierta, no un pool — en producción, el `TenantDbSession` que abre
// `@atiende/core-auth::dbSession` para el request, que satisface esta interfaz por
// structural typing).
//
// IMPORTANTE (fix D-0xx, hallazgo de auditoría): esa conexión YA está dentro de la
// transacción EXTERNA que `dbSession`/`TenancyEngine.withAppSession` abrió para todo
// el request (`BEGIN` + `set local role authenticated` + `set_config('request.jwt.
// claim.sub', ...)`, ver packages/db/src/managed-postgres-engine.ts) — el único
// caller real en producción. Antes de este fix, cada función de aquí abajo emitía su
// propio `BEGIN`/`COMMIT`/`ROLLBACK` literal; Postgres NO tiene transacciones
// anidadas reales: un segundo `BEGIN` dentro de una ya abierta es un no-op con
// WARNING, pero el `COMMIT` interno sí confirmaba de verdad la transacción EXTERNA de
// la request -- terminándola por completo y perdiendo `set local role`/`set_config`
// (ambos con alcance de transacción) para cualquier lectura/escritura posterior en el
// MISMO handler (permission denied, o peor: RLS aplicado con el rol de conexión del
// pool en vez del rol de usuario real). Por eso cada función usa ahora
// `SAVEPOINT <nombre>` / `RELEASE SAVEPOINT <nombre>` / `ROLLBACK TO SAVEPOINT
// <nombre>` en vez de `BEGIN`/`COMMIT`/`ROLLBACK` — un savepoint sí anida de verdad
// dentro de la transacción externa y nunca la confirma ni la revierte, así que la
// sesión del request sigue viva (con su rol y sus claims) para todo lo que corra
// después. Nunca se asume una conexión fuera de transacción: `EjecutorTransaccional`
// no expone forma de detectarlo, y el único caller real (`dbSession`) siempre corre
// dentro de una transacción abierta.
//
// Mecanismo de conflicto (corrección BC1 del origen): el `INSERT`/`UPDATE` que sí
// participa del EXCLUDE (capa='reserva', bloqueante=true, estado<>'cancelado') se
// intenta dentro de un `SAVEPOINT` anidado (uno más adentro que el de la función); si
// Postgres lo rechaza con `23P01` (`exclusion_violation`), se hace `ROLLBACK TO
// SAVEPOINT` (recupera la transacción, que de otro modo quedaría abortada) y se
// registra el conflicto de forma explícita — nunca se cancela ninguna reserva
// automáticamente (REQ-000).
//
// Diferencias deliberadas frente al port literal (ver README.md de este paquete):
//  1. Las tablas están calificadas por schema (`rentas.*`) e incluyen
//     `organization_id`/`property_id` (el origen es mono-vertical, sin esas
//     columnas) — se propagan desde `entrada` en las inserciones nuevas, o se leen
//     de la fila existente cuando la operación parte de un `ocupacionId` ya conocido.
//  2. Los `throw new Error(string)` genéricos del origen son ahora `RentasDomainError`
//     con código (ver errors.ts) — la ruta HTTP necesita distinguir el código sin
//     parsear el mensaje, mismo patrón que `domain-hoteles::QuoteError`.
//  3. Los INSERT a `outbox_evento` del origen se omiten (ver README.md: sin
//     consumidor en esta fase, tabla fuera del esquema mapeado).
import { calcularNoches, esRangoValido } from "../fechas.ts";
import { puedeTransicionar } from "../estados.ts";
import { RentasDomainError } from "../errors.ts";
import type { EstadoOcupacion, RangoFechas, Razon, TipoConflicto } from "../tipos.ts";
import { bloquearUnidadEnTransaccion, esViolacionExclusion, type EjecutorTransaccional } from "../ejecutor.ts";

function requireRangoValido(rango: RangoFechas): void {
  if (!esRangoValido(rango)) {
    throw new RentasDomainError("rango_invalido", `Rango inválido (debe cumplir inicio < fin): [${rango.inicio}, ${rango.fin})`);
  }
}

export interface InfoConflicto {
  tipo: TipoConflicto;
  conflictoId: string;
  ocupacionExistenteId: string;
}

/**
 * Verificación de solapamiento contra capas NO bloqueantes a nivel de EXCLUDE
 * (`capa='bloqueo'`: BLOQUEO_PROPIETARIO, MANTENIMIENTO, BUFFER_LIMPIEZA) que
 * `crearReservaConfirmada`/`modificarFechasReserva` necesitan replicar del mismo
 * patrón que ya usa `crearBloqueo`: el `EXCLUDE` de base de datos SOLO protege
 * `capa='reserva' AND bloqueante=true`, así que una reserva de canal que aterriza
 * sobre un bloqueo ya existente nunca dispara `23P01` y, sin esta verificación
 * explícita, se insertaría sin ninguna fila en `conflicto_calendario` ni alerta.
 *
 * Decisión de producto (heredada del origen): la reserva de canal SIEMPRE se acepta
 * —el canal externo ya la confirmó frente al huésped, cancelarla unilateralmente
 * violaría REQ-000— y el conflicto se registra para revisión humana como
 * `capa_cruzada`, nunca como motivo de rechazo.
 */
async function detectarYRegistrarConflictosCapaCruzada(
  ejecutor: EjecutorTransaccional,
  organizationId: string,
  propertyId: string,
  unidadId: string,
  ocupacionId: string,
  rango: RangoFechas,
): Promise<InfoConflicto[]> {
  const solapadas = await ejecutor.query<{ id: string }>(
    `SELECT id FROM rentas.ocupacion
     WHERE unidad_id = $1 AND id <> $2 AND estado <> 'cancelado' AND capa = 'bloqueo'
       AND rango && daterange($3, $4, '[)')`,
    [unidadId, ocupacionId, rango.inicio, rango.fin],
  );

  const conflictos: InfoConflicto[] = [];
  for (const fila of solapadas.rows) {
    const conflictoInsertado = await ejecutor.query<{ id: string }>(
      `INSERT INTO rentas.conflicto_calendario (organization_id, property_id, unidad_id, ocupacion_a_id, ocupacion_b_id, tipo)
       VALUES ($1, $2, $3, $4, $5, 'capa_cruzada')
       RETURNING id`,
      [organizationId, propertyId, unidadId, fila.id, ocupacionId],
    );
    conflictos.push({
      tipo: "capa_cruzada",
      conflictoId: conflictoInsertado.rows[0]!.id,
      ocupacionExistenteId: fila.id,
    });
  }
  return conflictos;
}

// ---------------------------------------------------------------------------
// Crear reserva confirmada / provisional
// ---------------------------------------------------------------------------

export interface EntradaCrearReserva {
  organizationId: string;
  propertyId: string;
  unidadId: string;
  rango: RangoFechas;
  /** `provisional` cubre tanto un hold bloqueante como una solicitud pendiente no
   * bloqueante (p. ej. un `INQUIRY` de canal). */
  estado: Extract<EstadoOcupacion, "confirmado" | "provisional">;
  /** Una reserva `confirmado` siempre es bloqueante (regla de negocio, verificada
   * abajo); una `provisional` puede o no serlo según si el canal de origen la
   * bloquea. */
  bloqueante: boolean;
  canalOrigenId?: string | null;
  externalId?: string | null;
}

export interface ResultadoCrearReserva {
  ocupacionId: string;
  conflicto: InfoConflicto | null;
  /** Conflictos `capa_cruzada` contra bloqueos (propietario, mantenimiento, buffer)
   * ya existentes sobre el mismo rango. Nunca bloquea la inserción de la reserva de
   * canal — solo la reporta. */
  conflictosCapaCruzada: InfoConflicto[];
}

export async function crearReservaConfirmada(ejecutor: EjecutorTransaccional, entrada: EntradaCrearReserva): Promise<ResultadoCrearReserva> {
  requireRangoValido(entrada.rango);
  if (entrada.estado === "confirmado" && !entrada.bloqueante) {
    throw new RentasDomainError(
      "rango_invalido",
      "una reserva 'confirmado' siempre debe ser bloqueante=true; bloqueante=false solo es válido para 'provisional'",
    );
  }

  await ejecutor.exec("SAVEPOINT sp_crear_reserva");
  try {
    await bloquearUnidadEnTransaccion(ejecutor, entrada.unidadId);

    // La duración mínima de estancia es una regla de la fuente de verdad interna, no
    // una validación que un canal pueda saltarse. Se aplica siempre, incluso a
    // reservas 'provisional' (para no encolar de entrada una solicitud que nunca
    // podría confirmarse tal cual).
    const unidad = await ejecutor.query<{ duracion_minima_noches: number }>(
      `SELECT duracion_minima_noches FROM rentas.unidad WHERE id = $1 AND property_id = $2`,
      [entrada.unidadId, entrada.propertyId],
    );
    if (unidad.rows.length === 0) {
      throw new RentasDomainError("unidad_no_encontrada", `unidad ${entrada.unidadId} no existe en esta property`);
    }
    const noches = calcularNoches(entrada.rango);
    const minimo = unidad.rows[0]!.duracion_minima_noches;
    if (noches < minimo) {
      throw new RentasDomainError(
        "duracion_minima_no_alcanzada",
        `estancia de ${noches} noche(s) por debajo de la duración mínima configurada (${minimo}) para esta unidad`,
      );
    }

    await ejecutor.exec("SAVEPOINT intento_insercion");

    let ocupacionId: string;
    let conflicto: InfoConflicto | null = null;

    try {
      const insertado = await ejecutor.query<{ id: string }>(
        `INSERT INTO rentas.ocupacion
           (organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante, canal_origen_id, external_id)
         VALUES
           ($1, $2, $3, daterange($4, $5, '[)'), 'reserva', 'RESERVA_CANAL', $6, $7, $8, $9)
         RETURNING id`,
        [
          entrada.organizationId,
          entrada.propertyId,
          entrada.unidadId,
          entrada.rango.inicio,
          entrada.rango.fin,
          entrada.estado,
          entrada.bloqueante,
          entrada.canalOrigenId ?? null,
          entrada.externalId ?? null,
        ],
      );
      ocupacionId = insertado.rows[0]!.id;
    } catch (error) {
      if (!esViolacionExclusion(error)) throw error;

      await ejecutor.exec("ROLLBACK TO SAVEPOINT intento_insercion");

      const existente = await ejecutor.query<{ id: string }>(
        `SELECT id FROM rentas.ocupacion
         WHERE unidad_id = $1 AND capa = 'reserva' AND estado <> 'cancelado' AND bloqueante
           AND rango && daterange($2, $3, '[)')
         LIMIT 1`,
        [entrada.unidadId, entrada.rango.inicio, entrada.rango.fin],
      );
      const ocupacionExistenteId = existente.rows[0]?.id ?? null;

      // Se inserta igualmente, pero como 'conflicto_pendiente' y bloqueante=false —
      // así este segundo INSERT queda excluido del EXCLUDE y sí se acepta.
      const insertadoComoConflicto = await ejecutor.query<{ id: string }>(
        `INSERT INTO rentas.ocupacion
           (organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante, canal_origen_id, external_id)
         VALUES
           ($1, $2, $3, daterange($4, $5, '[)'), 'reserva', 'RESERVA_CANAL', 'conflicto_pendiente', false, $6, $7)
         RETURNING id`,
        [entrada.organizationId, entrada.propertyId, entrada.unidadId, entrada.rango.inicio, entrada.rango.fin, entrada.canalOrigenId ?? null, entrada.externalId ?? null],
      );
      ocupacionId = insertadoComoConflicto.rows[0]!.id;

      if (ocupacionExistenteId) {
        const conflictoInsertado = await ejecutor.query<{ id: string }>(
          `INSERT INTO rentas.conflicto_calendario (organization_id, property_id, unidad_id, ocupacion_a_id, ocupacion_b_id, tipo)
           VALUES ($1, $2, $3, $4, $5, 'overbooking_confirmado')
           RETURNING id`,
          [entrada.organizationId, entrada.propertyId, entrada.unidadId, ocupacionExistenteId, ocupacionId],
        );
        conflicto = {
          tipo: "overbooking_confirmado",
          conflictoId: conflictoInsertado.rows[0]!.id,
          ocupacionExistenteId,
        };
      }

      // El conflicto reserva-vs-reserva (overbooking) no excluye que ADEMÁS haya un
      // solapamiento contra un bloqueo de menor precedencia (capa cruzada) — se
      // verifica siempre, no solo en la rama de éxito.
      const conflictosCapaCruzada = await detectarYRegistrarConflictosCapaCruzada(
        ejecutor,
        entrada.organizationId,
        entrada.propertyId,
        entrada.unidadId,
        ocupacionId,
        entrada.rango,
      );

      await ejecutor.exec("RELEASE SAVEPOINT sp_crear_reserva");
      return { ocupacionId, conflicto, conflictosCapaCruzada };
    }

    // La reserva de canal se acepta SIEMPRE (el canal externo ya la confirmó frente
    // al huésped) incluso cuando solapa con un bloqueo de propietario/mantenimiento/
    // buffer ya existente; el solapamiento se registra como conflicto de capa
    // cruzada para revisión humana, nunca como motivo de rechazo.
    const conflictosCapaCruzada = await detectarYRegistrarConflictosCapaCruzada(
      ejecutor,
      entrada.organizationId,
      entrada.propertyId,
      entrada.unidadId,
      ocupacionId,
      entrada.rango,
    );

    await ejecutor.exec("RELEASE SAVEPOINT sp_crear_reserva");
    return { ocupacionId, conflicto: null, conflictosCapaCruzada };
  } catch (error) {
    await ejecutor.exec("ROLLBACK TO SAVEPOINT sp_crear_reserva");
    await ejecutor.exec("RELEASE SAVEPOINT sp_crear_reserva");
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Crear bloqueo de propietario/mantenimiento/buffer
// ---------------------------------------------------------------------------
// Fuera de fase por HTTP (ver diseño §6: "no se porta crearBloqueo... solo reservas
// directas"). Se conserva el motor puro porque `detectarYRegistrarConflictosCapaCruzada`
// y los tests de regresión de `crearReservaConfirmada`/`modificarFechasReserva`
// dependen de que un bloqueo pueda existir en la fixture de pruebas.

export interface EntradaCrearBloqueo {
  organizationId: string;
  propertyId: string;
  unidadId: string;
  rango: RangoFechas;
  razon: Extract<Razon, "BLOQUEO_PROPIETARIO" | "MANTENIMIENTO" | "BUFFER_LIMPIEZA">;
}

export interface ResultadoCrearBloqueo {
  ocupacionId: string;
  conflictosCapaCruzada: InfoConflicto[];
}

export async function crearBloqueo(ejecutor: EjecutorTransaccional, entrada: EntradaCrearBloqueo): Promise<ResultadoCrearBloqueo> {
  requireRangoValido(entrada.rango);

  await ejecutor.exec("SAVEPOINT sp_crear_bloqueo");
  try {
    await bloquearUnidadEnTransaccion(ejecutor, entrada.unidadId);
    const insertado = await ejecutor.query<{ id: string }>(
      `INSERT INTO rentas.ocupacion (organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante)
       VALUES ($1, $2, $3, daterange($4, $5, '[)'), 'bloqueo', $6, 'confirmado', true)
       RETURNING id`,
      [entrada.organizationId, entrada.propertyId, entrada.unidadId, entrada.rango.inicio, entrada.rango.fin, entrada.razon],
    );
    const ocupacionId = insertado.rows[0]!.id;

    const solapadas = await ejecutor.query<{ id: string }>(
      `SELECT id FROM rentas.ocupacion
       WHERE unidad_id = $1 AND id <> $2 AND estado <> 'cancelado'
         AND rango && daterange($3, $4, '[)')`,
      [entrada.unidadId, ocupacionId, entrada.rango.inicio, entrada.rango.fin],
    );

    const conflictosCapaCruzada: InfoConflicto[] = [];
    for (const fila of solapadas.rows) {
      const conflictoInsertado = await ejecutor.query<{ id: string }>(
        `INSERT INTO rentas.conflicto_calendario (organization_id, property_id, unidad_id, ocupacion_a_id, ocupacion_b_id, tipo)
         VALUES ($1, $2, $3, $4, $5, 'capa_cruzada')
         RETURNING id`,
        [entrada.organizationId, entrada.propertyId, entrada.unidadId, fila.id, ocupacionId],
      );
      conflictosCapaCruzada.push({
        tipo: "capa_cruzada",
        conflictoId: conflictoInsertado.rows[0]!.id,
        ocupacionExistenteId: fila.id,
      });
    }

    await ejecutor.exec("RELEASE SAVEPOINT sp_crear_bloqueo");
    return { ocupacionId, conflictosCapaCruzada };
  } catch (error) {
    await ejecutor.exec("ROLLBACK TO SAVEPOINT sp_crear_bloqueo");
    await ejecutor.exec("RELEASE SAVEPOINT sp_crear_bloqueo");
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Cancelar: nunca reabre noches ocupadas por otra causa
// ---------------------------------------------------------------------------

export interface ResultadoCancelarOcupacion {
  estadoAnterior: EstadoOcupacion;
}

export async function cancelarOcupacion(ejecutor: EjecutorTransaccional, ocupacionId: string): Promise<ResultadoCancelarOcupacion> {
  await ejecutor.exec("SAVEPOINT sp_cancelar_ocupacion");
  try {
    const actual = await ejecutor.query<{ estado: EstadoOcupacion }>(`SELECT estado FROM rentas.ocupacion WHERE id = $1 FOR UPDATE`, [ocupacionId]);
    if (actual.rows.length === 0) {
      throw new RentasDomainError("ocupacion_no_encontrada", `rentas.ocupacion ${ocupacionId} no existe`);
    }
    const estadoAnterior = actual.rows[0]!.estado;
    if (!puedeTransicionar(estadoAnterior, "cancelado")) {
      throw new RentasDomainError("transicion_no_permitida", `no se puede cancelar una ocupación en estado "${estadoAnterior}"`);
    }

    await ejecutor.query(`UPDATE rentas.ocupacion SET estado = 'cancelado', updated_at = now() WHERE id = $1`, [ocupacionId]);
    // No hace falta "liberar" noches explícitamente: la disponibilidad se deriva
    // siempre por OR sobre filas activas. Si otra fila con estado<>'cancelado' cubre
    // la misma noche, seguirá contando como ocupada sin ningún cambio adicional aquí.

    await ejecutor.exec("RELEASE SAVEPOINT sp_cancelar_ocupacion");
    return { estadoAnterior };
  } catch (error) {
    await ejecutor.exec("ROLLBACK TO SAVEPOINT sp_cancelar_ocupacion");
    await ejecutor.exec("RELEASE SAVEPOINT sp_cancelar_ocupacion");
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Modificar fechas: ampliar/reducir/mover, atómico
// ---------------------------------------------------------------------------

export interface ResultadoModificarFechas {
  ocupacionId: string;
  rangoAnterior: RangoFechas;
  /** Rango efectivo tras la operación: igual a `rangoAnterior` si hubo conflicto (la
   * modificación se rechazó sin tocar la reserva). */
  rangoEfectivo: RangoFechas;
  conflicto: InfoConflicto | null;
  conflictosCapaCruzada: InfoConflicto[];
}

export async function modificarFechasReserva(ejecutor: EjecutorTransaccional, ocupacionId: string, nuevoRango: RangoFechas): Promise<ResultadoModificarFechas> {
  requireRangoValido(nuevoRango);

  await ejecutor.exec("SAVEPOINT sp_modificar_fechas_reserva");
  try {
    const filaInicial = await ejecutor.query<{ unidad_id: string; organization_id: string; property_id: string }>(
      `SELECT unidad_id, organization_id, property_id FROM rentas.ocupacion WHERE id = $1`,
      [ocupacionId],
    );
    if (filaInicial.rows.length === 0) {
      throw new RentasDomainError("ocupacion_no_encontrada", `rentas.ocupacion ${ocupacionId} no existe`);
    }
    const { unidad_id: unidadId, organization_id: organizationId, property_id: propertyId } = filaInicial.rows[0]!;
    // Mismo advisory lock que crearReservaConfirmada/crearBloqueo: evita que una
    // modificación y una inserción concurrentes sobre la misma unidad terminen en
    // deadlock (40P01) en vez de un exclusion_violation limpio (23P01).
    await bloquearUnidadEnTransaccion(ejecutor, unidadId);

    const actual = await ejecutor.query<{ inicio: string; fin: string; capa: string }>(
      `SELECT lower(rango)::text AS inicio, upper(rango)::text AS fin, capa
       FROM rentas.ocupacion WHERE id = $1 FOR UPDATE`,
      [ocupacionId],
    );
    if (actual.rows.length === 0) {
      throw new RentasDomainError("ocupacion_no_encontrada", `rentas.ocupacion ${ocupacionId} no existe`);
    }
    const fila = actual.rows[0]!;
    if (fila.capa !== "reserva") {
      throw new RentasDomainError("reserva_no_directa", "modificarFechasReserva solo aplica a filas capa='reserva'");
    }
    const rangoAnterior: RangoFechas = { inicio: fila.inicio, fin: fila.fin };

    await ejecutor.exec("SAVEPOINT intento_actualizacion");
    try {
      await ejecutor.query(`UPDATE rentas.ocupacion SET rango = daterange($2, $3, '[)'), version = version + 1, updated_at = now() WHERE id = $1`, [
        ocupacionId,
        nuevoRango.inicio,
        nuevoRango.fin,
      ]);
    } catch (error) {
      if (!esViolacionExclusion(error)) throw error;

      // La reserva ajena que causa el conflicto NUNCA se cancela ni se toca;
      // tampoco se degrada la reserva que intentó moverse — se deja exactamente en
      // su rango/estado anterior (rollback del intento) y solo se registra el
      // conflicto para revisión humana.
      await ejecutor.exec("ROLLBACK TO SAVEPOINT intento_actualizacion");

      const existente = await ejecutor.query<{ id: string }>(
        `SELECT id FROM rentas.ocupacion
         WHERE unidad_id = $1 AND id <> $2 AND capa = 'reserva' AND estado <> 'cancelado' AND bloqueante
           AND rango && daterange($3, $4, '[)')
         LIMIT 1`,
        [unidadId, ocupacionId, nuevoRango.inicio, nuevoRango.fin],
      );
      const ocupacionExistenteId = existente.rows[0]?.id ?? null;

      let conflicto: InfoConflicto | null = null;
      if (ocupacionExistenteId) {
        const conflictoInsertado = await ejecutor.query<{ id: string }>(
          `INSERT INTO rentas.conflicto_calendario (organization_id, property_id, unidad_id, ocupacion_a_id, ocupacion_b_id, tipo)
           VALUES ($1, $2, $3, $4, $5, 'overbooking_confirmado')
           RETURNING id`,
          [organizationId, propertyId, unidadId, ocupacionExistenteId, ocupacionId],
        );
        conflicto = {
          tipo: "overbooking_confirmado",
          conflictoId: conflictoInsertado.rows[0]!.id,
          ocupacionExistenteId,
        };
      }

      // El rango efectivo, tras rechazar el intento de modificación, sigue siendo
      // `rangoAnterior` — se verifica capa cruzada contra ESE rango (el que
      // realmente sigue vigente), no contra el rango rechazado.
      const conflictosCapaCruzada = await detectarYRegistrarConflictosCapaCruzada(ejecutor, organizationId, propertyId, unidadId, ocupacionId, rangoAnterior);

      await ejecutor.exec("RELEASE SAVEPOINT sp_modificar_fechas_reserva");
      return { ocupacionId, rangoAnterior, rangoEfectivo: rangoAnterior, conflicto, conflictosCapaCruzada };
    }

    // Una ampliación/movimiento de fechas que aterriza sobre un bloqueo de
    // propietario/mantenimiento/buffer se acepta igual (mismo criterio que
    // crearReservaConfirmada) y se registra como conflicto de capa cruzada.
    const conflictosCapaCruzada = await detectarYRegistrarConflictosCapaCruzada(ejecutor, organizationId, propertyId, unidadId, ocupacionId, nuevoRango);

    await ejecutor.exec("RELEASE SAVEPOINT sp_modificar_fechas_reserva");
    return { ocupacionId, rangoAnterior, rangoEfectivo: nuevoRango, conflicto: null, conflictosCapaCruzada };
  } catch (error) {
    await ejecutor.exec("ROLLBACK TO SAVEPOINT sp_modificar_fechas_reserva");
    await ejecutor.exec("RELEASE SAVEPOINT sp_modificar_fechas_reserva");
    throw error;
  }
}
