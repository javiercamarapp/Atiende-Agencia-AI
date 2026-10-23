// H-28 -- cambio de fechas de una reserva con recotizacion, en dos pasos:
//   POST  /hoteles/:propertyId/reservas/:id/fechas/previsualizar  -> cotizacion nueva vs actual, cupo, penalidad y bloqueos (solo lectura)
//   PATCH /hoteles/:propertyId/reservas/:id/fechas                -> aplica el cambio con guardia de precio (`totalEsperado`) e Idempotency-Key
// El total SIEMPRE lo calcula el motor de cotizacion determinista (`previsualizarCambioFechas`, domain-hoteles) con tarifas
// reales; si el total recalculado al confirmar difiere del que vio el staff, 409 `precio_cambio`. La escritura es la funcion
// atomica `hoteles.change_reservation_dates` (migracion 041): bloquea la reserva, no toca noches ya posteadas por el night-audit,
// libera/reserva inventario por noche con la sobreventa controlada y deja bitacora. Roles: owner, gm, frontdesk, reservations.
//
// MONTAJE: esta ruta cuelga de `/hoteles/:propertyId/reservas/*`, cuyo middleware (authMiddleware + dbSession +
// requirePropertyMembership) ya registra `reservas.ts` (se monta ANTES en hoteles.ts): aqui no se vuelve a registrar para no abrir
// dos transacciones por request.
//
// REGLA DURA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: la previsualizacion solo usa tablas anteriores a la 041 y funciona; confirmar
// responde 503 "no disponible aun" (SAVEPOINT en `PostgresCambioFechasRepository`), nunca un 500. Tras acortar fechas se ofrecen
// las noches liberadas a la lista de espera (best-effort, dentro de un SAVEPOINT: ver lista-espera-ofertas.ts).
import { Hono } from "hono";
import type { Context } from "hono";
import { ApiError, assertVerticalRole } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { hoyFechaNegocio, resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import {
  CambioFechasAccessDeniedError,
  CambioFechasConflictError,
  CambioFechasInvalidInputError,
  CambioFechasNotFoundError,
  CambioFechasUnavailableError,
  IdempotencyConflictError,
  MANAGE_RESERVATIONS_ROLES,
  PostgresCambioFechasRepository,
  esFechaIso,
  previsualizarCambioFechas,
  roundCurrency,
  type CambioFechasRepository,
  type PrevisualizacionCambioFechas,
  type ReservationRecord,
} from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { ofrecerListaEsperaTrasLiberacion } from "./lista-espera-ofertas.ts";

function toApiError(err: unknown): unknown {
  if (err instanceof CambioFechasUnavailableError) return Errors.serviceUnavailable(err.message);
  if (err instanceof CambioFechasNotFoundError) return Errors.notFound(err.message);
  if (err instanceof CambioFechasConflictError) return new ApiError(409, err.code, err.message);
  if (err instanceof CambioFechasInvalidInputError) return Errors.validation(err.message);
  if (err instanceof CambioFechasAccessDeniedError) return Errors.forbidden(err.message);
  return err;
}

const BLOQUEOS_DE_ENTRADA = new Set(["fechas_invalidas", "sin_cambio"]);

function serializePrevisualizacion(reservaId: string, p: PrevisualizacionCambioFechas) {
  return {
    reservaId,
    estado: p.estado,
    moneda: "MXN",
    puedeCambiar: p.puedeCambiar,
    bloqueos: p.bloqueos,
    actual: p.actual,
    nueva: p.nueva,
    diferenciaTotal: p.diferenciaTotal,
    nochesAgregadas: p.nochesAgregadas,
    nochesQuitadas: p.nochesQuitadas,
    nochesSinCupo: p.nochesSinCupo,
    penalidad: p.penalidad,
  };
}

function serializeReserva(r: ReservationRecord) {
  return {
    id: r.id,
    propertyId: r.propertyId,
    roomTypeId: r.roomTypeId,
    guestId: r.guestId,
    checkInDate: r.checkInDate,
    checkOutDate: r.checkOutDate,
    estado: r.status,
    montoTotal: r.totalAmount,
    roomId: r.roomId,
  };
}

interface CuerpoFechas {
  readonly checkInDate?: unknown;
  readonly checkOutDate?: unknown;
  readonly totalEsperado?: unknown;
  readonly motivo?: unknown;
}

export function hotelesReservasFechasRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const fechasRepo = (c: Context<CoreAuthHonoEnv>): CambioFechasRepository =>
    deps.hotelesFechasRepo ? deps.hotelesFechasRepo(c.get("db")) : new PostgresCambioFechasRepository(c.get("db"));

  function leerFechas(raw: CuerpoFechas): { entrada: string; salida: string } {
    if (!esFechaIso(raw.checkInDate)) throw Errors.validation("checkInDate: formato de fecha esperado YYYY-MM-DD.");
    if (!esFechaIso(raw.checkOutDate)) throw Errors.validation("checkOutDate: formato de fecha esperado YYYY-MM-DD.");
    return { entrada: raw.checkInDate, salida: raw.checkOutDate };
  }

  /** Lecturas en SECUENCIA: comparten la misma sesion transaccional. */
  async function calcular(c: Context<CoreAuthHonoEnv>, propertyId: string, reserva: ReservationRecord, entrada: string, salida: string): Promise<PrevisualizacionCambioFechas> {
    const repo = deps.hotelesRepo(c.get("db"));
    const tz = await repo.findPropertyTimezone(propertyId);
    const hoy = hoyFechaNegocio(resolverZonaHorariaNegocio(tz));
    const desde = reserva.checkInDate < entrada ? reserva.checkInDate : entrada;
    const hasta = reserva.checkOutDate > salida ? reserva.checkOutDate : salida;
    const impuestos = await repo.loadTaxConfig(propertyId);
    const tarifas = await repo.loadNightlyRates(propertyId, reserva.roomTypeId, desde, hasta);
    const politica = await repo.loadReservationCancellationPolicy(propertyId);
    const disponibilidad = await fechasRepo(c).cargarDisponibilidad(propertyId, reserva.roomTypeId, desde, hasta);
    return previsualizarCambioFechas({
      estado: reserva.status,
      entrada: reserva.checkInDate,
      salida: reserva.checkOutDate,
      totalNeto: reserva.totalAmount,
      nuevaEntrada: entrada,
      nuevaSalida: salida,
      hoy,
      ahora: new Date(),
      tarifas,
      impuestos: { ivaRate: impuestos.ivaRate, ishRate: impuestos.ishRate },
      politica,
      disponibilidad,
    });
  }

  app.post("/hoteles/:propertyId/reservas/:id/fechas/previsualizar", async (c) => {
    assertVerticalRole(c, MANAGE_RESERVATIONS_ROLES);
    const propertyId = c.req.param("propertyId");
    const raw = await readJsonCapped<CuerpoFechas>(c.req.raw, 2 * 1024);
    const { entrada, salida } = leerFechas(raw);
    const reserva = await deps.hotelesRepo(c.get("db")).findReservation(propertyId, c.req.param("id"));
    if (!reserva) throw Errors.notFound("Reserva no encontrada.");
    const p = await calcular(c, propertyId, reserva, entrada, salida);
    return c.json(serializePrevisualizacion(reserva.id, p));
  });

  app.patch("/hoteles/:propertyId/reservas/:id/fechas", async (c) => {
    assertVerticalRole(c, MANAGE_RESERVATIONS_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();
    const propertyId = c.req.param("propertyId");
    const organizationId = c.get("organizationId");
    const raw = await readJsonCapped<CuerpoFechas>(c.req.raw, 2 * 1024);
    const { entrada, salida } = leerFechas(raw);
    if (typeof raw.totalEsperado !== "number" || !Number.isFinite(raw.totalEsperado) || raw.totalEsperado < 0) throw Errors.validation("totalEsperado: se esperaba el total (con impuestos) que vio el staff en la previsualizacion.");
    const motivo = typeof raw.motivo === "string" && raw.motivo.trim().length > 0 ? raw.motivo.trim() : null;
    if (motivo !== null && (motivo.length < 3 || motivo.length > 200)) throw Errors.validation("motivo: entre 3 y 200 caracteres.");

    const repo = deps.hotelesRepo(c.get("db"));
    const reservationId = c.req.param("id");

    try {
      // TODO el cuerpo de negocio (lecturas, guardias y escritura) va DENTRO de `withIdempotency`: un reintento con la misma
      // Idempotency-Key devuelve la respuesta guardada SIN volver a evaluar contra el estado ya cambiado (si no, el reintento
      // de un cambio exitoso toparia con "sin_cambio"). Un error dentro revierte la transaccion y libera la llave.
      const result = await repo.withIdempotency(
        { organizationId, scope: "reservation.change_dates", key: idempotencyKey, body: { reservationId, entrada, salida, totalEsperado: roundCurrency(raw.totalEsperado) } },
        async () => {
          const reserva = await repo.findReservation(propertyId, reservationId);
          if (!reserva) throw Errors.notFound("Reserva no encontrada.");
          const p = await calcular(c, propertyId, reserva, entrada, salida);
          const bloqueo = p.bloqueos[0];
          if (bloqueo) {
            if (BLOQUEOS_DE_ENTRADA.has(bloqueo.codigo)) throw Errors.validation(bloqueo.mensaje);
            throw new ApiError(409, bloqueo.codigo, bloqueo.mensaje);
          }
          const nueva = p.nueva;
          if (!nueva) throw new ApiError(409, "sin_cotizacion", "No se pudo cotizar la nueva estancia.");
          // Guardia de precio: el total recalculado al confirmar debe ser el que el staff vio al previsualizar.
          if (roundCurrency(nueva.total) !== roundCurrency(raw.totalEsperado as number)) {
            throw new ApiError(409, "precio_cambio", `El total cambio: ahora es ${nueva.total.toFixed(2)} y esperabas ${roundCurrency(raw.totalEsperado as number).toFixed(2)}. Vuelve a previsualizar.`);
          }
          const aplicado = await fechasRepo(c).aplicarCambio({
            propertyId,
            reservationId: reserva.id,
            esperadaEntrada: reserva.checkInDate,
            esperadaSalida: reserva.checkOutDate,
            nuevaEntrada: entrada,
            nuevaSalida: salida,
            nuevoTotalNeto: nueva.neto,
            penalidad: p.penalidad.monto,
            motivo,
          });
          // Noches liberadas -> lista de espera (best-effort, dentro de un SAVEPOINT).
          const ofertas = await ofrecerListaEsperaTrasLiberacion(deps, c.get("db"), { organizationId, propertyId, roomTypeId: reserva.roomTypeId, noches: p.nochesQuitadas }, c.get("postCommitTasks"));
          const actualizada = await repo.findReservation(propertyId, reserva.id);
          return {
            status: 200,
            body: {
              reserva: actualizada ? serializeReserva(actualizada) : null,
              cambio: { entradaAnterior: aplicado.entradaAnterior, salidaAnterior: aplicado.salidaAnterior, nochesLiberadas: aplicado.nochesLiberadas, nochesReservadas: aplicado.nochesReservadas },
              totalAnterior: p.actual.total,
              totalNuevo: nueva.total,
              penalidad: p.penalidad,
              ofertasListaEspera: ofertas,
            },
          };
        },
      );
      return c.json(result.body as object, result.status as 200);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) throw Errors.idempotencyConflict();
      throw toApiError(err);
    }
  });

  return app;
}
