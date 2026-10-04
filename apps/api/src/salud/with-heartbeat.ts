// withHeartbeat -- envuelve el cuerpo real de un handler de cron `/internal/*`
// con el registro best-effort de su latido (`core.record_cron_heartbeat`, ver
// `packages/db/migrations/0014_superadmin_salud_operativa.sql`), aplicado de
// forma UNIFORME a los 17 handlers reales (ver cada `routes/verticals/*` y
// `routes/internal/whatsapp-dispatch.ts`).
//
// REGLA DURA (repetida en cada call site): el registro del latido es
// best-effort -- un fallo al escribir el latido JAMÁS debe tumbar ni alterar
// la respuesta del cron real. Si `handler` lanza, este wrapper registra el
// error y RELANZA exactamente la misma excepción, igual que si
// `withHeartbeat` no existiera -- ningún caller de las rutas de cron ve un
// comportamiento distinto por estar instrumentado.
//
// Bitacora de corridas (SA-L-07): ademas del latido, cada corrida real deja una fila en `core.agent_run`
// (`../agentes/corridas.ts::registrarCorridaBestEffort`) con estado ok | parcial | fallo y duracion; el error va
// redactado y a 500 caracteres o menos. Mismo contrato best-effort que el latido: una bitacora rota NUNCA tumba ni
// altera la corrida, y contra la base sin la 0044 se omite en silencio. Una pausa por interruptor NO es una corrida.
//
// Por qué el registro SÍ se espera (`await`), nunca "fire and forget": una
// función serverless de Vercel puede congelarse/terminar justo después de
// responder (mismo problema documentado en
// `routes/internal/whatsapp-dispatch.ts::triggerInline` para el disparo
// inline de WhatsApp) -- una promesa no esperada podría nunca completar su
// escritura. Un UPSERT de una sola fila (`core.record_cron_heartbeat`) es
// rápido; esperarlo no agrega latencia significativa al cron real, y
// garantiza que el latido sobreviva pase lo que pase con la respuesta.
//
// `CronPartialFailureError` (r4-fix-crons-transaccion-por-unidad) -- cierra el
// hallazgo de auditoría a1b #1/#2 punto (5): con el barrido corregido a
// "una transacción POR unidad" (property/organización, ver
// `../routes/verticals/hoteles/night-audit.ts` y hermanos), cada unidad que
// falla YA aísla su propio ROLLBACK real -- pero el handler HTTP seguía sin
// lanzar cuando `failures.length > 0` (el body ya reportaba `ok:false` con el
// detalle, pero nunca llegaba a `catch` de este wrapper), así que el latido
// quedaba "ok" limpio aunque una unidad real hubiera fallado -- el panel de
// salud no podía distinguir "corrió perfecto" de "corrió parcial". Un handler
// que YA construyó la `Response` de 200 con el detalle completo (failures[])
// la envuelve en este error en vez de devolverla directo; este wrapper
// registra el latido como "error" (con el mensaje del error, visible en el
// panel de salud) pero **devuelve la Response original al caller HTTP** --
// nunca un 500: Vercel Cron no debe reintentar un barrido que ya corrió (las
// unidades que sí funcionaron ya persistieron, aislado por unidad), solo el
// latido debe dejar de mentir.
import { emitirNotificacion } from "@atiende/db";
import { registrarCorridaBestEffort, verticalDeCron } from "../agentes/corridas.ts";
import type { AppDeps } from "../deps.ts";

const MAX_ERROR_LENGTH = 500;

export class CronPartialFailureError extends Error {
  constructor(
    message: string,
    readonly response: Response,
  ) {
    super(message);
    this.name = "CronPartialFailureError";
  }
}

function truncarError(err: unknown): string {
  const mensaje = err instanceof Error ? err.message : String(err);
  return mensaje.length > MAX_ERROR_LENGTH ? `${mensaje.slice(0, MAX_ERROR_LENGTH - 1)}…` : mensaje;
}

async function registrarLatidoBestEffort(deps: AppDeps, cronName: string, status: "ok" | "error", error: string | null, startedAt: Date, finishedAt: Date): Promise<void> {
  try {
    await deps.saludRepo.recordCronHeartbeat({
      cronName,
      status,
      error,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    });
  } catch (err) {
    // Best-effort real: el latido nunca debe tumbar el cron real. Se deja un
    // rastro en logs de proceso (no en `core.cron_heartbeat`, que es
    // justamente lo que falló) para que un fallo persistente de esta tabla
    // no sea del todo silencioso.
    console.error(`withHeartbeat: no se pudo registrar el latido de "${cronName}":`, err);
  }
}

/** Aviso saliente (correo/webhook/Sentry) de un cron que fallo. Best-effort: sin despachador
 *  configurado no hace nada y NUNCA lanza ni altera la respuesta del cron. El piso por hora por
 *  (tipo, destino) lo aplica el propio despachador, asi que un cron que falla cada minuto no
 *  inunda el buzon. */
async function notificarFalloCronBestEffort(deps: AppDeps, cronName: string, err: unknown): Promise<void> {
  if (!deps.alertas) return;
  try {
    await deps.alertas.notificar({
      tipo: `cron_error:${cronName}`,
      severidad: "alta",
      titulo: `Cron con error: ${cronName}`,
      detalle: truncarError(err),
      href: "/superadmin/salud/crons",
      contexto: { cron: cronName },
    });
  } catch (alertErr) {
    console.error(`withHeartbeat: no se pudo notificar el fallo de "${cronName}":`, alertErr instanceof Error ? alertErr.message : String(alertErr));
  }
}

/** Aviso in-app (campana de superadmin) de un cron que fallo: una por cron por dia (clave de dedupe), asi que
 *  un cron que falla cada minuto no inunda. Best-effort: NUNCA lanza ni altera la respuesta del cron, y
 *  contra la base sin la 0039 degrada en silencio. El texto solo lleva el nombre del cron (sin el error). */
async function notificarFalloCronEnAppBestEffort(deps: AppDeps, cronName: string): Promise<void> {
  try {
    const ruta = cronName.replace(/^\/(internal\/)?/, "").replace(/\//g, ".").replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 40);
    await deps.engine.withAppSession({ userId: null }, (db) =>
      emitirNotificacion(db, { evento: "superadmin.cron.fallo", organizationId: null, clave: `${ruta}:${new Date().toISOString().slice(0, 10)}`, parametros: { ruta } }),
    );
  } catch {
    // best-effort
  }
}

/**
 * `cronName` debe ser el path EXACTO tal como aparece en
 * `vercel.json::crons` (mismo criterio que
 * `./cadencia.ts::cadenciaMinutosPorRuta`, para que la cadencia esperada se
 * resuelva sin duplicar el dato en un segundo sitio).
 *
 * `handler` es un thunk sin argumentos (cada call site ya tiene `c` --el
 * `Context` de Hono-- disponible por closure, así que `withHeartbeat` no
 * necesita conocer el tipo exacto del contexto de cada ruta).
 */
export function withHeartbeat(deps: AppDeps, cronName: string, handler: () => Promise<Response>): () => Promise<Response> {
  return async () => {
    const startedAt = new Date();

    // Interruptor de plataforma (kill switch por cron o global): si el superadmin
    // detuvo este cron, el handler real NO corre. Responde 200 (Vercel Cron no
    // debe reintentar una pausa deliberada) con `skipped` explicito, y deja el
    // latido como `ok` con una nota visible -- la pausa no se esconde ni parece
    // un fallo. El guard es fail-open (ver platform-switches.ts): si no puede
    // leer los interruptores, el cron corre como siempre.
    if (deps.platformSwitchGuard) {
      let blockedBy: string | null = null;
      try {
        blockedBy = await deps.platformSwitchGuard.cronBlockedBy(cronName);
      } catch (err) {
        console.error(`withHeartbeat: no se pudo consultar el interruptor de "${cronName}" (se ejecuta el cron):`, err);
      }
      if (blockedBy) {
        await registrarLatidoBestEffort(deps, cronName, "ok", `pausado por interruptor de plataforma (${blockedBy})`, startedAt, new Date());
        return Response.json({ ok: true, skipped: "kill_switch", switch: blockedBy }, { status: 200 });
      }
    }

    try {
      const response = await handler();
      const finishedAt = new Date();
      // QA-restaurantes-R1-automatizacion-09: un cron fail-closed sin credencial/adaptador (softrestaurant-dispatch,
      // whatsapp-dispatch) responde 503 en cada corrida. No es un fallo del cron (no hay nada que correr): el latido
      // queda 'ok' CON NOTA visible en /superadmin/salud (como la pausa por interruptor) y no se registra corrida (no
      // corrio nada), en vez de aparentar una corrida sana sin nota. Los demas 5xx no cambian.
      if (response.status === 503) {
        await registrarLatidoBestEffort(deps, cronName, "ok", "no configurado: la ruta responde 503 (falta credencial o adaptador); no se ejecuto nada", startedAt, finishedAt);
        return response;
      }
      await registrarLatidoBestEffort(deps, cronName, "ok", null, startedAt, finishedAt);
      await registrarCorridaBestEffort(deps, { agente: cronName, vertical: verticalDeCron(cronName), disparo: "cron", estado: "ok", iniciadoEn: startedAt, terminadoEn: finishedAt });
      return response;
    } catch (err) {
      const finishedAt = new Date();
      await registrarLatidoBestEffort(deps, cronName, "error", truncarError(err), startedAt, finishedAt);
      await registrarCorridaBestEffort(deps, {
        agente: cronName,
        vertical: verticalDeCron(cronName),
        disparo: "cron",
        estado: err instanceof CronPartialFailureError ? "parcial" : "fallo",
        error: err,
        iniciadoEn: startedAt,
        terminadoEn: finishedAt,
      });
      await notificarFalloCronBestEffort(deps, cronName, err);
      await notificarFalloCronEnAppBestEffort(deps, cronName);
      // `CronPartialFailureError`: el handler YA construyó la Response real (200
      // + detalle de failures[]) -- se devuelve tal cual al caller HTTP, el
      // latido ya quedó registrado como "error" arriba (ver comentario de
      // cabecera). Cualquier otra excepción sigue relanzándose sin cambios.
      if (err instanceof CronPartialFailureError) return err.response;
      throw err;
    }
  };
}
