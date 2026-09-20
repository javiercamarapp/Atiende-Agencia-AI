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
import { hoyFechaNegocio, resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
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
  tryEnqueueGuestEmail,
  type HotelRole,
  type ReservationStatus,
  type ReservationRecord,
} from "@atiende/domain-hoteles";
import { runNoShowSweep } from "@atiende/worker";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { INLINE_BATCH_SIZE, runHotelesEmailDispatch, triggerHotelesEmailDispatchInline } from "./email-dispatch.ts";
import type { AppDeps } from "../../../deps.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const DEFAULT_RESERVAS_LIMIT = 50;
const MAX_RESERVAS_LIMIT = 200;

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

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

// Fix hallazgo CRÍTICO — alta de huésped real (ver POST .../huespedes abajo).
interface CrearHuespedBody {
  readonly nombreCompleto?: unknown;
  readonly email?: unknown;
  readonly telefono?: unknown;
}

// Fix hallazgo CRÍTICO — asignación de habitación FÍSICA al reservar (ver
// PATCH .../reservas/:id/asignar-habitacion abajo).
interface AsignarHabitacionBody {
  readonly roomId?: unknown;
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
    // Fix hallazgo CRÍTICO ("asignación de habitación al reservar") — `null` hasta
    // que el staff asigna una habitación física concreta, ver
    // PATCH .../reservas/:id/asignar-habitacion.
    roomId: r.roomId,
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
  // Hallazgo de auditoría (rubro 10, "performance y escalabilidad", severidad BAJA:
  // "listados sin paginación en 4 verticales") -- devolvía TODAS las reservas de la
  // property en un solo array, sin límite. Un hotel activo acumula miles de reservas
  // a lo largo de los años. El body sigue siendo el array plano (compatibilidad con
  // el cliente ya existente) -- lo que cambia de verdad es que la QUERY ahora está
  // acotada por `limit`/`offset` reales (`listReservationsPage`, ver
  // @atiende/domain-hoteles::repository.ts) en vez de traer TODA la tabla; el total
  // real y el siguiente offset van en headers para quien sí quiera paginar de verdad.
  app.get("/hoteles/:propertyId/reservas", async (c) => {
    const repo = deps.hotelesRepo(c.get("db"));
    const limit = parsePositiveInt(c.req.query("limit"), DEFAULT_RESERVAS_LIMIT, MAX_RESERVAS_LIMIT);
    const rawOffset = Number.parseInt(c.req.query("offset") ?? "0", 10);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;

    const page = await repo.listReservationsPage(c.req.param("propertyId"), { limit, offset });
    c.header("X-Total-Count", String(page.total));
    if (page.nextOffset !== null) c.header("X-Next-Offset", String(page.nextOffset));
    return c.json(page.items.map(serializeReservation));
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
  app.get("/hoteles/:propertyId/huespedes", async (c) => {
    const repo = deps.hotelesRepo(c.get("db"));
    const q = c.req.query("q")?.trim() || null;
    const huespedes = await repo.searchGuests(c.req.param("propertyId"), q);
    return c.json(huespedes.map((g) => ({ id: g.id, nombreCompleto: g.fullName, email: g.email, telefono: g.phone })));
  });

  // Fix hallazgo CRÍTICO ("Alta de organización/property/tipos-de-habitación/
  // tarifas/huéspedes imposible sin SQL directo") — hasta este endpoint,
  // `guestId` en `POST .../reservas` SOLO podía apuntar a un huésped YA sembrado
  // por SQL directo (`GET .../huespedes` de arriba era puramente de lectura); ahora
  // recepción puede registrar uno real desde el mismo formulario de "crear
  // reserva". `guestId` sigue siendo opcional en `POST .../reservas` (walk-in sin
  // huésped capturado sigue soportado, sin cambio de comportamiento ahí). Mismo
  // gate que crear una reserva (`MANAGE_RESERVATIONS_ROLES`, ver
  // migrations/018_admin_catalogo_alta.sql: `hoteles.can_manage_reservations()`).
  app.post("/hoteles/:propertyId/huespedes", async (c) => {
    assertVerticalRole(c, MANAGE_RESERVATIONS_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const raw = await readJsonCapped<CrearHuespedBody>(c.req.raw, 2 * 1024);

    if (typeof raw.nombreCompleto !== "string" || raw.nombreCompleto.trim().length === 0) throw Errors.validation("nombreCompleto requerido.");
    const email = typeof raw.email === "string" && raw.email.trim().length > 0 ? raw.email.trim() : null;
    const telefono = typeof raw.telefono === "string" && raw.telefono.trim().length > 0 ? raw.telefono.trim() : null;

    const repo = deps.hotelesRepo(c.get("db"));
    const guest = await repo.insertGuest({ propertyId, organizationId, fullName: raw.nombreCompleto.trim(), email, phone: telefono });
    return c.json({ id: guest.id, nombreCompleto: guest.fullName, email: guest.email, telefono: guest.phone }, 201);
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
          // Hallazgo ALTA — correo real de confirmación al huésped (best-effort:
          // sin correo en archivo, o cualquier otra falla, NUNCA tumba la creación
          // de la reserva ya persistida). Ver @atiende/domain-hoteles::guest-email-notifications.ts.
          await tryEnqueueGuestEmail(repo, propertyId, organizationId, "reservation.created", reservation.id);
          // Cluster #3 (CRÍTICO) de la auditoría final — disparo inline best-effort
          // del correo recién encolado arriba, mismo `repo`/transacción (ver
          // comentario de cabecera de email-dispatch.ts). Ruta de sesión de STAFF:
          // `db` es el MISMO `TenantDbSession` de esta transacción, necesario para
          // el SAVEPOINT del hotfix de auditoría a2 -- CRÍTICO en este call site
          // en particular, porque corre dentro de `repo.withIdempotency` (arriba):
          // sin el SAVEPOINT, la transacción abortada hacía fallar con 500 el
          // UPDATE de `idempotency_key` que corre justo después de este bloque.
          await triggerHotelesEmailDispatchInline(deps, c.get("db"), repo);
          // Arreglo de fondo (auditoría a2, parte 3) — ver comentario de
          // folios.ts::cerrar; el envío real solo puede pasar post-commit, en
          // sesión de sistema.
          c.get("postCommitTasks").push(() => runHotelesEmailDispatch(deps, INLINE_BATCH_SIZE).then(() => undefined));
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

  // Fix hallazgo CRÍTICO ("asignación de habitación al reservar") — la reserva
  // SIEMPRE se crea contra un `roomTypeId` (disponibilidad agregada por tipo, ver
  // `POST .../reservas` arriba); esta ruta es la única forma de decidir el número
  // de cuarto FÍSICO concreto, igual que en un PMS real (recepción asigna al
  // check-in, o antes si ya se sabe). Mismo gate que crear/cancelar una reserva
  // (`MANAGE_RESERVATIONS_ROLES`) -- asignar habitación es la misma familia de
  // decisión operativa de front-of-house.
  app.patch("/hoteles/:propertyId/reservas/:id/asignar-habitacion", async (c) => {
    assertVerticalRole(c, MANAGE_RESERVATIONS_ROLES);
    const propertyId = c.req.param("propertyId");
    const reservationId = c.req.param("id");
    const raw = await readJsonCapped<AsignarHabitacionBody>(c.req.raw, 1024);
    if (typeof raw.roomId !== "string" || raw.roomId.length === 0) throw Errors.validation("roomId requerido.");

    const repo = deps.hotelesRepo(c.get("db"));
    const reservation = await repo.findReservation(propertyId, reservationId);
    if (!reservation) throw Errors.notFound("Reserva no encontrada.");

    const room = await repo.findRoom(propertyId, raw.roomId);
    if (!room) throw Errors.notFound("Habitación no encontrada en esta property.");
    // Validación de dominio ANTES de escribir (mismo reparto de responsabilidad que
    // `canTransition`/`transitionReservation`): la habitación asignada DEBE ser del
    // mismo tipo de habitación que la reserva -- nunca se le asigna al huésped un
    // cuarto de un tipo distinto al que cotizó/pagó.
    if (room.roomTypeId !== reservation.roomTypeId) {
      throw Errors.validation(`La habitación "${room.code}" es de un tipo de habitación distinto al de esta reserva.`);
    }

    const updated = await repo.assignRoomToReservation(propertyId, reservationId, raw.roomId);
    if (!updated) throw Errors.notFound("Reserva no encontrada."); // carrera: se borró/dejó de existir entre el findReservation y aquí.
    return c.json(serializeReservation(updated));
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
    const repo = deps.hotelesRepo(c.get("db"));

    // FASE 3 (producto) zona horaria por negocio: si el caller no manda `asOfDate`
    // explícito, el default YA NO es el default de plataforma a secas -- se resuelve
    // la zona REAL de esta property (`hoteles.property_config.timezone`, o el
    // default si no la configuró/la columna no existe todavía) y se calcula "hoy" en
    // ESA zona (mismo criterio que `night-audit.ts`, disparo manual).
    const asOfDate =
      typeof raw.asOfDate === "string" && DATE_RE.test(raw.asOfDate)
        ? raw.asOfDate
        : hoyFechaNegocio(resolverZonaHorariaNegocio(await repo.findPropertyTimezone(propertyId)));

    const procesadas = await runNoShowSweep(repo, { organizationId, propertyId, asOfDate, session: "staff" });

    return c.json({ procesadas: procesadas.length, detalle: procesadas });
  });

  return app;
}
