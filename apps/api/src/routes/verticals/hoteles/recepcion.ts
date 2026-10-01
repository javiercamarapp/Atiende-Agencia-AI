// H-28 -- /hoteles/:propertyId/recepcion: vista de RECEPCION / front desk. Llegadas, salidas y en casa del dia (en la zona
// horaria de la property), rack de habitaciones con el estado de limpieza, check-in y check-out de un clic y cambio de
// habitacion. No duplica logica: el estado de la reserva lo mueve `transitionReservation` con la tabla de transiciones
// de domain-hoteles (mismos roles que la ruta generica), el estado de limpieza sale de `HousekeepingRepository.getBoard`
// y la asignacion de habitacion es la funcion atomica `hoteles.change_reservation_room` (migracion 038).
//
// Privacidad (H-02): el tablero solo expone nombre del huesped y si ya hay identidad registrada (un booleano); el
// documento nunca viaja aqui, se captura y revela solo en la boveda de identidad (check-in).
//
// REGLA DURA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: contra una base anterior a la migracion 038 el tablero, el
// check-in con la habitacion ya asignada y el check-out funcionan igual (solo usan tablas anteriores); asignar o
// cambiar de habitacion cae al camino anterior (asignacion simple con revision de traslape en la aplicacion) en el
// check-in, y responde 503 "no disponible aun" en el cambio de habitacion. Nunca un 500.
import { Hono } from "hono";
import type { Context } from "hono";
import { ApiError, authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { hoyFechaNegocio, resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import {
  HousekeepingAccessDeniedError,
  HousekeepingConflictError,
  HousekeepingInvalidInputError,
  HousekeepingNotFoundError,
  HousekeepingUnavailableError,
  PostgresHousekeepingRepository,
  PostgresRecepcionRepository,
  RECEPCION_OPERATE_ROLES,
  RECEPCION_VIEW_ROLES,
  RecepcionAccessDeniedError,
  RecepcionConflictError,
  RecepcionInvalidInputError,
  RecepcionNotFoundError,
  RecepcionUnavailableError,
  clasificarRecepcion,
  isInHouse,
  isIsoDate,
  ocupacionDeHabitacion,
  type HousekeepingRepository,
  type RecepcionMovimiento,
  type RecepcionRepository,
  type ReservationRecord,
  type RoomSummary,
} from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toApiError(err: unknown): unknown {
  if (err instanceof RecepcionUnavailableError) return Errors.serviceUnavailable(err.message);
  if (err instanceof RecepcionNotFoundError) return Errors.notFound(err.message);
  if (err instanceof RecepcionConflictError) return new ApiError(409, err.code, err.message);
  if (err instanceof RecepcionInvalidInputError) return Errors.validation(err.message);
  if (err instanceof RecepcionAccessDeniedError) return Errors.forbidden(err.message);
  if (err instanceof HousekeepingUnavailableError) return Errors.serviceUnavailable(err.message);
  if (err instanceof HousekeepingNotFoundError) return Errors.notFound(err.message);
  if (err instanceof HousekeepingConflictError) return Errors.conflict(err.message);
  if (err instanceof HousekeepingInvalidInputError) return Errors.validation(err.message);
  if (err instanceof HousekeepingAccessDeniedError) return Errors.forbidden(err.message);
  return err;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toApiError(err);
  }
}

function serializeMovimiento(m: RecepcionMovimiento, identidad: ReadonlySet<string> | null) {
  return {
    reservaId: m.reservationId,
    estado: m.status,
    huesped: m.guestId ? { id: m.guestId, nombre: m.guestName } : null,
    tipoHabitacion: m.roomTypeId ? { id: m.roomTypeId, nombre: m.roomTypeName } : null,
    habitacion: m.roomId ? { id: m.roomId, codigo: m.roomCode } : null,
    entrada: m.checkInDate,
    salida: m.checkOutDate,
    noches: m.noches,
    salidaVencida: m.salidaVencida,
    // null = la boveda de identidad aun no esta disponible en esta base: no se afirma ni se niega.
    identidadRegistrada: m.guestId === null || identidad === null ? null : identidad.has(m.guestId),
  };
}

function serializeReserva(r: ReservationRecord) {
  return {
    id: r.id,
    roomTypeId: r.roomTypeId,
    guestId: r.guestId,
    checkInDate: r.checkInDate,
    checkOutDate: r.checkOutDate,
    estado: r.status,
    roomId: r.roomId,
  };
}

export function hotelesRecepcionRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/hoteles/:propertyId/recepcion", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/recepcion/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  const recepRepo = (c: Context<CoreAuthHonoEnv>): RecepcionRepository =>
    deps.hotelesRecepcionRepo ? deps.hotelesRecepcionRepo(c.get("db")) : new PostgresRecepcionRepository(c.get("db"));
  const hkRepo = (c: Context<CoreAuthHonoEnv>): HousekeepingRepository =>
    deps.hotelesHousekeepingRepo ? deps.hotelesHousekeepingRepo(c.get("db")) : new PostgresHousekeepingRepository(c.get("db"));

  async function hoy(c: Context<CoreAuthHonoEnv>, propertyId: string): Promise<string> {
    const tz = await deps.hotelesRepo(c.get("db")).findPropertyTimezone(propertyId);
    return hoyFechaNegocio(resolverZonaHorariaNegocio(tz));
  }

  async function bodyOf(c: Context<CoreAuthHonoEnv>): Promise<Record<string, unknown>> {
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, 1024).catch((err: unknown) => {
      if (err instanceof ApiError) throw err;
      return {};
    });
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  }

  /** Habitacion apta para recibir a un huesped que llega: solo `disponible` (limpia e inspeccionada). */
  function assertRoomReadyForArrival(room: RoomSummary): void {
    if (room.status === "disponible") return;
    if (room.status === "sucia") throw new ApiError(409, "habitacion_no_lista", `La habitacion ${room.code} esta sucia: espera su inspeccion o elige otra.`);
    throw new ApiError(409, "habitacion_no_disponible", `La habitacion ${room.code} no esta disponible (${room.status.replace("_", " ")}).`);
  }

  // ---- Tablero del dia ----------------------------------------------------------------------------------------------
  app.get("/hoteles/:propertyId/recepcion", async (c) => {
    assertVerticalRole(c, RECEPCION_VIEW_ROLES);
    const propertyId = c.req.param("propertyId");
    const rawFecha = c.req.query("fecha");
    if (rawFecha !== undefined && !isIsoDate(rawFecha)) throw Errors.validation("fecha: formato esperado YYYY-MM-DD.");
    const fecha = rawFecha ?? (await hoy(c, propertyId));

    const repo = recepRepo(c);
    const dia = clasificarRecepcion(await guarded(() => repo.listarReservasDelDia(propertyId, fecha)), fecha);
    const guestIds = [...new Set([...dia.llegadas, ...dia.enCasa].map((m) => m.guestId).filter((g): g is string => g !== null))];
    const identidad = await guarded(() => repo.huespedesConIdentidad(propertyId, guestIds));
    // En SECUENCIA, nunca con Promise.all: ambas lecturas comparten la MISMA sesion transaccional y `getBoard` degrada con
    // SAVEPOINT/ROLLBACK TO ante una base sin migrar (033); un `listRooms` en vuelo se intercalaria y daria 25P02/500.
    const board = await guarded(() => hkRepo(c).getBoard(propertyId, fecha));
    const rooms = await deps.hotelesRepo(c.get("db")).listRooms(propertyId);
    const roomTypeById = new Map(rooms.map((r) => [r.id, r.roomTypeId]));

    const rack = board.rows.map((row) => {
      const { ocupacion, reserva } = ocupacionDeHabitacion(dia, row.roomId);
      return {
        roomId: row.roomId,
        codigo: row.code,
        tipoHabitacionId: roomTypeById.get(row.roomId) ?? null,
        tipoHabitacion: row.roomType,
        estado: row.roomStatus,
        limpieza: row.task ? { tareaId: row.task.id, tipo: row.task.taskType, estado: row.task.status } : null,
        fueraDeServicio: row.outOfService ? { motivo: row.outOfService.reason, regresoEstimado: row.outOfService.expectedReturnDate } : null,
        ocupacion,
        reserva: reserva ? { reservaId: reserva.reservationId, huesped: reserva.guestName, entrada: reserva.checkInDate, salida: reserva.checkOutDate } : null,
      };
    });

    const llegadasPendientes = dia.llegadas.filter((m) => m.status === "confirmada").length;
    const salidasPendientes = dia.salidas.filter((m) => isInHouse(m.status)).length;
    return c.json({
      fecha,
      tareasDisponibles: board.tareasDisponibles,
      identidadDisponible: identidad !== null,
      resumen: {
        llegadas: dia.llegadas.length,
        llegadasPendientes,
        salidas: dia.salidas.length,
        salidasPendientes,
        enCasa: dia.enCasa.length,
        habitacionesLibres: rack.filter((r) => r.estado === "disponible" && r.ocupacion === "libre").length,
        habitacionesSucias: rack.filter((r) => r.estado === "sucia").length,
        habitacionesFueraDeServicio: rack.filter((r) => r.estado === "fuera_de_servicio" || r.estado === "mantenimiento").length,
      },
      llegadas: dia.llegadas.map((m) => serializeMovimiento(m, identidad)),
      salidas: dia.salidas.map((m) => serializeMovimiento(m, identidad)),
      enCasa: dia.enCasa.map((m) => serializeMovimiento(m, identidad)),
      rack,
    });
  });

  // ---- Check-in de un clic ------------------------------------------------------------------------------------------
  // confirmada -> check_in -> en_estancia en la misma transaccion, con la habitacion asignada (la de la reserva o la
  // elegida en el body). Reglas: la llegada no puede ser futura ni la estancia ya vencida, la habitacion debe estar limpia
  // y disponible y ninguna otra reserva activa puede traslaparla (sin doble ocupacion).
  app.post("/hoteles/:propertyId/recepcion/reservas/:id/check-in", async (c) => {
    assertVerticalRole(c, RECEPCION_OPERATE_ROLES);
    const propertyId = c.req.param("propertyId");
    const reservationId = c.req.param("id");
    const userId = c.get("userId");
    const raw = await bodyOf(c);
    if (raw.roomId !== undefined && raw.roomId !== null && (typeof raw.roomId !== "string" || !UUID_RE.test(raw.roomId))) throw Errors.validation("roomId: se esperaba un UUID.");

    const repo = deps.hotelesRepo(c.get("db"));
    const reservation = await repo.findReservation(propertyId, reservationId);
    if (!reservation) throw Errors.notFound("Reserva no encontrada.");
    if (reservation.status !== "confirmada") throw Errors.reservaTransicionInvalida(reservation.status, "check_in");

    const hoyLocal = await hoy(c, propertyId);
    if (reservation.checkInDate > hoyLocal) throw new ApiError(409, "llegada_no_es_hoy", `La llegada es el ${reservation.checkInDate}: aun no se puede hacer el check-in.`);
    if (reservation.checkOutDate <= hoyLocal) throw new ApiError(409, "estancia_vencida", "La fecha de salida de esta reserva ya paso: no se puede hacer el check-in.");

    const roomId = (typeof raw.roomId === "string" ? raw.roomId : null) ?? reservation.roomId;
    if (!roomId) throw Errors.validation("roomId requerido: la reserva aun no tiene habitacion asignada.");
    const room = await repo.findRoom(propertyId, roomId);
    if (!room) throw Errors.notFound("Habitacion no encontrada en esta property.");
    if (room.roomTypeId !== reservation.roomTypeId) throw Errors.validation(`La habitacion "${room.code}" es de un tipo de habitacion distinto al de esta reserva.`);
    assertRoomReadyForArrival(room);

    const recep = recepRepo(c);
    if (roomId !== reservation.roomId) {
      try {
        await recep.cambiarHabitacion(propertyId, reservationId, roomId, "Asignacion en el check-in");
      } catch (err) {
        if (!(err instanceof RecepcionUnavailableError)) throw toApiError(err);
        // Base sin la migracion 038: camino anterior (asignacion simple) con la revision de traslape en la aplicacion.
        const traslape = await guarded(() => recep.buscarTraslapeDeHabitacion(propertyId, roomId, reservation.checkInDate, reservation.checkOutDate, reservationId));
        if (traslape) throw new ApiError(409, "habitacion_ocupada", `La habitacion ${room.code} tiene otra reserva en esas fechas.`);
        const assigned = await repo.assignRoomToReservation(propertyId, reservationId, roomId);
        if (!assigned) throw Errors.notFound("Reserva no encontrada.");
      }
    } else {
      const traslape = await guarded(() => recep.buscarTraslapeDeHabitacion(propertyId, roomId, reservation.checkInDate, reservation.checkOutDate, reservationId));
      if (traslape) throw new ApiError(409, "habitacion_ocupada", `La habitacion ${room.code} tiene otra reserva en esas fechas.`);
    }

    const enCheckIn = await repo.transitionReservation(propertyId, reservationId, ["confirmada"], "check_in", userId);
    if (!enCheckIn) throw Errors.reservaConflictoDeEstado();
    const enEstancia = await repo.transitionReservation(propertyId, reservationId, ["check_in"], "en_estancia", userId);
    if (!enEstancia) throw Errors.reservaConflictoDeEstado();

    // El huesped ya esta en la habitacion: queda `ocupada` (asi el dia genera su tarea de estancia y el check-out la pasa a `sucia`).
    // Consecuencia, no condicion: `markRoomOccupied` corre dentro de un SAVEPOINT y un fallo no invalida el check-in.
    let habitacionMarcadaOcupada = false;
    try {
      habitacionMarcadaOcupada = (await hkRepo(c).markRoomOccupied(propertyId, roomId)) !== null;
    } catch {
      habitacionMarcadaOcupada = false;
    }
    const identidad = enEstancia.guestId ? await guarded(() => recep.huespedesConIdentidad(propertyId, [enEstancia.guestId as string])) : new Set<string>();
    return c.json({
      ...serializeReserva(enEstancia),
      habitacion: { id: room.id, codigo: room.code },
      habitacionMarcadaOcupada,
      identidadRegistrada: enEstancia.guestId === null || identidad === null ? null : identidad.has(enEstancia.guestId),
    });
  });

  // ---- Check-out de un clic -----------------------------------------------------------------------------------------
  // en_estancia -> check_out y la habitacion queda `sucia` para limpieza. El folio NO se cierra aqui (sigue su propio
  // flujo: saldo cero o cuenta por cobrar con aprobacion); la respuesta avisa cuantos folios siguen abiertos.
  app.post("/hoteles/:propertyId/recepcion/reservas/:id/check-out", async (c) => {
    assertVerticalRole(c, RECEPCION_OPERATE_ROLES);
    const propertyId = c.req.param("propertyId");
    const reservationId = c.req.param("id");
    const userId = c.get("userId");
    const repo = deps.hotelesRepo(c.get("db"));
    const reservation = await repo.findReservation(propertyId, reservationId);
    if (!reservation) throw Errors.notFound("Reserva no encontrada.");
    if (!isInHouse(reservation.status)) throw Errors.reservaTransicionInvalida(reservation.status, "check_out");

    if (reservation.status === "check_in") {
      const enEstancia = await repo.transitionReservation(propertyId, reservationId, ["check_in"], "en_estancia", userId);
      if (!enEstancia) throw Errors.reservaConflictoDeEstado();
    }
    const salida = await repo.transitionReservation(propertyId, reservationId, ["en_estancia"], "check_out", userId);
    if (!salida) throw Errors.reservaConflictoDeEstado();

    // La limpieza de la habitacion es consecuencia, no condicion: si no se pudo marcar (rol, estado), el check-out ya
    // es valido y la camarista la ve en el tablero. `markRoomDirty` corre dentro de un SAVEPOINT: la sesion sigue sana.
    let habitacionMarcadaSucia = false;
    if (reservation.roomId) {
      try {
        habitacionMarcadaSucia = (await hkRepo(c).markRoomDirty(propertyId, reservation.roomId)) !== null;
      } catch {
        habitacionMarcadaSucia = false;
      }
    }
    const folios = await repo.listFoliosByReservation(propertyId, reservationId);
    return c.json({ ...serializeReserva(salida), habitacionMarcadaSucia, foliosAbiertos: folios.filter((f) => f.status === "abierto").length });
  });

  // ---- Cambio de habitacion -----------------------------------------------------------------------------------------
  app.post("/hoteles/:propertyId/recepcion/reservas/:id/cambiar-habitacion", async (c) => {
    assertVerticalRole(c, RECEPCION_OPERATE_ROLES);
    const propertyId = c.req.param("propertyId");
    const reservationId = c.req.param("id");
    const raw = await bodyOf(c);
    if (typeof raw.roomId !== "string" || !UUID_RE.test(raw.roomId)) throw Errors.validation("roomId: se esperaba un UUID.");
    const motivo = typeof raw.motivo === "string" && raw.motivo.trim().length > 0 ? raw.motivo.trim() : null;
    if (motivo !== null && (motivo.length < 3 || motivo.length > 200)) throw Errors.validation("motivo: entre 3 y 200 caracteres.");

    const repo = deps.hotelesRepo(c.get("db"));
    const reservation = await repo.findReservation(propertyId, reservationId);
    if (!reservation) throw Errors.notFound("Reserva no encontrada.");
    const result = await guarded(() => recepRepo(c).cambiarHabitacion(propertyId, reservationId, raw.roomId as string, motivo));
    const updated = await repo.findReservation(propertyId, reservationId);
    return c.json({ ...(updated ? serializeReserva(updated) : serializeReserva(reservation)), habitacionAnteriorId: result.fromRoomId, habitacionId: result.toRoomId });
  });

  return app;
}
