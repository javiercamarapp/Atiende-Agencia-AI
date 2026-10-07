import type {
  ConfirmDataRightsOutcome,
  DataRightStaffTargetStatus,
  DataRightType,
  DataRightsChannel,
  DataRightsEventRow,
  DataRightsPaginacion,
  DataRightsRequestsFiltro,
  DataRightsRequestsPage,
  RegisterDataRightsOutcome,
  UpdateDataRightsStatusResult,
} from "./data-rights.ts";
import type { PrivacyConfig, PrivacyConfigEntrada } from "./aviso.ts";

export interface PurgeOutcome {
  /** `false` cuando la migracion 030 no esta aplicada: no hay nada que purgar. */
  readonly disponible: boolean;
  readonly conversationsCleared: number;
  readonly voiceTurnsDeleted: number;
  /** Llamadas PROCESADAS del lote (con o sin `caller_hash`) desde la 046; antes solo contaba las que tenian hash. */
  readonly voiceCallsAnonymized: number;
  /** Desde la 046 (QA-restaurantes-R1-automatizacion-05): pedidos a los que se les vacio transcripcion/URL de grabacion. */
  readonly ordersVoiceCleared?: number;
  /** Desde la 046: filas de `messaging_outbox` terminadas cuyo payload (telefono y texto) se reemplazo. */
  readonly outboxPayloadsErased?: number;
  /** Desde la 046: avisos de la bandeja del staff cuyo texto (nombre del cliente) se reemplazo. */
  readonly staffNotificationsErased?: number;
}

export type UpdatePrivacyConfigResult = { readonly outcome: "updated" } | { readonly outcome: "forbidden" } | { readonly outcome: "unavailable" };

export type RecordingConsent = "otorgado" | "negado";

export type SetRecordingConsentResult =
  | { readonly outcome: "set"; readonly consent: RecordingConsent }
  | { readonly outcome: "unavailable" }
  | { readonly outcome: "rejected" };

/**
 * Puerto de persistencia de privacidad (migracion 030). Separado de `RestaurantesRepository` a
 * proposito: todo degrada de forma uniforme cuando la base no esta migrada (lecturas ->
 * `disponible: false`; escrituras de sistema -> `available: false`/`unavailable`), y nunca toca
 * el resto del dominio ni infla `postgres-repository.ts`.
 */
export interface PrivacidadRepository {
  /** Configuracion de privacidad de la organizacion; sin fila o base sin migrar -> valores por
   * defecto con `configurada: false` (nunca lanza). */
  getPrivacyConfig(organizationId: string): Promise<PrivacyConfig>;

  // ---- solo sistema (sesion sin usuario; las funciones SQL exigen `auth.uid() is null`) ----
  /** `true` solo la PRIMERA vez que esa version del aviso se entrega a ese telefono por ese canal;
   * `null` = la base no tiene la migracion 030 (el caller decide su alternativa). */
  claimPrivacyNotice(organizationId: string, phoneHash: string, channel: DataRightsChannel, version: string): Promise<boolean | null>;
  registerDataRightsRequestAsSystem(input: {
    readonly organizationId: string;
    readonly customerPhone: string;
    readonly rightType: DataRightType;
    readonly channel: DataRightsChannel;
    readonly detail: string | null;
  }): Promise<RegisterDataRightsOutcome>;
  resolveDataRightsConfirmationAsSystem(organizationId: string, customerPhone: string, confirm: boolean): Promise<ConfirmDataRightsOutcome>;
  setVoiceRecordingConsent(organizationId: string, conversationId: string, consent: RecordingConsent): Promise<SetRecordingConsentResult>;
  purgeExpiredPrivacyData(limit: number): Promise<PurgeOutcome>;

  // ---- staff owner/admin ----
  listDataRightsRequests(organizationId: string, filtro: DataRightsRequestsFiltro, paginacion: DataRightsPaginacion): Promise<DataRightsRequestsPage>;
  /** `null` = base sin migrar. */
  listDataRightsEvents(organizationId: string, requestId: string): Promise<readonly DataRightsEventRow[] | null>;
  updateDataRightsRequestStatus(organizationId: string, requestId: string, status: DataRightStaffTargetStatus, note: string | null): Promise<UpdateDataRightsStatusResult>;
  updatePrivacyConfig(organizationId: string, config: PrivacyConfigEntrada): Promise<UpdatePrivacyConfigResult>;
}
