// ProductionSuperadminAccionesRepository — adaptador real de
// `SuperadminAccionesRepository` (@atiende/db) para `deps.accionesRepo`,
// consumido por `production/deps.ts`. MISMO patrón exacto que
// `ProductionSaludRepository`/`ProductionResumenDiarioRepository`:
// `PostgresSuperadminAccionesRepository` exige un `TenantDbSession` ya
// abierto en su constructor — este wrapper abre una transacción NUEVA en
// CADA llamada.
//
// Las dos automatizaciones abren sesión de SISTEMA (`{ userId: null }`) —
// las funciones SQL que consumen exigen `auth.uid() is null`. La máquina de
// estados del intent y las 4 lecturas `*ForSuperadmin` abren sesión COMO el
// caller (`{ userId: callerId }`) — las funciones SQL exigen `auth.uid() =
// p_caller_id`.
import type {
  AutomationActionLogRow,
  DesatascarOutboxResultRow,
  IntentTipo,
  MarcarProspectoResultRow,
  OutboxDeadMessageDetailRow,
  OutboxDeadMessageRow,
  OutboxQueueName,
  SuperadminAccionesRepository,
  SuperadminActionIntentRow,
} from "@atiende/db";
import { PostgresSuperadminAccionesRepository } from "@atiende/db";
import type { TenancyEngine } from "@atiende/core-tenancy";

export class ProductionSuperadminAccionesRepository implements SuperadminAccionesRepository {
  constructor(private readonly engine: TenancyEngine) {}

  desatascarOutboxColgadosForSystem(umbralMinutos: number): Promise<readonly DesatascarOutboxResultRow[]> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresSuperadminAccionesRepository(session).desatascarOutboxColgadosForSystem(umbralMinutos));
  }

  marcarProspectosSinMovimientoForSystem(umbralDias: number): Promise<readonly MarcarProspectoResultRow[]> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresSuperadminAccionesRepository(session).marcarProspectosSinMovimientoForSystem(umbralDias));
  }

  crearIntent(callerId: string, tipo: IntentTipo, payload: Record<string, unknown>, resumen: string, venceEnMinutos: number): Promise<SuperadminActionIntentRow> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresSuperadminAccionesRepository(session).crearIntent(callerId, tipo, payload, resumen, venceEnMinutos));
  }

  confirmarIntent(callerId: string, intentId: string): Promise<SuperadminActionIntentRow> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresSuperadminAccionesRepository(session).confirmarIntent(callerId, intentId));
  }

  cancelarIntent(callerId: string, intentId: string): Promise<SuperadminActionIntentRow> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresSuperadminAccionesRepository(session).cancelarIntent(callerId, intentId));
  }

  listIntentsForSuperadmin(callerId: string, limit: number): Promise<readonly SuperadminActionIntentRow[]> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresSuperadminAccionesRepository(session).listIntentsForSuperadmin(callerId, limit));
  }

  listAutomationActionLogForSuperadmin(callerId: string, limit: number): Promise<readonly AutomationActionLogRow[]> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresSuperadminAccionesRepository(session).listAutomationActionLogForSuperadmin(callerId, limit));
  }

  listOutboxMensajesMuertosForSuperadmin(callerId: string, limit: number): Promise<readonly OutboxDeadMessageRow[]> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresSuperadminAccionesRepository(session).listOutboxMensajesMuertosForSuperadmin(callerId, limit));
  }

  getOutboxDeadMessageForSuperadmin(callerId: string, queue: OutboxQueueName, mensajeId: string): Promise<OutboxDeadMessageDetailRow | null> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresSuperadminAccionesRepository(session).getOutboxDeadMessageForSuperadmin(callerId, queue, mensajeId));
  }
}
