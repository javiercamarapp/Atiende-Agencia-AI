// Alta del equipo inicial de una organizacion por un superadmin (SA-L-26 version minima, go-live G-07).
//
//   GET    /superadmin/organizaciones/:organizationId/invitaciones                 -- miembros actuales e invitaciones pendientes (correo enmascarado,
//                                                                                     sin hashes ni tokens) y las sucursales de la organizacion.
//   POST   /superadmin/organizaciones/:organizationId/invitaciones                 -- invita (correo, rol de la vertical, sucursales opcionales).
//   POST   /superadmin/organizaciones/:organizationId/invitaciones/:id/reenviar    -- token nuevo; el anterior deja de servir.
//   DELETE /superadmin/organizaciones/:organizationId/invitaciones/:id             -- revoca una invitacion pendiente.
//
// Las tres mutaciones exigen motivo (>= 20 caracteres) y estan en SENSITIVE_ROUTES (step-up MFA, superadmin-seguridad/step-up.ts). La
// autorizacion real (superadmin de plataforma, auth.uid() = p_caller_id), la lista blanca de roles, las sucursales de la propia
// organizacion, los conflictos y la bitacora viven en las funciones SQL de la migracion 0053; este archivo solo valida la forma del request,
// arma el token y el correo y traduce los rechazos. NO crea usuarios ni contrasenas: la persona define la suya en POST /auth/accept-invite.
//
// Correo: igual que la invitacion que hace un owner/admin (restaurantes/admin-staff.ts), se encola en `restaurantes.messaging_outbox`
// (channel='email') con el enlace `${APP_BASE_URL}/aceptar-invitacion?token=...`. El superadmin NO es miembro de la organizacion y el guard de
// esa funcion lo rechazaria en su sesion, asi que el encolado corre en una sesion de sistema PROPIA (otra transaccion, despues de que la
// invitacion ya quedo confirmada): un fallo del correo nunca revierte la invitacion y nada mas corre tras un error de Postgres en esa
// transaccion. El token en claro se devuelve UNA sola vez en la respuesta (solo el hash persiste) por si el correo aun no esta listo.
//
// Compatibilidad con la base sin migrar: sin la 0053 la lectura responde 200 `disponible: false` (con su razon) y las mutaciones 503; nunca 500.
// Solo restaurantes tiene hoy su lista blanca de roles; las demas verticales se rechazan con 400 explicito.
import { Hono } from "hono";
import { ApiError, generateInviteToken } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import { EquipoInvitacionError, EquipoNoDisponibleError, emitirNotificacion } from "@atiende/db";
import type { InvitacionEquipo } from "@atiende/db";
import { correoInvitacionStaff, isRestaurantesRole } from "@atiende/domain-restaurantes";
import type { StaffInviteVerticalRole } from "@atiende/domain-restaurantes";
import { Errors } from "../errors.ts";
import { readJsonCapped, requestActor } from "../http-security.ts";
import { logEvent } from "../logger.ts";
import type { AppDeps } from "../deps.ts";
import { enmascararCorreoInvitado, tryEnqueueStaffInviteEmail } from "./verticals/restaurantes/admin-staff.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MUTACION_RATE_LIMIT = { max: 30, windowMs: 5 * 60_000 } as const;
const NO_DISPONIBLE = "El alta de equipo todavía no está disponible en este despliegue (falta aplicar la migración 0053_superadmin_alta_equipo).";

interface InvitarBody {
  readonly email?: unknown;
  readonly verticalRole?: unknown;
  readonly propertyIds?: unknown;
  readonly motivo?: unknown;
  readonly confirmarSegundoOwner?: unknown;
}
interface MotivoBody {
  readonly motivo?: unknown;
}

function motivoDe(raw: { readonly motivo?: unknown }): string {
  const motivo = typeof raw.motivo === "string" ? raw.motivo.trim() : "";
  if (motivo.length < 20) throw Errors.validation("motivo obligatorio (mínimo 20 caracteres).");
  if (motivo.length > 500) throw Errors.validation("motivo demasiado largo (máximo 500 caracteres).");
  return motivo;
}

/** Traduce los rechazos de negocio de la base a la respuesta HTTP; lo desconocido se relanza (500 con requestId). */
function traducirError(err: unknown): never {
  if (err instanceof EquipoNoDisponibleError) throw Errors.serviceUnavailable(NO_DISPONIBLE);
  if (err instanceof EquipoInvitacionError) {
    switch (err.codigo) {
      case "forbidden":
        throw Errors.forbidden(err.message);
      case "validation":
        throw Errors.validation(err.message);
      case "not_found":
        throw Errors.notFound("Invitación u organización no encontrada, o la invitación ya no está pendiente.");
      case "conflict":
        throw Errors.conflict(err.message);
      case "segundo_owner":
        throw new ApiError(409, "segundo_owner_requiere_confirmacion", "La organización ya tiene un owner: confirma explícitamente que quieres invitar a un segundo owner.");
    }
  }
  throw err;
}

function serializar(i: InvitacionEquipo) {
  return {
    id: i.id,
    correo: enmascararCorreoInvitado(i.email),
    verticalRole: i.verticalRole,
    propertyIds: i.propertyIds,
    estado: i.status,
    venceEn: i.expiresAt,
    creadaEn: i.createdAt,
  };
}

export function superadminOrganizacionesEquipoRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/superadmin/organizaciones/:organizationId/invitaciones";

  async function limitar(c: { req: { raw: Request } }, callerId: string, nombre: string): Promise<void> {
    const allowed = await rateLimit(`admin:${nombre}:${requestActor(c.req.raw, callerId)}`, MUTACION_RATE_LIMIT.max, MUTACION_RATE_LIMIT.windowMs, { category: "admin" });
    if (!allowed) throw Errors.tooManyRequests("Demasiadas solicitudes de gestión del equipo en poco tiempo.");
  }

  function organizacionDe(c: { req: { param(name: string): string } }): string {
    const id = c.req.param("organizationId");
    if (!UUID_RE.test(id)) throw Errors.notFound("Organización no encontrada.");
    return id;
  }

  /** Encola el correo en una sesion de sistema propia. Best-effort: devuelve si quedo encolado, nunca lanza. */
  async function encolarCorreo(organizationId: string, invitacion: InvitacionEquipo, tokenPlain: string): Promise<{ readonly acceptUrl: string; readonly encolado: boolean }> {
    const acceptUrl = `${deps.env.appBaseUrl}/aceptar-invitacion?token=${encodeURIComponent(tokenPlain)}`;
    try {
      const correo = correoInvitacionStaff({
        email: invitacion.email,
        // La base ya valido la lista blanca de restaurantes (owner, admin, staff, repartidor): el estrechamiento es seguro.
        verticalRole: invitacion.verticalRole as StaffInviteVerticalRole,
        acceptUrl,
        expiresAtTexto: new Intl.DateTimeFormat("es-MX", { dateStyle: "long" }).format(new Date(invitacion.expiresAt)),
      });
      const encolado = await deps.engine.withAppSession({ userId: null }, (db) => tryEnqueueStaffInviteEmail(deps.restaurantesRepo(db), organizationId, invitacion.id, invitacion.email, correo));
      return { acceptUrl, encolado };
    } catch (err) {
      console.error("superadmin-organizaciones-equipo: no se pudo encolar el correo de invitacion:", err);
      return { acceptUrl, encolado: false };
    }
  }

  app.get(base, async (c) => {
    const organizationId = organizacionDe(c);
    const repo = deps.orgEquipoRepo;
    if (!repo) return c.json({ disponible: false, mensaje: NO_DISPONIBLE, miembros: [], invitaciones: [], sucursales: [] });
    const callerId = c.get("userId");
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).leer(callerId, organizationId));
    if (!r.ok) {
      return c.json({
        disponible: false,
        mensaje: r.razon === "no_migrado" ? NO_DISPONIBLE : "No se pudo leer el equipo de esta organización; reintenta en unos minutos.",
        miembros: [],
        invitaciones: [],
        sucursales: [],
      });
    }
    if (r.data === null) throw Errors.notFound("Organización no encontrada.");
    return c.json({ disponible: true, mensaje: null, ...r.data });
  });

  app.post(base, async (c) => {
    const organizationId = organizacionDe(c);
    const callerId = c.get("userId");
    await limitar(c, callerId, "orgs-equipo-invitar");
    const repo = deps.orgEquipoRepo;
    if (!repo) throw Errors.serviceUnavailable(NO_DISPONIBLE);

    const raw = await readJsonCapped<InvitarBody>(c.req.raw, 4 * 1024);
    if (typeof raw.email !== "string" || !EMAIL_RE.test(raw.email.trim())) throw Errors.validation("email inválido");
    if (typeof raw.verticalRole !== "string" || !isRestaurantesRole(raw.verticalRole)) throw Errors.validation("verticalRole inválido — se esperaba uno de: owner, admin, staff, repartidor.");
    let propertyIds: string[] | null = null;
    if (raw.propertyIds !== undefined && raw.propertyIds !== null) {
      if (!Array.isArray(raw.propertyIds) || raw.propertyIds.length === 0 || raw.propertyIds.length > 100 || raw.propertyIds.some((p) => typeof p !== "string" || !UUID_RE.test(p))) {
        throw Errors.validation("propertyIds debe ser una lista no vacía de ids de sucursal (omítelo para dar acceso a todas).");
      }
      propertyIds = raw.propertyIds as string[];
    }
    if (raw.confirmarSegundoOwner !== undefined && typeof raw.confirmarSegundoOwner !== "boolean") throw Errors.validation("confirmarSegundoOwner debe ser booleano.");
    const motivo = motivoDe(raw);

    const { tokenPlain, tokenHash } = generateInviteToken();
    let invitacion: InvitacionEquipo;
    try {
      invitacion = await deps.engine.withAppSession({ userId: callerId }, (db) =>
        repo(db).invitar(callerId, {
          organizationId,
          email: raw.email as string,
          verticalRole: raw.verticalRole as string,
          propertyIds,
          tokenHash,
          motivo,
          confirmarSegundoOwner: raw.confirmarSegundoOwner === true,
        }),
      );
    } catch (err) {
      return traducirError(err);
    }

    const { acceptUrl, encolado } = await encolarCorreo(organizationId, invitacion, tokenPlain);
    logEvent(c, "info", "superadmin_equipo_invitacion_creada", { actorUserId: callerId, organizationId, inviteId: invitacion.id, invitedEmail: enmascararCorreoInvitado(invitacion.email), verticalRole: invitacion.verticalRole });
    return c.json({ invitacion: serializar(invitacion), inviteToken: tokenPlain, acceptUrl, correoEncolado: encolado }, 201);
  });

  app.post(`${base}/:inviteId/reenviar`, async (c) => {
    const organizationId = organizacionDe(c);
    const inviteId = c.req.param("inviteId");
    if (!UUID_RE.test(inviteId)) throw Errors.notFound("Invitación no encontrada.");
    const callerId = c.get("userId");
    await limitar(c, callerId, "orgs-equipo-reenviar");
    const repo = deps.orgEquipoRepo;
    if (!repo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const motivo = motivoDe(await readJsonCapped<MotivoBody>(c.req.raw, 2 * 1024));

    const { tokenPlain, tokenHash } = generateInviteToken();
    let invitacion: InvitacionEquipo;
    try {
      invitacion = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).reenviar(callerId, organizationId, inviteId, tokenHash, motivo));
    } catch (err) {
      return traducirError(err);
    }
    const { acceptUrl, encolado } = await encolarCorreo(organizationId, invitacion, tokenPlain);
    logEvent(c, "info", "superadmin_equipo_invitacion_reenviada", { actorUserId: callerId, organizationId, inviteId });
    return c.json({ invitacion: serializar(invitacion), inviteToken: tokenPlain, acceptUrl, correoEncolado: encolado });
  });

  app.delete(`${base}/:inviteId`, async (c) => {
    const organizationId = organizacionDe(c);
    const inviteId = c.req.param("inviteId");
    if (!UUID_RE.test(inviteId)) throw Errors.notFound("Invitación no encontrada.");
    const callerId = c.get("userId");
    await limitar(c, callerId, "orgs-equipo-revocar");
    const repo = deps.orgEquipoRepo;
    if (!repo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const motivo = motivoDe(await readJsonCapped<MotivoBody>(c.req.raw, 2 * 1024));
    try {
      await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).revocar(callerId, organizationId, inviteId, motivo));
    } catch (err) {
      return traducirError(err);
    }
    logEvent(c, "info", "superadmin_equipo_invitacion_revocada", { actorUserId: callerId, organizationId, inviteId });
    return c.json({ ok: true, id: inviteId });
  });

  return app;
}

/**
 * Aviso in-app al superadmin cuando alguien acepta una invitacion creada por un superadmin (`superadmin.organizacion.miembro_aceptado`,
 * una por invitacion, sin PII). Lo llama POST /auth/accept-invite DESPUES de aceptar, en su propia sesion de sistema: es best-effort y
 * nunca rompe ni retrasa el login (los errores solo se registran). Sin la 0053 no hace nada.
 */
export async function avisarAceptacionInvitacionSuperadmin(deps: AppDeps, tokenHash: string): Promise<void> {
  const repo = deps.orgEquipoRepo;
  if (!repo) return;
  try {
    await deps.engine.withAppSession({ userId: null }, async (db) => {
      const r = await repo(db).aceptacionParaSistema(tokenHash);
      if (!r.ok || r.data === null) return;
      await emitirNotificacion(db, {
        evento: "superadmin.organizacion.miembro_aceptado",
        organizationId: null,
        clave: r.data.inviteId,
        entidadTipo: "staff_invite",
        entidadId: r.data.organizationId,
      });
    });
  } catch (err) {
    console.error("superadmin-organizaciones-equipo: no se pudo emitir el aviso de invitacion aceptada:", err);
  }
}

