// Alta autoservicio -- «primer valor en <30 min» de UNA sucursal (la de `:propertyId`), aunque este inactiva:
//   GET  /v1/restaurantes/:propertyId/admin/primer-valor              -> calcularPrimerValor (menu, horario, zonas, metodos de pago,
//                                                                       prueba del agente, activacion) con minutos restantes.
//   POST /v1/restaurantes/:propertyId/admin/primer-valor/metodos-pago  -> el dueño confirma como cobra esta sucursal (hito
//                                                                       `metodos_pago_confirmados` de core.onboarding_evento, migracion 0078).
// La activacion NO vive aqui: el panel llama a POST /v1/restaurantes/:orgSlug/admin/alta-sucursal/:propertyId/activar (0071), que es
// quien hace cumplir los pasos obligatorios. owner/admin (STAFF_INVITE_ROLES) con acceso a la sucursal. Base sin migrar: cada lectura
// degrada a «no disponible» (repositorio y onboarding-evento con SAVEPOINT); nunca 500.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { hayOnboardingEvento, registrarOnboardingEvento } from "@atiende/db";
import { calcularPrimerValor, STAFF_INVITE_ROLES } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";

export function restaurantesAdminPrimerValorRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const path = "/v1/restaurantes/:propertyId/admin/primer-valor";
  const pagoPath = `${path}/metodos-pago`;
  for (const p of [path, pagoPath]) app.use(p, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  async function sucursal(c: Context<CoreAuthHonoEnv>) {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId") ?? "";
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    if (scope !== null && !scope.includes(propertyId)) throw Errors.forbidden("No tienes acceso a esta sucursal.");
    const repo = deps.restaurantesRepo(c.get("db"));
    const branch = await repo.findBranchById(organizationId, propertyId);
    if (!branch) throw Errors.notFound("Sucursal no encontrada.");
    return { organizationId, branch, repo };
  }

  app.get(path, async (c) => {
    const { organizationId, branch, repo } = await sucursal(c);
    const db = c.get("db");
    const [productos, politica, zonas, pago, prueba] = await Promise.all([
      repo.listAvailableProductsForBranch(branch.propertyId),
      repo.findBranchPolicy(branch.propertyId),
      repo.listBranchDeliveryZoneIds(branch.propertyId),
      hayOnboardingEvento(db, organizationId, "restaurantes", "metodos_pago_confirmados", branch.propertyId),
      hayOnboardingEvento(db, organizationId, "restaurantes", "prueba_agente_whatsapp"),
    ]);
    c.header("Cache-Control", "no-store");
    return c.json(
      calcularPrimerValor({
        sucursal: { propertyId: branch.propertyId, nombre: branch.name, status: branch.status },
        productosDisponibles: productos.length,
        tieneHorario: (politica.horario?.length ?? 0) > 0,
        aceptaDomicilio: politica.aceptaDomicilio !== false,
        coloniasConCobertura: zonas.length,
        metodosPagoConfirmados: pago,
        agenteProbado: prueba,
      }),
    );
  });

  app.post(pagoPath, async (c) => {
    const { organizationId, branch } = await sucursal(c);
    const r = await registrarOnboardingEvento(c.get("db"), { organizationId, vertical: "restaurantes", tipo: "metodos_pago_confirmados", propertyId: branch.propertyId, detalle: { efectivo: true, tarjetaConTerminal: true } });
    if (r === "no_migrado" || r === "error") throw Errors.serviceUnavailable("Confirmar métodos de pago no está disponible aún: requiere aplicar la migración 0078.");
    logEvent(c, "info", "restaurantes_primer_valor_metodos_pago", { actorUserId: c.get("userId"), organizationId, propertyId: branch.propertyId, resultado: r });
    return c.json({ ok: true, yaEstaba: r === "ya_existia" });
  });

  return app;
}
