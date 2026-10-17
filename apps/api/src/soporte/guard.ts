// Guarda CENTRAL de las sesiones de soporte ("entrar a un cliente" desde el superadmin).
//
// Un token con el claim `soporte` (ver packages/core-auth/src/jwt.ts::SoporteClaim) es el que recibe el superadmin al entrar al
// panel de una organización de cliente. Esta guarda se monta UNA vez, global, en app.ts (antes de cualquier ruta) y por eso cubre
// las 6 verticales y cualquier ruta futura sin tocar cada archivo -- mismo criterio fail-closed que el write-guard de
// `/superadmin/*` (routes/superadmin.ts): lo que no está permitido explícitamente se niega.
//
//   1. La sesión se verifica EN SQL en cada petición (`getSupportState`): activa, del mismo usuario y de la misma organización que
//      el token. Terminada, vencida, de otra organización o imposible de verificar -> se niega (401/503), nunca se deja pasar.
//   2. Política por método y ruta (`evaluarPeticionSoporte`, pura y probada aparte):
//        - `/superadmin/*` nunca (la consola de plataforma no se usa desde una sesión de cliente);
//        - GET/HEAD/OPTIONS permitidos;
//        - SIEMPRE bloqueado aun con edición habilitada: DELETE, cuenta/contraseña/2FA (`/auth/*`), pagos y plan, privacidad/ARCO,
//          mensajes reales a clientes finales, importaciones masivas, voz/llamadas, equipo e invitaciones, secretos;
//        - POST de solo lectura (lista cerrada): consulta del chat de datos y vistas previas/exportaciones del CFO;
//        - resto de POST/PUT/PATCH: 403 `soporte_solo_lectura` mientras el token no esté elevado (`ro: false`, emitido por
//          POST /soporte/elevar con segundo motivo registrado).
//   3. La bitácora no guarda el contenido visto: aquí no se escribe nada, solo se decide.
import type { Context, MiddlewareHandler, Next } from "hono";
import { ApiError, verifyAccessToken } from "@atiende/core-auth";
import type { AccessTokenClaims } from "@atiende/core-auth";
import { Errors } from "../errors.ts";
import type { AppDeps } from "../deps.ts";

export type DecisionSoporte =
  | { readonly permitido: true }
  | { readonly permitido: false; readonly code: "soporte_solo_lectura" | "soporte_accion_bloqueada" | "soporte_ruta_bloqueada"; readonly message: string };

/** Endpoints propios de la sesión de soporte: los valida su propio handler (SQL), nunca la política de solo lectura. */
const RUTAS_PROPIAS_SOPORTE: ReadonlyArray<{ readonly method: string; readonly re: RegExp }> = [
  { method: "GET", re: /^\/soporte\/estado$/ },
  { method: "POST", re: /^\/soporte\/elevar$/ },
  { method: "POST", re: /^\/soporte\/salir$/ },
];

/** Acciones sensibles: bloqueadas SIEMPRE en sesión de soporte (también con edición habilitada). Lista cerrada y revisable. */
export const ACCIONES_SIEMPRE_BLOQUEADAS: ReadonlyArray<{ readonly nombre: string; readonly re: RegExp }> = [
  { nombre: "cuenta, contraseña, correo y verificación en dos pasos", re: /^\/auth(\/|$)/ },
  { nombre: "pagos, plan y facturación", re: /(^|\/)(billing|pagos?|payments?|checkout|stripe|suscripcion(es)?|facturacion)(\/|$)/ },
  { nombre: "privacidad, ARCO, supresión y retención de datos", re: /(^|\/)(privacidad|arco|derechos|supresion|retencion|consentimientos?)(\/|$)|borrar-memoria/ },
  { nombre: "mensajes reales a clientes finales", re: /(^|\/)(whatsapp|mensajes?|messages?|broadcast|campanas?|marketing|enviar|send|callbacks?|email|sms|outbox|conversaciones)(\/|$)/ },
  { nombre: "importaciones y cargas masivas", re: /(^|\/)(import|importar|importaciones|bulk|masivo|purge)(\/|$)/ },
  { nombre: "voz y llamadas", re: /(^|\/)(voice|voz|llamadas?)(\/|$)/ },
  { nombre: "equipo, invitaciones y roles", re: /(^|\/)(staff|invitaciones?|invites?|equipo|members?|membership|roles?)(\/|$)/ },
  { nombre: "secretos y credenciales", re: /(^|\/)(secrets?|credenciales|api-keys?|webhooks?|tokens?)(\/|$)|voice-secret/ },
];

/** POST que SOLO leen o generan un archivo/vista previa (no cambian datos del cliente): permitidos en solo lectura. */
export const POST_DE_SOLO_LECTURA: ReadonlyArray<RegExp> = [
  /^\/v1\/restaurantes\/[^/]+\/admin\/chat-datos$/,
  /^\/v1\/restaurantes\/[^/]+\/cfo\/exportaciones$/,
  /^\/v1\/restaurantes\/[^/]+\/cfo\/softrestaurant\/importar\/vista-previa$/,
  /^\/v1\/restaurantes\/[^/]+\/admin\/customers\/import\/preview$/,
];

const METODOS_DE_LECTURA = new Set(["GET", "HEAD", "OPTIONS"]);

/** Sin cuerpo ni red: dado método, ruta y si el token está elevado, decide. Probada con `tests/soporte-guard.spec.ts`. */
export function evaluarPeticionSoporte(input: { readonly method: string; readonly path: string; readonly elevado: boolean }): DecisionSoporte {
  const method = input.method.toUpperCase();
  const path = (input.path.toLowerCase().replace(/\/+$/, "") || "/");

  if (RUTAS_PROPIAS_SOPORTE.some((r) => r.method === method && r.re.test(path))) return { permitido: true };

  if (path === "/superadmin" || path.startsWith("/superadmin/")) {
    return { permitido: false, code: "soporte_ruta_bloqueada", message: "La consola de plataforma no está disponible dentro de una sesión de soporte. Sal de la sesión para volver." };
  }

  if (METODOS_DE_LECTURA.has(method)) return { permitido: true };

  if (method === "DELETE") {
    return { permitido: false, code: "soporte_accion_bloqueada", message: "Borrar datos de un cliente no está permitido en una sesión de soporte." };
  }
  // Lista cerrada de POST que solo leen: se evalúa ANTES de las acciones sensibles (la vista previa de una importación no importa nada).
  if (method === "POST" && POST_DE_SOLO_LECTURA.some((re) => re.test(path))) return { permitido: true };

  for (const { nombre, re } of ACCIONES_SIEMPRE_BLOQUEADAS) {
    if (re.test(path)) {
      return { permitido: false, code: "soporte_accion_bloqueada", message: `Acción bloqueada en sesión de soporte (${nombre}). Pídesela al cliente o hazla con otro procedimiento autorizado.` };
    }
  }

  if (!input.elevado) {
    return { permitido: false, code: "soporte_solo_lectura", message: "Sesión de soporte en solo lectura. Usa «Permitir edición» (pide un segundo motivo y queda registrado) para modificar datos." };
  }
  return { permitido: true };
}

function bearer(c: Context): string | null {
  const header = c.req.header("authorization");
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
}

/** Claims del token de la petición si trae el claim `soporte` y la firma es válida; `null` en cualquier otro caso. */
export async function leerClaimsSoporte(c: Context, jwtSecret: string): Promise<(AccessTokenClaims & { soporte: NonNullable<AccessTokenClaims["soporte"]> }) | null> {
  const token = bearer(c);
  if (!token) return null;
  try {
    const claims = await verifyAccessToken(token, jwtSecret);
    return claims.soporte ? (claims as AccessTokenClaims & { soporte: NonNullable<AccessTokenClaims["soporte"]> }) : null;
  } catch {
    // Token inválido o vencido: lo rechaza el authMiddleware de la ruta; esta guarda solo actúa sobre tokens de soporte válidos.
    return null;
  }
}

export function soporteGuard(deps: AppDeps): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const claims = await leerClaimsSoporte(c, deps.env.jwtSecret);
    if (!claims) return next();

    // 1) Sesión verificada en SQL, fail-closed.
    let state;
    try {
      const r = await deps.engine.withAppSession({ userId: claims.sub }, (db) => deps.impersonationRepo(db).getSupportState(claims.sub, claims.soporte.sid));
      state = r.availability === "available" ? r.state : null;
    } catch {
      throw Errors.serviceUnavailable("No se pudo verificar la sesión de soporte. Por seguridad no se permite la petición; intenta de nuevo.");
    }
    if (!state || !state.active || state.organizationId !== claims.org_id) {
      throw Errors.unauthorized("La sesión de soporte terminó o venció. Vuelve a entrar desde la consola de plataforma.");
    }
    if (claims.soporte.ro === false && !state.elevated) {
      throw Errors.unauthorized("La elevación de esta sesión de soporte no está registrada. Vuelve a entrar desde la consola de plataforma.");
    }

    // 2) Política por método y ruta.
    const decision = evaluarPeticionSoporte({ method: c.req.method, path: c.req.path, elevado: claims.soporte.ro === false });
    if (!decision.permitido) throw new ApiError(403, decision.code, decision.message);
    return next();
  };
}
