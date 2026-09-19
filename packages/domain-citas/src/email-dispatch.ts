// Envío real de un job de correo del outbox vía Resend — `fetch` nativo (sin
// SDK), port de
// citas-reservaciones/supabase/functions/_shared/email-dispatch-core.ts +
// messaging-dispatcher/index.ts (la parte de correo), sobre `CitasRepository` en
// vez de un cliente supabase-js crudo.
//
// Fail-closed explícito: sin `RESEND_API_KEY` configurada, `sendEmailOutboxJob`
// SIEMPRE lanza — nunca finge éxito. `dispatchPendingEmailJobs` captura esa
// excepción y marca el job 'failed' (reintento con backoff vía
// `citas.claim_email_outbox_batch`, que solo reclama `attempts < 5`) o 'dead'
// tras agotar intentos — un correo JAMÁS se marca 'sent' sin que Resend en
// verdad lo haya aceptado.
//
// Seguimiento del PR #166 (auditoría a2b, CRÍTICO) — ANTES de este fix,
// `dispatchPendingEmailJobs` llamaba `repo.claimEmailOutboxBatch(batchSize)`
// SIEMPRE, incluso sin `RESEND_API_KEY`: el claim es CROSS-TENANT (reclama de
// TODAS las organizaciones) y el claim mismo YA cuenta como un intento
// (`attempts += 1` dentro de la función SQL, ver su migración). Con
// producción sin la key configurada, cada invocación --el cron diario Y,
// desde #166, el drenado post-commit de CADA acción de staff-- quemaba un
// intento de CADA correo pendiente de CADA organización; 5 invocaciones
// bastaban para dejar todos los correos pendientes de la plataforma en
// 'dead' para siempre, sin que Resend jamás hubiera visto ninguno. Fix: sin
// `apiKey`, `dispatchPendingEmailJobs` devuelve `{ ...summary vacío,
// notConfigured: true }` de inmediato, SIN llamar al claim -- cero jobs
// reclamados, cero intentos quemados.
import type { CitasRepository, EmailOutboxJobRow } from "./repository.ts";

export const MAX_EMAIL_DISPATCH_ATTEMPTS = 5;

/** Timeout por request individual a Resend -- sin esto, un `fetch` colgado
 * (Resend caído a medias, red lenta) podía bloquear indefinidamente el
 * drenado post-commit que corre con `await` antes de que la respuesta HTTP
 * del staff se transmita (ver comentario de `dbSession` en
 * `packages/core-auth/src/middleware.ts`), acercando cada vez más el request
 * al límite de 30s de una función de Vercel. Bajado de 8s a 4s (no
 * bloqueante de revisión independiente PR #168): con INLINE_BATCH_SIZE=5
 * envíos secuenciales, el peor caso pasa de 40s (por encima del límite de
 * 30s de `vercel.json::functions.maxDuration`) a 20s -- sigue sin
 * garantizar por sí solo que el lote completo quede bajo 30s (ver
 * knownGaps del PR: falta un presupuesto global del lote), pero acota cada
 * intento individual y dispara el mismo camino de reintento/backoff que
 * cualquier otro fallo de Resend. */
export const RESEND_FETCH_TIMEOUT_MS = 4_000;

export interface ResendConfig {
  readonly apiKey: string | null;
  readonly from: string;
}

/**
 * Envía UN job real vía la API de Resend. Lanza explícito (nunca resuelve en
 * silencio) si: falta la API key de plataforma, o el payload no trae
 * to/subject/html reales, o Resend responde con error — `dispatchPendingEmailJobs`
 * es quien decide qué hacer con esa excepción (reintentar o marcar 'dead'), nunca
 * este función.
 */
export async function sendEmailOutboxJob(fetchImpl: typeof fetch, job: EmailOutboxJobRow, config: ResendConfig): Promise<void> {
  if (!config.apiKey) throw new Error("Resend API key unavailable");

  const payload = job.payload ?? {};
  if (typeof payload.to !== "string" || !payload.to) {
    throw new Error("Outbox job missing recipient email");
  }
  if (typeof payload.subject !== "string" || !payload.subject || typeof payload.html !== "string" || !payload.html) {
    throw new Error("Outbox job missing email content");
  }

  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      // Resend retiene idempotency keys 24h — cierra la ventana normal de "el
      // proveedor sí lo aceptó pero el worker murió antes de marcar 'sent'" para
      // que un reintento del outbox nunca duplique el correo. El id del job ya
      // es único y estable por fila (a diferencia del origen, este outbox no
      // tiene un `fence_token` separado — el id mismo cumple ese rol).
      "Idempotency-Key": `outbox/${job.id}`,
    },
    body: JSON.stringify({ from: config.from, to: payload.to, subject: payload.subject, html: payload.html, text: typeof payload.text === "string" ? payload.text : undefined }),
    signal: AbortSignal.timeout(RESEND_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend respondió ${response.status}: ${body}`);
  }
}

export interface EmailDispatchSummary {
  processed: number;
  sent: number;
  failed: number;
  dead: number;
  errors: { jobId: string; error: string }[];
  /** true cuando NO hay `RESEND_API_KEY` configurada -- `dispatchPendingEmailJobs`
   * devolvió esto de inmediato SIN llamar a `repo.claimEmailOutboxBatch` (ver
   * comentario de cabecera del archivo). Los crons `/internal/*\/email-dispatch`
   * usan este flag para responder 200 con un estado explícito "no configurado"
   * en vez de tratarlo como un fallo real -- pegar la API key nunca debe
   * encontrar el outbox ya vaciado de intentos. */
  notConfigured: boolean;
}

function emptySummary(): EmailDispatchSummary {
  return { processed: 0, sent: 0, failed: 0, dead: 0, errors: [], notConfigured: false };
}

/**
 * Reconciliación por lote — el cuerpo real de
 * `POST /internal/citas/email-dispatch` (ver apps/api): reclama hasta
 * `batchSize` jobs `channel='email'` pendientes/fallidos con `attempts < 5`
 * (`citas.claim_email_outbox_batch`), los envía uno por uno, y marca cada uno
 * 'sent' (éxito real de Resend), 'failed' (reintentable, si no agotó los
 * intentos) o 'dead' (agotó los 5 intentos — un humano debe revisarlo). Un job
 * con datos raros nunca tumba el lote completo de los demás.
 */
export async function dispatchPendingEmailJobs(repo: CitasRepository, config: ResendConfig, opts: { readonly fetchImpl?: typeof fetch; readonly batchSize?: number } = {}): Promise<EmailDispatchSummary> {
  // Fix a2b (CRÍTICO) -- ver comentario de cabecera: sin proveedor configurado
  // NUNCA se reclama el lote (cross-tenant, cuenta intento), pase lo que pase
  // con `batchSize`/`fetchImpl`.
  if (!config.apiKey) {
    return { ...emptySummary(), notConfigured: true };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const batchSize = opts.batchSize ?? 25;
  const summary = emptySummary();

  const jobs = await repo.claimEmailOutboxBatch(batchSize);
  summary.processed = jobs.length;

  for (const job of jobs) {
    try {
      await sendEmailOutboxJob(fetchImpl, job, config);
      await repo.completeEmailOutboxJob(job.id, "sent", null);
      summary.sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 500) : "email dispatch failed";
      summary.errors.push({ jobId: job.id, error: message });
      if (job.attempts >= MAX_EMAIL_DISPATCH_ATTEMPTS) {
        await repo.completeEmailOutboxJob(job.id, "dead", message);
        summary.dead += 1;
      } else {
        await repo.completeEmailOutboxJob(job.id, "failed", message);
        summary.failed += 1;
      }
    }
  }

  return summary;
}
