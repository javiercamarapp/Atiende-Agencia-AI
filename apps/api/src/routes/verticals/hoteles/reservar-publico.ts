// H-42 (P1) -- MOTOR DE RESERVAS DIRECTO PUBLICO del hotel, SIN login. Igual que la privacidad publica (H-30) y el storefront de restaurantes, este grupo
// se monta sin `authMiddleware` y abre su propia sesion de SISTEMA (`userId: null`); su defensa es CORS por origen, limite de tasa por IP / contacto
// (consumido en una sesion APARTE para que un rechazo no revierta el conteo), honeypot, validacion estricta, tokens firmados y un modelo de datos que solo
// expone funciones `security definer` solo-sistema (migracion 044 sobre el agente de reservas 037).
//
//   GET  /v1/hoteles/:orgSlug/reservar                          propiedades del hotel y si reciben reservas en linea (anticipo, terminos)
//   GET  /v1/hoteles/:orgSlug/reservar/disponibilidad           tipos de cuarto y precio desde para unas fechas y ocupacion (nunca el inventario exacto)
//   POST /v1/hoteles/:orgSlug/reservar/cotizacion               cotizacion calculada por el servidor -> `quoteToken` firmado de vida corta
//   POST /v1/hoteles/:orgSlug/reservar/confirmar                quoteToken + huesped + consentimiento del aviso (Idempotency-Key) -> hold sin sobreventa y, con
//                                                               anticipo, cobro via PaymentsPort; sin llave de la pasarela: 503 honesto y el hold queda pendiente_pago
//   GET  /v1/hoteles/:orgSlug/reservar/estado/:token            estado por token opaco (sin datos personales)
//   POST /v1/hoteles/:orgSlug/reservar/estado/:token/cancelar   cancelacion aplicando cancellation_policy (Idempotency-Key); reembolso via PaymentsPort o solicitud al staff
//
// Sin enumeracion: un token invalido, vencido, de otra organizacion o de un hold que no existe responde LO MISMO (404). El precio NUNCA lo manda el navegador:
// el `quoteToken` solo registra lo que el servidor cotizo y la base recalcula al confirmar (si difiere: 409 con el total vigente). El hold no se cobra aqui
// dentro de la transaccion de la base: la llamada a la pasarela corre FUERA de toda sesion (primero se confirma el hold, despues se cobra, despues se registra).
//
// REGLA DURA de compatibilidad con la base sin migrar: la configuracion y la disponibilidad responden `disponible: false`; las escrituras 503 honesto (SAVEPOINT en
// el repositorio). Nunca un 500 por una base vieja.
import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { emitirNotificacion } from "@atiende/db";
import {
  PostgresPublicPrivacyRepository,
  PostgresReservarDirectoRepository,
  ReservarValidationError,
  ReservasAgenteError,
  ReservasAgenteUnavailableError,
  calcularAnticipo,
  consumeRateLimit,
  esCancelable,
  estadoPublico,
  estadoTokenKey,
  issueEstadoToken,
  issueQuoteToken,
  nightsBetween,
  opcionesPublicas,
  parseCancelarVacio,
  parseConfirmarBody,
  parseCotizacionBody,
  parseDisponibilidadQuery,
  parseIdempotencyKey,
  previsionCancelacion,
  propertySlug,
  quoteTokenKey,
  terminosPublicos,
  verifyEstadoToken,
  verifyQuoteToken,
  type PublicPrivacyRepository,
  type ReservarDirectoRepository,
  type WebHoldContext,
  type WebHoldRecord,
  type WebPolicyRecord,
} from "@atiende/domain-hoteles";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { Errors } from "../../../errors.ts";
import { logEvent } from "../../../logger.ts";
import { originAllowed, readJsonCapped, requestActor as ipActor } from "../../../http-security.ts";
import { ofrecerListaEsperaTrasLiberacion } from "./lista-espera-ofertas.ts";
import type { AppDeps } from "../../../deps.ts";

const MAX_BODY_BYTES = 8 * 1024;
const SIN_AVISO = "sin_aviso_publicado";
const NO_MIGRADA = "La reserva en linea aun no esta disponible: falta aplicar la migracion 044 en esta base.";

const noStore = (c: Context) => c.header("Cache-Control", "no-store");
const sha = (v: string): string => createHash("sha256").update(v).digest("hex");

interface Hotel {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly properties: ReadonlyArray<{ readonly propertyId: string; readonly name: string; readonly slug: string }>;
}

/** Mensajes ESTATICOS y seguros por codigo de dominio: nunca se repite un mensaje interno de la base al navegador. */
function dominioAHttp(err: unknown): Response | never {
  if (err instanceof ReservasAgenteUnavailableError) throw Errors.serviceUnavailable(NO_MIGRADA);
  if (!(err instanceof ReservasAgenteError)) throw err;
  const json = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ code, message, ...extra }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  switch (err.code) {
    case "precio_cambio": {
      const total = typeof err.detail?.totalCents === "number" ? err.detail.totalCents : null;
      return json(409, "precio_cambio", "El precio cambió desde tu cotización. Revisa el nuevo total y confirma de nuevo.", total === null ? {} : { totalCentavos: total });
    }
    case "sin_disponibilidad":
      return json(409, "sin_disponibilidad", "Ya no hay habitaciones disponibles de ese tipo para esas fechas.");
    case "cotizacion_no_disponible":
      return json(409, "cotizacion_no_disponible", "Ese tipo de habitación no se puede reservar en línea para esas fechas.");
    case "web_deshabilitado":
      return json(409, "reserva_en_linea_no_habilitada", "Este hotel aún no recibe reservas en línea.");
    case "limite_holds_contacto":
      return json(409, "limite_reservas_abiertas", "Ya tienes reservas en curso con esos datos. Termina o cancela una antes de hacer otra.");
    case "limite_holds_activos":
      return json(409, "sin_cupo_temporal", "El hotel tiene demasiadas reservas en curso ahora mismo. Inténtalo de nuevo en unos minutos.");
    case "idempotencia_conflicto":
      throw Errors.idempotencyConflict();
    case "no_encontrada":
      throw Errors.notFound("No encontramos esa reserva.");
    case "estado_no_valido":
      return json(409, "estado_no_valido", err.detail?.motivo === "no_cancelable" ? "Esta reserva ya no se puede cancelar en línea. Contacta al hotel." : "La reserva no admite esa operación en su estado actual.");
    case "fechas_invalidas":
      throw Errors.validation("Las fechas no son válidas.");
    case "fecha_pasada":
      throw Errors.validation("La llegada ya pasó.");
    case "fecha_muy_lejana":
      throw Errors.validation("La llegada está demasiado lejos: este hotel reserva con menos anticipación.");
    case "estadia_muy_larga":
      throw Errors.validation("La estadía excede el máximo que permite la reserva en línea.");
    case "huespedes_invalidos":
      throw Errors.validation("El número de huéspedes no cabe en ese tipo de habitación.");
    case "tipo_habitacion_invalido":
      throw Errors.notFound("No encontramos ese tipo de habitación.");
    case "consentimiento_requerido":
      throw Errors.validation("Debes aceptar el aviso de privacidad para reservar.");
    default:
      throw Errors.validation("Los datos de la reserva no son válidos.");
  }
}

export function hotelesReservarPublicoRoutes(deps: AppDeps): Hono {
  const app = new Hono();
  const quoteKey = quoteTokenKey(deps.env.internalSecret);
  const estadoKey = estadoTokenKey(deps.env.internalSecret);
  const repoOf = (db: TenantDbSession): ReservarDirectoRepository => (deps.hotelesReservarPublicoRepo ? deps.hotelesReservarPublicoRepo(db) : new PostgresReservarDirectoRepository(db));
  const privacyOf = (db: TenantDbSession): PublicPrivacyRepository => (deps.hotelesPrivacidadPublicaRepo ? deps.hotelesPrivacidadPublicaRepo(db) : new PostgresPublicPrivacyRepository(db));
  const ipOf = (c: Context) => ipActor(c.req.raw, "");

  function assertOrigin(c: Context) {
    if (!originAllowed(c.req.header("origin") ?? null, deps.env.allowedOrigins)) throw Errors.forbidden("Origen no permitido");
  }

  /** Consume UN cupo en su propia sesion (commit propio) y lanza 429 DESPUES: el rechazo no revierte el conteo. */
  async function limitOrThrow(scope: string, actor: string, max: number, windowSeconds: number) {
    const allowed = await deps.engine.withAppSession({ userId: null }, async (db) => (await consumeRateLimit(deps.hotelesRepo(db), scope, actor, max, windowSeconds)).allowed);
    if (!allowed) throw Errors.tooManyRequests();
  }

  /** Hotel y propiedades por slug (sesion ya abierta). null = no existe ese hotel (404 generico). */
  async function cargarHotel(db: TenantDbSession, orgSlug: string): Promise<Hotel | null> {
    const repo = deps.hotelesRepo(db);
    const org = await repo.findOrganizationBySlug(orgSlug);
    if (!org) return null;
    const props = await repo.listPropertiesForOrganization(org.id);
    return { organizationId: org.id, organizationName: org.name, properties: props.map((p) => ({ propertyId: p.propertyId, name: p.name, slug: propertySlug(p.name) })) };
  }

  function elegirPropiedad(hotel: Hotel, slug: string | null) {
    if (slug) return hotel.properties.find((p) => p.slug === slug) ?? null;
    return hotel.properties.length === 1 ? (hotel.properties[0] ?? null) : null;
  }

  /** Version del aviso de privacidad vigente de la propiedad (H-30): lo que el huesped acepta. Sin aviso publicado se registra como tal. */
  async function versionAviso(db: TenantDbSession, orgSlug: string, propertyId: string): Promise<string> {
    try {
      const r = await privacyOf(db).listNotices(orgSlug);
      if (!r.available) return SIN_AVISO;
      return r.properties.find((p) => p.propertyId === propertyId)?.notice?.version ?? SIN_AVISO;
    } catch {
      return SIN_AVISO;
    }
  }

  function vista(hold: WebHoldRecord, ctx: WebHoldContext | null, ahora: Date) {
    const contexto = ctx ?? { roomTypeName: "", propertyName: "", reservationStatus: null, terminos: null };
    const estado = estadoPublico(hold, contexto);
    const cancelable = esCancelable(hold, contexto);
    const pagado = hold.paymentStatus === "capturado" || hold.paymentStatus === "manual" ? hold.depositCents : 0;
    const terminos = terminosPublicos(contexto.terminos, hold.checkInDate);
    return {
      estado,
      hotel: contexto.propertyName,
      tipoHabitacion: contexto.roomTypeName,
      llegada: hold.checkInDate,
      salida: hold.checkOutDate,
      noches: hold.nights,
      huespedes: hold.guests,
      totalCentavos: hold.totalCents,
      anticipoCentavos: hold.depositCents,
      pago: { estado: hold.paymentStatus, reembolso: hold.refundStatus },
      vigenteHasta: estado === "pago_pendiente" || estado === "en_revision" || estado === "aprobada" ? hold.expiresAt : null,
      cancelable,
      cancelacion: {
        gratisHasta: terminos.gratisHasta,
        penalidadPct: terminos.penalidadPct,
        // Lo que pasaria si cancelas AHORA (misma regla que aplica la base). Solo una reserva confirmada puede tener penalidad.
        siCancelasAhora: cancelable && hold.status === "confirmado"
          ? previsionCancelacion({ totalCents: hold.totalCents, pagadoCents: pagado, checkInDate: hold.checkInDate, now: ahora, terminos: contexto.terminos })
          : null,
        resultado: hold.canceledAt === null ? null : { penalidadCentavos: hold.cancelPenaltyCents ?? 0, reembolsoCentavos: hold.refundCents ?? 0 },
      },
    };
  }

  // ---- Configuracion publica -----------------------------------------------------------------------------------------------
  app.get("/v1/hoteles/:orgSlug/reservar", async (c) => {
    noStore(c);
    await limitOrThrow("hoteles-reservar-lectura", ipOf(c), 120, 60);
    const orgSlug = c.req.param("orgSlug");
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const hotel = await cargarHotel(db, orgSlug);
      if (!hotel || hotel.properties.length === 0) throw Errors.notFound("Hotel no encontrado.");
      const repo = repoOf(db);
      const propiedades = [];
      for (const p of hotel.properties) {
        const pol = await repo.webPolicy(p.propertyId);
        if (!pol.disponible) return c.json({ disponible: false, motivo: NO_MIGRADA });
        propiedades.push({
          slug: p.slug,
          nombre: p.name,
          reservaEnLinea: pol.webEnabled && pol.holdsEnabled,
          anticipoPct: pol.webEnabled && pol.holdsEnabled ? pol.depositPct : null,
          maxHuespedes: pol.maxGuests,
          maxNoches: pol.maxNights,
          cancelacion: pol.terminos ? { ventanaGratisHoras: pol.terminos.freeUntilHours, penalidadPct: pol.terminos.penaltyPct } : null,
        });
      }
      return c.json({ disponible: true, hotel: { nombre: hotel.organizationName }, propiedades });
    });
  });

  // ---- Disponibilidad ------------------------------------------------------------------------------------------------------
  app.get("/v1/hoteles/:orgSlug/reservar/disponibilidad", async (c) => {
    noStore(c);
    await limitOrThrow("hoteles-reservar-disponibilidad", ipOf(c), 60, 60);
    const orgSlug = c.req.param("orgSlug");
    const q = parseDisponibilidadQuery({ llegada: c.req.query("llegada"), salida: c.req.query("salida"), huespedes: c.req.query("huespedes"), property: c.req.query("property") });
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const hotel = await cargarHotel(db, orgSlug);
      if (!hotel) throw Errors.notFound("Hotel no encontrado.");
      const prop = elegirPropiedad(hotel, q.propiedad);
      if (!prop) throw hotel.properties.length > 1 && !q.propiedad ? Errors.validation("propiedad: indica la propiedad del hotel.") : Errors.notFound("Propiedad no encontrada.");
      const repo = repoOf(db);
      const pol = await repo.webPolicy(prop.propertyId);
      if (!pol.disponible) return c.json({ disponible: false, motivo: NO_MIGRADA });
      if (!pol.webEnabled || !pol.holdsEnabled) return c.json({ disponible: true, reservaEnLinea: false, motivo: "Este hotel aún no recibe reservas en línea." });
      if (q.guests > pol.maxGuests) throw Errors.validation(`Este hotel reserva en línea hasta ${pol.maxGuests} huéspedes.`);
      if (q.nights > pol.maxNights) throw Errors.validation(`Este hotel reserva en línea hasta ${pol.maxNights} noches.`);
      let stay;
      try {
        stay = await repo.stayOptions(prop.propertyId, q.checkInDate, q.checkOutDate);
      } catch (err) {
        return dominioAHttp(err);
      }
      if (!stay.disponible) return c.json({ disponible: false, motivo: NO_MIGRADA });
      return c.json({
        disponible: true,
        reservaEnLinea: true,
        propiedad: { slug: prop.slug, nombre: prop.name },
        llegada: q.checkInDate,
        salida: q.checkOutDate,
        noches: q.nights,
        huespedes: q.guests,
        anticipoPct: pol.depositPct,
        opciones: opcionesPublicas(stay.opciones, q.nights, q.guests),
      });
    });
  });

  // ---- Cotizacion ----------------------------------------------------------------------------------------------------------
  app.post("/v1/hoteles/:orgSlug/reservar/cotizacion", async (c) => {
    noStore(c);
    assertOrigin(c);
    await limitOrThrow("hoteles-reservar-cotizacion", ipOf(c), 30, 60);
    const orgSlug = c.req.param("orgSlug");
    const body = parseCotizacionBody(await readJsonCapped<unknown>(c.req.raw, MAX_BODY_BYTES));
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const hotel = await cargarHotel(db, orgSlug);
      if (!hotel) throw Errors.notFound("Hotel no encontrado.");
      const prop = elegirPropiedad(hotel, body.propiedad);
      if (!prop) throw hotel.properties.length > 1 && !body.propiedad ? Errors.validation("propiedad: indica la propiedad del hotel.") : Errors.notFound("Propiedad no encontrada.");
      const repo = repoOf(db);
      const pol = await repo.webPolicy(prop.propertyId);
      if (!pol.disponible) throw Errors.serviceUnavailable(NO_MIGRADA);
      if (!pol.webEnabled || !pol.holdsEnabled) return c.json({ code: "reserva_en_linea_no_habilitada", message: "Este hotel aún no recibe reservas en línea." }, 409);
      if (body.guests > pol.maxGuests) throw Errors.validation(`Este hotel reserva en línea hasta ${pol.maxGuests} huéspedes.`);
      if (body.nights > pol.maxNights) throw Errors.validation(`Este hotel reserva en línea hasta ${pol.maxNights} noches.`);
      let stay;
      try {
        stay = await repo.stayOptions(prop.propertyId, body.checkInDate, body.checkOutDate);
      } catch (err) {
        return dominioAHttp(err);
      }
      if (!stay.disponible) throw Errors.serviceUnavailable(NO_MIGRADA);
      const opcion = stay.opciones.find((o) => o.roomTypeId === body.roomTypeId);
      if (!opcion) throw Errors.notFound("No encontramos ese tipo de habitación.");
      if (body.guests > opcion.maxOccupancy) throw Errors.validation("El número de huéspedes no cabe en ese tipo de habitación.");
      if (opcion.status !== "ok" || opcion.freeRooms <= 0 || opcion.totalCents === null || opcion.netCents === null || opcion.ivaCents === null || opcion.ishCents === null) {
        return c.json(opcion.freeRooms <= 0
          ? { code: "sin_disponibilidad", message: "Ya no hay habitaciones disponibles de ese tipo para esas fechas." }
          : { code: "cotizacion_no_disponible", message: "Ese tipo de habitación no se puede reservar en línea para esas fechas." }, 409);
      }
      const anticipo = calcularAnticipo(opcion.totalCents, pol.depositPct);
      const ahora = Date.now();
      const quoteToken = issueQuoteToken(quoteKey, { org: hotel.organizationId, prop: prop.propertyId, rt: body.roomTypeId, in: body.checkInDate, out: body.checkOutDate, g: body.guests, tot: opcion.totalCents }, ahora);
      const t = terminosPublicos(pol.terminos, body.checkInDate);
      return c.json({
        quoteToken,
        venceEn: new Date(ahora + 15 * 60_000).toISOString(),
        propiedad: { slug: prop.slug, nombre: prop.name },
        tipoHabitacion: { id: opcion.roomTypeId, nombre: opcion.roomTypeName },
        llegada: body.checkInDate,
        salida: body.checkOutDate,
        noches: body.nights,
        huespedes: body.guests,
        cotizacion: {
          moneda: "MXN",
          netoCentavos: opcion.netCents,
          ivaCentavos: opcion.ivaCents,
          ishCentavos: opcion.ishCents,
          totalCentavos: opcion.totalCents,
          porNoche: opcion.nightly ?? [],
        },
        anticipo: { porcentaje: pol.depositPct, centavos: anticipo, requerido: anticipo > 0 },
        cancelacion: { gratisHasta: t.gratisHasta, penalidadPct: t.penalidadPct },
      });
    });
  });

  // ---- Confirmacion --------------------------------------------------------------------------------------------------------
  app.post("/v1/hoteles/:orgSlug/reservar/confirmar", async (c) => {
    noStore(c);
    assertOrigin(c);
    const orgSlug = c.req.param("orgSlug");
    const idempotencyKey = parseIdempotencyKey(c.req.header("idempotency-key"));
    const body = parseConfirmarBody(await readJsonCapped<unknown>(c.req.raw, MAX_BODY_BYTES));
    await limitOrThrow("hoteles-reservar-confirmar", ipOf(c), 8, 60);
    // Honeypot: un robot recibe una respuesta de exito SIN token y no se guarda nada.
    if (body.honeypot) return c.json({ ok: true, estado: "recibida" }, 202);
    // Topes por contacto (telefono y correo), en sesion aparte; el rechazo no delata si ya hay reservas con esos datos.
    await limitOrThrow("hoteles-reservar-contacto-telefono", body.contactPhone, 5, 3600);
    await limitOrThrow("hoteles-reservar-contacto-correo", body.contactEmail, 5, 3600);

    const q = verifyQuoteToken(quoteKey, body.quoteToken);
    if (!q.ok) {
      if (q.reason === "expired") return c.json({ code: "cotizacion_vencida", message: "Tu cotización venció. Vuelve a cotizar para ver el precio vigente." }, 409);
      throw Errors.validation("La cotización no es válida. Vuelve a cotizar.");
    }
    const claims = q.claims;

    // Fase 1 (una transaccion): crea el hold. Si el cobro no procede, el hold YA quedo comprometido y visible al staff.
    const fase1 = await deps.engine.withAppSession({ userId: null }, async (db) => {
      const hotel = await cargarHotel(db, orgSlug);
      if (!hotel || hotel.organizationId !== claims.org) throw Errors.notFound("Hotel no encontrado.");
      const prop = hotel.properties.find((p) => p.propertyId === claims.prop);
      if (!prop) throw Errors.notFound("Propiedad no encontrada.");
      const repo = repoOf(db);
      const pol = await repo.webPolicy(prop.propertyId);
      if (!pol.disponible) throw Errors.serviceUnavailable(NO_MIGRADA);
      if (!pol.webEnabled || !pol.holdsEnabled) return { kind: "resp" as const, respuesta: c.json({ code: "reserva_en_linea_no_habilitada", message: "Este hotel aún no recibe reservas en línea." }, 409) };
      const aviso = await versionAviso(db, orgSlug, prop.propertyId);
      let hold: WebHoldRecord;
      try {
        hold = await repo.createWebHold({
          propertyId: prop.propertyId,
          roomTypeId: claims.rt,
          checkInDate: claims.in,
          checkOutDate: claims.out,
          guests: claims.g,
          guestName: body.guestName,
          contactPhone: body.contactPhone,
          contactEmail: body.contactEmail,
          idempotencyKey: `web:${sha(`${prop.propertyId}:${idempotencyKey}`).slice(0, 48)}`,
          expectedTotalCents: claims.tot,
          consentNoticeVersion: aviso,
        });
      } catch (err) {
        return { kind: "resp" as const, respuesta: dominioAHttp(err) };
      }
      // Notificacion in-app al staff (campana): una por hold (clave de dedupe). SAVEPOINT dentro de emitirNotificacion: contra la base sin migrar no revierte el hold.
      await emitirNotificacion(db, {
        evento: "hoteles.reserva_directa.nueva",
        organizationId: hotel.organizationId,
        propertyId: prop.propertyId,
        clave: hold.id,
        entidadTipo: "booking_hold",
        entidadId: hold.id,
      });
      const ctx = await repo.webContext(prop.propertyId, hold.id);
      return { kind: "ok" as const, hotel, prop, hold, ctx };
    });
    if (fase1.kind === "resp") return fase1.respuesta;
    const { hotel, prop, ctx } = fase1;
    let hold = fase1.hold;
    const rastreoToken = issueEstadoToken(estadoKey, { org: hotel.organizationId, prop: prop.propertyId, hold: hold.id });
    const ahora = new Date();
    const base = (status: number, extra: Record<string, unknown> = {}) => c.json({ rastreoToken, ...vista(hold, ctx, ahora), ...extra }, status as 200);

    if (hold.status === "confirmado") return base(200);
    if (hold.status !== "pendiente_pago") return base(202);

    // Fase 2 (SIN sesion): el cobro. Con anticipo y sin metodo de pago tokenizado el hold queda esperando el pago ("pago pendiente").
    if (!body.paymentMethodToken) {
      return base(202, { pago: { estado: hold.paymentStatus, reembolso: hold.refundStatus, requiereAccion: "El hotel te contactará para registrar tu anticipo." } });
    }
    let cobro: Awaited<ReturnType<typeof deps.hotelesPaymentsPort.charge>> | null = null;
    try {
      cobro = await deps.hotelesPaymentsPort.charge({
        amount: hold.depositCents,
        currency: "MXN",
        paymentMethodToken: body.paymentMethodToken,
        idempotencyKey: `h42-pago-${hold.id}-${sha(body.paymentMethodToken).slice(0, 16)}`,
        onSession: true,
      });
    } catch (err) {
      logEvent(c, "warn", "hoteles_reservar_publico_pago_no_disponible", { holdId: hold.id, message: err instanceof Error ? err.message : String(err) });
      return base(503, { code: "pago_no_disponible", message: "El cobro en línea no está disponible por ahora. Tu reserva quedó apartada como pendiente de pago: el hotel te contactará." });
    }

    // Fase 3 (otra transaccion): registrar el resultado. Si el registro falla despues de cobrar, se conserva la referencia de la pasarela para conciliar.
    const registrado = await deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = repoOf(db);
      const estadoPago = cobro!.status === "capturado" ? "capturado" : cobro!.status === "fallido" ? "fallido" : "pendiente";
      try {
        const actualizado = await repo.recordPayment(prop.propertyId, hold.id, estadoPago, cobro!.externalPaymentId);
        return { hold: actualizado, ctx: await repo.webContext(prop.propertyId, hold.id) };
      } catch (err) {
        logEvent(c, "error", "hoteles_reservar_publico_pago_sin_registrar", { holdId: hold.id, intento: cobro!.externalPaymentId, estado: estadoPago, message: err instanceof Error ? err.message : String(err) });
        try {
          const actualizado = await repo.recordPayment(prop.propertyId, hold.id, "pendiente", cobro!.externalPaymentId);
          return { hold: actualizado, ctx };
        } catch {
          return { hold, ctx };
        }
      }
    });
    hold = registrado.hold;
    const ctxFinal = registrado.ctx ?? ctx;
    const resp = (status: number, extra: Record<string, unknown> = {}) => c.json({ rastreoToken, ...vista(hold, ctxFinal, new Date()), ...extra }, status as 200);
    if (hold.status === "confirmado") return resp(200);
    if (cobro.status === "fallido") return resp(402, { code: "pago_rechazado", message: "Tu pago fue rechazado. Tu reserva sigue apartada unos minutos: prueba con otro método de pago." });
    return resp(202);
  });

  // ---- Estado por token ----------------------------------------------------------------------------------------------------
  function leerToken(orgSlugToken: string) {
    const v = verifyEstadoToken(estadoKey, orgSlugToken);
    return v.ok ? v.claims : null;
  }

  app.get("/v1/hoteles/:orgSlug/reservar/estado/:token", async (c) => {
    noStore(c);
    await limitOrThrow("hoteles-reservar-estado", ipOf(c), 60, 60);
    const orgSlug = c.req.param("orgSlug");
    const claims = leerToken(c.req.param("token"));
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const hotel = await cargarHotel(db, orgSlug);
      // Token invalido, vencido, de otra organizacion o de un hold que no existe: la MISMA respuesta (sin oraculo).
      if (!claims || !hotel || hotel.organizationId !== claims.org || !hotel.properties.some((p) => p.propertyId === claims.prop)) throw Errors.notFound("No encontramos esa reserva.");
      const repo = repoOf(db);
      let hold: WebHoldRecord;
      try {
        hold = await repo.getWebHold(claims.prop, claims.hold);
      } catch (err) {
        if (err instanceof ReservasAgenteError && err.code === "no_encontrada") throw Errors.notFound("No encontramos esa reserva.");
        return dominioAHttp(err);
      }
      return c.json(vista(hold, await repo.webContext(claims.prop, claims.hold), new Date()));
    });
  });

  // ---- Cancelacion por token -----------------------------------------------------------------------------------------------
  app.post("/v1/hoteles/:orgSlug/reservar/estado/:token/cancelar", async (c) => {
    noStore(c);
    assertOrigin(c);
    const orgSlug = c.req.param("orgSlug");
    parseIdempotencyKey(c.req.header("idempotency-key"));
    parseCancelarVacio(await readJsonCapped<unknown>(c.req.raw, 1024));
    await limitOrThrow("hoteles-reservar-cancelar", ipOf(c), 10, 60);
    const token = c.req.param("token");
    const claims = leerToken(token);
    if (claims) await limitOrThrow("hoteles-reservar-cancelar-reserva", claims.hold, 6, 3600);

    // Fase 1: cancelar (libera inventario y aplica cancellation_policy en la base).
    const fase1 = await deps.engine.withAppSession({ userId: null }, async (db) => {
      const hotel = await cargarHotel(db, orgSlug);
      if (!claims || !hotel || hotel.organizationId !== claims.org || !hotel.properties.some((p) => p.propertyId === claims.prop)) throw Errors.notFound("No encontramos esa reserva.");
      const repo = repoOf(db);
      let previo: WebHoldRecord;
      let hold: WebHoldRecord;
      try {
        previo = await repo.getWebHold(claims.prop, claims.hold);
        hold = await repo.cancelWebHold(claims.prop, claims.hold);
      } catch (err) {
        if (err instanceof ReservasAgenteError && err.code === "no_encontrada") throw Errors.notFound("No encontramos esa reserva.");
        return { kind: "resp" as const, respuesta: dominioAHttp(err) };
      }
      const recienCancelada = previo.canceledAt === null && previo.status !== "cancelado" && hold.canceledAt !== null;
      if (recienCancelada) {
        // Las noches liberadas se ofrecen a la lista de espera (FIFO) y se avisa al staff. Best-effort con SAVEPOINT: nunca revierte la cancelacion.
        await ofrecerListaEsperaTrasLiberacion(deps, db, { organizationId: hotel.organizationId, propertyId: claims.prop, roomTypeId: hold.roomTypeId, noches: nightsBetween(hold.checkInDate, hold.checkOutDate) });
      }
      return { kind: "ok" as const, hold, ctx: await repo.webContext(claims.prop, claims.hold), hotel, recienCancelada };
    });
    if (fase1.kind === "resp") return fase1.respuesta;
    let hold = fase1.hold;
    const { ctx, hotel } = fase1;
    const propertyId = hold.propertyId;

    // Fase 2 (SIN sesion): reembolso por la pasarela si hubo cobro capturado. Sin llave/adaptador: queda la solicitud para el staff.
    let reembolsoRef: string | null = null;
    if (hold.refundStatus === "solicitado" && (hold.refundCents ?? 0) > 0 && hold.paymentStatus === "capturado" && hold.paymentRef && typeof deps.hotelesPaymentsPort.refund === "function") {
      try {
        const r = await deps.hotelesPaymentsPort.refund({ externalPaymentId: hold.paymentRef, amount: hold.refundCents as number, idempotencyKey: `h42-reembolso-${hold.id}` });
        if (r.status === "procesado") reembolsoRef = r.externalRefundId;
      } catch (err) {
        logEvent(c, "warn", "hoteles_reservar_publico_reembolso_pendiente", { holdId: hold.id, message: err instanceof Error ? err.message : String(err) });
      }
    }

    // Fase 3: registrar el reembolso procesado, o avisar al staff que hay uno por atender (clave de dedupe: el hold).
    if (fase1.recienCancelada || reembolsoRef) {
      hold = await deps.engine.withAppSession({ userId: null }, async (db) => {
        const repo = repoOf(db);
        let actual = hold;
        if (reembolsoRef) {
          try {
            actual = await repo.markRefunded(propertyId, hold.id, reembolsoRef);
          } catch (err) {
            logEvent(c, "error", "hoteles_reservar_publico_reembolso_sin_registrar", { holdId: hold.id, referencia: reembolsoRef, message: err instanceof Error ? err.message : String(err) });
          }
        }
        if (actual.refundStatus === "solicitado") {
          await emitirNotificacion(db, {
            evento: "hoteles.reserva_directa.reembolso_pendiente",
            organizationId: hotel.organizationId,
            propertyId,
            clave: actual.id,
            entidadTipo: "booking_hold",
            entidadId: actual.id,
          });
        }
        return actual;
      });
    }
    return c.json(vista(hold, ctx, new Date()));
  });

  return app;
}
