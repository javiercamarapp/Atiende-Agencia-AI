// Envío real de un job de correo del outbox vía Resend — `fetch` nativo (sin SDK),
// mismo patrón EXACTO que packages/domain-citas/src/email-dispatch.ts, sobre
// `HotelesRepository` en vez de `CitasRepository`.
//
// Fail-closed explícito: sin `RESEND_API_KEY` configurada, `sendEmailOutboxJob`
// SIEMPRE lanza — nunca finge éxito. `dispatchPendingEmailJobs` captura esa
// excepción y marca el job 'failed' (reintento con backoff vía
// `hoteles.claim_email_outbox_batch`, que solo reclama `attempts < 5`) o 'dead'
// tras agotar intentos — un correo JAMÁS se marca 'sent' sin que Resend en verdad
// lo haya aceptado.
import type { EmailOutboxJobRow, HotelesRepository } from "./repository.ts";

export const MAX_EMAIL_DISPATCH_ATTEMPTS = 5;

export interface ResendConfig {
  readonly apiKey: string | null;
  readonly from: string;
}

/**
 * Envía UN job real vía la API de Resend. Lanza explícito (nunca resuelve en
 * silencio) si: falta la API key de plataforma, o el payload no trae
 * to/subject/html reales, o Resend responde con error — `dispatchPendingEmailJobs`
 * es quien decide qué hacer con esa excepción (reintentar o marcar 'dead'), nunca
 * esta función.
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
      // que un reintento del outbox nunca duplique el correo. El id del job ya es
      // único y estable por fila.
      "Idempotency-Key": `outbox/${job.id}`,
    },
    body: JSON.stringify({ from: config.from, to: payload.to, subject: payload.subject, html: payload.html, text: typeof payload.text === "string" ? payload.text : undefined }),
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
}

function emptySummary(): EmailDispatchSummary {
  return { processed: 0, sent: 0, failed: 0, dead: 0, errors: [] };
}

/**
 * Reconciliación por lote — el cuerpo real de
 * `POST /internal/hoteles/email-dispatch` (ver apps/api): reclama hasta
 * `batchSize` jobs `channel='email'` pendientes/fallidos con `attempts < 5`
 * (`hoteles.claim_email_outbox_batch`), los envía uno por uno, y marca cada uno
 * 'sent' (éxito real de Resend), 'failed' (reintentable, si no agotó los
 * intentos) o 'dead' (agotó los 5 intentos — un humano debe revisarlo). Un job
 * con datos raros nunca tumba el lote completo de los demás.
 */
export async function dispatchPendingEmailJobs(
  repo: HotelesRepository,
  config: ResendConfig,
  opts: { readonly fetchImpl?: typeof fetch; readonly batchSize?: number } = {},
): Promise<EmailDispatchSummary> {
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
