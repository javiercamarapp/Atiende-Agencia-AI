// Middlewares transversales — portado y generalizado de
// `hoteles/apps/api/src/middleware.ts` (ADR-004/ADR-008):
//  - authMiddleware: valida el JWT (Bearer) y expone {userId, userEmail,
//    organizationId, vertical, propertyIds}.
//  - dbSession: abre UNA transacción por request vía `TenancyEngine.withAppSession`
//    (RLS real) y la comparte con toda la cadena de middlewares/handler restante;
//    confirma al terminar sin error, revierte si algo lanza.
//  - requirePropertyMembership: generaliza `requireHotelMembership` — 403 explícito
//    (defensa en profundidad, además de RLS) ANTES de tocar la tabla de negocio cuando
//    el usuario no pertenece a la property de la ruta o no tiene uno de los
//    `allowedRoles` de PLATAFORMA permitidos. La autoridad real de organizationId/
//    propertyIds para el resto del request es SIEMPRE la membership verificada en este
//    momento contra `core.membership` — nunca el claim del JWT (ADR-004).
//  - assertVerticalRole: segunda capa, delega la lista concreta de roles finos
//    (ej. "frontdesk"|"housekeeping") a cada domain-<vertical> — core-auth nunca
//    conoce esos nombres.
import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler, Next } from "hono";
import type { PlatformRole, TenancyEngine } from "@atiende/core-tenancy";
import { Errors } from "./errors.ts";
import { verifyAccessToken, TokenExpiredError } from "./jwt.ts";
import type { CoreAuthEnv, CoreAuthHonoEnv } from "./types.ts";

type Ctx = Context<CoreAuthHonoEnv>;

export function requestId(): MiddlewareHandler<CoreAuthHonoEnv> {
  return async (c: Ctx, next: Next) => {
    const incoming = c.req.header("x-request-id");
    const id = incoming && incoming.length <= 100 ? incoming : randomUUID();
    c.set("requestId", id);
    c.header("x-request-id", id);
    await next();
  };
}

export function authMiddleware(env: CoreAuthEnv): MiddlewareHandler<CoreAuthHonoEnv> {
  return async (c: Ctx, next: Next) => {
    const header = c.req.header("authorization");
    if (!header?.startsWith("Bearer ")) throw Errors.unauthorized("Falta el header Authorization: Bearer <token>.");
    const token = header.slice("Bearer ".length).trim();

    try {
      const claims = await verifyAccessToken(token, env.jwtSecret);
      c.set("userId", claims.sub);
      c.set("userEmail", claims.email);
      c.set("organizationId", claims.org_id);
      c.set("vertical", claims.vertical);
      c.set("propertyIds", claims.property_ids);
    } catch (err) {
      if (err instanceof TokenExpiredError) throw Errors.unauthorized("El token expiró. Inicia sesión de nuevo.");
      throw Errors.unauthorized();
    }

    await next();
  };
}

export function dbSession(engine: TenancyEngine): MiddlewareHandler<CoreAuthHonoEnv> {
  return async (c: Ctx, next: Next) => {
    await engine.withAppSession({ userId: c.get("userId") ?? null }, async (session) => {
      c.set("db", session);
      await next();
      // Hono compone `onError` en CADA nivel del dispatch chain (ver
      // `compose.js`: cada `dispatch(i)` tiene su propio try/catch que llama a
      // `onError` y devuelve su respuesta normalmente, SIN volver a lanzar) — el
      // handler global de `app.onError` en apps/api/src/app.ts atrapa el error del
      // handler de la ruta ANTES de que la excepción se propague de vuelta hasta
      // este `await next()`, así que `next()` resuelve normalmente incluso cuando
      // el request terminó en 4xx/5xx. Sin este chequeo, `withAppSession` nunca ve
      // el error y confirma (`commit`) escrituras parciales de un handler que
      // falló. `c.error` es la forma documentada por Hono de recuperar ese error
      // atrapado más abajo (https://hono.dev/docs/api/context#error) — relanzarlo
      // aquí hace que el `catch` de `withAppSession` corra `rollback` como se
      // esperaba.
      if (c.error) {
        throw c.error;
      }
    });
  };
}

interface MembershipRow {
  readonly organization_id: string;
  readonly platform_role: PlatformRole;
  readonly vertical_role: string;
}

/**
 * 403 explícito si el usuario no pertenece a `:propertyIdParam` de la ruta o no tiene
 * uno de `allowedRoles` (roles de PLATAFORMA — el rol fino de vertical se valida aparte
 * con `assertVerticalRole`). Consulta `core.membership`/`core.property` de forma
 * genérica (nunca una tabla de vertical concreta, a diferencia de `hotel_staff` en
 * hoteles) — funciona igual para las 5 verticales sin que este paquete conozca ninguna.
 *
 * Si el header `X-Property-Id` viene presente, debe coincidir con el parámetro de ruta
 * (selector de property activa consistente, mismo patrón que `X-Hotel-Id` en hoteles).
 */
export function requirePropertyMembership(
  propertyIdParam: string,
  allowedRoles?: readonly PlatformRole[],
): MiddlewareHandler<CoreAuthHonoEnv> {
  return async (c: Ctx, next: Next) => {
    const propertyId = c.req.param(propertyIdParam);
    if (!propertyId) throw Errors.validation(`Falta el parámetro de ruta "${propertyIdParam}".`);

    const headerPropertyId = c.req.header("x-property-id");
    if (headerPropertyId && headerPropertyId !== propertyId) {
      throw Errors.forbidden("El header X-Property-Id no coincide con la property de la ruta.");
    }

    const db = c.get("db");
    const { rows } = await db.query<MembershipRow>(
      `select m.organization_id, m.platform_role, m.vertical_role
       from core.membership m
       join core.property p on p.organization_id = m.organization_id
       where p.id = $1
         and m.user_id = auth.uid()
         and (m.property_ids is null or p.id = any(m.property_ids));`,
      [propertyId],
    );

    if (rows.length === 0) {
      throw Errors.forbidden("No perteneces al staff de esta property.");
    }
    const row = rows[0]!;
    if (allowedRoles && !allowedRoles.includes(row.platform_role)) {
      throw Errors.forbidden(`Tu rol (${row.platform_role}) no puede realizar esta acción.`);
    }

    // Autoridad real de organizationId/propertyIds para el resto del request: la
    // membership verificada en este momento, NUNCA el claim potencialmente obsoleto
    // del JWT (ADR-004: el rol/alcance real siempre se resuelve en vivo).
    c.set("organizationId", row.organization_id);
    c.set("propertyIds", [propertyId]);
    c.set("platformRole", row.platform_role);
    c.set("verticalRole", row.vertical_role);
    await next();
  };
}

/**
 * Segunda capa explícita de autorización (además de la RLS): se llama DENTRO de un
 * handler ya protegido por `requirePropertyMembership`, para rutas donde el rol
 * permitido depende del método HTTP o de una acción concreta. `allowedRoles` es la
 * lista de `verticalRole` (string) que define `domain-<vertical>` — core-auth solo
 * compara contra lo que YA quedó resuelto en el contexto, nunca decide el significado.
 */
export function assertVerticalRole(c: Ctx, allowedRoles: readonly string[]): void {
  const role = c.get("verticalRole");
  if (!role || !allowedRoles.includes(role)) {
    throw Errors.forbidden(`Tu rol (${role ?? "sin resolver"}) no puede realizar esta acción.`);
  }
}
