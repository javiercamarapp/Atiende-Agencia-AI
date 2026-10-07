// Reactivacion de clientes inactivos (autopiloto 2, migracion 052) -- panel de owner/admin con alcance a TODA la organizacion:
//   GET  .../admin/marketing                              configuracion + requisitos reales + campanas con atribucion
//   PUT  .../admin/marketing/config                       activo, tarifa por mensaje de Meta, tope mensual, minimo de segmento, plantilla
//   POST .../admin/marketing/campanas/:campanaId/decidir  { accion: "aprobar" | "rechazar" }  (un clic; rechazar o ignorar NO envia nada)
//
// Toda la regla (consentimiento vigente, tope de 14 dias, grupo de control, plantilla aprobada, tope mensual) vive en la base (SECURITY
// DEFINER con guard owner/admin y property_ids nulo); aqui solo se valida la forma, se traduce el error y se responde. Sin la migracion:
// GET -> `disponible: false` (lista vacia honesta) y las escrituras -> 503. Sin PII: nada de telefonos ni nombres de clientes.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  MarketingNoDisponibleError,
  MarketingParametrosError,
  MarketingRechazadoError,
  MarketingSinAccesoError,
  STAFF_INVITE_ROLES,
  decidirCampana,
  guardarConfigMarketing,
  leerConfigMarketing,
  listarCampanas,
} from "@atiende/domain-restaurantes";
import type { CodigoRechazoMarketing } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";

const MENSAJE_RECHAZO: Readonly<Record<CodigoRechazoMarketing, string>> = {
  requiere_tarifa: "Configura la tarifa por mensaje de marketing de Meta antes de aprobar: el costo debe verse antes de enviar.",
  requiere_marketing_activo: "Las campañas están desactivadas: actívalas en la configuración antes de aprobar (puedes rechazar este borrador).",
  requiere_nuevo_borrador: "Este borrador se generó sin costo o con otra tarifa que la vigente: recházalo y espera el siguiente borrador para ver el costo correcto antes de aprobar.",
  requiere_plantilla_aprobada: "Requiere una plantilla de marketing aprobada por Meta (configúrala en Plantillas de WhatsApp) antes de enviar.",
  requiere_whatsapp_conectado: "Requiere el WhatsApp de la organización conectado antes de enviar.",
  tope_mensual_excedido: "El costo estimado de esta campaña (recalculado con los clientes elegibles de hoy y la tarifa vigente) excede el tope mensual de marketing configurado.",
  campana_no_aprobable: "Esta campaña ya fue decidida o expiró; espera el siguiente borrador.",
};

function traducir(err: unknown): never {
  if (err instanceof MarketingNoDisponibleError) throw Errors.serviceUnavailable(err.message);
  if (err instanceof MarketingRechazadoError) throw Errors.conflict(MENSAJE_RECHAZO[err.codigo]);
  if (err instanceof MarketingSinAccesoError) throw Errors.forbidden(err.message);
  if (err instanceof MarketingParametrosError) throw Errors.validation(err.message);
  throw err;
}

interface ConfigBody {
  readonly activo?: unknown;
  readonly tarifaCentavos?: unknown;
  readonly topeMensualCentavos?: unknown;
  readonly minimoSegmento?: unknown;
  readonly plantillaNombre?: unknown;
  readonly plantillaIdioma?: unknown;
}

function enteroONull(v: unknown, campo: string, min: number, max: number): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw Errors.validation(`${campo}: se esperaba un entero entre ${min} y ${max}, o null.`);
  return v;
}

export function restaurantesAdminMarketingRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/v1/restaurantes/:propertyId/admin/marketing";
  for (const path of [base, `${base}/*`]) app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(base, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    try {
      const config = await leerConfigMarketing(c.get("db"), organizationId);
      const campanas = await listarCampanas(c.get("db"), organizationId);
      return c.json({ disponible: config.disponible && campanas.disponible, config: config.valor, campanas: campanas.valor });
    } catch (err) {
      return traducir(err);
    }
  });

  app.put(`${base}/config`, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const raw = await readJsonCapped<ConfigBody>(c.req.raw, 4 * 1024);
    if (typeof raw.activo !== "boolean") throw Errors.validation("activo: se esperaba un booleano.");
    const minimo = raw.minimoSegmento === undefined ? 10 : enteroONull(raw.minimoSegmento, "minimoSegmento", 1, 10000);
    if (minimo === null) throw Errors.validation("minimoSegmento: obligatorio.");
    if (raw.plantillaNombre !== undefined && raw.plantillaNombre !== null && (typeof raw.plantillaNombre !== "string" || !/^[a-z0-9_]{1,255}$/.test(raw.plantillaNombre))) {
      throw Errors.validation("plantillaNombre: minúsculas, dígitos y guion bajo (como en Meta), o null.");
    }
    const idioma = raw.plantillaIdioma === undefined ? "es_MX" : raw.plantillaIdioma;
    if (typeof idioma !== "string" || !/^[a-z]{2,3}(_[A-Z]{2})?$/.test(idioma)) throw Errors.validation("plantillaIdioma: se esperaba un código como es_MX.");
    try {
      await guardarConfigMarketing(c.get("db"), organizationId, {
        activo: raw.activo,
        tarifaCentavos: enteroONull(raw.tarifaCentavos, "tarifaCentavos", 1, 10000),
        topeMensualCentavos: enteroONull(raw.topeMensualCentavos, "topeMensualCentavos", 1, 100_000_000),
        minimoSegmento: minimo,
        plantillaNombre: (raw.plantillaNombre as string | null | undefined) ?? null,
        plantillaIdioma: idioma,
      });
    } catch (err) {
      return traducir(err);
    }
    logEvent(c, "info", "restaurantes_marketing_config_guardada", { actorUserId: c.get("userId"), organizationId, activo: raw.activo });
    const config = await leerConfigMarketing(c.get("db"), organizationId);
    return c.json({ disponible: config.disponible, config: config.valor });
  });

  app.post(`${base}/campanas/:campanaId/decidir`, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const campanaId = c.req.param("campanaId") ?? "";
    if (!/^[0-9a-fA-F-]{36}$/.test(campanaId)) throw Errors.validation("campanaId: se esperaba un id de campaña válido.");
    const raw = await readJsonCapped<{ accion?: unknown }>(c.req.raw, 1024);
    if (raw.accion !== "aprobar" && raw.accion !== "rechazar") throw Errors.validation('accion: se esperaba "aprobar" o "rechazar".');
    try {
      const resultado = await decidirCampana(c.get("db"), campanaId, raw.accion === "aprobar");
      logEvent(c, "info", "restaurantes_marketing_campana_decidida", { actorUserId: c.get("userId"), organizationId, campanaId, estado: resultado.estado, encolados: resultado.encolados });
      return c.json({ estado: resultado.estado, encolados: resultado.encolados, control: resultado.control });
    } catch (err) {
      return traducir(err);
    }
  });

  return app;
}
