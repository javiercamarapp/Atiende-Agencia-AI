// Cron `/internal/superadmin/alertas-cfo` (SA-36): toma la foto mensual de ingreso (base del NRR)
// y evalua las reglas proactivas del CFO -- margen bajo el umbral, voz sobre el tope del plan,
// cobranza vencida y cliente en riesgo -- para avisarlas por los canales de alertas (#227:
// correo / webhook / Sentry, con redaccion y piso por hora por tipo y destino). Envuelto en
// `withHeartbeat` (mismo patron que los otros handlers `/internal/*`).
//
// Reglas de seguridad y de compatibilidad:
//   * SOLO-SISTEMA: las dos lecturas/escrituras usan `withAppSession({ userId: null })`; cada una
//     abre SU PROPIA transaccion (la foto no comparte transaccion con la lectura de alertas), asi
//     que la degradacion a "base sin migrar" no deja ninguna transaccion abortada.
//   * Base sin migrar (0030 sin aplicar): responde 200 `ok:false, motivo: migracion_pendiente` y
//     NO ensucia el latido (el caso normal de "codigo nuevo, base vieja" no es un fallo del cron).
//   * NUNCA cambia un plan, un tope ni cobra nada: solo avisa. Una alerta es un resumen por regla
//     (con la lista de organizaciones), no un mensaje por organizacion.
//   * Sin despachador configurado (`deps.alertas` ausente) o sin canales, evalua y reporta pero no
//     envia nada; un canal roto no altera la respuesta (`notificar` nunca lanza y aqui ademas se
//     captura).
import { Hono } from "hono";
import { evaluarAlertasCfo } from "@atiende/billing";
import type { AlertaCfo } from "@atiende/billing";
import { Errors } from "../../errors.ts";
import { internalOrCronSecretMatches } from "../../http-security.ts";
import { logEvent } from "../../logger.ts";
import { withHeartbeat } from "../../salud/with-heartbeat.ts";
import { construirFilasCfo, tipoCambioDeFilas, UMBRAL_MARGEN_PCT_DEFAULT } from "../../cfo/filas.ts";
import type { AlertaSaliente } from "../../alertas/tipos.ts";
import type { AppDeps } from "../../deps.ts";

/** Path EXACTO usado tanto en `vercel.json::crons` como en `withHeartbeat`. */
export const SUPERADMIN_ALERTAS_CFO_CRON_PATH = "/internal/superadmin/alertas-cfo";

const MAX_ORGS_EN_DETALLE = 8;

/** Una alerta de dashboard -> una alerta saliente. El `tipo` es POR REGLA (no por organizacion): el
 *  piso por hora se cuenta por tipo y destino, y un id de organizacion dentro del tipo se redactaria. */
export function alertaCfoASaliente(a: AlertaCfo, mes: string): AlertaSaliente {
  const lista = a.organizaciones.slice(0, MAX_ORGS_EN_DETALLE).map((o) => `${o.nombre} (${o.dato})`);
  const resto = a.organizaciones.length - lista.length;
  return {
    tipo: `cfo:${a.codigo}`,
    severidad: a.severidad,
    titulo: `${a.titulo}: ${a.organizaciones.length}`,
    detalle: `${lista.join("; ")}${resto > 0 ? `; y ${resto} más` : ""}`,
    href: "/superadmin/cfo",
    contexto: { mes, organizaciones: a.organizaciones.length },
  };
}

export function superadminAlertasCfoRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], SUPERADMIN_ALERTAS_CFO_CRON_PATH, async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, SUPERADMIN_ALERTAS_CFO_CRON_PATH, async () => {
      const repo = deps.cfoRepo;
      if (!repo) {
        logEvent(c, "warn", "superadmin_alertas_cfo_migracion_pendiente");
        return c.json({ ok: false, motivo: "migracion_pendiente" });
      }
      const mes = new Date().toISOString().slice(0, 7);

      // Transaccion 1: la foto mensual (idempotente). Si la migracion falta, nada que deshacer.
      const foto = await deps.engine.withAppSession({ userId: null }, (db) => repo(db).snapshotForSystem());
      if (foto.availability === "not_migrated") {
        logEvent(c, "warn", "superadmin_alertas_cfo_migracion_pendiente");
        return c.json({ ok: false, motivo: "migracion_pendiente" });
      }

      // Transaccion 2: las entradas de las alertas.
      const entradas = await deps.engine.withAppSession({ userId: null }, (db) => repo(db).getAlertInputsForSystem(`${mes}-01`));
      if (entradas.availability === "not_migrated") {
        logEvent(c, "warn", "superadmin_alertas_cfo_migracion_pendiente");
        return c.json({ ok: false, motivo: "migracion_pendiente" });
      }

      const fx = tipoCambioDeFilas(entradas.rows);
      const filas = construirFilasCfo(entradas.rows, { umbralMargenPct: UMBRAL_MARGEN_PCT_DEFAULT, mxnPorUsd: fx?.mxnPorUsd ?? null });
      const alertas = evaluarAlertasCfo(filas, { umbralMargenPct: UMBRAL_MARGEN_PCT_DEFAULT, ahoraMs: Date.now() });

      let notificadas = 0;
      if (deps.alertas) {
        for (const a of alertas) {
          try {
            await deps.alertas.notificar(alertaCfoASaliente(a, mes));
            notificadas += 1;
          } catch {
            // best-effort: un canal roto no tumba el cron ni cambia la respuesta
          }
        }
      }
      if (alertas.length > 0) logEvent(c, "warn", "superadmin_alertas_cfo_con_alertas", { mes, alertas: alertas.length });

      return c.json({
        ok: true,
        mes,
        fotoFilas: foto.filas,
        sinTipoDeCambio: fx === null,
        alertas: alertas.map((a) => ({ codigo: a.codigo, severidad: a.severidad, organizaciones: a.organizaciones.length })),
        notificadas,
      });
    })();
  });

  return app;
}
