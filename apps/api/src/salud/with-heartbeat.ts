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
// Por qué el registro SÍ se espera (`await`), nunca "fire and forget": una
// función serverless de Vercel puede congelarse/terminar justo después de
// responder (mismo problema documentado en
// `routes/internal/whatsapp-dispatch.ts::triggerInline` para el disparo
// inline de WhatsApp) -- una promesa no esperada podría nunca completar su
// escritura. Un UPSERT de una sola fila (`core.record_cron_heartbeat`) es
// rápido; esperarlo no agrega latencia significativa al cron real, y
// garantiza que el latido sobreviva pase lo que pase con la respuesta.
import type { AppDeps } from "../deps.ts";

const MAX_ERROR_LENGTH = 500;

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
    try {
      const response = await handler();
      await registrarLatidoBestEffort(deps, cronName, "ok", null, startedAt, new Date());
      return response;
    } catch (err) {
      await registrarLatidoBestEffort(deps, cronName, "error", truncarError(err), startedAt, new Date());
      throw err;
    }
  };
}
