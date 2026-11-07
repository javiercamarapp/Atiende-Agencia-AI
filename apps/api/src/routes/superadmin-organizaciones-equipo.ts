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
// Verticales: desde la migracion 0070 TODAS las verticales tienen su lista blanca (ver ROLES_INVITABLES_POR_VERTICAL de @atiende/db). Aqui solo
// se valida que el rol exista en ALGUNA vertical; la base decide con la vertical real de la organizacion (400 si no corresponde). Contra una base
// con solo la 0053, una organizacion que no es de restaurantes sigue recibiendo el 400 explicito de la base. El correo usa la plantilla de la
// vertical (leida de la lectura del equipo, llave `vertical` de 0070); sin esa llave cae a la de restaurantes.
import { Hono } from "hono";
import { ApiError, generateInviteToken } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import { EquipoInvitacionError, EquipoNoDisponibleError, emitirNotificacion, esRolInvitableEnAlgunaVertical } from "@atiende/db";
import type { InvitacionEquipo, OrgEquipoRepository } from "@atiende/db";
import { correoInvitacionStaff as correoCitas, isCitasRole } from "@atiende/domain-citas";
import { correoInvitacionStaff as correoDespachos, isDespachosRole } from "@atiende/domain-despachos";
import { correoInvitacionStaff as correoHoteles, isHotelRole } from "@atiende/domain-hoteles";
import { correoInvitacionStaff as correoLicitaciones, isLicitacionesRole } from "@atiende/domain-licitaciones";
import { correoInvitacionStaff as correoRentas, isRentasVerticalRole } from "@atiende/domain-rentas";
import { correoInvitacionStaff, isRestaurantesRole } from "@atiende/domain-restaurantes";
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

interface CorreoArmado {
  readonly asunto: string;
  readonly html: string;
  readonly texto: string;
}

/**
 * Plantilla del correo de invitacion de la vertical de la organizacion (cada domain-<vertical> ya tiene la suya, la misma que usa la invitacion
 * de un owner/admin). La base ya valido que el rol pertenece a ESA vertical; los type guards solo estrechan el tipo. Si la vertical no se conoce
 * (base con solo la 0053) o el rol no encaja, cae a la plantilla de restaurantes, que era el unico caso posible antes de la 0070.
 */
export function correoInvitacionSuperadmin(vertical: string | undefined, c: { readonly email: string; readonly verticalRole: string; readonly acceptUrl: string; readonly expiresAtTexto: string }): CorreoArmado {
  const { verticalRole: rol, ...resto } = c;
  if (vertical === "citas" && isCitasRole(rol)) return correoCitas({ ...resto, verticalRole: rol });
  if (vertical === "hoteles" && isHotelRole(rol)) return correoHoteles({ ...resto, verticalRole: rol });
  if (vertical === "despachos" && isDespachosRole(rol)) return correoDespachos({ ...resto, verticalRole: rol });
  if (vertical === "licitaciones" && isLicitacionesRole(rol)) return correoLicitaciones({ ...resto, verticalRole: rol });
  if (vertical === "rentas" && isRentasVerticalRole(rol)) return correoRentas({ ...resto, verticalRole: rol });
  return correoInvitacionStaff({ ...resto, verticalRole: isRestaurantesRole(rol) ? rol : "staff" });
}

/** Vertical de la organizacion segun la lectura del equipo (misma sesion del caller); undefined si la base no la expone. */
async function verticalDe(repo: OrgEquipoRepository, callerId: string, organizationId: string): Promise<string | undefined> {
  const r = await repo.leer(callerId, organizationId);
  return r.ok && r.data ? r.data.vertical : undefined;
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
  async function encolarCorreo(organizationId: string, invitacion: InvitacionEquipo, tokenPlain: string, vertical: string | undefined): Promise<{ readonly acceptUrl: string; readonly encolado: boolean }> {
    const acceptUrl = `${deps.env.appBaseUrl}/aceptar-invitacion?token=${encodeURIComponent(tokenPlain)}`;
    try {
      const correo = correoInvitacionSuperadmin(vertical, {
        email: invitacion.email,
        verticalRole: invitacion.verticalRole,
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
    if (typeof raw.verticalRole !== "string" || !esRolInvitableEnAlgunaVertical(raw.verticalRole)) throw Errors.validation("verticalRole inválido — no es un rol de ninguna vertical.");
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
    let vertical: string | undefined;
    try {
      ({ invitacion, vertical } = await deps.engine.withAppSession({ userId: callerId }, async (db) => {
        const r = repo(db);
        const creada = await r.invitar(callerId, {
          organizationId,
          email: raw.email as string,
          verticalRole: raw.verticalRole as string,
          propertyIds,
          tokenHash,
          motivo,
          confirmarSegundoOwner: raw.confirmarSegundoOwner === true,
        });
        return { invitacion: creada, vertical: await verticalDe(r, callerId, organizationId) };
      }));
    } catch (err) {
      return traducirError(err);
    }

    const { acceptUrl, encolado } = await encolarCorreo(organizationId, invitacion, tokenPlain, vertical);
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
    let vertical: string | undefined;
    try {
      ({ invitacion, vertical } = await deps.engine.withAppSession({ userId: callerId }, async (db) => {
        const r = repo(db);
        const reenviada = await r.reenviar(callerId, organizationId, inviteId, tokenHash, motivo);
        return { invitacion: reenviada, vertical: await verticalDe(r, callerId, organizationId) };
      }));
    } catch (err) {
      return traducirError(err);
    }
    const { acceptUrl, encolado } = await encolarCorreo(organizationId, invitacion, tokenPlain, vertical);
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

