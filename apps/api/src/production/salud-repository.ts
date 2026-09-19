// ProductionSaludRepository — adaptador real de `SaludRepository` (@atiende/db)
// para `deps.saludRepo`, consumido por `production/deps.ts`.
//
// MISMO patrón exacto que `ProductionLlmUsageRepository` (`./llm-usage-
// repository.ts`): `PostgresSaludRepository` exige un `TenantDbSession` ya
// abierto en su constructor — este wrapper abre una transacción NUEVA en
// CADA llamada. Dos sesiones DISTINTAS, mismo criterio que el resto del back
// office de plataforma (ver `packages/db/migrations/0011_superadmin_caller_
// binding.sql`):
//   - `recordCronHeartbeat` (sin `p_caller_id`, solo la invoca
//     `salud/with-heartbeat.ts::withHeartbeat`) abre sesión de SISTEMA
//     (`{ userId: null }`) — la función SQL exige `auth.uid() is null`.
//   - Las 3 lecturas `*ForSuperadmin` (con `callerId` explícito) abren
//     sesión COMO el caller autenticado (`{ userId: callerId }`) — las
//     funciones SQL exigen `auth.uid() = p_caller_id`.
import type { CronHeartbeatRow, LicitacionesFuenteRunRow, OutboxQueueHealthRow, RecordCronHeartbeatInput, SaludRepository } from "@atiende/db";
import { PostgresSaludRepository } from "@atiende/db";
import type { TenancyEngine } from "@atiende/core-tenancy";

export class ProductionSaludRepository implements SaludRepository {
  constructor(private readonly engine: TenancyEngine) {}

  recordCronHeartbeat(input: RecordCronHeartbeatInput): Promise<void> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresSaludRepository(session).recordCronHeartbeat(input));
  }

  listCronHeartbeatsForSuperadmin(callerId: string): Promise<readonly CronHeartbeatRow[]> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresSaludRepository(session).listCronHeartbeatsForSuperadmin(callerId));
  }

  getOutboxHealthForSuperadmin(callerId: string): Promise<readonly OutboxQueueHealthRow[]> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresSaludRepository(session).getOutboxHealthForSuperadmin(callerId));
  }

  listLicitacionesFuenteRunsForSuperadmin(callerId: string): Promise<readonly LicitacionesFuenteRunRow[]> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresSaludRepository(session).listLicitacionesFuenteRunsForSuperadmin(callerId));
  }
}
