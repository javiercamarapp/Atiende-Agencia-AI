// Configuracion del Resumen por ORGANIZACION (migracion 096): minutos por conversacion atendida (base de «Horas de atencion ahorradas») y metas de IA.
//   GET /v1/restaurantes/:propertyId/admin/resumen/config   lectura (cualquier rol de gestion que ve el Resumen)
//   PUT /v1/restaurantes/:propertyId/admin/resumen/config   reemplaza los tres valores (owner/admin; rangos validados; bitacora con antes/despues)
// RLS es la autoridad; esta capa es defensa en profundidad. Base SIN migrar: la lectura devuelve `disponible:false` y la escritura 503 honesto.
import { Hono } from "hono";
import { assertVerticalRole, authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  MANAGER_ROLES,
  RESUMEN_META_MAX,
  RESUMEN_META_MIN,
  RESUMEN_MINUTOS_MAX,
  RESUMEN_MINUTOS_MIN,
  ResumenConfigInvalidaError,
  ResumenConfigNoDisponibleError,
  ResumenConfigRechazadaError,
  STAFF_INVITE_ROLES,
  validarResumenConfig,
} from "@atiende/domain-restaurantes";
import type { LecturaResumenConfig } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";

const FORMULA =
  "Horas ahorradas = conversaciones de WhatsApp atendidas por el agente en el periodo × minutos por conversacion que configuraste ÷ 60. Es una estimacion con tu supuesto, no una medicion.";

const texto = (n: number | null, sufijo: string) => (n === null ? "sin configurar" : `${n}${sufijo}`);
/** Resumen legible para la bitacora: tres numeros acotados, sin PII. */
function textoConfig(v: { minutosPorConversacion: number | null; metaPedidosIaPct: number | null; metaIngresosIaPct: number | null }): string {
  return `minutos por conversacion: ${texto(v.minutosPorConversacion, "")}; meta de pedidos IA: ${texto(v.metaPedidosIaPct, "%")}; meta de ingresos IA: ${texto(v.metaIngresosIaPct, "%")}`;
}

function serializar(l: LecturaResumenConfig) {
  return {
    disponible: l.disponible,
    config: l.valor,
    actualizadoEn: l.actualizadoEn,
    rangos: { minutos: { min: RESUMEN_MINUTOS_MIN, max: RESUMEN_MINUTOS_MAX }, meta: { min: RESUMEN_META_MIN, max: RESUMEN_META_MAX } },
    formula: FORMULA,
  };
}

export function restaurantesResumenConfigRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const path = "/v1/restaurantes/:propertyId/admin/resumen/config";
  app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(path, async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const lectura = await deps.restaurantesRepo(c.get("db")).leerResumenConfig(c.get("organizationId"));
    return c.json(serializar(lectura));
  });

  app.put(path, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const actorUserId = c.get("userId");
    const repo = deps.restaurantesRepo(c.get("db"));
    let nuevo;
    try {
      nuevo = validarResumenConfig(await readJsonCapped<unknown>(c.req.raw, 1024));
    } catch (err) {
      if (err instanceof ResumenConfigInvalidaError) throw Errors.validation(err.message);
      throw err;
    }
    const anterior = await repo.leerResumenConfig(organizationId);
    let guardado: LecturaResumenConfig;
    try {
      guardado = await repo.guardarResumenConfig(organizationId, actorUserId, nuevo);
    } catch (err) {
      if (err instanceof ResumenConfigNoDisponibleError) throw Errors.serviceUnavailable(err.message);
      if (err instanceof ResumenConfigRechazadaError) throw Errors.forbidden(err.message);
      throw err;
    }
    logEvent(c, "info", "restaurantes_admin_resumen_config_actualizada", { actorUserId, organizationId });
    await repo.registrarAuditoria({
      organizationId,
      actorUserId,
      action: "configuracion.resumen_actualizada",
      entityType: "configuracion",
      entityId: organizationId,
      campo: "resumen_config",
      antes: anterior.disponible ? textoConfig(anterior.valor) : null,
      despues: textoConfig(guardado.valor),
    });
    return c.json(serializar(guardado));
  });

  return app;
}
