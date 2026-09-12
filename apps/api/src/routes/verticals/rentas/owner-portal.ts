// Portal de propietario (Fase 3, diseño §3/§4) -- rutas de solo lectura bajo
// `/rentas/owner-portal/*` (NUNCA `/rentas/:propertyId/...`: la ausencia del parámetro
// `propertyId` es intencional, hace imposible por construcción pegarle
// `requirePropertyMembership` por copy-paste -- esas rutas no tienen el parámetro que
// esa función exige).
//
// `RentasOwnerPortalHonoEnv` es un Env de Hono PROPIO, nunca `CoreAuthHonoEnv` -- este
// archivo jamás importa `authMiddleware`/`dbSession`/`requirePropertyMembership` de
// `@atiende/core-auth`. El middleware `requireRentasOwnerSession` de abajo es el ÚNICO
// punto de entrada de autenticación de estas rutas: verifica el JWT de propietario
// (secreto propio, `deps.env.rentasOwnerJwtSecret`) y abre
// `engine.withAppSession({userId: ownerId})` -- el MISMO mecanismo genérico que usa
// `dbSession()` de core-auth para staff (`TenancyEngine` no sabe qué es un "staff", ver
// diseño Fase 3 §1.3), nunca un motor nuevo.
//
// Todas las queries de negocio usan `db` (la sesión RLS del request) a través de
// `deps.rentasOwnerPortalRepo` -- la autorización real la hace Postgres vía las
// policies aditivas de la migración 006; estas rutas son defensa en profundidad, igual
// que `requirePropertyMembership` hoy es una segunda capa sobre RLS para staff (mismo
// principio, actor distinto).
import { Hono } from "hono";
import type { Context, MiddlewareHandler, Next } from "hono";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { hashPassword, verifyPassword } from "@atiende/db";
import {
  hashInviteToken,
  RentasPropertyOwnerTokenExpiredError,
  signRentasPropertyOwnerAccessToken,
  signRentasPropertyOwnerRefreshToken,
  verifyRentasPropertyOwnerAccessToken,
  verifyRentasPropertyOwnerRefreshToken,
} from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

export interface RentasOwnerPortalVariables {
  ownerId: string;
  db: TenantDbSession;
}

export interface RentasOwnerPortalHonoEnv {
  Variables: RentasOwnerPortalVariables;
}

type Ctx = Context<RentasOwnerPortalHonoEnv>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Único middleware de autenticación de este archivo -- NUNCA `authMiddleware` de
 * core-auth (secreto/claims shape distintos, ver cabecera del archivo). */
export function requireRentasOwnerSession(deps: AppDeps): MiddlewareHandler<RentasOwnerPortalHonoEnv> {
  return async (c: Ctx, next: Next) => {
    const header = c.req.header("authorization");
    if (!header?.startsWith("Bearer ")) throw Errors.unauthorized("Falta el header Authorization: Bearer <token>.");
    const token = header.slice("Bearer ".length).trim();

    let ownerId: string;
    try {
      const claims = await verifyRentasPropertyOwnerAccessToken(token, deps.env.rentasOwnerJwtSecret);
      ownerId = claims.sub;
    } catch (err) {
      if (err instanceof RentasPropertyOwnerTokenExpiredError) throw Errors.unauthorized("El token expiró. Inicia sesión de nuevo.");
      throw Errors.unauthorized();
    }

    // Mismo mecanismo genérico que `dbSession()` de core-auth -- `TenancyEngine` no
    // sabe qué es un "owner", solo mete el uuid en el GUC que lee `auth.uid()` (ver
    // diseño Fase 3 §1.3). Las policies de staff nunca "cuelan" aquí: `core.membership`
    // no tiene fila para un ownerId.
    await deps.engine.withAppSession({ userId: ownerId }, async (session) => {
      c.set("ownerId", ownerId);
      c.set("db", session);
      await next();
    });
  };
}

interface LoginBody {
  readonly email?: unknown;
  readonly password?: unknown;
}

function validateLoginBody(body: LoginBody): { email: string; password: string } {
  if (typeof body.email !== "string" || !EMAIL_RE.test(body.email.trim())) throw Errors.validation("email inválido");
  if (typeof body.password !== "string" || body.password.length === 0) throw Errors.validation("password requerido");
  return { email: body.email.trim().toLowerCase(), password: body.password };
}

async function issueOwnerSession(deps: AppDeps, ownerId: string, email: string) {
  const token = await signRentasPropertyOwnerAccessToken({ sub: ownerId, email }, deps.env.rentasOwnerJwtSecret, deps.env.rentasOwnerAccessTokenTtlSeconds);
  const refreshToken = await signRentasPropertyOwnerRefreshToken(ownerId, deps.env.rentasOwnerJwtSecret, deps.env.rentasOwnerRefreshTokenTtlSeconds);
  return { token, refreshToken, ownerId, email };
}

export function rentasOwnerPortalRoutes(deps: AppDeps): Hono<RentasOwnerPortalHonoEnv> {
  const app = new Hono<RentasOwnerPortalHonoEnv>();

  // ---- auth pública ----
  // Sin `requireRentasOwnerSession` (aún no hay identidad verificada) -- cada
  // handler abre su propia sesión vía `engine.withAppSession(...)`, igual que el
  // resto de rutas públicas/de sistema del monorepo. `findOwnerCredentialByEmail`/
  // `consumePortalInvite` son, además, dos de los 3 métodos que requieren privilegio
  // de `service_role` (ver production/rentas-owner-portal-repository.ts) -- la
  // sesión que se les pasa aquí es la mejor disponible hoy, no una que ya satisfaga
  // ese requisito (gap de infraestructura aparte, documentado ahí).

  app.post("/rentas/owner-portal/auth/login", async (c) => {
    const raw = await readJsonCapped<LoginBody>(c.req.raw, 2 * 1024);
    const { email, password } = validateLoginBody(raw);

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.rentasOwnerPortalRepo(db);
      const invalidCredentials = () => Errors.unauthorized("Correo o contraseña incorrectos.");
      const credential = await repo.findOwnerCredentialByEmail(email);
      if (!credential) throw invalidCredentials();
      const valid = await verifyPassword(password, credential.passwordHash);
      if (!valid) throw invalidCredentials();

      return c.json(await issueOwnerSession(deps, credential.ownerId, credential.email), 200);
    });
  });

  app.post("/rentas/owner-portal/auth/refresh", async (c) => {
    const body = await readJsonCapped<{ refreshToken?: unknown }>(c.req.raw, 2 * 1024);
    if (typeof body.refreshToken !== "string" || !body.refreshToken) throw Errors.validation("refreshToken requerido");

    let ownerId: string;
    try {
      const claims = await verifyRentasPropertyOwnerRefreshToken(body.refreshToken, deps.env.rentasOwnerJwtSecret);
      ownerId = claims.sub;
    } catch {
      throw Errors.unauthorized("Refresh token inválido o expirado.");
    }

    // `ownerId` ya viene verificado (firma del refresh token) -- abre una sesión RLS
    // real con ESE claim, igual que `requireRentasOwnerSession` hace para las rutas
    // autenticadas (findOwnerProfile SÍ es uno de los 5 métodos de solo lectura).
    return deps.engine.withAppSession({ userId: ownerId }, async (db) => {
      const repo = deps.rentasOwnerPortalRepo(db);
      const profile = await repo.findOwnerProfile(ownerId);
      if (!profile || !profile.email) throw Errors.unauthorized();
      return c.json(await issueOwnerSession(deps, ownerId, profile.email), 200);
    });
  });

  // Consume la invitación de un solo uso emitida por staff (ver
  // owner-portal-invite.ts) -- la ÚNICA acción de escritura que ejecuta el propio
  // propietario en esta fase, y es sobre su propia credencial de acceso, nunca sobre
  // datos de negocio (diseño §5/§8).
  app.post("/rentas/owner-portal/auth/set-password", async (c) => {
    const body = await readJsonCapped<{ token?: unknown; password?: unknown }>(c.req.raw, 2 * 1024);
    if (typeof body.token !== "string" || body.token.length === 0) throw Errors.validation("token requerido");
    if (typeof body.password !== "string" || body.password.length < 8) throw Errors.validation("password: mínimo 8 caracteres");
    const token = body.token;
    const password = body.password;

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.rentasOwnerPortalRepo(db);
      const passwordHash = await hashPassword(password);
      const resultado = await repo.consumePortalInvite({ tokenHash: hashInviteToken(token), passwordHash, now: new Date().toISOString() });
      if (!resultado) throw Errors.rentasOwnerInviteTokenInvalido();

      return c.json({ ok: true }, 200);
    });
  });

  // ---- autenticadas (requireRentasOwnerSession) ----
  // Cada ruta exacta se protege por separado (mismo patrón que
  // finanzas-statements.ts::ownerPath/detallePath) -- nunca un wildcard `/*` que
  // dependa de un orden de composición de middleware/handler no garantizado frente a
  // las rutas públicas de arriba.

  const mePath = "/rentas/owner-portal/me";
  const unidadesPath = "/rentas/owner-portal/unidades";
  const statementsPath = "/rentas/owner-portal/statements";
  const statementDetallePath = "/rentas/owner-portal/statements/:id";
  app.use(mePath, requireRentasOwnerSession(deps));
  app.use(unidadesPath, requireRentasOwnerSession(deps));
  app.use(statementsPath, requireRentasOwnerSession(deps));
  app.use(statementDetallePath, requireRentasOwnerSession(deps));

  app.get(mePath, async (c) => {
    const ownerId = c.get("ownerId");
    const repo = deps.rentasOwnerPortalRepo(c.get("db"));
    const [profile, organizaciones] = await Promise.all([repo.findOwnerProfile(ownerId), repo.listOwnerOrganizaciones(ownerId)]);
    if (!profile) throw Errors.notFound("Perfil de propietario no encontrado.");
    // `organizaciones` es puramente informativo (diseño §1.5) -- NUNCA un selector que
    // acote qué se ve en /unidades y /statements, que siempre muestran TODO junto.
    return c.json({ id: profile.id, name: profile.name, email: profile.email, organizaciones }, 200);
  });

  app.get(unidadesPath, async (c) => {
    const ownerId = c.get("ownerId");
    const repo = deps.rentasOwnerPortalRepo(c.get("db"));
    const unidades = await repo.listUnidadesPropietario(ownerId);
    return c.json({ unidades }, 200);
  });

  app.get(statementsPath, async (c) => {
    const ownerId = c.get("ownerId");
    const repo = deps.rentasOwnerPortalRepo(c.get("db"));
    const propertyId = c.req.query("propertyId");
    const desde = c.req.query("desde");
    const hasta = c.req.query("hasta");
    if (desde !== undefined && !DATE_RE.test(desde)) throw Errors.validation("desde: formato de fecha esperado YYYY-MM-DD.");
    if (hasta !== undefined && !DATE_RE.test(hasta)) throw Errors.validation("hasta: formato de fecha esperado YYYY-MM-DD.");

    const statements = await repo.listOwnerStatementsPropietario(ownerId, { propertyId, desde, hasta });
    return c.json({ statements }, 200);
  });

  app.get(statementDetallePath, async (c) => {
    const ownerId = c.get("ownerId");
    const repo = deps.rentasOwnerPortalRepo(c.get("db"));
    const id = c.req.param("id");
    // `id` viene de la URL, pero el WHERE real (aquí y, en Postgres, en la RLS) es
    // owner_id = ownerId -- nunca se acepta un ownerId por parámetro (diseño §4): un id
    // de statement que pertenece a OTRO propietario simplemente no resuelve, sin
    // importar que el id en sí sea válido para algún otro owner.
    const statement = await repo.findOwnerStatementDetallePropietario(ownerId, id);
    if (!statement) throw Errors.notFound("Statement no encontrado.");
    return c.json(statement, 200);
  });

  return app;
}
