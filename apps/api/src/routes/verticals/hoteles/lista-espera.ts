// H-12 -- lista de espera de hoteles: cola FIFO de huespedes que quieren un tipo de habitacion y fechas sin cupo.
//   GET  /hoteles/:propertyId/lista-espera?estado=            -> entradas (las ofertas vencidas se marcan `expirada` al listar)
//   POST /hoteles/:propertyId/lista-espera                    -> agregar una entrada
//   POST /hoteles/:propertyId/lista-espera/:id/cancelar       -> cancelar (activa u ofrecida)
//   POST /hoteles/:propertyId/lista-espera/:id/ofrecer        -> ofrecer a mano (si hoy hay cupo para todas sus noches)
//   POST /hoteles/:propertyId/lista-espera/:id/aceptar        -> aceptar la oferta: crea la reserva con la cotizacion VIGENTE
// La oferta automatica ocurre al cancelar una reserva o acortar fechas (lista-espera-ofertas.ts). Una oferta no retiene inventario:
// al aceptar, `book_availability` vuelve a validar el cupo noche por noche. Roles: owner, gm, frontdesk, reservations.
//
// REGLA DURA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: las lecturas responden `disponible:false` con lista vacia y las escrituras 503
// "no disponible aun" (SAVEPOINT en `PostgresListaEsperaRepository`), nunca un 500. El aviso al huesped por WhatsApp no esta conectado
// (depende de Meta, H-23): la oferta solo se registra y avisa al staff.
import { Hono } from "hono";
import type { Context } from "hono";
import { ApiError, assertVerticalRole, authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { hoyFechaNegocio, resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import {
  HORAS_OFERTA_DEFAULT,
  HORAS_OFERTA_MAX,
  IdempotencyConflictError,
  ListaEsperaAccessDeniedError,
  ListaEsperaConflictError,
  ListaEsperaInvalidInputError,
  ListaEsperaNotFoundError,
  ListaEsperaUnavailableError,
  MANAGE_RESERVATIONS_ROLES,
  PostgresCambioFechasRepository,
  PostgresListaEsperaRepository,
  QuoteError,
  canBook,
  computeQuote,
  esEstadoListaEspera,
  esFechaIso,
  nightsBetween,
  type CambioFechasRepository,
  type EntradaListaEspera,
  type ListaEsperaRepository,
} from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { programarMensajesHuesped } from "./mensajes-huesped.ts";

const QUOTE_CODE_STATUS: Record<string, number> = {
  estadia_invalida: 400,
  sin_tarifa: 409,
  cerrado_a_llegada: 409,
  cerrado_a_salida: 409,
  estadia_minima_no_alcanzada: 409,
};
const MAX_NOCHES = 60;
const TELEFONO_RE = /^[0-9+()\- ]{7,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toApiError(err: unknown): unknown {
  if (err instanceof ListaEsperaUnavailableError) return Errors.serviceUnavailable(err.message);
  if (err instanceof ListaEsperaNotFoundError) return Errors.notFound(err.message);
  if (err instanceof ListaEsperaConflictError) return new ApiError(409, err.code, err.message);
  if (err instanceof ListaEsperaInvalidInputError) return Errors.validation(err.message);
  if (err instanceof ListaEsperaAccessDeniedError) return Errors.forbidden(err.message);
  return err;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toApiError(err);
  }
}

interface Cotizacion {
  readonly total: number;
  readonly neto: number;
  readonly noches: number;
}

function serializeEntrada(e: EntradaListaEspera, cotizacion: Cotizacion | null) {
  return {
    id: e.id,
    tipoHabitacionId: e.roomTypeId,
    entrada: e.checkInDate,
    salida: e.checkOutDate,
    huespedes: e.huespedes,
    nombre: e.nombre,
    telefono: e.telefono,
    email: e.email,
    notas: e.notas,
    estado: e.estado,
    ofrecidaEn: e.ofrecidaEn,
    ofertaVenceEn: e.ofertaVenceEn,
    reservaId: e.reservaId,
    creadaEn: e.creadaEn,
    // Solo en ofertas vigentes: lo que costaria hoy (con impuestos); null si no se pudo cotizar.
    cotizacionVigente: cotizacion ? { total: cotizacion.total, noches: cotizacion.noches, moneda: "MXN" } : null,
  };
}

export function hotelesListaEsperaRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/hoteles/:propertyId/lista-espera", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/lista-espera/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  const listaRepo = (c: Context<CoreAuthHonoEnv>): ListaEsperaRepository =>
    deps.hotelesListaEsperaRepo ? deps.hotelesListaEsperaRepo(c.get("db")) : new PostgresListaEsperaRepository(c.get("db"));
  const fechasRepo = (c: Context<CoreAuthHonoEnv>): CambioFechasRepository =>
    deps.hotelesFechasRepo ? deps.hotelesFechasRepo(c.get("db")) : new PostgresCambioFechasRepository(c.get("db"));

  async function hoy(c: Context<CoreAuthHonoEnv>, propertyId: string): Promise<string> {
    const tz = await deps.hotelesRepo(c.get("db")).findPropertyTimezone(propertyId);
    return hoyFechaNegocio(resolverZonaHorariaNegocio(tz));
  }

  /** Cotizacion de la entrada con tarifas e impuestos de HOY; lanza `QuoteError` si no se puede. */
  async function cotizar(c: Context<CoreAuthHonoEnv>, e: EntradaListaEspera): Promise<Cotizacion> {
    const repo = deps.hotelesRepo(c.get("db"));
    const impuestos = await repo.loadTaxConfig(e.propertyId);
    const tarifas = await repo.loadNightlyRates(e.propertyId, e.roomTypeId, e.checkInDate, e.checkOutDate);
    const q = computeQuote({ checkInDate: e.checkInDate, checkOutDate: e.checkOutDate, currency: "MXN", nightlyRates: tarifas, taxConfig: { ivaRate: impuestos.ivaRate, ishRate: impuestos.ishRate } });
    return { total: q.totalAmount, neto: q.netAmount, noches: q.nights };
  }

  // ---- Listar ---------------------------------------------------------------------------------------------------------
  app.get("/hoteles/:propertyId/lista-espera", async (c) => {
    assertVerticalRole(c, MANAGE_RESERVATIONS_ROLES);
    const propertyId = c.req.param("propertyId");
    const rawEstado = c.req.query("estado");
    if (rawEstado !== undefined && !esEstadoListaEspera(rawEstado)) throw Errors.validation("estado: activa, ofrecida, aceptada, expirada o cancelada.");
    const repo = listaRepo(c);
    // Las ofertas vencidas se marcan expiradas al consultar (no hay cron): el listado nunca muestra una oferta ya vencida como vigente.
    await guarded(() => repo.expirarVencidas(propertyId, new Date()));
    const listado = await guarded(() => repo.listar(propertyId, rawEstado ?? null));
    const entradas: ReturnType<typeof serializeEntrada>[] = [];
    for (const e of listado.entradas) {
      let cotizacion: Cotizacion | null = null;
      if (e.estado === "ofrecida") {
        try {
          cotizacion = await cotizar(c, e);
        } catch (err) {
          if (!(err instanceof QuoteError)) throw err;
        }
      }
      entradas.push(serializeEntrada(e, cotizacion));
    }
    return c.json({ disponible: listado.disponible, entradas });
  });

  // ---- Agregar --------------------------------------------------------------------------------------------------------
  app.post("/hoteles/:propertyId/lista-espera", async (c) => {
    assertVerticalRole(c, MANAGE_RESERVATIONS_ROLES);
    const propertyId = c.req.param("propertyId");
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, 4 * 1024);
    if (typeof raw.roomTypeId !== "string" || raw.roomTypeId.length === 0) throw Errors.validation("roomTypeId requerido.");
    if (!esFechaIso(raw.checkInDate)) throw Errors.validation("checkInDate: formato de fecha esperado YYYY-MM-DD.");
    if (!esFechaIso(raw.checkOutDate)) throw Errors.validation("checkOutDate: formato de fecha esperado YYYY-MM-DD.");
    if (raw.checkOutDate <= raw.checkInDate) throw Errors.validation("checkOutDate debe ser posterior a checkInDate.");
    if (nightsBetween(raw.checkInDate, raw.checkOutDate).length > MAX_NOCHES) throw Errors.validation(`La estancia no puede pasar de ${MAX_NOCHES} noches.`);
    if (raw.checkInDate < (await hoy(c, propertyId))) throw Errors.validation("La llegada no puede ser anterior a hoy.");
    const huespedes = raw.huespedes === undefined ? 1 : raw.huespedes;
    if (typeof huespedes !== "number" || !Number.isInteger(huespedes) || huespedes < 1 || huespedes > 20) throw Errors.validation("huespedes: entero entre 1 y 20.");
    const nombre = typeof raw.nombre === "string" ? raw.nombre.trim() : "";
    if (nombre.length < 2 || nombre.length > 120) throw Errors.validation("nombre: entre 2 y 120 caracteres.");
    const telefono = typeof raw.telefono === "string" && raw.telefono.trim().length > 0 ? raw.telefono.trim() : null;
    const email = typeof raw.email === "string" && raw.email.trim().length > 0 ? raw.email.trim() : null;
    if (telefono !== null && !TELEFONO_RE.test(telefono)) throw Errors.validation("telefono: entre 7 y 20 caracteres (digitos, +, espacios, guiones).");
    if (email !== null && (!EMAIL_RE.test(email) || email.length > 160)) throw Errors.validation("email: formato invalido.");
    if (telefono === null && email === null) throw Errors.validation("Captura un telefono o un correo de contacto.");
    const notas = typeof raw.notas === "string" && raw.notas.trim().length > 0 ? raw.notas.trim() : null;
    if (notas !== null && notas.length > 300) throw Errors.validation("notas: maximo 300 caracteres.");

    const repo = deps.hotelesRepo(c.get("db"));
    const tipos = await repo.listRoomTypes(propertyId);
    const tipo = tipos.find((t) => t.id === raw.roomTypeId);
    if (!tipo) throw Errors.notFound("Tipo de habitacion no encontrado en esta property.");
    if (huespedes > tipo.maxOccupancy) throw Errors.validation(`El tipo "${tipo.name}" admite hasta ${tipo.maxOccupancy} huespedes.`);

    const entrada = await guarded(() =>
      listaRepo(c).crear({ propertyId, roomTypeId: tipo.id, checkInDate: raw.checkInDate as string, checkOutDate: raw.checkOutDate as string, huespedes, nombre, telefono, email, notas }),
    );
    return c.json(serializeEntrada(entrada, null), 201);
  });

  // ---- Cancelar -------------------------------------------------------------------------------------------------------
  app.post("/hoteles/:propertyId/lista-espera/:id/cancelar", async (c) => {
    assertVerticalRole(c, MANAGE_RESERVATIONS_ROLES);
    const propertyId = c.req.param("propertyId");
    const repo = listaRepo(c);
    const e = await guarded(() => repo.buscar(propertyId, c.req.param("id")));
    if (!e) throw Errors.notFound("Entrada de la lista de espera no encontrada.");
    return c.json(serializeEntrada(await guarded(() => repo.cancelar(propertyId, e.id)), null));
  });

  // ---- Ofrecer a mano ---------------------------------------------------------------------------------------------------
  app.post("/hoteles/:propertyId/lista-espera/:id/ofrecer", async (c) => {
    assertVerticalRole(c, MANAGE_RESERVATIONS_ROLES);
    const propertyId = c.req.param("propertyId");
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, 1024).catch((err: unknown) => {
      if (err instanceof ApiError) throw err;
      return {} as Record<string, unknown>;
    });
    const horas = raw.horas === undefined ? HORAS_OFERTA_DEFAULT : raw.horas;
    if (typeof horas !== "number" || !Number.isInteger(horas) || horas < 1 || horas > HORAS_OFERTA_MAX) throw Errors.validation(`horas: entero entre 1 y ${HORAS_OFERTA_MAX}.`);

    const repo = listaRepo(c);
    const e = await guarded(() => repo.buscar(propertyId, c.req.param("id")));
    if (!e) throw Errors.notFound("Entrada de la lista de espera no encontrada.");
    if (e.estado !== "activa") throw new ApiError(409, "estado_invalido", `La entrada esta ${e.estado}: solo se ofrece una entrada activa.`);
    if (e.checkInDate < (await hoy(c, propertyId))) throw new ApiError(409, "llegada_pasada", "La llegada de esta entrada ya paso.");

    const disp = await fechasRepo(c).cargarDisponibilidad(propertyId, e.roomTypeId, e.checkInDate, e.checkOutDate);
    const sinCupo = nightsBetween(e.checkInDate, e.checkOutDate).filter((n) => {
      const fila = disp.noches.find((x) => x.date === n);
      return !fila || !canBook(fila.totalRooms, fila.bookedRooms, 1, disp.overbooking);
    });
    if (sinCupo.length > 0) throw new ApiError(409, "sin_disponibilidad", `Aun no hay habitaciones libres en: ${sinCupo.join(", ")}.`);

    const ofrecida = await guarded(() => repo.ofrecer(propertyId, e.id, new Date(Date.now() + horas * 3_600_000)));
    // H-P3-03: la oferta le llega al huesped (WhatsApp o correo) con su vigencia; despues del commit, acotado a esta entrada.
    programarMensajesHuesped(deps, c, { propertyId, refId: e.id });
    return c.json(serializeEntrada(ofrecida, null));
  });

  // ---- Aceptar --------------------------------------------------------------------------------------------------------
  app.post("/hoteles/:propertyId/lista-espera/:id/aceptar", async (c) => {
    assertVerticalRole(c, MANAGE_RESERVATIONS_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();
    const propertyId = c.req.param("propertyId");
    const organizationId = c.get("organizationId");
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, 1024);
    if (typeof raw.totalEsperado !== "number" || !Number.isFinite(raw.totalEsperado) || raw.totalEsperado < 0) throw Errors.validation("totalEsperado: se esperaba el total (con impuestos) de la cotizacion vigente.");

    const repo = listaRepo(c);
    const hotel = deps.hotelesRepo(c.get("db"));
    try {
      // TODO el cuerpo (lecturas, guardias y escritura) va DENTRO de `withIdempotency`: un reintento con la misma llave devuelve la
      // respuesta guardada sin reevaluar contra el estado ya cambiado (la entrada ya estaria `aceptada`).
      const result = await hotel.withIdempotency(
        { organizationId, scope: "waitlist.accept", key: idempotencyKey, body: { id: c.req.param("id"), totalEsperado: Math.round(raw.totalEsperado * 100) } },
        async () => {
          await guarded(() => repo.expirarVencidas(propertyId, new Date()));
          const e = await guarded(() => repo.buscar(propertyId, c.req.param("id")));
          if (!e) throw Errors.notFound("Entrada de la lista de espera no encontrada.");
          if (e.estado === "expirada") throw new ApiError(409, "oferta_vencida", "La oferta ya vencio.");
          if (e.estado !== "ofrecida") throw new ApiError(409, "estado_invalido", `La entrada esta ${e.estado}: solo se acepta una oferta vigente.`);
          if (e.checkInDate < (await hoy(c, propertyId))) throw new ApiError(409, "llegada_pasada", "La llegada de esta entrada ya paso.");

          let cot: Cotizacion;
          try {
            cot = await cotizar(c, e);
          } catch (err) {
            if (err instanceof QuoteError) throw new ApiError(QUOTE_CODE_STATUS[err.code] ?? 409, err.code, err.message);
            throw err;
          }
          if (Math.round(cot.total * 100) !== Math.round((raw.totalEsperado as number) * 100)) {
            throw new ApiError(409, "precio_cambio", `La cotizacion vigente es ${cot.total.toFixed(2)} y esperabas ${(raw.totalEsperado as number).toFixed(2)}. Recarga la lista.`);
          }
          // Reserva noche por noche con la sobreventa controlada de siempre: si el lugar ya no esta, 409 sin_disponibilidad y la
          // oferta sigue vigente (el rollback de la transaccion deja inventario y entrada intactos).
          for (const night of nightsBetween(e.checkInDate, e.checkOutDate)) await hotel.bookAvailability(propertyId, e.roomTypeId, night, 1);
          const huesped = await hotel.insertGuest({ propertyId, organizationId, fullName: e.nombre, email: e.email, phone: e.telefono });
          const reserva = await hotel.insertReservation({
            organizationId,
            propertyId,
            roomTypeId: e.roomTypeId,
            guestId: huesped.id,
            checkInDate: e.checkInDate,
            checkOutDate: e.checkOutDate,
            totalAmount: cot.neto,
            idempotencyKey,
          });
          await hotel.ensurePrimaryFolio(propertyId, organizationId, reserva.id);
          const aceptada = await repo.marcarAceptada(propertyId, e.id, reserva.id);
          return { status: 201, body: { entrada: serializeEntrada(aceptada, null), reserva: { id: reserva.id, checkInDate: reserva.checkInDate, checkOutDate: reserva.checkOutDate, estado: reserva.status, montoTotal: reserva.totalAmount } } };
        },
      );
      return c.json(result.body as object, result.status as 201);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) throw Errors.idempotencyConflict();
      if (err instanceof Error && err.message.startsWith("sin_disponibilidad")) throw Errors.reservaSinDisponibilidad(err.message);
      throw toApiError(err);
    }
  });

  return app;
}
