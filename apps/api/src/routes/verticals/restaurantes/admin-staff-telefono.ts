// Alta del celular de acceso de un REPARTIDOR (docs/LOGIN-CHOFER-WHATSAPP.md). Lo registra el encargado/admin al crear la cuenta del
// repartidor; SOLO aplica a cuentas de repartidor (el encargado, cajero, administrador y superadmin siguen entrando con correo).
//
//   GET    .../admin/staff/telefonos-acceso                       -- telefonos ENMASCARADOS por usuario.
//   PUT    .../admin/staff/miembros/:userId/telefono-acceso       -- { telefono } registra/reemplaza.
//   DELETE .../admin/staff/miembros/:userId/telefono-acceso       -- quita el acceso por celular.
//
// Primer filtro en TypeScript (`MANAGER_ROLES` + el objetivo debe ser repartidor de ESTA organizacion); la autoridad real vive en
// `core.chofer_login_telefono_guardar/quitar/listar` (security definer, exigen auth.uid() con autoridad y un repartidor elegible).
// La bitacora NO guarda el telefono.
import { Hono } from "hono";
import { assertVerticalRole, authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { MANAGER_ROLES } from "@atiende/domain-restaurantes";
import { LoginChoferNoDisponibleError, LoginChoferTelefonoError } from "@atiende/db";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { normalizarTelefonoMx } from "../../../login-telefono/telefono.ts";

const MENSAJE_NO_DISPONIBLE = "El acceso con celular todavía no está disponible en esta base: requiere aplicar la migración 0059.";

function traducir(err: unknown): never {
  if (err instanceof LoginChoferNoDisponibleError) throw Errors.serviceUnavailable(MENSAJE_NO_DISPONIBLE);
  if (err instanceof LoginChoferTelefonoError) {
    if (err.message.startsWith("no se pudo registrar")) throw Errors.conflict("No se pudo registrar ese teléfono. Revisa el número o usa otro.");
    throw Errors.forbidden(err.message.charAt(0).toUpperCase() + err.message.slice(1) + ".");
  }
  throw err;
}

export function restaurantesAdminStaffTelefonoRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const listaPath = "/v1/restaurantes/:propertyId/admin/staff/telefonos-acceso";
  const itemPath = "/v1/restaurantes/:propertyId/admin/staff/miembros/:userId/telefono-acceso";
  app.use(listaPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(itemPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  function repo(db: TenantDbSession) {
    if (!deps.loginChoferRepo) throw Errors.serviceUnavailable(MENSAJE_NO_DISPONIBLE);
    return deps.loginChoferRepo(db);
  }

  app.get(listaPath, async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    try {
      const filas = await repo(c.get("db")).listarTelefonos(c.get("organizationId"));
      return c.json({ telefonos: filas.map((f) => ({ userId: f.userId, telefonoEnmascarado: f.telefonoEnmascarado })) });
    } catch (err) {
      return traducir(err);
    }
  });

  async function objetivoRepartidor(c: Parameters<typeof assertVerticalRole>[0], userId: string): Promise<void> {
    const miembros = await deps.coreStaffRepo(c.get("db")).listMembersByVerticalRole(c.get("organizationId"), "repartidor");
    if (!miembros.some((m) => m.userId === userId)) throw Errors.notFound("Ese repartidor no pertenece a esta organización.");
  }

  app.put(itemPath, async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const organizationId = c.get("organizationId");
    const userId = c.req.param("userId");
    const raw = await readJsonCapped<{ telefono?: unknown }>(c.req.raw, 1024);
    const telefono = normalizarTelefonoMx(raw.telefono);
    if (!telefono) throw Errors.validation("Escribe un celular mexicano de 10 dígitos.");
    await objetivoRepartidor(c, userId);
    try {
      await repo(c.get("db")).guardarTelefono(organizationId, userId, telefono);
    } catch (err) {
      return traducir(err);
    }
    // Sin el telefono en la bitacora ni en el log (PII).
    await deps.restaurantesRepo(c.get("db")).registrarAuditoria({ organizationId, actorUserId: c.get("userId"), action: "staff.telefono_acceso_registrado", entityType: "staff", entityId: userId, campo: null, antes: null, despues: null });
    logEvent(c, "info", "restaurantes_telefono_acceso_registrado", { organizationId, targetUserId: userId });
    return c.json({ ok: true });
  });

  app.delete(itemPath, async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const organizationId = c.get("organizationId");
    const userId = c.req.param("userId");
    let borrado: boolean;
    try {
      borrado = await repo(c.get("db")).quitarTelefono(organizationId, userId);
    } catch (err) {
      return traducir(err);
    }
    if (borrado) {
      await deps.restaurantesRepo(c.get("db")).registrarAuditoria({ organizationId, actorUserId: c.get("userId"), action: "staff.telefono_acceso_quitado", entityType: "staff", entityId: userId, campo: null, antes: null, despues: null });
    }
    return c.json({ ok: true, quitado: borrado });
  });

  return app;
}
