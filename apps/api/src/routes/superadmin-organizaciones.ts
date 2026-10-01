// Gestion de organizaciones del back office: alta, suspender, reactivar y cambiar
// plan de cuenta (trial <-> active), SIEMPRE en dos pasos (solicitar -> confirmar),
// con motivo obligatorio (>= 20 caracteres), una sola accion pendiente por
// organizacion y bitacora inmutable. Mismo principio rector que
// docs/SUPERADMIN_ACCIONES.md: ningun efecto real con un solo POST.
//
// `POST .../acciones/:id/confirmar` esta en la lista de acciones sensibles
// (step-up MFA, ver superadmin-seguridad/step-up.ts). Suspender corta el acceso del
// STAFF al panel de esa organizacion (core-auth: 403 organization_suspended); NO toca
// Stripe ni core.organization_billing, ni detiene los canales publicos de cara al
// cliente final (WhatsApp/checkout) -- ver docs/SUPERADMIN_ORGANIZACIONES.md.
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import type { OrgActionTipo, OrgAdminActionRow } from "@atiende/db";
import { Errors } from "../errors.ts";
import { requestActor } from "../http-security.ts";
import { traducirErrorSeguridad } from "./superadmin-mfa.ts";
import type { AppDeps } from "../deps.ts";

const NO_DISPONIBLE = "La gestión de organizaciones todavía no está disponible en este despliegue (falta aplicar la migración 0025_superadmin_mfa_switches_orgs).";
const MUTACION_RATE_LIMIT = { max: 30, windowMs: 5 * 60_000 } as const;
const TIPOS = new Set<OrgActionTipo>(["alta", "suspender", "reactivar", "cambiar_plan"]);

function serialize(a: OrgAdminActionRow) {
  return {
    id: a.id,
    tipo: a.tipo,
    organizationId: a.organizationId,
    payload: a.payload,
    motivo: a.motivo,
    estado: a.estado,
    creadoPor: a.creadoPor,
    creadoEnMs: a.creadoEnMs,
    venceEnMs: a.venceEnMs,
    confirmadoPor: a.confirmadoPor,
    confirmadoEnMs: a.confirmadoEnMs,
    resultado: a.resultado,
  };
}

interface SolicitarBody {
  readonly tipo?: unknown;
  readonly organizationId?: unknown;
  readonly payload?: unknown;
  readonly motivo?: unknown;
}

export function superadminOrganizacionesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  async function limitar(c: { req: { raw: Request } }, callerId: string, nombre: string): Promise<void> {
    const allowed = await rateLimit(`admin:${nombre}:${requestActor(c.req.raw, callerId)}`, MUTACION_RATE_LIMIT.max, MUTACION_RATE_LIMIT.windowMs, { category: "admin" });
    if (!allowed) throw Errors.tooManyRequests("Demasiadas solicitudes de gestión de organizaciones en poco tiempo.");
  }

  app.get("/superadmin/organizaciones/acciones", async (c) => {
    if (!deps.orgAdminRepo) return c.json({ disponible: false, acciones: [] });
    const repo = deps.orgAdminRepo;
    const callerId = c.get("userId");
    const { availability, actions } = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).list(callerId, 100));
    return c.json({ disponible: availability === "available", acciones: actions.map(serialize) });
  });

  // Primer paso: NUNCA ejecuta nada, solo registra la solicitud (vence en 10 min).
  app.post("/superadmin/organizaciones/acciones", async (c) => {
    if (!deps.orgAdminRepo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const repo = deps.orgAdminRepo;
    const callerId = c.get("userId");
    await limitar(c, callerId, "orgs-solicitar");

    const raw = (await c.req.json().catch(() => ({}))) as SolicitarBody;
    const tipo = typeof raw.tipo === "string" ? (raw.tipo as OrgActionTipo) : undefined;
    if (!tipo || !TIPOS.has(tipo)) throw Errors.validation("tipo debe ser alta, suspender, reactivar o cambiar_plan.");
    const organizationId = typeof raw.organizationId === "string" && raw.organizationId.trim().length > 0 ? raw.organizationId.trim() : null;
    if (tipo !== "alta" && organizationId === null) throw Errors.validation("organizationId requerido para este tipo de acción.");
    const payload = raw.payload !== null && typeof raw.payload === "object" && !Array.isArray(raw.payload) ? (raw.payload as Record<string, unknown>) : {};
    const motivo = typeof raw.motivo === "string" ? raw.motivo : "";
    if (motivo.trim().length < 20) throw Errors.validation("motivo obligatorio (mínimo 20 caracteres).");

    try {
      const result = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).request(callerId, tipo, organizationId, payload, motivo));
      if (result.availability === "not_migrated" || !result.action) throw Errors.serviceUnavailable(NO_DISPONIBLE);
      return c.json({ accion: serialize(result.action) }, 201);
    } catch (err) {
      return traducirErrorSeguridad(err);
    }
  });

  // Segundo paso: confirma y EJECUTA (el SQL revalida el estado del mundo). Solo el solicitante.
  app.post("/superadmin/organizaciones/acciones/:id/confirmar", async (c) => {
    if (!deps.orgAdminRepo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const repo = deps.orgAdminRepo;
    const callerId = c.get("userId");
    await limitar(c, callerId, "orgs-confirmar");
    try {
      const result = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).confirm(callerId, c.req.param("id")));
      if (result.availability === "not_migrated" || !result.action) throw Errors.serviceUnavailable(NO_DISPONIBLE);
      if (result.action.estado === "expired") throw Errors.conflict("Esta solicitud ya venció: créala de nuevo.");
      return c.json({ accion: serialize(result.action) });
    } catch (err) {
      return traducirErrorSeguridad(err);
    }
  });

  app.post("/superadmin/organizaciones/acciones/:id/cancelar", async (c) => {
    if (!deps.orgAdminRepo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const repo = deps.orgAdminRepo;
    const callerId = c.get("userId");
    try {
      const result = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).cancel(callerId, c.req.param("id")));
      if (result.availability === "not_migrated" || !result.action) throw Errors.serviceUnavailable(NO_DISPONIBLE);
      return c.json({ accion: serialize(result.action) });
    } catch (err) {
      return traducirErrorSeguridad(err);
    }
  });

  return app;
}
