// createCitasMessagingOutboxPort — adapta `CitasRepository`'s 4 métodos de
// messaging_outbox (migrations/007) al puerto genérico
// `@atiende/whatsapp-gateway::MessagingOutboxPort` que
// `WhatsAppOutboundDispatcher` consume. Puro adaptador estructural: ninguna
// lógica de negocio nueva vive aquí (backoff/tope de intentos son del
// dispatcher, no de este archivo) — ver README de @atiende/whatsapp-gateway para
// por qué el punto de unificación entre las 3 verticales es este puerto TS y no
// una tabla compartida.
import type { MessagingOutboxItem, MessagingOutboxPort } from "@atiende/whatsapp-gateway";
import { filtrarRecordatoriosDeCitasInactivas } from "../cita-activa.ts";
import type { CitasRepository } from "../repository.ts";

/** Motivo (`last_error`) con que se descarta el recordatorio de una cita que ya se cancelo o cerro. Sin reintento. */
export const RECORDATORIO_CITA_INACTIVA = "cita_inactiva";

export function createCitasMessagingOutboxPort(repo: CitasRepository): MessagingOutboxPort {
  return {
    label: "citas",
    async claimBatch(limit: number, leaseSeconds: number): Promise<readonly MessagingOutboxItem[]> {
      const reclamados = await repo.claimMessagingOutboxBatch(limit, leaseSeconds);
      // Un recordatorio que se quedo en el outbox (Meta caido, backoff...) NO se entrega si su cita ya se cancelo o cerro: se marca `dead`
      // con motivo `cita_inactiva` (el patron del dispatcher para "no enviar nunca") y el resto del lote sigue.
      // OJO: contra la base real esta lectura corre en sesion de sistema bajo una RLS solo de staff y no ve la cita (fail-open, se entrega); ver cita-activa.ts.
      const { entregables, descartados } = await filtrarRecordatoriosDeCitasInactivas(repo, reclamados);
      for (const id of descartados) {
        const original = reclamados.find((r) => r.id === id);
        await repo.markMessagingOutboxDead(id, (original?.attempts ?? 0) + 1, RECORDATORIO_CITA_INACTIVA);
      }
      return entregables;
    },
    async markSent(id: string): Promise<void> {
      await repo.markMessagingOutboxSent(id);
    },
    async markRetry(id: string, attempts: number, errorClass: string, nextAttemptAtIso: string): Promise<void> {
      await repo.markMessagingOutboxRetry(id, attempts, errorClass, nextAttemptAtIso);
    },
    async markDead(id: string, attempts: number, errorClass: string): Promise<void> {
      await repo.markMessagingOutboxDead(id, attempts, errorClass);
    },
  };
}
