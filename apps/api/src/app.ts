// Ensambla la app Hono real de apps/api. Deliberadamente SIN ningún middleware
// global de parseo de JSON (`app.use(json())`/`bodyLimit`) — cada ruta lee su propio
// body (`c.req.json()`/`readJsonCapped`/`c.req.raw.arrayBuffer()`), para que
// whatsapp.ts pueda leer bytes crudos sin que nada los haya consumido antes (ver
// comentario crítico en routes/verticals/restaurantes/whatsapp.ts).
import { Hono } from "hono";
import { ApiError, requestId } from "@atiende/core-auth";
import { DatabaseBusyError } from "@atiende/db";
import type { AppDeps } from "./deps.ts";
import { logEvent } from "./logger.ts";
import { cabecerasSeguridadApi } from "./cabeceras-seguridad.ts";
import { originGuard, sinCacheEnSesion } from "./origin-guard.ts";
import { demoAgentsRoutes } from "./routes/demo-agents.ts";
import { healthRoutes } from "./routes/health.ts";
import { authRoutes } from "./routes/auth.ts";
import { authGoogleRoutes } from "./routes/auth-google.ts";
import { authMagicLinkRoutes } from "./routes/auth-magic-link.ts";
import { auth2faRoutes } from "./routes/auth-2fa.ts";
import { authAccountRoutes } from "./routes/auth-account.ts";
import { authCuentaRoutes } from "./routes/auth-cuenta.ts";
import { superadminRoutes } from "./routes/superadmin.ts";
import { superadminIntegracionesRoutes } from "./routes/superadmin-integraciones.ts";
import { superadminLlmUsageRoutes } from "./routes/superadmin-llm-usage.ts";
import { superadminBreakGlassRoutes } from "./routes/superadmin-break-glass.ts";
import { superadminImpersonacionRoutes } from "./routes/superadmin-impersonacion.ts";
import { superadminFacturacionRoutes } from "./routes/superadmin-facturacion.ts";
import { superadminSaludRoutes } from "./routes/superadmin-salud.ts";
import { superadminResumenRoutes } from "./routes/superadmin-resumen.ts";
import { superadminAccionesRoutes } from "./routes/superadmin-acciones.ts";
import { superadminMfaRoutes } from "./routes/superadmin-mfa.ts";
import { superadminInterruptoresRoutes } from "./routes/superadmin-interruptores.ts";
import { superadminOrganizacionesRoutes } from "./routes/superadmin-organizaciones.ts";
import { superadminOrganizacionesFichaRoutes } from "./routes/superadmin-organizaciones-ficha.ts";
import { superadminOrganizacionesEquipoRoutes } from "./routes/superadmin-organizaciones-equipo.ts";
import { superadminCostosRoutes } from "./routes/superadmin-costos.ts";
import { superadminCfoRoutes } from "./routes/superadmin-cfo.ts";
import { superadminPylRoutes } from "./routes/superadmin-pyl.ts";
import { superadminConsolaRoutes } from "./routes/superadmin-consola.ts";
import { superadminAgentesFichasRoutes } from "./routes/superadmin-agentes-fichas.ts";
import { superadminAgentesRoutes } from "./routes/superadmin-agentes.ts";
import { superadminContratosRoutes } from "./routes/superadmin-contratos.ts";
import { superadminPlanesRoutes } from "./routes/superadmin-planes.ts";
import { superadminZonaCfoRoutes } from "./routes/superadmin-zona-cfo.ts";
import { superadminPrivacidadRoutes } from "./routes/superadmin-privacidad.ts";
import { superadminSupresionRoutes } from "./routes/superadmin-supresion.ts";
import { superadminCerebroRoutes } from "./routes/superadmin-cerebro.ts";
import { superadminCopilotoRoutes } from "./routes/superadmin-copiloto.ts";
import { privacidadOrgRoutes } from "./routes/privacidad-org.ts";
import { notificationsRoutes } from "./routes/notifications.ts";
import { billingRoutes } from "./routes/billing.ts";
import { restaurantesPublicRoutes } from "./routes/verticals/restaurantes/public.ts";
import { restaurantesDemoWidgetRoutes } from "./routes/verticals/restaurantes/demo-widget.ts";
import { restaurantesStorefrontRoutes } from "./routes/verticals/restaurantes/storefront.ts";
import { restaurantesStorefrontMetaRoutes } from "./routes/verticals/restaurantes/storefront-meta.ts";
import { restaurantesVoiceToolsRoutes } from "./routes/verticals/restaurantes/voice-tools.ts";
import { restaurantesWhatsAppRoutes } from "./routes/verticals/restaurantes/whatsapp.ts";
import { restaurantesRoutes } from "./routes/verticals/restaurantes/restaurantes.ts";
import { hotelesRoutes } from "./routes/verticals/hoteles/hoteles.ts";
import { hotelesVoiceToolsRoutes } from "./routes/verticals/hoteles/voice-tools.ts";
import { hotelesWhatsAppRoutes } from "./routes/verticals/hoteles/whatsapp.ts";
import { hotelesCfdiWebhookRoutes } from "./routes/verticals/hoteles/cfdi-webhook.ts";
import { citasRoutes } from "./routes/verticals/citas/citas.ts";
import { licitacionesRoutes } from "./routes/verticals/licitaciones/licitaciones.ts";
import { despachosRoutes } from "./routes/verticals/despachos/despachos.ts";
import { rentasRoutes } from "./routes/verticals/rentas/rentas.ts";
import { whatsappDispatchRoutes } from "./routes/internal/whatsapp-dispatch.ts";
import { resumenDiarioRoutes } from "./routes/internal/resumen-diario.ts";
import { superadminMantenimientoRoutes } from "./routes/internal/superadmin-mantenimiento.ts";
import { superadminAlertasCfoRoutes } from "./routes/internal/superadmin-alertas-cfo.ts";
import { plataformaRetencionRoutes } from "./routes/internal/plataforma-retencion.ts";
import { pruebaAvisosRoutes } from "./routes/internal/prueba-avisos.ts";

export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();

  // Hallazgo de auditoría (observabilidad) — `requestId()` (@atiende/core-auth)
  // existía y varias rutas de licitaciones ya leían `c.get("requestId")` para
  // `correlationId`, pero el middleware nunca se montaba en el pipeline real:
  // fuera de tests que lo montan manualmente, `c.get("requestId")` siempre
  // devolvía `undefined` en producción pese a que `CoreAuthVariables` lo tipa
  // como `string` no-opcional. Montado aquí, primero que nada, para TODA ruta
  // (incluidas las públicas/internas que no pasan por `authMiddleware`) — ver
  // `./logger.ts` (`logEvent`) para cómo el resto de logs estructurados de esta
  // app ahora incluyen este mismo id, y `docs/OBSERVABILIDAD.md` para el detalle
  // completo de qué correlaciona y qué no.
  app.use("*", requestId());

  // Cabeceras de seguridad (HSTS, nosniff, anti-framing, CSP restrictiva de API, etc.)
  // en TODA respuesta, incluidos 401/404/500 -- ver ./cabeceras-seguridad.ts.
  app.use("*", cabecerasSeguridadApi());

  // PL-09: validacion de Origin/Host en las rutas de sesion (`/auth/*`) y de back office
  // (`/superadmin/*`) para metodos con efectos, y sin cache en sus respuestas -- ver ./origin-guard.ts.
  for (const prefijo of ["/auth/*", "/superadmin/*"]) {
    app.use(prefijo, originGuard({ allowedOrigins: deps.env.allowedOrigins, appBaseUrl: deps.env.appBaseUrl }));
    app.use(prefijo, sinCacheEnSesion());
  }

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ code: err.code, message: err.message }, err.status as 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503, err.headers);
    }
    // Pool de conexiones saturado (sobrecarga transitoria, ver `DatabaseBusyError`): 503 reintentable, no 500. Meta y los
    // clientes HTTP reintentan; el ledger de mensajes entrantes y la idempotencia de pedidos evitan duplicados.
    if (err instanceof DatabaseBusyError) {
      logEvent(c, "warn", "apps_api_db_ocupada", { depth: err.depth, waitedMs: err.waitedMs });
      return c.json({ code: "service_busy", message: "Servicio ocupado. Intenta de nuevo en unos segundos." }, 503, { "Retry-After": "2" });
    }
    logEvent(c, "error", "apps_api_error_interno", { message: err instanceof Error ? err.message : String(err) });
    return c.json({ code: "internal_error", message: "Error interno" }, 500);
  });

  // /health real (BD + latidos + rate limiter, degrada a 503), ver routes/health.ts.
  app.route("/", healthRoutes(deps));

  app.route("/", authRoutes(deps));
  app.route("/", authGoogleRoutes(deps));
  app.route("/", authMagicLinkRoutes(deps));
  app.route("/", auth2faRoutes(deps));
  app.route("/", authAccountRoutes(deps));
  app.route("/", authCuentaRoutes(deps));
  app.route("/", superadminRoutes(deps));
  app.route("/", superadminIntegracionesRoutes(deps));
  app.route("/", superadminLlmUsageRoutes(deps));
  app.route("/", superadminBreakGlassRoutes(deps));
  app.route("/", superadminImpersonacionRoutes(deps));
  app.route("/", superadminFacturacionRoutes(deps));
  app.route("/", superadminSaludRoutes(deps));
  app.route("/", superadminResumenRoutes(deps));
  app.route("/", superadminAccionesRoutes(deps));
  // MFA TOTP + step-up, interruptores de plataforma y gestion de organizaciones del
  // superadmin (autenticacion/gateo/step-up montados una vez en routes/superadmin.ts).
  app.route("/", superadminMfaRoutes(deps));
  app.route("/", superadminInterruptoresRoutes(deps));
  app.route("/", superadminOrganizacionesRoutes(deps));
  app.route("/", superadminOrganizacionesFichaRoutes(deps));
  app.route("/", superadminOrganizacionesEquipoRoutes(deps));
  app.route("/", superadminCostosRoutes(deps));
  app.route("/", superadminCfoRoutes(deps));
  app.route("/", superadminPylRoutes(deps));
  app.route("/", superadminConsolaRoutes(deps));
  app.route("/", superadminAgentesRoutes(deps));
  app.route("/", superadminAgentesFichasRoutes(deps));
  app.route("/", superadminPlanesRoutes(deps));
  app.route("/", superadminContratosRoutes(deps));
  app.route("/", superadminZonaCfoRoutes(deps));
  app.route("/", superadminPrivacidadRoutes(deps));
  app.route("/", superadminSupresionRoutes(deps));
  app.route("/", superadminCerebroRoutes(deps));
  app.route("/", superadminCopilotoRoutes(deps));
  app.route("/", privacidadOrgRoutes(deps));
  app.route("/", notificationsRoutes(deps));
  app.route("/", billingRoutes(deps));
  app.route("/", restaurantesPublicRoutes(deps));
  app.route("/", restaurantesStorefrontRoutes(deps));
  // Vista previa al compartir: index.html con meta y JSON-LD de la organizacion/sucursal (vercel.json reescribe /pedir/:org[/:slug] aqui).
  app.route("/", restaurantesStorefrontMetaRoutes(deps));
  // R-19: widget de chat WhatsApp para demos (sin Meta), solo organizaciones marcadas como demo.
  app.route("/", restaurantesDemoWidgetRoutes(deps));
  app.route("/", demoAgentsRoutes(deps.publicDemoAgents));
  app.route("/", restaurantesVoiceToolsRoutes(deps));
  app.route("/", restaurantesWhatsAppRoutes(deps));
  app.route("/", restaurantesRoutes(deps));
  app.route("/", hotelesRoutes(deps));
  app.route("/", hotelesVoiceToolsRoutes(deps));
  app.route("/", hotelesWhatsAppRoutes(deps));
  app.route("/", hotelesCfdiWebhookRoutes(deps));
  app.route("/", citasRoutes(deps));
  app.route("/", licitacionesRoutes(deps));
  app.route("/", despachosRoutes(deps));
  app.route("/", rentasRoutes(deps));
  // Plataforma compartida (no de un vertical) — drena messaging_outbox de las 3
  // verticales de WhatsApp vía Graph API real, ver ese archivo para el detalle.
  app.route("/", whatsappDispatchRoutes(deps));
  // Resumen diario automático -- plataforma compartida (no de un vertical),
  // mismo criterio que whatsappDispatchRoutes de arriba.
  app.route("/", resumenDiarioRoutes(deps));
  // Automatizaciones seguras del back office de plataforma -- mismo criterio
  // que resumenDiarioRoutes de arriba.
  app.route("/", superadminMantenimientoRoutes(deps));
  // Foto mensual de ingreso + alertas proactivas del CFO -- mismo criterio.
  app.route("/", superadminAlertasCfoRoutes(deps));
  app.route("/", plataformaRetencionRoutes(deps));
  // Avisos de fin de prueba (PL-16) -- plataforma compartida; no esta en vercel.json (programarlo es una decision de despliegue).
  app.route("/", pruebaAvisosRoutes(deps));

  return app;
}
