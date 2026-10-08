// Rn-P3-08 -- pre-check-in PUBLICO por reserva. El huesped de una OTA (Airbnb, Booking, Vrbo) llega por iCal sin correo; con el enlace fijo de la
// property escribe su codigo de confirmacion y los ultimos 4 digitos de su telefono (ambos vienen del iCal) y deja su correo para recibir el acceso.
//
//   GET  /rentas/precheckin/:propertyId             datos de la pantalla (nombre de la propiedad, reglamento, aviso de privacidad)
//   POST /rentas/precheckin/:propertyId/verificar   { codigo, ultimos4 } -> token de un solo uso si coincide con una reserva confirmada y proxima
//   POST /rentas/precheckin/:propertyId/capturar    { token, correo, whatsapp?, aceptaPrivacidad, aceptaReglamento }
//
// SIN authMiddleware/dbSession de staff a proposito (el huesped no tiene cuenta): sesion "de sistema" (`engine.withAppSession({ userId: null })`),
// igual que el feed iCal publico. Montada ANTES de las rutas de staff `/rentas/:propertyId/...` (ver rentas.ts) por la misma razon de forma de ruta.
//
// Defensa contra abuso:
//  - rate limit por IP+property y por IP (core-ratelimit) ANTES de tocar la base;
//  - 5 intentos fallidos con un mismo codigo bloquean ese codigo 1 h (lo aplica rentas.precheckin_verificar; cuenta igual un codigo que no existe);
//  - un dato que no coincide, una reserva pasada/cancelada/de otra property y un codigo inexistente dan LA MISMA respuesta, y la respuesta de
//    /verificar tarda al menos PISO_RESPUESTA_VERIFICAR_MS (no se distingue "existe" de "no existe" por tiempo);
//  - el token es de un solo uso y vence a los 15 min; la base solo guarda su hash;
//  - el codigo, el telefono y el correo NUNCA se registran en logs (logEvent solo recibe el resultado).
// Todas las respuestas llevan `Cache-Control: no-store`. Base sin la migracion 036: 503 "aun no disponible" (nunca un 500).
import { Hono } from "hono";
import { rateLimit } from "@atiende/core-ratelimit";
import {
  PostgresRentasPrecheckinRepository,
  avisoPrivacidadPrecheckin,
  capturarPrecheckin,
  validarCaptura,
  validarVerificacion,
  verificarPrecheckin,
} from "@atiende/domain-rentas";
import type { RentasPrecheckinRepository } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped, requestActor } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 4 * 1024;
/** Intentos de verificar/capturar por IP y property en 10 min (un huesped real necesita 1 o 2). */
const LIMITE_POR_PROPERTY = { max: 12, windowMs: 10 * 60_000 } as const;
/** Tope por IP en todas las properties (frena a quien recorre enlaces). */
const LIMITE_POR_IP = { max: 40, windowMs: 10 * 60_000 } as const;
/** Piso de tiempo de /verificar: iguala el tiempo de "no coincide" y "coincide" (que ademas crea un token). */
export const PISO_RESPUESTA_VERIFICAR_MS = 250;

const MENSAJE_INVALIDO = "No pudimos validar tus datos. Revisa el código de confirmación y los últimos 4 dígitos de tu teléfono.";
const MENSAJE_BLOQUEADO = "Demasiados intentos con ese código. Intenta de nuevo en una hora o escribe a tu anfitrión.";
const MENSAJE_NO_DISPONIBLE = "El pre-check-in aún no está disponible para esta propiedad.";

const dormir = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function rentasPrecheckinPublicoRoutes(deps: AppDeps): Hono {
  const app = new Hono();
  const repo = (db: Parameters<AppDeps["rentasRepo"]>[0]): RentasPrecheckinRepository => (deps.rentasPrecheckinRepo ? deps.rentasPrecheckinRepo(db) : new PostgresRentasPrecheckinRepository(db));

  async function limitar(c: { req: { raw: Request } }, propertyId: string): Promise<void> {
    const actor = requestActor(c.req.raw);
    const porIp = await rateLimit(`rentas:precheckin:ip:${actor}`, LIMITE_POR_IP.max, LIMITE_POR_IP.windowMs, { category: "rentas:precheckin-publico" });
    const porProperty = await rateLimit(`rentas:precheckin:${propertyId}:${actor}`, LIMITE_POR_PROPERTY.max, LIMITE_POR_PROPERTY.windowMs, { category: "rentas:precheckin-publico" });
    if (!porIp || !porProperty) throw Errors.tooManyRequests("Demasiadas solicitudes. Intenta de nuevo en unos minutos.");
  }

  /** Un enlace con un id que no es UUID se trata como una propiedad que no existe (404 fijo), igual que un UUID desconocido. */
  function propiedad(propertyId: string): string {
    if (!UUID_RE.test(propertyId)) throw Errors.notFound("Este enlace de pre-check-in no es válido.");
    return propertyId;
  }

  app.get("/rentas/precheckin/:propertyId", async (c) => {
    const propertyId = propiedad(c.req.param("propertyId"));
    await limitar(c, propertyId);
    c.header("Cache-Control", "no-store");
    const r = await deps.engine.withAppSession({ userId: null }, (db) => repo(db).obtenerInfo(propertyId));
    if (!r.disponible) throw Errors.serviceUnavailable(MENSAJE_NO_DISPONIBLE);
    if (r.valor === null) throw Errors.notFound("Este enlace de pre-check-in no es válido.");
    const aviso = avisoPrivacidadPrecheckin(r.valor.organizacionNombre);
    return c.json(
      {
        propiedad: r.valor.propiedadNombre,
        organizacion: r.valor.organizacionNombre,
        reglamento: r.valor.reglamento,
        aviso: { version: aviso.version, titulo: aviso.titulo, parrafos: aviso.parrafos },
      },
      200,
    );
  });

  app.post("/rentas/precheckin/:propertyId/verificar", async (c) => {
    const inicio = Date.now();
    const propertyId = propiedad(c.req.param("propertyId"));
    await limitar(c, propertyId);
    c.header("Cache-Control", "no-store");
    const v = validarVerificacion(await readJsonCapped<unknown>(c.req.raw, MAX_BODY));
    if (!v.ok) throw Errors.validation(v.error);
    const r = await deps.engine.withAppSession({ userId: null }, (db) => verificarPrecheckin(repo(db), propertyId, v.valor));
    const restante = PISO_RESPUESTA_VERIFICAR_MS - (Date.now() - inicio);
    if (restante > 0) await dormir(restante);
    // Solo el resultado: nunca el codigo, el telefono ni la reserva.
    logEvent(c, "info", "rentas.precheckin.verificar", { propertyId, resultado: r.estado });
    if (r.estado === "no_disponible") throw Errors.serviceUnavailable(MENSAJE_NO_DISPONIBLE);
    if (r.estado === "bloqueado") throw Errors.tooManyRequests(MENSAJE_BLOQUEADO);
    if (r.estado === "invalido") return c.json({ estado: "invalido", mensaje: MENSAJE_INVALIDO }, 200);
    return c.json(
      { estado: "ok", token: r.token, token_expira_en: r.tokenExpiraEn, propiedad: r.propiedadNombre, unidad: r.unidadNombre, check_in: r.checkIn, check_out: r.checkOut, ya_capturado: r.yaCapturado },
      200,
    );
  });

  app.post("/rentas/precheckin/:propertyId/capturar", async (c) => {
    const propertyId = propiedad(c.req.param("propertyId"));
    await limitar(c, propertyId);
    c.header("Cache-Control", "no-store");
    const v = validarCaptura(await readJsonCapped<unknown>(c.req.raw, MAX_BODY));
    if (!v.ok) throw Errors.validation(v.error);
    const r = await deps.engine.withAppSession({ userId: null }, (db) => capturarPrecheckin(repo(db), v.valor));
    logEvent(c, "info", "rentas.precheckin.capturar", { propertyId, resultado: r.estado });
    switch (r.estado) {
      case "no_disponible":
        throw Errors.serviceUnavailable(MENSAJE_NO_DISPONIBLE);
      case "token_invalido":
        throw Errors.validation("La verificación expiró o ya se usó. Vuelve a empezar.");
      case "privacidad_requerida":
        throw Errors.validation("Debes aceptar el aviso de privacidad para continuar.");
      case "reglamento_requerido":
        throw Errors.validation("Debes aceptar el reglamento de la casa para continuar.");
      case "ya_capturado":
        return c.json({ estado: "ya_capturado", mensaje: "Ya recibimos tus datos para esta reserva. Si necesitas cambiarlos, escribe a tu anfitrión." }, 200);
      default:
        return c.json({ estado: "ok", mensaje: "Listo. Te enviaremos las instrucciones de acceso por correo antes de tu llegada." }, 200);
    }
  });

  return app;
}
