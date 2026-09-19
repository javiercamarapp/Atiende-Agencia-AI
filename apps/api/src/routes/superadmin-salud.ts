// Back office de plataforma — "Salud operativa": el superadmin hoy no tiene
// forma de saber si los 17 crons de `vercel.json` corrieron, si una cola de
// mensajería está atascada/con muertos, o si una fuente de licitaciones está
// caída (ver comentario de cabecera de
// `packages/db/migrations/0014_superadmin_salud_operativa.sql` para el hueco
// real que esto cierra). Archivo NUEVO a propósito — mismo criterio que
// `superadmin-integraciones.ts`/`superadmin-llm-usage.ts`/
// `superadmin-facturacion.ts`: cada concern de plataforma en su propio
// archivo, montado por separado en `app.ts`.
//
// Autorización real: las 3 funciones SQL que `deps.saludRepo` consume
// (`core.list_cron_heartbeats_for_superadmin`/etc.) YA verifican
// `auth.uid() = p_caller_id` + `core.is_platform_superadmin(p_caller_id)` por
// dentro -- el middleware de aquí (`requireSuperadmin`, MISMO patrón que el
// resto del back office) es defensa en profundidad (403 explícito en vez de
// arreglos vacíos silenciosos), nunca la única autoridad real.
//
// Cada lectura se envuelve en try/catch INDEPENDIENTE: un fallo en, p. ej.,
// `getOutboxHealthForSuperadmin` nunca debe tumbar la lectura de crons o de
// gasto de LLM -- se convierte en `null` para esa sección, que el motor puro
// (`../salud/motor.ts::calcularAlertas`) transforma en su propia alerta "no
// se pudo leer" (nunca en "todo bien").
import { Hono } from "hono";
import { authMiddleware } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { Errors } from "../errors.ts";
import { cadenciaMinutosPorRuta, rutasDeCronDeclaradas } from "../salud/cadencia.ts";
import { calcularAlertas, juzgarLatido, type CronConEstado, type CronHeartbeatRow, type LicitacionesFuenteRunRow, type OutboxQueueHealthRow } from "../salud/motor.ts";
import type { AppDeps } from "../deps.ts";

/** Combina los latidos reales con los paths DECLARADOS en `vercel.json`
 *  (`../salud/cadencia.ts`) -- un cron agregado a `vercel.json` que todavía
 *  no corrió ni una vez aparece igual, con `heartbeat: null` ->
 *  `estado: "sin_latido"` (nunca omitido del panel, nunca tratado como
 *  error). Un latido "huérfano" (cron_name que ya no está en vercel.json,
 *  p. ej. uno removido) también se incluye -- mejor mostrar de más que
 *  esconder un latido real. */
function construirEstadoCrons(heartbeats: readonly CronHeartbeatRow[], ahora: Date): CronConEstado[] {
  const cadencias = cadenciaMinutosPorRuta();
  const porNombre = new Map(heartbeats.map((h) => [h.cronName, h]));
  const nombres = new Set<string>([...rutasDeCronDeclaradas(), ...porNombre.keys()]);

  return [...nombres]
    .sort((a, b) => a.localeCompare(b))
    .map((cronName) => {
      const heartbeat = porNombre.get(cronName) ?? null;
      const cadenciaMin = cadencias[cronName] ?? 0;
      return { cronName, estado: juzgarLatido(heartbeat, cadenciaMin, ahora), heartbeat };
    });
}

async function leerCronsConEstado(deps: AppDeps, callerId: string): Promise<readonly CronConEstado[] | null> {
  try {
    const heartbeats = await deps.saludRepo.listCronHeartbeatsForSuperadmin(callerId);
    return construirEstadoCrons(heartbeats, new Date());
  } catch {
    return null;
  }
}

async function leerColas(deps: AppDeps, callerId: string): Promise<readonly OutboxQueueHealthRow[] | null> {
  try {
    return await deps.saludRepo.getOutboxHealthForSuperadmin(callerId);
  } catch {
    return null;
  }
}

async function leerLicitacionesFuentes(deps: AppDeps, callerId: string): Promise<readonly LicitacionesFuenteRunRow[] | null> {
  try {
    return await deps.saludRepo.listLicitacionesFuenteRunsForSuperadmin(callerId);
  } catch {
    return null;
  }
}

/** Gasto de LLM -- reutiliza `deps.llmUsageRepo` (ya expuesto en
 *  `superadmin-llm-usage.ts`), NUNCA se duplica esa lectura aquí. */
async function leerGastoLlm(deps: AppDeps, callerId: string) {
  try {
    return await deps.llmUsageRepo.getPlatformBudgetForSuperadmin(callerId);
  } catch {
    return null;
  }
}

export function superadminSaludRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/superadmin/salud", authMiddleware(deps.env));
  app.use("/superadmin/salud/*", authMiddleware(deps.env));
  app.use("/superadmin/salud", async (c, next) => {
    if (!(await deps.coreRepo.isPlatformSuperadmin(c.get("userId")))) {
      throw Errors.forbidden("Este panel es exclusivo del back office de plataforma.");
    }
    await next();
  });
  app.use("/superadmin/salud/*", async (c, next) => {
    if (!(await deps.coreRepo.isPlatformSuperadmin(c.get("userId")))) {
      throw Errors.forbidden("Este panel es exclusivo del back office de plataforma.");
    }
    await next();
  });

  app.get("/superadmin/salud", async (c) => {
    const callerId = c.get("userId");
    const [crons, colas, licitacionesFuentes, llmPlatformBudget] = await Promise.all([
      leerCronsConEstado(deps, callerId),
      leerColas(deps, callerId),
      leerLicitacionesFuentes(deps, callerId),
      leerGastoLlm(deps, callerId),
    ]);

    const alertas = calcularAlertas({ crons, colas, licitacionesFuentes, llmPlatformBudget });

    return c.json({
      alertas,
      resumen: {
        crons: crons === null ? null : { total: crons.length, ok: crons.filter((x) => x.estado === "ok").length, vencido: crons.filter((x) => x.estado === "vencido").length, sinLatido: crons.filter((x) => x.estado === "sin_latido").length, error: crons.filter((x) => x.estado === "error").length },
        colas: colas === null ? null : { total: colas.length, muertos: colas.reduce((sum, c2) => sum + c2.deadCount, 0), pendientes: colas.reduce((sum, c2) => sum + c2.pendingCount, 0) },
        licitacionesFuentes:
          licitacionesFuentes === null
            ? null
            : { total: licitacionesFuentes.length, conAlerta: licitacionesFuentes.filter((f) => f.state !== "ok" && f.state !== "not_configured").length },
      },
    });
  });

  // Las 3 rutas de detalle de abajo NO envuelven la lectura en try/catch --
  // a diferencia de `/superadmin/salud` (que degrada sección por sección
  // porque junta 4 lecturas independientes en una sola respuesta), aquí un
  // fallo real de lectura es simplemente un 500 (`app.onError` de app.ts),
  // igual que cualquier otra ruta de este backend.
  app.get("/superadmin/salud/crons", async (c) => {
    const callerId = c.get("userId");
    const heartbeats = await deps.saludRepo.listCronHeartbeatsForSuperadmin(callerId);
    return c.json({ crons: construirEstadoCrons(heartbeats, new Date()) });
  });

  app.get("/superadmin/salud/colas", async (c) => {
    const colas = await deps.saludRepo.getOutboxHealthForSuperadmin(c.get("userId"));
    return c.json({ colas });
  });

  app.get("/superadmin/salud/licitaciones-fuentes", async (c) => {
    const fuentes = await deps.saludRepo.listLicitacionesFuenteRunsForSuperadmin(c.get("userId"));
    return c.json({ fuentes });
  });

  return app;
}
