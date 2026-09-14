// createHotelesMessagingOutboxPort — adapta `HotelesRepository`'s 4 métodos de
// messaging_outbox (migrations/008) al puerto genérico
// `@atiende/whatsapp-gateway::MessagingOutboxPort`. Ver
// packages/domain-citas/src/whatsapp/outbox-adapter.ts para el mismo patrón.
import type { MessagingOutboxItem, MessagingOutboxPort } from "@atiende/whatsapp-gateway";
import type { HotelesRepository } from "../repository.ts";

export function createHotelesMessagingOutboxPort(repo: HotelesRepository): MessagingOutboxPort {
  return {
    label: "hoteles",
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
