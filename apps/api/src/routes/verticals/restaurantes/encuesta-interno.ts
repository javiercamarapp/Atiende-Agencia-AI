// R-41 -- POST/GET /internal/restaurantes/enviar-encuestas: barrido de envio de la encuesta post-entrega en TODAS las organizaciones
// (o en una con `?organizationId=`). Idempotente: una segunda llamada (o dos simultaneas) no duplica el WhatsApp de un pedido (la reserva
// es unica por pedido). NO es un cron de `vercel.json` (decision de costo): hoy lo dispara el boton "Enviar pendientes ahora" del panel
// (por organizacion) o quien llame este endpoint con el secreto; ver docs/CRONS.md. Mismo guard que el resto de rutas internas:
// `x-atiende-internal-secret` o `Authorization: Bearer <CRON_SECRET>`.
import { Hono } from "hono";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { ejecutarBarridoEncuestas } from "./encuesta-envio.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function restaurantesEncuestaInternoRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/restaurantes/enviar-encuestas", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();
    const org = c.req.query("organizationId");
    if (org !== undefined && !UUID_RE.test(org)) throw Errors.validation("organizationId debe ser un uuid.");
    const resultado = await ejecutarBarridoEncuestas(deps, org ?? null);
    if (!resultado) throw Errors.tooManyRequests();
    logEvent(c, "info", "restaurantes_encuestas_enviadas", {
      candidatas: resultado.candidatas,
      encoladas: resultado.encoladas,
      yaRegistradas: resultado.yaRegistradas,
      errores: resultado.errores,
      disponible: resultado.disponible,
    });
    return c.json({
      ok: resultado.errores === 0,
      status: resultado.disponible ? "ok" : "not_available",
      candidates: resultado.candidatas,
      enqueued: resultado.encoladas,
      alreadyRegistered: resultado.yaRegistradas,
      skipped: resultado.omitidas,
      errors: resultado.errores,
    });
  });

  return app;
}
