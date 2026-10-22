// Login del REPARTIDOR con celular + codigo de 6 digitos por WhatsApp (docs/LOGIN-CHOFER-WHATSAPP.md). SOLO cuentas cuyo unico rol es
// `repartidor` de restaurantes: la elegibilidad la decide la base (core.chofer_login_es_elegible) en cada paso. El login por correo
// (`routes/auth.ts`, magic link, Google) no cambia.
//
//   GET  /auth/login-telefono/estado     -- { disponible }  (bandera encendida + plantilla `codigo_acceso` aprobada en alguna organizacion).
//   POST /auth/login-telefono/solicitar  -- SIEMPRE el mismo 200 { ok, expiraEnSegundos }, exista o no la cuenta (sin enumeracion).
//   POST /auth/login-telefono/verificar  -- mismo 401 para cualquier fallo; exito = la MISMA sesion que /auth/login (`issueSession`).
//
// Reglas que esta ruta cuida (el resto vive en la base): sin bandera o sin plantilla aprobada -> 503 "no disponible aun" identico para
// todos y NO se envia nada; el mensaje sale solo como plantilla (`solo_plantilla`), nunca como texto libre; el telefono y la IP solo
// existen como HMAC en la auditoria/limites y nunca en los logs.
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { getDefaultLoginLockout, rateLimit } from "@atiende/core-ratelimit";
import { LoginChoferNoDisponibleError } from "@atiende/db";
import type { LoginChoferRepository } from "@atiende/db";
import { Errors } from "../errors.ts";
import { readJsonCapped, requestActor } from "../http-security.ts";
import { logEvent } from "../logger.ts";
import type { AppDeps } from "../deps.ts";
import { CODIGO_MAX_INTENTOS, CODIGO_TTL_SEGUNDOS, derivarLlave, generarCodigo, generarSal, hashCodigo, iguales, normalizarCodigoIngresado, pseudonimo } from "../login-telefono/codigo.ts";
import { normalizarTelefonoMx } from "../login-telefono/telefono.ts";
import { triggerRestaurantesWhatsAppDispatchInline } from "./internal/whatsapp-dispatch.ts";
import { issueSession } from "./auth.ts";

const MENSAJE_NO_DISPONIBLE = "El acceso con celular todavía no está disponible. Entra con tu correo o pídele ayuda a tu encargado.";
const MENSAJE_CODIGO_MALO = "Código incorrecto o vencido. Pide uno nuevo.";
const MAX_SOLICITUDES_TELEFONO = 3;
const MAX_SOLICITUDES_IP = 10;
const VENTANA_SEGUNDOS = 15 * 60;
const BLOQUEO_SEGUNDOS = 30 * 60;
const RATE_SOLICITAR = { max: 5, windowMs: 5 * 60_000 } as const;
const RATE_VERIFICAR = { max: 10, windowMs: 5 * 60_000 } as const;
const BODY_MAX_BYTES = 1024;
/** Cuerpo fijo del payload (obligatorio para el gateway): NO lleva el codigo. Con `solo_plantilla` jamas se envia como texto. */
const CUERPO_FIJO_SIN_CODIGO = "Código de acceso de atiende";
const SAL_SENUELO = "0".repeat(32);
const HASH_SENUELO = "0".repeat(64);

function ipDe(req: Request): string {
  return requestActor(req).replace(/:$/, "");
}

async function habilitado(deps: AppDeps): Promise<boolean> {
  return deps.env.loginChoferWhatsapp === true && deps.loginChoferRepo !== undefined;
}

export function authLoginTelefonoRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const llave = derivarLlave(deps.env.jwtSecret);

  /** Sesion de sistema (antes del login no hay `auth.uid()`). Un fallo de "base sin migrar" sale como `null` -> 503 honesto. */
  async function conRepo<T>(fn: (repo: LoginChoferRepository, db: TenantDbSession) => Promise<T>): Promise<T | "no_disponible"> {
    try {
      return await deps.engine.withAppSession({ userId: null }, (db) => fn(deps.loginChoferRepo!(db), db));
    } catch (err) {
      if (err instanceof LoginChoferNoDisponibleError) return "no_disponible";
      throw err;
    }
  }

  app.get("/auth/login-telefono/estado", async (c) => {
    if (!(await habilitado(deps))) return c.json({ disponible: false }, 200);
    const ok = await conRepo((repo) => repo.plantillaDisponible());
    return c.json({ disponible: ok === true }, 200);
  });

  app.post("/auth/login-telefono/solicitar", async (c) => {
    if (!(await habilitado(deps))) throw Errors.serviceUnavailable(MENSAJE_NO_DISPONIBLE);
    const raw = await readJsonCapped<{ telefono?: unknown }>(c.req.raw, BODY_MAX_BYTES).catch(() => ({}) as { telefono?: unknown });
    const telefono = normalizarTelefonoMx(raw.telefono);
    // Validacion de FORMATO: no depende de si existe una cuenta.
    if (!telefono) throw Errors.validation("Escribe tu celular de 10 dígitos.");
    const telHash = pseudonimo(llave, "tel", telefono);
    const ip = ipDe(c.req.raw);
    const ipHash = pseudonimo(llave, "ip", ip);

    // Primera barrera barata (en memoria/Redis), antes de tocar la base: por IP+telefono y solo por IP.
    const permitido = await rateLimit(`auth:login-tel:${requestActor(c.req.raw, telHash)}`, RATE_SOLICITAR.max, RATE_SOLICITAR.windowMs, { category: "auth:login" });
    if (!permitido) throw Errors.tooManyRequests("Demasiados intentos. Intenta de nuevo en unos minutos.");

    const resultado = await conRepo(async (repo, db) => {
      if (!(await repo.plantillaDisponible())) return "plantilla" as const;
      const limite = await repo.puedeSolicitar({ telefonoHash: telHash, ipHash, maxTelefono: MAX_SOLICITUDES_TELEFONO, maxIp: MAX_SOLICITUDES_IP, ventanaSegundos: VENTANA_SEGUNDOS, bloqueoSegundos: BLOQUEO_SEGUNDOS });
      // 'bloqueado' se trata como exito: un bloqueo solo existe para telefonos con cuenta, nunca debe distinguirse desde fuera.
      if (limite === "limitado") return "limitado" as const;
      if (limite === "bloqueado") return "ok" as const;

      const codigo = generarCodigo();
      const sal = generarSal();
      // Mismo costo criptografico exista o no la cuenta.
      const hash = hashCodigo(llave, sal, codigo);
      const cuenta = await repo.resolver(telefono);
      if (!cuenta) {
        await repo.registrarEvento({ tipo: "cuenta_no_elegible", telefonoHash: telHash, ipHash });
        return "ok" as const;
      }
      const plantilla = await repo.plantilla(cuenta.organizationId);
      const restaurantes = deps.restaurantesRepo(db);
      const phoneNumberId = plantilla ? await restaurantes.resolveActiveWhatsAppPhoneNumberId(cuenta.organizationId, cuenta.propertyIds?.[0] ?? null) : null;
      if (!plantilla || !phoneNumberId) {
        // Sin plantilla aprobada para ESTA organizacion o sin numero remitente: no se envia nada (jamas texto libre) y se deja rastro.
        await repo.registrarEvento({ tipo: "plantilla_no_disponible", telefonoHash: telHash, ipHash, userId: cuenta.userId, organizationId: cuenta.organizationId });
        return "ok" as const;
      }
      const codigoId = await repo.emitir({ userId: cuenta.userId, organizationId: cuenta.organizationId, codeHash: hash, codeSalt: sal, expiresAt: new Date(Date.now() + CODIGO_TTL_SEGUNDOS * 1000).toISOString() });
      if (!codigoId) {
        await repo.registrarEvento({ tipo: "cuenta_no_elegible", telefonoHash: telHash, ipHash, userId: cuenta.userId, organizationId: cuenta.organizationId });
        return "ok" as const;
      }
      await restaurantes.enqueueMessagingOutbox(cuenta.organizationId, "whatsapp", "auth.codigo_acceso", `auth-codigo:${codigoId}`, {
        to: telefono,
        phone_number_id: phoneNumberId,
        body: CUERPO_FIJO_SIN_CODIGO,
        template: { name: plantilla.nombre, language: plantilla.idioma, params: [codigo], codigoBoton: codigo },
        solo_plantilla: true,
        transaccional: true,
        critico: true,
      });
      await repo.registrarEvento({ tipo: "codigo_encolado", telefonoHash: telHash, ipHash, userId: cuenta.userId, organizationId: cuenta.organizationId });
      // Envio inmediato (mejor esfuerzo, SAVEPOINT propio); el cron de WhatsApp es la red de seguridad.
      await triggerRestaurantesWhatsAppDispatchInline(deps, db, restaurantes);
      return "ok" as const;
    });

    // Los errores se lanzan DESPUES de confirmar la transaccion: los contadores/auditoria deben persistir.
    if (resultado === "no_disponible" || resultado === "plantilla") throw Errors.serviceUnavailable(MENSAJE_NO_DISPONIBLE);
    if (resultado === "limitado") throw Errors.tooManyRequests("Pediste demasiados códigos. Espera unos minutos e inténtalo de nuevo.");
    logEvent(c, "info", "login_telefono_solicitud", { telHash: telHash.slice(0, 12) });
    return c.json({ ok: true, expiraEnSegundos: CODIGO_TTL_SEGUNDOS }, 200);
  });

  app.post("/auth/login-telefono/verificar", async (c) => {
    if (!(await habilitado(deps))) throw Errors.serviceUnavailable(MENSAJE_NO_DISPONIBLE);
    const raw = await readJsonCapped<{ telefono?: unknown; codigo?: unknown }>(c.req.raw, BODY_MAX_BYTES).catch(() => ({}) as { telefono?: unknown; codigo?: unknown });
    const telefono = normalizarTelefonoMx(raw.telefono);
    const codigo = normalizarCodigoIngresado(raw.codigo);
    if (!telefono) throw Errors.validation("Escribe tu celular de 10 dígitos.");
    if (!codigo) throw Errors.validation("Escribe el código de 6 dígitos.");
    const telHash = pseudonimo(llave, "tel", telefono);
    const ipHash = pseudonimo(llave, "ip", ipDe(c.req.raw));

    const permitido = await rateLimit(`auth:login-tel-v:${requestActor(c.req.raw, telHash)}`, RATE_VERIFICAR.max, RATE_VERIFICAR.windowMs, { category: "auth:login" });
    if (!permitido) throw Errors.tooManyRequests("Demasiados intentos. Intenta de nuevo en unos minutos.");
    // Bloqueo con retroceso por llave IP+telefono, igual que /auth/login; depende solo de la llave, nunca de si la cuenta existe.
    const lockout = getDefaultLoginLockout();
    const lockKey = requestActor(c.req.raw, telHash);
    const estado = await lockout.status(lockKey);
    if (estado.locked) throw Errors.loginLocked(estado.retryAfterMs);

    const staff = await conRepo(async (repo) => {
      const reservado = await repo.reservarIntento(telefono);
      // Sin cuenta/codigo se compara contra un senuelo para igualar el costo; el resultado se descarta.
      const esperado = reservado ? reservado.codeHash : HASH_SENUELO;
      const sal = reservado ? reservado.codeSalt : SAL_SENUELO;
      const coincide = iguales(hashCodigo(llave, sal, codigo), esperado) && reservado !== null;
      if (!reservado) {
        await repo.registrarEvento({ tipo: "verificacion_fallo", telefonoHash: telHash, ipHash });
        return null;
      }
      if (!coincide) {
        const agotado = await repo.registrarFallo(reservado.codigoId);
        await repo.registrarEvento({ tipo: agotado ? "codigo_agotado" : "verificacion_fallo", telefonoHash: telHash, ipHash, userId: reservado.userId, organizationId: reservado.organizationId });
        if (agotado && reservado.intentos >= CODIGO_MAX_INTENTOS) logEvent(c, "warn", "login_telefono_codigo_agotado", { telHash: telHash.slice(0, 12) });
        return null;
      }
      const fila = await repo.consumir(reservado.codigoId);
      await repo.registrarEvento({ tipo: fila ? "verificacion_ok" : "verificacion_fallo", telefonoHash: telHash, ipHash, userId: reservado.userId, organizationId: reservado.organizationId });
      return fila;
    });

    if (staff === "no_disponible") throw Errors.serviceUnavailable(MENSAJE_NO_DISPONIBLE);
    if (!staff) {
      await lockout.recordFailure(lockKey);
      throw Errors.unauthorized(MENSAJE_CODIGO_MALO);
    }
    await lockout.recordSuccess(lockKey);
    // MISMA sesion que /auth/login: mismos tiempos de vida, registro de sesion y revocacion.
    return c.json(await issueSession(deps, staff.id, staff.email, staff.fullName, { c }), 200);
  });

  return app;
}
