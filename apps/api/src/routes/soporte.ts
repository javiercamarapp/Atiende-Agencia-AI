// "Entrar a un cliente" (sesión de soporte) -- ver el diseño completo en apps/api/src/soporte/guard.ts y
// packages/db/migrations/0058_superadmin_soporte_entrar_clientes.sql.
//
//   POST /superadmin/soporte/entrar   {organizationId, reason}   (superadmin; gateo y write-guard de `/superadmin/*` ya corrieron)
//       1. motivo >= 10 caracteres; la organización existe y NO es una demo (esas se abren en «Ver los otros paneles»);
//       2. abre la sesión en la bitácora hash-encadenada ANTES de entregar nada -- si la bitácora falla, no hay token (falla cerrado);
//       3. si el superadmin ya es miembro usa su membresía real; si no, concesión TEMPORAL y trazada (nunca permanente);
//       4. firma un access token con claim `soporte` (solo lectura), con `exp` = fin de la sesión y SIN refresh token.
//   GET  /soporte/estado              estado verificado en SQL (activa, elevada, vencimiento) -- lo sondea el banner.
//   POST /soporte/elevar {reason}     «Permitir edición»: segundo motivo (>= 10) registrado; devuelve un token nuevo con `ro: false`.
//   POST /soporte/salir               revoca la concesión temporal y termina la sesión en la bitácora (idempotente).
//
// La bitácora guarda quién, a qué organización, por qué, cuándo y si hubo elevación; NUNCA el contenido que se vio.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, signAccessToken } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  ImpersonationConflictError,
  ImpersonationForbiddenError,
  ImpersonationNotFoundError,
  ImpersonationReasonInvalidError,
} from "@atiende/db";
import { Errors } from "../errors.ts";
import { leerClaimsSoporte } from "../soporte/guard.ts";
import type { AppDeps } from "../deps.ts";

export const MOTIVO_SOPORTE_MINIMO = 10;
export const MOTIVO_SOPORTE_MAXIMO = 500;
const MENSAJE_NO_MIGRADO = "La sesión de soporte todavía no está disponible en esta base (migración 0020/0058 pendiente de aplicar).";

interface EntrarBody {
  readonly organizationId?: unknown;
  readonly reason?: unknown;
}

/** Motivo ya recortado, o lanza 400. Acepta SOLO texto: null, número, vacío o solo espacios se rechazan igual que uno corto. */
export function validarMotivoSoporte(raw: unknown, etiqueta = "motivo"): string {
  const motivo = typeof raw === "string" ? raw.trim() : "";
  if (motivo.length < MOTIVO_SOPORTE_MINIMO) throw Errors.validation(`El ${etiqueta} es obligatorio (mínimo ${MOTIVO_SOPORTE_MINIMO} caracteres).`);
  if (motivo.length > MOTIVO_SOPORTE_MAXIMO) throw Errors.validation(`El ${etiqueta} no puede pasar de ${MOTIVO_SOPORTE_MAXIMO} caracteres.`);
  return motivo;
}

function traducirError(err: unknown): never {
  if (err instanceof ImpersonationReasonInvalidError) throw Errors.validation(err.message);
  if (err instanceof ImpersonationNotFoundError) throw Errors.notFound(err.message);
  if (err instanceof ImpersonationForbiddenError) throw Errors.forbidden(err.message);
  if (err instanceof ImpersonationConflictError) throw Errors.conflict(err.message);
  throw err;
}

/** Segundos que le quedan a la sesión (entero >= 1): un token de soporte nunca vive más que su sesión. */
function ttlRestanteSegundos(expiresAtMs: number, nowMs: number): number {
  return Math.max(1, Math.floor((expiresAtMs - nowMs) / 1000));
}

export function soporteRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const ahora = () => (deps.relojMs ?? Date.now)();

  app.post("/superadmin/soporte/entrar", async (c) => {
    const callerId = c.get("userId");
    const raw = (await c.req.json().catch(() => ({}))) as EntrarBody;
    const organizationId = typeof raw.organizationId === "string" ? raw.organizationId.trim() : "";
    if (!organizationId) throw Errors.validation("organizationId requerido.");
    const reason = validarMotivoSoporte(raw.reason);

    const organizaciones = await deps.coreRepo.listAllOrganizationsForSuperadmin(callerId);
    const org = organizaciones.find((o) => o.id === organizationId);
    if (!org) throw Errors.notFound("La organización no existe.");
    if (org.slug.startsWith("demo-")) {
      throw Errors.conflict("Las organizaciones demo se abren desde «Ver los otros paneles», sin sesión de soporte.");
    }

    // 1) Bitácora primero (transacción propia, confirmada antes de seguir). Cualquier fallo -> no hay token.
    let sesion;
    try {
      const r = await deps.engine.withAppSession({ userId: callerId }, (db) => deps.impersonationRepo(db).startSupportSession(callerId, org.id, reason));
      if (r.availability === "not_migrated" || !r.session || !r.kind) throw Errors.serviceUnavailable(MENSAJE_NO_MIGRADO);
      sesion = { ...r.session, kind: r.kind };
    } catch (err) {
      return traducirError(err);
    }

    // 2) Membresía: la real si existe; si no, concesión temporal trazada. Si algo falla, la sesión se cierra y no hay token.
    try {
      const miembro = (await deps.coreRepo.findMembershipsByUserId(callerId)).find((m) => m.organizationId === org.id);
      if (!miembro) {
        const g = await deps.engine.withAppSession({ userId: callerId }, (db) => deps.impersonationRepo(db).grantSupportMembership(callerId, sesion.id));
        if (g.availability === "not_migrated") {
          throw Errors.conflict("No eres miembro de esta organización y el acceso de soporte sin membresía requiere la migración 0058 (pendiente de aplicar).");
        }
      }
      const propertyIds = miembro?.propertyIds ? [...miembro.propertyIds] : null;
      const nowMs = ahora();
      const token = await signAccessToken(
        {
          sub: callerId,
          org_id: org.id,
          vertical: org.vertical as "hoteles" | "restaurantes" | "rentas" | "licitaciones" | "citas" | "despachos",
          property_ids: propertyIds,
          email: c.get("userEmail"),
          soporte: { sid: sesion.id, ro: true },
        },
        deps.env.jwtSecret,
        ttlRestanteSegundos(sesion.expiresAtMs, nowMs),
      );
      return c.json(
        {
          token,
          // Sin refresh token a propósito: la sesión de soporte no se renueva sola; al vencer hay que volver a entrar con motivo.
          refreshToken: "",
          session: {
            id: sesion.id,
            kind: sesion.kind,
            organizationId: org.id,
            organizationName: org.name,
            organizationSlug: org.slug,
            vertical: org.vertical,
            expiresAtMs: sesion.expiresAtMs,
            soloLectura: true,
          },
        },
        201,
      );
    } catch (err) {
      await cerrarSesionBestEffort(deps, callerId, sesion.id);
      return traducirError(err);
    }
  });

  // --- Endpoints propios de la sesión (token de soporte) ------------------------------------------------------
  app.use("/soporte/*", authMiddleware(deps.env));

  async function claimsOrForbidden(c: Context<CoreAuthHonoEnv>) {
    const claims = await leerClaimsSoporte(c, deps.env.jwtSecret);
    if (!claims) throw Errors.forbidden("Este endpoint solo existe dentro de una sesión de soporte.");
    return claims;
  }

  app.get("/soporte/estado", async (c) => {
    const claims = await claimsOrForbidden(c);
    const r = await deps.engine.withAppSession({ userId: claims.sub }, (db) => deps.impersonationRepo(db).getSupportState(claims.sub, claims.soporte.sid));
    const s = r.availability === "available" ? r.state : null;
    if (!s || s.organizationId !== claims.org_id) return c.json({ active: false, elevated: false, expiresAtMs: 0, remainingMs: 0 });
    return c.json({ active: s.active, elevated: s.elevated, expiresAtMs: s.expiresAtMs, remainingMs: Math.max(0, s.expiresAtMs - ahora()), organizationId: s.organizationId });
  });

  app.post("/soporte/elevar", async (c) => {
    const claims = await claimsOrForbidden(c);
    const raw = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
    const reason = validarMotivoSoporte(raw.reason, "segundo motivo");
    try {
      const r = await deps.engine.withAppSession({ userId: claims.sub }, async (db) => {
        const repo = deps.impersonationRepo(db);
        const elevada = await repo.elevateSupportSession(claims.sub, claims.soporte.sid, reason);
        if (elevada.availability === "not_migrated") return null;
        return repo.getSupportState(claims.sub, claims.soporte.sid);
      });
      if (!r || r.availability === "not_migrated" || !r.state) throw Errors.serviceUnavailable("Permitir edición requiere la migración 0058 (pendiente de aplicar): esta sesión queda en solo lectura.");
      const token = await signAccessToken(
        {
          sub: claims.sub,
          org_id: claims.org_id,
          vertical: claims.vertical,
          property_ids: claims.property_ids,
          email: claims.email,
          soporte: { sid: claims.soporte.sid, ro: false },
        },
        deps.env.jwtSecret,
        ttlRestanteSegundos(r.state.expiresAtMs, ahora()),
      );
      return c.json({ token, session: { id: claims.soporte.sid, organizationId: claims.org_id, expiresAtMs: r.state.expiresAtMs, soloLectura: false } });
    } catch (err) {
      return traducirError(err);
    }
  });

  app.post("/soporte/salir", async (c) => {
    const claims = await claimsOrForbidden(c);
    try {
      await deps.engine.withAppSession({ userId: claims.sub }, async (db) => {
        const repo = deps.impersonationRepo(db);
        await repo.revokeSupportMemberships(claims.sub, claims.soporte.sid);
        await repo.endSession(claims.sub, claims.soporte.sid);
      });
    } catch (err) {
      // Ya terminada o vencida: salir es idempotente (la concesión ya no sirve: la guarda niega sesiones inactivas).
      if (!(err instanceof ImpersonationConflictError)) return traducirError(err);
    }
    return c.json({ ok: true });
  });

  return app;
}

async function cerrarSesionBestEffort(deps: AppDeps, callerId: string, sessionId: string): Promise<void> {
  try {
    await deps.engine.withAppSession({ userId: callerId }, async (db) => {
      const repo = deps.impersonationRepo(db);
      await repo.revokeSupportMemberships(callerId, sessionId);
      await repo.endSession(callerId, sessionId);
    });
  } catch {
    // La sesión queda con su vencimiento (60 min) y sin token entregado; no hay nada más que revertir.
  }
}
