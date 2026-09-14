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
import { Errors } from "../errors.ts";
import { readJsonCapped } from "../http-security.ts";
import type { AppDeps } from "../deps.ts";

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

async function issueSession(deps: AppDeps, staffId: string, email: string) {
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
    organizations: memberships.map((m) => ({ id: m.organizationId, slug: m.organizationSlug, nombre: m.organizationName, vertical: m.vertical, rol: m.verticalRole })),
  };
}

export function authRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.post("/auth/login", async (c) => {
    const raw = (await c.req.json().catch(() => ({}))) as LoginBody;
    const { email, password } = validateLoginBody(raw);

    const invalidCredentials = () => Errors.unauthorized("Correo o contraseña incorrectos.");
    const staff = await deps.coreRepo.findStaffByEmail(email);
    if (!staff) throw invalidCredentials();
    const valid = await verifyPassword(password, staff.passwordHash);
    if (!valid) throw invalidCredentials();

    if (staff.createdVia === "registro_autoservicio" && !staff.emailVerifiedAt) {
      throw Errors.forbidden("Todavía no confirmas tu correo. Revisa tu bandeja o pide que te reenvíen el enlace de verificación.");
    }

    return c.json(await issueSession(deps, staff.id, staff.email), 200);
  });

  app.post("/auth/refresh", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { refreshToken?: unknown };
    if (typeof body.refreshToken !== "string" || !body.refreshToken) throw Errors.validation("refreshToken requerido");

    let sub: string;
    let jti: string;
    try {
      const claims = await verifyRefreshToken(body.refreshToken, deps.env.jwtSecret);
      sub = claims.sub;
      jti = claims.jti;
    } catch {
      throw Errors.unauthorized("Refresh token inválido o expirado.");
    }

    // Hallazgo de auditoría (severidad ALTA, "sin logout explícito en el panel de
    // hoteles"): un refresh token cuyo `jti` ya fue revocado (el staff cerró sesión
    // con él vía POST /auth/logout) no puede reemitir sesión, aunque el JWT en sí
    // siga siendo criptográficamente válido y no haya expirado todavía — sin este
    // chequeo, /auth/logout solo habría limpiado el localStorage de QUIEN pidió
    // logout, sin impedir que ese mismo refresh token (copiado o interceptado antes)
    // siguiera sirviendo para sacar access tokens nuevos indefinidamente.
    if (await deps.coreRepo.isRefreshTokenRevoked(jti)) {
      throw Errors.unauthorized("Refresh token inválido o expirado.");
    }

    const staff = await deps.coreRepo.findStaffById(sub);
    if (!staff) throw Errors.unauthorized();
    return c.json(await issueSession(deps, staff.id, staff.email), 200);
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
    const memberships = await deps.coreRepo.findMembershipsByUserId(c.get("userId"));
    return c.json({
      id: c.get("userId"),
      email: c.get("userEmail"),
      organizations: memberships.map((m) => ({ id: m.organizationId, slug: m.organizationSlug, nombre: m.organizationName, vertical: m.vertical, rol: m.verticalRole })),
    });
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
    return c.json(await issueSession(deps, result.staffId, result.email), 200);
  });

  return app;
}
