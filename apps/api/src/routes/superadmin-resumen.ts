// Back office de plataforma — RESUMEN DIARIO AUTOMÁTICO (segunda pieza del
// "cerebro" de backoffice, después de Salud operativa). Archivo NUEVO a
// propósito -- mismo criterio que el resto de `superadmin-*.ts`: cada
// concern de plataforma en su propio archivo, montado por separado en
// `app.ts`.
//
// Autorización real: `core.list_daily_ops_summaries_for_superadmin`/`core.
// get_daily_ops_summary_for_superadmin` YA verifican `auth.uid() =
// p_caller_id` + `core.is_platform_superadmin(p_caller_id)` por dentro -- el
// middleware de aquí (`requireSuperadmin`, MISMO patrón que el resto del
// back office) es defensa en profundidad. `POST .../generar` ejecuta el
// MISMO agregador que el cron (`../resumen-diario/agregador.ts::
// generarYPersistirResumenDiario`) -- nunca una segunda implementación del
// cálculo -- y corre bajo rate-limit de categoría "admin" (superficie de
// operador con privilegios elevados, mismo criterio que break-glass).
import { Hono } from "hono";
import { authMiddleware } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import type { DailyOpsSummaryRow } from "@atiende/db";
import { Errors } from "../errors.ts";
import { requestActor } from "../http-security.ts";
import { fechaAyerMexico } from "../resumen-diario/motor.ts";
import { generarYPersistirResumenDiario } from "../resumen-diario/agregador.ts";
import { enviarCorreoResumenDiarioSiCorresponde } from "../resumen-diario/correo.ts";
import type { AppDeps } from "../deps.ts";

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 365;

/** Categoría "admin" de `packages/core-ratelimit/src/endpoint-policy.ts` --
 *  MISMO criterio que `/superadmin/break-glass/*`: "generar ahora" dispara
 *  hasta 10 lecturas de fuente + potencialmente una llamada real al LLM, no
 *  debe poder golpearse en un loop accidental del frontend. */
const GENERAR_RATE_LIMIT = { max: 10, windowMs: 5 * 60_000 } as const;

function serializeResumen(r: DailyOpsSummaryRow) {
  return {
    fecha: r.fecha,
    agregados: r.agregados,
    narrativa: r.narrativa,
    generadoPor: r.generadoPor,
    costoLlmMicroUsd: r.costoLlmMicroUsd,
    modeloLlm: r.modeloLlm,
    proveedorLlm: r.proveedorLlm,
    creadoEn: r.creadoEn,
    actualizadoEn: r.actualizadoEn,
    correoEnviadoEn: r.correoEnviadoEn,
  };
}

export function superadminResumenRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/superadmin/resumen/*", authMiddleware(deps.env));
  app.use("/superadmin/resumen/*", async (c, next) => {
    if (!(await deps.coreRepo.isPlatformSuperadmin(c.get("userId")))) {
      throw Errors.forbidden("Este panel es exclusivo del back office de plataforma.");
    }
    await next();
  });

  app.get("/superadmin/resumen", async (c) => {
    const rawLimit = c.req.query("limit");
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== undefined) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1) throw Errors.validation("limit debe ser un entero >= 1.");
      limit = Math.min(parsed, MAX_LIMIT);
    }
    const resumenes = await deps.resumenDiarioRepo.listDailyOpsSummariesForSuperadmin(c.get("userId"), limit);
    return c.json({ resumenes: resumenes.map(serializeResumen) });
  });

  app.get("/superadmin/resumen/:fecha", async (c) => {
    const fecha = c.req.param("fecha");
    if (!FECHA_RE.test(fecha)) throw Errors.validation("fecha debe tener formato YYYY-MM-DD.");
    const resumen = await deps.resumenDiarioRepo.getDailyOpsSummaryForSuperadmin(c.get("userId"), fecha);
    if (!resumen) throw Errors.notFound(`No hay un resumen guardado para ${fecha}.`);
    return c.json({ resumen: serializeResumen(resumen) });
  });

  // "Generar ahora" -- ejecuta el MISMO agregador que el cron
  // (`/internal/superadmin/resumen-diario`), por defecto para el día
  // calendario anterior en America/Mexico_City (mismo criterio que el cron:
  // un "hoy" todavía en curso no es un día completo que resumir); acepta
  // `fecha` explícita en el body para regenerar un día concreto (idempotente,
  // ver `core.upsert_daily_ops_summary`).
  app.post("/superadmin/resumen/generar", async (c) => {
    const callerId = c.get("userId");
    const allowed = await rateLimit(`admin:resumen-diario:${requestActor(c.req.raw, callerId)}`, GENERAR_RATE_LIMIT.max, GENERAR_RATE_LIMIT.windowMs, { category: "admin" });
    if (!allowed) throw Errors.tooManyRequests("Demasiadas solicitudes de generación del resumen diario en poco tiempo.");

    const raw = (await c.req.json().catch(() => ({}))) as { readonly fecha?: unknown };
    const fecha = typeof raw.fecha === "string" && raw.fecha.length > 0 ? raw.fecha : fechaAyerMexico(new Date());
    if (!FECHA_RE.test(fecha)) throw Errors.validation("fecha debe tener formato YYYY-MM-DD.");

    const resultado = await generarYPersistirResumenDiario(deps, fecha);
    // Distinto criterio que el cron (`routes/internal/resumen-diario.ts`):
    // aquí SÍ hay un humano esperando la respuesta de un clic explícito
    // ("generar ahora"), así que un 503 honesto es lo coherente -- mismo
    // patrón ya usado para "Stripe no configurado" en
    // `superadmin-facturacion.ts` (ver su test "sin Stripe configurado
    // (503)"), nunca un 500 ni un 200 que finja que se generó algo.
    if (!resultado.ok) throw Errors.serviceUnavailable("El resumen diario automático todavía no está disponible en este entorno -- falta aplicar una migración pendiente.");
    const { agregados, narrativa, generadoPor } = resultado;
    // El correo NO es parte del contrato de "generar ahora" para el usuario
    // (nunca bloquea la respuesta ni la hace fallar) -- mismo criterio
    // best-effort que el resto del envío de correo de este backend; un
    // reintento manual el mismo día no reenvía (idempotente, ver `core.
    // mark_daily_ops_summary_email_sent`).
    const correo = await enviarCorreoResumenDiarioSiCorresponde(deps, fecha, agregados, narrativa).catch(() => ({ enviado: false, motivo: "error_envio" as const }));

    return c.json({ fecha, generadoPor, alertas: agregados.salud.alertas.length, correo: correo.motivo });
  });

  return app;
}
