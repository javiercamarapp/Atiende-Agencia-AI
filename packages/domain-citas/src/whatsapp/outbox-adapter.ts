// createCitasMessagingOutboxPort — adapta `CitasRepository`'s 4 métodos de
// messaging_outbox (migrations/007) al puerto genérico
// `@atiende/whatsapp-gateway::MessagingOutboxPort` que
// `WhatsAppOutboundDispatcher` consume. Puro adaptador estructural: ninguna
// lógica de negocio nueva vive aquí (backoff/tope de intentos son del
// dispatcher, no de este archivo) — ver README de @atiende/whatsapp-gateway para
// por qué el punto de unificación entre las 3 verticales es este puerto TS y no
// una tabla compartida.
import type { MessagingOutboxItem, MessagingOutboxPort } from "@atiende/whatsapp-gateway";
import type { CitasRepository } from "../repository.ts";

export function createCitasMessagingOutboxPort(repo: CitasRepository): MessagingOutboxPort {
  return {
    label: "citas",
    async claimBatch(limit: number, leaseSeconds: number): Promise<readonly MessagingOutboxItem[]> {
      return repo.claimMessagingOutboxBatch(limit, leaseSeconds);
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
