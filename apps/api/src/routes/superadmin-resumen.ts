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
import { isMigrationPendingError } from "@atiende/db";
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

  // Hallazgo de auditoría (revisores del 19-sep, rubro A): la base Supabase
  // real NO tiene aplicada la migración del resumen diario
  // (`supabase/migrations/20240101000138_*`), así que
  // `deps.resumenDiarioRepo.listDailyOpsSummariesForSuperadmin`/`get
  // DailyOpsSummaryForSuperadmin` (`ProductionResumenDiarioRepository`, ver
  // su comentario de cabecera) lanzan con SQLSTATE 42883 (`core.list_daily_
  // ops_summaries_for_superadmin`/`core.get_daily_ops_summary_for_superadmin`
  // no existen todavía) -- sin este guard, estas 2 rutas daban 500 en vez de
  // un vacío honesto (`{ disponible: false }`, NUNCA ceros que parezcan
  // datos reales, mismo criterio que `POST /superadmin/resumen/generar` ya
  // usaba más abajo). El `try/catch` va AQUÍ, envolviendo la llamada COMPLETA
  // al repositorio -- cada una de las 2 lecturas abre su PROPIA transacción
  // nueva (`ProductionResumenDiarioRepository::listDailyOpsSummariesFor
  // Superadmin/getDailyOpsSummaryForSuperadmin`, `engine.withAppSession` por
  // llamada, ver su comentario de cabecera), así que este catch corre
  // DESPUÉS de que esa transacción YA terminó (con un `rollback;` limpio si
  // `fn()` lanzó, ver `managed-postgres-engine.ts::withAppSession`) -- NUNCA
  // dentro de ella, así que NO hace falta ningún SAVEPOINT (a diferencia de
  // un fallback que siguiera consultando DENTRO de una transacción
  // compartida ya abortada, ver la REGLA DURA de transacciones del repo).
  // `isMigrationPendingError` (endurecido, `@atiende/db`) distingue esto de
  // un `42883` real de "operator does not exist" (bug de tipos) -- ese caso
  // SIGUE propagándose como error real (nunca se confunde con "migración
  // pendiente").
  app.get("/superadmin/resumen", async (c) => {
    const rawLimit = c.req.query("limit");
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== undefined) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1) throw Errors.validation("limit debe ser un entero >= 1.");
      limit = Math.min(parsed, MAX_LIMIT);
    }
    let resumenes: readonly DailyOpsSummaryRow[];
    try {
      resumenes = await deps.resumenDiarioRepo.listDailyOpsSummariesForSuperadmin(c.get("userId"), limit);
    } catch (err) {
      if (!isMigrationPendingError(err, "core.list_daily_ops_summaries_for_superadmin")) throw err;
      return c.json({ disponible: false, resumenes: [] });
    }
    return c.json({ disponible: true, resumenes: resumenes.map(serializeResumen) });
  });

  app.get("/superadmin/resumen/:fecha", async (c) => {
    const fecha = c.req.param("fecha");
    if (!FECHA_RE.test(fecha)) throw Errors.validation("fecha debe tener formato YYYY-MM-DD.");
    let resumen: DailyOpsSummaryRow | null;
    try {
      resumen = await deps.resumenDiarioRepo.getDailyOpsSummaryForSuperadmin(c.get("userId"), fecha);
    } catch (err) {
      if (!isMigrationPendingError(err, "core.get_daily_ops_summary_for_superadmin")) throw err;
      // 200 honesto, NUNCA un 404 -- un 404 aquí afirmaría "se consultó y no
      // hay resumen para esa fecha", cuando en realidad no se pudo consultar
      // nada todavía.
      return c.json({ disponible: false, resumen: null });
    }
    if (!resumen) throw Errors.notFound(`No hay un resumen guardado para ${fecha}.`);
    return c.json({ disponible: true, resumen: serializeResumen(resumen) });
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
