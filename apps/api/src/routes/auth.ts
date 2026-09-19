// Rutas núcleo de login — NO son de domain-restaurantes (ver diseño Fase 1 §5): el
// JWT propio (@atiende/core-auth) es el mismo mecanismo para TODAS las verticales, así
// que estas rutas viven en apps/api, y restaurantes es simplemente su primer
// consumidor real. Mismo patrón que hoteles/apps/api/src/routes/auth.ts (ADR-004):
// login por email+password contra `core.staff_user` (hash scrypt), JWT HS256 con exp
// corta + refresh.
//
// El Supabase de producción de restaurantes ya fue borrado (sin usuarios reales que
// migrar) — no hace falta preservar magic-link ni OAuth de Google del origen
// (AdminLogin.tsx); se adopta directamente el mismo login email+password que hoteles
// ya prueba en producción.
import { Hono } from "hono";
import { authMiddleware, hashInviteToken, signAccessToken, signRefreshToken, verifyRefreshToken } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { hashPassword, verifyPassword, StaffInviteInvalidError } from "@atiende/db";
import { rateLimit } from "@atiende/core-ratelimit";
import { Errors } from "../errors.ts";
import { readJsonCapped, requestActor } from "../http-security.ts";
import type { AppDeps } from "../deps.ts";

// Hallazgo de auditoría (rubro 2, autenticación y sesión, severidad ALTA: "sin
// rate-limit en /auth/login, /auth/refresh, accept-invite -- un token robado o fuerza
// bruta no encuentran ninguna fricción"). `@atiende/core-ratelimit` ya existía en el
// monorepo con las categorías `auth:login`/`auth:token-issue` YA catalogadas en
// `packages/core-ratelimit/src/endpoint-policy.ts` anticipando exactamente este
// hallazgo -- nunca se había conectado a ninguna ruta real hasta esta pasada (se
// agrega además `auth:accept-invite`, que no existía). Límites deliberadamente
// generosos para un usuario legítimo (nadie inicia sesión/refresca/canjea una
// invitación 10-30 veces en 5 minutos de uso normal) y ajustados para fuerza bruta
// (10 intentos/5min es un candado real contra probar contraseñas, no un techo que un
// atacante alcanza sin darse cuenta). La llave combina IP + el identificador que cada
// endpoint ya tiene disponible ANTES de tocar la base de datos (email/token) --
// `requestActor` (ver `http-security.ts`) para que el límite sea por IP+identidad, no
// solo por IP (un NAT compartido no debe bloquear a todo el edificio) ni solo por
// identidad (un atacante no debe poder rotar de IP para evadirlo sin límite --
// ambos ejes cuentan).
const LOGIN_RATE_LIMIT = { max: 10, windowMs: 5 * 60_000 } as const;
const REFRESH_RATE_LIMIT = { max: 30, windowMs: 5 * 60_000 } as const;
const ACCEPT_INVITE_RATE_LIMIT = { max: 10, windowMs: 5 * 60_000 } as const;
// Hallazgo de auditoría (P2, "tokens de sesión completos en query params de URL")
// — ver el comentario de cabecera de `packages/db/migrations/0008_auth_exchange_
// code.sql`. Límite generoso (mismo orden que REFRESH_RATE_LIMIT): un login
// legítimo canjea el código UNA vez al montar `GoogleCallback.tsx`; React
// StrictMode puede montar el efecto dos veces en desarrollo, y una pestaña
// duplicada/doble clic no debe verse como fuerza bruta.
const EXCHANGE_CODE_RATE_LIMIT = { max: 30, windowMs: 5 * 60_000 } as const;
// Vida corta a propósito (segundos, no minutos como `MAGIC_LINK_TTL_MS`): el
// código viaja en la URL del redirect y el frontend lo canjea de inmediato al
// montar -- una ventana de 60s es más que suficiente para ese round-trip
// mientras mantiene mínima la superficie de un código interceptado (ej. en un
// log de acceso) antes de que expire por sí solo.
export const EXCHANGE_CODE_TTL_MS = 60_000;

interface LoginBody {
  readonly email?: unknown;
  readonly password?: unknown;
}

interface SelectOrgBody {
  readonly organizationId?: unknown;
}

interface AcceptInviteBody {
  readonly token?: unknown;
  readonly fullName?: unknown;
  readonly password?: unknown;
}

function validateAcceptInviteBody(body: AcceptInviteBody): { token: string; fullName: string; password: string } {
  if (typeof body.token !== "string" || body.token.length === 0) throw Errors.validation("token requerido");
  if (typeof body.fullName !== "string" || body.fullName.trim().length === 0 || body.fullName.length > 200) {
    throw Errors.validation("fullName requerido (máx 200 caracteres)");
  }
  if (typeof body.password !== "string" || body.password.length < 8) throw Errors.validation("password: mínimo 8 caracteres");
  return { token: body.token, fullName: body.fullName.trim(), password: body.password };
}

function validateLoginBody(body: LoginBody): { email: string; password: string } {
  if (typeof body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) {
    throw Errors.validation("email inválido");
  }
  if (typeof body.password !== "string" || body.password.length === 0) {
    throw Errors.validation("password requerido");
  }
  return { email: body.email.trim().toLowerCase(), password: body.password };
}

/** Exportada para que `routes/auth-google.ts` emita EXACTAMENTE la misma forma de
 *  sesión tras un login con Google — nunca un mecanismo paralelo/duplicado (a
 *  diferencia de hoteles, que sí duplica esta función en su propio `auth-google.ts`
 *  por evitar un choque de merge entre correctores en paralelo de esa fase; aquí no
 *  aplica el mismo riesgo, así que se prefiere una sola fuente de verdad). */
export async function issueSession(deps: AppDeps, staffId: string, email: string, fullName: string) {
  const memberships = await deps.coreRepo.findMembershipsByUserId(staffId);
  const first = memberships[0];
  // Fase 1: un token corresponde a UNA organización activa (mismo patrón que
  // hoteles). Un staff con memberships en varias organizaciones (ej. dueño de 2
  // restaurantes distintos) elige después vía POST /auth/select-org — aquí se emite
  // sesión para la primera por defecto, igual que hoteles hace hoy.
  const token = await signAccessToken(
    {
      sub: staffId,
      org_id: first?.organizationId ?? "",
      vertical: (first?.vertical as "hoteles" | "restaurantes" | "rentas" | "licitaciones" | "citas" | "despachos") ?? "restaurantes",
      property_ids: first?.propertyIds ? [...first.propertyIds] : null,
      email,
    },
    deps.env.jwtSecret,
    deps.env.accessTokenTtlSeconds,
  );
  const refreshToken = await signRefreshToken(staffId, deps.env.jwtSecret, deps.env.refreshTokenTtlSeconds);
  return {
    token,
    refreshToken,
    email,
    // Nombre real del staff (`core.staff_user.full_name`, siempre presente -- lo pide
    // el propio formulario de aceptar invitación) -- se agrega aquí para que el
    // saludo real ("Buenos días, {nombre}") de cada Dashboard tenga algo mejor que el
    // correo, sin depender de una llamada aparte.
    fullName,
    organizations: memberships.map((m) => ({ id: m.organizationId, slug: m.organizationSlug, nombre: m.organizationName, vertical: m.vertical, rol: m.verticalRole })),
  };
}

export function authRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.post("/auth/login", async (c) => {
    const raw = (await c.req.json().catch(() => ({}))) as LoginBody;
    const { email, password } = validateLoginBody(raw);

    // Hallazgo de auditoría (rubro 2, severidad ALTA) — ver comentario de cabecera del
    // archivo. Se evalúa DESPUÉS de validar el formato del email (para que la llave
    // sea estable) pero ANTES de tocar `coreRepo`/scrypt (para que una ráfaga ni
    // siquiera pague el costo de esa consulta/hash).
    const loginAllowed = await rateLimit(`auth:login:${requestActor(c.req.raw, email)}`, LOGIN_RATE_LIMIT.max, LOGIN_RATE_LIMIT.windowMs, {
      category: "auth:login",
    });
    if (!loginAllowed) throw Errors.tooManyRequests("Demasiados intentos de inicio de sesión. Intenta de nuevo en unos minutos.");

    const invalidCredentials = () => Errors.unauthorized("Correo o contraseña incorrectos.");
    const staff = await deps.coreRepo.findStaffByEmail(email);
    if (!staff) throw invalidCredentials();
    const valid = await verifyPassword(password, staff.passwordHash);
    if (!valid) throw invalidCredentials();

    if (staff.createdVia === "registro_autoservicio" && !staff.emailVerifiedAt) {
      throw Errors.forbidden("Todavía no confirmas tu correo. Revisa tu bandeja o pide que te reenvíen el enlace de verificación.");
    }

    return c.json(await issueSession(deps, staff.id, staff.email, staff.fullName), 200);
  });

  app.post("/auth/refresh", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { refreshToken?: unknown };
    if (typeof body.refreshToken !== "string" || !body.refreshToken) throw Errors.validation("refreshToken requerido");

    // Hallazgo de auditoría (rubro 2, severidad ALTA) — ver comentario de cabecera del
    // archivo. Sin identidad todavía disponible (el body solo trae el JWT, y no vale
    // la pena verificarlo antes de frenar una ráfaga), la llave es solo IP.
    const refreshAllowed = await rateLimit(`auth:refresh:${requestActor(c.req.raw)}`, REFRESH_RATE_LIMIT.max, REFRESH_RATE_LIMIT.windowMs, {
      category: "auth:token-issue",
    });
    if (!refreshAllowed) throw Errors.tooManyRequests("Demasiados intentos de refresco de sesión. Intenta de nuevo en unos minutos.");

    let sub: string;
    let jti: string;
    let iat: number;
    let exp: number;
    try {
      const claims = await verifyRefreshToken(body.refreshToken, deps.env.jwtSecret);
      sub = claims.sub;
      jti = claims.jti;
      iat = claims.iat;
      exp = claims.exp;
    } catch {
      throw Errors.unauthorized("Refresh token inválido o expirado.");
    }

    // Hallazgo de auditoría (severidad ALTA, "sin logout explícito en el panel de
    // hoteles"): un refresh token cuyo `jti` ya fue revocado (el staff cerró sesión
    // con él vía POST /auth/logout, O el propio uso de este mismo token vía rotación
    // más abajo) no puede reemitir sesión, aunque el JWT en sí siga siendo
    // criptográficamente válido y no haya expirado todavía — sin este chequeo,
    // /auth/logout solo habría limpiado el localStorage de QUIEN pidió logout, sin
    // impedir que ese mismo refresh token (copiado o interceptado antes) siguiera
    // sirviendo para sacar access tokens nuevos indefinidamente.
    if (await deps.coreRepo.isRefreshTokenRevoked(jti)) {
      throw Errors.unauthorized("Refresh token inválido o expirado.");
    }

    const staff = await deps.coreRepo.findStaffById(sub);
    if (!staff) throw Errors.unauthorized();

    // Hallazgo de auditoría (rubro 2, severidad ALTA, "no hay forma de invalidar
    // sesiones activas de un usuario") — ver `packages/db/migrations/0006_revoke_all_
    // sessions.sql`. Un refresh token emitido ANTES del corte que fijó POST
    // /auth/revoke-sessions se rechaza aquí, aunque su `jti` individual nunca haya
    // sido revocado uno por uno (no hay forma de enumerarlos todos).
    if (staff.sessionsRevokedAt && iat * 1000 < new Date(staff.sessionsRevokedAt).getTime()) {
      throw Errors.unauthorized("Refresh token inválido o expirado.");
    }

    // Hallazgo de auditoría (rubro 2, severidad ALTA, "el refresh token vive 30 días
    // sin rotación"): se revoca el refresh token PRESENTADO antes de emitir uno nuevo
    // — cada uso es de un solo tiro. Un replay del mismo refresh token (robado o
    // interceptado) después de este punto encuentra su `jti` ya en
    // `core.revoked_refresh_token` y es rechazado por el chequeo de arriba, igual que
    // si el staff hubiera hecho logout explícito con él.
    await deps.coreRepo.revokeRefreshToken({ jti, userId: sub, expiresAt: new Date(exp * 1000).toISOString() });

    return c.json(await issueSession(deps, staff.id, staff.email, staff.fullName), 200);
  });

  // Hallazgo de auditoría (P2, "tokens de sesión completos en query params de
  // URL (Google OAuth y magic-link) -- riesgo de filtración vía Referer/
  // historial/logs") -- ver el comentario de cabecera de
  // `packages/db/migrations/0008_auth_exchange_code.sql`. Reemplaza el
  // contrato anterior de `auth-google.ts`/`auth-magic-link.ts` (JWT real +
  // refreshToken directo en la query string del redirect 302) por el patrón
  // "authorization code": ambos callbacks ahora ponen aquí un código opaco de
  // un solo uso y 60s de vida (`EXCHANGE_CODE_TTL_MS`), y ESTE endpoint es el
  // ÚNICO lugar donde el token/refreshToken reales viajan -- siempre en el BODY
  // de una respuesta JSON, nunca en una URL. `GoogleCallback.tsx` (compartido
  // por las 6 verticales y por magic-link) lo llama de inmediato al montar.
  //
  // Sin `authMiddleware` (todavía no hay sesión -- mismo momento que /auth/
  // login): el código en sí es la credencial de un solo uso, exactamente igual
  // que un `refreshToken` en /auth/refresh o un `token` de magic-link en
  // /verify.
  app.post("/auth/exchange-code", async (c) => {
    const raw = (await c.req.json().catch(() => ({}))) as { code?: unknown };
    if (typeof raw.code !== "string" || raw.code.length === 0) throw Errors.validation("code requerido");

    // Mismo criterio que /auth/refresh -- sin identidad todavía disponible antes
    // de consumir el código, la llave es solo IP.
    const exchangeAllowed = await rateLimit(`auth:exchange-code:${requestActor(c.req.raw)}`, EXCHANGE_CODE_RATE_LIMIT.max, EXCHANGE_CODE_RATE_LIMIT.windowMs, {
      category: "auth:token-issue",
    });
    if (!exchangeAllowed) throw Errors.tooManyRequests("Demasiados intentos. Intenta de nuevo en unos minutos.");

    // Consumo atómico (`core.consume_auth_exchange_code`, ver la migración) --
    // `null` si el código no existe, ya se usó, o venció; nunca se distingue
    // cuál de los tres casos fue (mismo criterio que magic-link/refresh).
    const staff = await deps.coreRepo.consumeAuthExchangeCode(hashInviteToken(raw.code));
    if (!staff) throw Errors.unauthorized("Código de intercambio inválido, ya usado, o expirado.");

    return c.json(await issueSession(deps, staff.id, staff.email, staff.fullName), 200);
  });

  // Hallazgo de auditoría (severidad ALTA, "sin logout explícito en el panel de
  // hoteles" — HotelesShell.tsx no renderizaba ningún botón de cerrar sesión, y hasta
  // esta pieza tampoco había NADA del lado del servidor que ese botón pudiera
  // invalidar de verdad; `clearHotelesSession` solo borraba localStorage). Revoca el
  // refresh token presentado (por su `jti`, ver `core.revoked_refresh_token` en
  // `packages/db/migrations/0003_refresh_token_revocation.sql`) — a partir de este
  // punto ESE refresh token concreto ya no puede reemitir sesión vía /auth/refresh
  // (chequeo justo arriba). El access token ya emitido sigue siendo válido hasta su
  // propio `exp` (900s por defecto, `ACCESS_TOKEN_TTL_SECONDS`) — es JWT stateless
  // por diseño (ver core-auth/src/jwt.ts), el mismo trade-off documentado en el header
  // de la migración.
  //
  // Sin `authMiddleware`: mismo criterio que /auth/refresh — el actor se identifica
  // por el refresh token mismo (su `sub`/`jti`), no por un Bearer access token ya
  // verificado (cerrar sesión debe seguir funcionando aunque el access token ya haya
  // expirado, que es exactamente el caso normal: el usuario deja el navegador abierto
  // horas después del login). Idempotente y sin filtrar información: un refreshToken
  // ya inválido/expirado/inexistente responde 200 igual que uno válido — no hay nada
  // que revocar en ese caso, pero un 401 aquí le confirmaría a quien sea que el token
  // que probó ya no sirve, información que un logout no necesita exponer.
  app.post("/auth/logout", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { refreshToken?: unknown };
    if (typeof body.refreshToken !== "string" || !body.refreshToken) throw Errors.validation("refreshToken requerido");

    // Solo el paso de VERIFICAR se trata como "no hay nada que revocar" (idempotente,
    // ver comentario de cabecera) — un fallo real de `revokeRefreshToken` (ej. la
    // base de datos no responde) SÍ debe propagarse como 500: si no se pudo persistir
    // la revocación, el refresh token sigue siendo válido y logout no puede fingir
    // que "tuvo éxito" sin mentir.
    let claims: Awaited<ReturnType<typeof verifyRefreshToken>> | null = null;
    try {
      claims = await verifyRefreshToken(body.refreshToken, deps.env.jwtSecret);
    } catch {
      // Ya inválido/expirado/con otro secreto — nada que revocar, logout de todas
      // formas "tiene éxito" (ver comentario de cabecera de esta ruta).
    }

    if (claims) {
      await deps.coreRepo.revokeRefreshToken({
        jti: claims.jti,
        userId: claims.sub,
        expiresAt: new Date(claims.exp * 1000).toISOString(),
      });
    }

    return c.json({ ok: true }, 200);
  });

  app.use("/auth/me", authMiddleware(deps.env));
  app.get("/auth/me", async (c) => {
    const userId = c.get("userId");
    // Ejecutados en paralelo -- son tres lecturas independientes de la misma
    // sesión de staff, ninguna depende del resultado de las otras. `staff` se
    // agrega aquí SOLO por `fullName` -- GoogleCallback.tsx (el único caller real
    // de este endpoint) arma su `LoginSession` desde esta respuesta, y sin esto
    // un login por Google se quedaría sin nombre real para el saludo (a
    // diferencia de login/refresh/accept-invite, que ya lo traen de
    // `issueSession`).
    const [memberships, isPlatformSuperadmin, staff] = await Promise.all([
      deps.coreRepo.findMembershipsByUserId(userId),
      deps.coreRepo.isPlatformSuperadmin(userId),
      deps.coreRepo.findStaffById(userId),
    ]);
    return c.json({
      id: userId,
      email: c.get("userEmail"),
      fullName: staff?.fullName ?? "",
      organizations: memberships.map((m) => ({ id: m.organizationId, slug: m.organizationSlug, nombre: m.organizationName, vertical: m.vertical, rol: m.verticalRole })),
      // Back office de plataforma (`apps/web/src/superadmin/**`) -- el puente
      // de login compartido (`shell/GoogleCallback.tsx`) redirige aquí en vez
      // del landing normal de una vertical cuando esto es `true`.
      isPlatformSuperadmin,
    });
  });

  // Hallazgo de auditoría (rubro 2, severidad ALTA, "no hay forma de invalidar
  // sesiones activas de un usuario, ej. tras cambio de contraseña o sospecha de
  // compromiso") — ver `packages/db/migrations/0006_revoke_all_sessions.sql`. Cierra
  // TODOS los refresh tokens del staff autenticado que llama (nunca un id recibido
  // del body — self-service, no un endpoint de administrador sobre OTRO usuario, eso
  // queda fuera de esta pasada). El access token ya emitido de la sesión que llama
  // sigue vivo hasta su propio `exp` (mismo trade-off que logout/rotación arriba, JWT
  // stateless por diseño) — el efecto real es que NINGÚN refresh token emitido antes
  // de esta llamada (de esta sesión o de cualquier otra del mismo usuario, en
  // cualquier dispositivo) vuelve a servir en POST /auth/refresh.
  app.use("/auth/revoke-sessions", authMiddleware(deps.env));
  app.post("/auth/revoke-sessions", async (c) => {
    await deps.coreRepo.revokeAllRefreshTokens(c.get("userId"));
    return c.json({ ok: true }, 200);
  });

  app.use("/auth/select-org", authMiddleware(deps.env));
  app.post("/auth/select-org", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as SelectOrgBody;
    if (typeof body.organizationId !== "string" || !body.organizationId) throw Errors.validation("organizationId requerido");

    const memberships = await deps.coreRepo.findMembershipsByUserId(c.get("userId"));
    const membership = memberships.find((m) => m.organizationId === body.organizationId);
    if (!membership) throw Errors.forbidden("No perteneces a esa organización.");

    const token = await signAccessToken(
      {
        sub: c.get("userId"),
        org_id: membership.organizationId,
        vertical: membership.vertical as "hoteles" | "restaurantes" | "rentas" | "licitaciones" | "citas" | "despachos",
        property_ids: membership.propertyIds ? [...membership.propertyIds] : null,
        email: c.get("userEmail"),
      },
      deps.env.jwtSecret,
      deps.env.accessTokenTtlSeconds,
    );
    const refreshToken = await signRefreshToken(c.get("userId"), deps.env.jwtSecret, deps.env.refreshTokenTtlSeconds);
    return c.json({ token, refreshToken }, 200);
  });

  // Fase 10 — lado del INVITADO de "alta y gestión de cuentas de staff" (ver diseño
  // completo en packages/db/migrations/0002_staff_invite_schema.sql). Vive AQUÍ, en
  // las rutas núcleo (no bajo /v1/restaurantes/...), por el MISMO motivo que el resto
  // de este archivo (cabecera): aceptar una invitación es login/registro (todavía sin
  // sesión, JWT propio genérico a las 6 verticales), no una acción de negocio de
  // restaurantes — mismo principio que ya separa `owner-portal.ts` de
  // `finanzas-statements.ts` en rentas. La ruta de CREAR la invitación (Fase 10, solo
  // owner/admin de un vertical ya autenticado) sí es vertical-específica en esta
  // pasada y vive en `routes/verticals/restaurantes/admin-staff.ts` — ver el
  // comentario de cabecera de ese archivo para la decisión de diseño completa
  // (por qué esta mitad es genérica y esa otra, por ahora, no).
  app.post("/auth/accept-invite", async (c) => {
    const raw = await readJsonCapped<AcceptInviteBody>(c.req.raw, 4 * 1024);
    const { token, fullName, password } = validateAcceptInviteBody(raw);

    // Hallazgo de auditoría (rubro 2, severidad ALTA) — ver comentario de cabecera del
    // archivo. Llave por IP + token (nunca el token completo se loguea/expone más
    // allá de esta llave interna del rate limiter — mismo criterio que el resto del
    // monorepo de nunca persistir un secreto en texto plano más de lo necesario).
    const acceptInviteAllowed = await rateLimit(
      `auth:accept-invite:${requestActor(c.req.raw, token)}`,
      ACCEPT_INVITE_RATE_LIMIT.max,
      ACCEPT_INVITE_RATE_LIMIT.windowMs,
      { category: "auth:accept-invite" },
    );
    if (!acceptInviteAllowed) throw Errors.tooManyRequests("Demasiados intentos. Intenta de nuevo en unos minutos.");

    const passwordHash = await hashPassword(password);
    let result;
    try {
      result = await deps.coreRepo.acceptStaffInvite({ tokenHash: hashInviteToken(token), fullName, passwordHash });
    } catch (err) {
      if (err instanceof StaffInviteInvalidError) throw Errors.staffInviteTokenInvalido();
      throw err;
    }

    // Sesión inmediata (mismo `issueSession` que login/refresh) — el invitado queda
    // "vinculado" Y autenticado en una sola llamada, sin un paso extra de login.
    return c.json(await issueSession(deps, result.staffId, result.email, fullName), 200);
  });

  return app;
}
