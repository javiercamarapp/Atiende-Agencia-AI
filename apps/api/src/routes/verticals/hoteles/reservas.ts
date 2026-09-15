// H02 (Fase 3) · /hoteles/:propertyId/reservas: máquina de estados de reservas —
// crear (aterriza directo en `confirmada`, salta `cotizada`, ver diseño Fase 3 §3.2),
// transición genérica (check_in/en_estancia/check_out/cerrada), cancelar (con efectos
// secundarios propios: libera inventario + penalización) y procesar-no-show (job por
// HTTP, actor lógico "system"). Motor de estados/guardias SIEMPRE en
// @atiende/domain-hoteles (reservationStateMachine.ts/folioEngine.ts) — esta ruta
// nunca decide por su cuenta si una transición es válida ni calcula un monto de
// penalización a mano.
//
// Mismo patrón de montaje que folios.ts/pedidosFnb.ts: authMiddleware + dbSession +
// requirePropertyMembership("propertyId") (sin allowedRoles de plataforma), filtrado
// fino con assertVerticalRole/canRolePerformTransition dentro de cada handler.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { ApiError } from "@atiende/core-auth";
import {
  ADMIN_ROLES,
  MANAGE_RESERVATIONS_ROLES,
  QuoteError,
  QuoteInputValidationError,
  parseQuoteInput,
  computeQuote,
  nightsBetween,
  canTransition,
  canRolePerformTransition,
  isCancellable,
  isReservationStatus,
  evaluateCancellation,
  roundCurrency,
  IdempotencyConflictError,
  type HotelRole,
  type ReservationStatus,
  type ReservationRecord,
} from "@atiende/domain-hoteles";
import { runNoShowSweep } from "@atiende/worker";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Mapa de códigos de dominio (@atiende/domain-hoteles::QuoteError) -> estatus HTTP —
// idéntico al de quotes.ts (mismo motor, mismo significado de cada código).
const QUOTE_CODE_STATUS: Record<string, number> = {
  estadia_invalida: 400,
  sin_tarifa: 409,
  cerrado_a_llegada: 409,
  cerrado_a_salida: 409,
  estadia_minima_no_alcanzada: 409,
};

// Transiciones alcanzables desde la ruta GENÉRICA — `cancelada`/`no_show` tienen
// efectos secundarios propios (liberar inventario/penalización) que solo garantizan
// sus rutas dedicadas (diseño §5), así que quedan excluidas aquí sin importar si
// `canTransition` las consideraría válidas para el estado actual. `confirmada` (desde
// `cotizada`) tampoco se expone: esta fase nunca crea una reserva en `cotizada`
// (§3.2), así que no hay reserva real desde la que alcanzarla por esta ruta.
const GENERIC_TRANSITION_TARGETS: ReadonlySet<ReservationStatus> = new Set(["check_in", "en_estancia", "check_out", "cerrada"]);

interface CrearReservaBody {
  readonly roomTypeId?: unknown;
  readonly checkInDate?: unknown;
  readonly checkOutDate?: unknown;
  readonly guestId?: unknown;
}

interface TransicionBody {
  readonly toStatus?: unknown;
}

interface CancelarBody {
  readonly motivo?: unknown;
}

interface ProcesarNoShowBody {
  readonly asOfDate?: unknown;
}

function serializeReservation(r: ReservationRecord) {
  return {
    id: r.id,
    propertyId: r.propertyId,
    roomTypeId: r.roomTypeId,
    guestId: r.guestId,
    checkInDate: r.checkInDate,
    checkOutDate: r.checkOutDate,
    estado: r.status,
    montoTotal: r.totalAmount,
    penalizacionCancelacion: r.cancellationPenaltyAmount,
    canceladaEn: r.canceledAt,
    creadaEn: r.createdAt,
  };
}

export function hotelesReservasRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/hoteles/:propertyId/reservas", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/reservas/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  // Fix hallazgo ALTA — catálogos de solo lectura que le faltaban al formulario de
  // "crear reserva" (ver HotelesRepository.listRoomTypes/searchGuests): antes de
  // esto no existía NINGÚN GET de tipos de habitación ni de huéspedes, así que el
  // panel de recepción exigía pegar un UUID a mano. Mismo montaje que las rutas de
  // arriba y mismo criterio de acceso que GET /reservas (cualquier staff de la
  // property puede leer) — la restricción fina de quién puede CREAR la reserva ya la
  // aplica `MANAGE_RESERVATIONS_ROLES` en el POST de abajo.
  app.use("/hoteles/:propertyId/tipos-habitacion", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/huespedes", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // Superficie mínima consultable (diseño §5) — sin roles finos, cualquier staff de la
  // property puede leer, mismo criterio que GET /pedidos-fnb.
  app.get("/hoteles/:propertyId/reservas", async (c) => {
    const repo = deps.hotelesRepo(c.get("db"));
    const reservas = await repo.listReservations(c.req.param("propertyId"));
    return c.json(reservas.map(serializeReservation));
  });

  // Fix hallazgo ALTA — catálogo de tipos de habitación de la property (ver
  // HotelesRepository.listRoomTypes). Insumo directo del <select> de "tipo de
  // habitación" en el formulario de crear reserva del panel web.
  app.get("/hoteles/:propertyId/tipos-habitacion", async (c) => {
    const repo = deps.hotelesRepo(c.get("db"));
    const tipos = await repo.listRoomTypes(c.req.param("propertyId"));
    return c.json(tipos.map((t) => ({ id: t.id, nombre: t.name, capacidadMaxima: t.maxOccupancy })));
  });

  // Fix hallazgo ALTA — búsqueda de huéspedes YA registrados de la property (ver
  // HotelesRepository.searchGuests). `?q=` es opcional: sin query devuelve las
  // primeras filas en orden alfabético (insumo de un autocomplete recién abierto).
  // NO crea huéspedes nuevos (fuera del hallazgo asignado) -- `guestId` sigue siendo
  // opcional en `POST .../reservas`, mismo criterio de walk-in sin huésped capturado
  // que ya tenía esta ruta antes de este fix.
  app.get("/hoteles/:propertyId/huespedes", async (c) => {
    const repo = deps.hotelesRepo(c.get("db"));
    const q = c.req.query("q")?.trim() || null;
    const huespedes = await repo.searchGuests(c.req.param("propertyId"), q);
    return c.json(huespedes.map((g) => ({ id: g.id, nombreCompleto: g.fullName, email: g.email, telefono: g.phone })));
  });

  app.get("/hoteles/:propertyId/reservas/:id", async (c) => {
    const repo = deps.hotelesRepo(c.get("db"));
    const reservation = await repo.findReservation(c.req.param("propertyId"), c.req.param("id"));
    if (!reservation) throw Errors.notFound("Reserva no encontrada.");
    return c.json(serializeReservation(reservation));
  });

  app.post("/hoteles/:propertyId/reservas", async (c) => {
    assertVerticalRole(c, MANAGE_RESERVATIONS_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const raw = await readJsonCapped<CrearReservaBody>(c.req.raw, 4 * 1024);

    if (typeof raw.roomTypeId !== "string" || raw.roomTypeId.length === 0) throw Errors.validation("roomTypeId requerido.");
    if (typeof raw.checkInDate !== "string" || !DATE_RE.test(raw.checkInDate)) throw Errors.validation("checkInDate: formato de fecha esperado YYYY-MM-DD.");
    if (typeof raw.checkOutDate !== "string" || !DATE_RE.test(raw.checkOutDate)) throw Errors.validation("checkOutDate: formato de fecha esperado YYYY-MM-DD.");
    if (raw.checkOutDate <= raw.checkInDate) throw Errors.validation("checkOutDate debe ser posterior a checkInDate.");
    const roomTypeId = raw.roomTypeId;
    const checkInDate = raw.checkInDate;
    const checkOutDate = raw.checkOutDate;
    const guestId = typeof raw.guestId === "string" && raw.guestId.length > 0 ? raw.guestId : null;

    const repo = deps.hotelesRepo(c.get("db"));
    const roomType = await repo.findRoomType(propertyId, roomTypeId);
    if (!roomType) throw Errors.notFound("Tipo de habitación no encontrado en esta property.");

    // REQ-REV-001/REQ-RES-002: el total SIEMPRE lo calcula el motor de cotización
    // determinista desde tarifas reales — jamás un monto que mande el cliente HTTP
    // (mismo criterio que quotes.ts, ver @atiende/domain-hoteles::parseQuoteInput).
    const taxConfig = await repo.loadTaxConfig(propertyId);
    const nightlyRates = await repo.loadNightlyRates(propertyId, roomTypeId, checkInDate, checkOutDate);

    let totalAmount: number;
    try {
      const quoteInput = parseQuoteInput({
        checkInDate,
        checkOutDate,
        taxConfig: { ivaRate: taxConfig.ivaRate, ishRate: taxConfig.ishRate },
        nightlyRates,
      });
      // NETO, nunca el total con impuestos (ver ReservationRecord.totalAmount) — evita
      // que la penalización de no-show vuelva a gravar un monto ya gravado (§3.4).
      totalAmount = computeQuote(quoteInput).netAmount;
    } catch (err) {
      if (err instanceof QuoteError) {
        const status = QUOTE_CODE_STATUS[err.code] ?? 409;
        throw new ApiError(status, err.code, err.message);
      }
      if (err instanceof QuoteInputValidationError) throw Errors.validation(err.message);
      throw err;
    }

    const nights = nightsBetween(checkInDate, checkOutDate);

    try {
      const result = await repo.withIdempotency(
        { organizationId, scope: "reservation.create", key: idempotencyKey, body: { roomTypeId, checkInDate, checkOutDate, guestId } },
        async () => {
          // Reserva noche por noche (advisory lock/atomicidad real dentro de
          // `bookAvailability`, ver migrations/003_availability.sql) — honra la misma
          // sobreventa controlada que el resto del vertical.
          for (const night of nights) {
            await repo.bookAvailability(propertyId, roomTypeId, night, 1);
          }
          const reservation = await repo.insertReservation({
            organizationId,
            propertyId,
            roomTypeId,
            guestId,
            checkInDate,
            checkOutDate,
            totalAmount,
            idempotencyKey,
          });
          // El folio primario nace en el mismo instante en que la reserva se vuelve
          // real (diseño §1: "el folio principal se crea al confirmar") — esta fase
          // salta `cotizada`, así que creación y confirmación son la misma operación.
          await repo.ensurePrimaryFolio(propertyId, organizationId, reservation.id);
          return { status: 201, body: serializeReservation(reservation) };
        },
      );
      return c.json(result.body as object, result.status as 201);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) throw Errors.idempotencyConflict();
      if (err instanceof Error && err.message.startsWith("sin_disponibilidad")) throw Errors.reservaSinDisponibilidad(err.message);
      if (err instanceof Error && err.message.startsWith("tipo_habitacion_invalido")) throw Errors.notFound(err.message);
      if (err instanceof Error && err.message.startsWith("cantidad_invalida")) throw Errors.validation(err.message);
      throw err;
    }
  });

  // Transición GENÉRICA del ciclo de vida (check_in/en_estancia/check_out/cerrada) —
  // el rol permitido depende de (from,to), NUNCA un rol fijo por ruta (diseño §5), así
  // que se evalúa con `canRolePerformTransition` en vez de `assertVerticalRole` con una
  // lista estática.
  app.patch("/hoteles/:propertyId/reservas/:id/transicion", async (c) => {
    const propertyId = c.req.param("propertyId");
    const reservationId = c.req.param("id");
    const verticalRole = c.get("verticalRole");
    const userId = c.get("userId");
    const raw = await readJsonCapped<TransicionBody>(c.req.raw, 1024);

    if (typeof raw.toStatus !== "string" || !isReservationStatus(raw.toStatus)) {
      throw Errors.validation("toStatus: se esperaba un estado de reserva válido.");
    }
    const toStatus = raw.toStatus;
    if (!GENERIC_TRANSITION_TARGETS.has(toStatus)) throw Errors.reservaTransicionNoPermitidaPorRuta(toStatus);

    const repo = deps.hotelesRepo(c.get("db"));
    const reservation = await repo.findReservation(propertyId, reservationId);
    if (!reservation) throw Errors.notFound("Reserva no encontrada.");
    const fromStatus = reservation.status;

    if (!canTransition(fromStatus, toStatus)) throw Errors.reservaTransicionInvalida(fromStatus, toStatus);
    if (!verticalRole || !canRolePerformTransition(verticalRole as HotelRole, fromStatus, toStatus)) {
      throw Errors.forbidden(`Tu rol (${verticalRole ?? "sin resolver"}) no puede ejecutar la transición "${fromStatus}" -> "${toStatus}".`);
    }

    const updated = await repo.transitionReservation(propertyId, reservationId, [fromStatus], toStatus, userId);
    if (!updated) throw Errors.reservaConflictoDeEstado();
    return c.json(serializeReservation(updated));
  });

  // Cancelación con efectos secundarios propios — NUNCA a través de la transición
  // genérica (diseño §5). El reclamo atómico (`cancelReservation` con guardia
  // `WHERE status IN ('cotizada','confirmada')`) corre PRIMERO: solo quien gana esa
  // carrera libera inventario, así que un doble clic/reintento nunca libera dos veces.
  app.post("/hoteles/:propertyId/reservas/:id/cancelar", async (c) => {
    assertVerticalRole(c, MANAGE_RESERVATIONS_ROLES);
    const propertyId = c.req.param("propertyId");
    const reservationId = c.req.param("id");
    const userId = c.get("userId");
    await readJsonCapped<CancelarBody>(c.req.raw, 1024); // valida que el body sea JSON bien formado; `motivo` es informativo, sin efecto en el cálculo.

    const repo = deps.hotelesRepo(c.get("db"));
    const reservation = await repo.findReservation(propertyId, reservationId);
    if (!reservation) throw Errors.notFound("Reserva no encontrada.");
    if (!isCancellable(reservation.status)) throw Errors.reservaNoCancelable(reservation.status);

    const policy = (await repo.loadReservationCancellationPolicy(propertyId)) ?? { freeUntilHours: Number.POSITIVE_INFINITY, penaltyPct: 0 };
    const evaluation = evaluateCancellation({ checkInDate: reservation.checkInDate, now: new Date(), policy });
    const penaltyAmount = roundCurrency(reservation.totalAmount * evaluation.penaltyPct);

    const canceled = await repo.cancelReservation(propertyId, reservationId, penaltyAmount, userId);
    if (!canceled) throw Errors.reservaNoCancelable(reservation.status); // carrera: alguien más ya la canceló/avanzó entre el findReservation y aquí.

    const nights = nightsBetween(reservation.checkInDate, reservation.checkOutDate);
    for (const night of nights) {
      await repo.releaseAvailability(propertyId, reservation.roomTypeId, night, 1);
    }

    return c.json(serializeReservation(canceled));
  });

  // Job de no-show por HTTP — ADMIN_ROLES dispara el proceso, pero la transición
  // resultante se atribuye SIEMPRE al actor lógico "system" (diseño §1/§7-punto 3:
  // nunca al humano que llamó el endpoint) — reclamo atómico por reserva, una carrera
  // perdida se salta sin reintento ni error. Lógica real en
  // `@atiende/worker::runNoShowSweep` (extraída en Fase 6/REQ-REV-013 para que
  // `night-audit.ts` la reutilice sin reimplementarla) -- esta ruta solo valida el
  // input HTTP y expone el mismo contrato de siempre.
  app.post("/hoteles/:propertyId/reservas/procesar-no-show", async (c) => {
    assertVerticalRole(c, ADMIN_ROLES);
    const propertyId = c.req.param("propertyId");
    const organizationId = c.get("organizationId");
    const raw = await readJsonCapped<ProcesarNoShowBody>(c.req.raw, 1024);
    const asOfDate = typeof raw.asOfDate === "string" && DATE_RE.test(raw.asOfDate) ? raw.asOfDate : null;

    const repo = deps.hotelesRepo(c.get("db"));
    const procesadas = await runNoShowSweep(repo, { organizationId, propertyId, asOfDate });

    return c.json({ procesadas: procesadas.length, detalle: procesadas });
  });

  return app;
}
