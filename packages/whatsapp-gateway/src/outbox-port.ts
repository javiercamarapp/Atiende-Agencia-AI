// MessagingOutboxPort — el puerto genérico que las 3 verticales (citas/hoteles/
// restaurantes) implementan para que `WhatsAppOutboundDispatcher` (dispatcher.ts)
// pueda drenar CUALQUIERA de sus tres tablas `messaging_outbox` sin conocer el
// schema/SQL concreto de ninguna.
//
// DECISIÓN DE DISEÑO (ver hallazgo de la auditoría que originó este paquete): el
// shape de "un mensaje pendiente de envío" NO era consistente entre las 3
// verticales antes de este cambio — solo domain-citas traía una tabla
// `messaging_outbox` real (migrations/003), domain-hoteles/domain-restaurantes no
// tenían ningún concepto de outbox (la respuesta del turn handler solo se
// persistía en el historial de la conversación, nunca se encolaba para envío
// real). Este cambio agrega la MISMA tabla/función a los 3 dominios (ver
// migrations/007-008 de cada paquete) para que el shape sea honestamente
// consistente ahora — pero cada dominio sigue siendo dueño de su propio schema
// (organization_id vs. property_id como clave de partición difiere, hoteles
// parte por property), así que el punto de unificación real es este puerto TS,
// no una tabla compartida entre schemas de Postgres (eso violaría el aislamiento
// por vertical que el resto del monorepo ya establece).
export interface MessagingOutboxItem {
  readonly id: string;
  /** Cuántas veces YA se intentó entregar este mensaje antes de este intento
   *  (0 la primera vez que se reclama). */
  readonly attempts: number;
  /** Payload jsonb tal cual se encoló — el dispatcher lo valida (ver
   *  `dispatcher.ts::isValidWhatsAppPayload`) antes de tocar la red; un payload
   *  con forma inválida se marca `dead` de inmediato, nunca se reintenta a ciegas. */
  readonly payload: unknown;
}

export interface MessagingOutboxPort {
  /** Nombre corto de la vertical (`"citas"`/`"hoteles"`/`"restaurantes"`) — solo
   *  para logging/reporte agregado, el dispatcher no ramifica lógica por esto. */
  readonly label: string;

  /**
   * Reclama hasta `limit` mensajes pendientes de envío (`status = 'pending'` con
   * `next_attempt_at <= now()`, o `status = 'processing'` cuyo lease ya expiró —
   * mismo idioma de "claim con lease reclamable" que
   * `claim_whatsapp_message`/`whatsapp_conversation_leases` en las 3 verticales,
   * ver migrations/004 de hoteles y restaurantes). Atómico: dos corridas
   * concurrentes del job nunca reclaman el mismo mensaje dos veces.
   */
  claimBatch(limit: number, leaseSeconds: number): Promise<readonly MessagingOutboxItem[]>;

  /** Envío confirmado — `status = 'sent'`. Un mensaje en este estado nunca vuelve a
   *  ser elegible para `claimBatch`, sea cual sea el número de corridas futuras del
   *  job (la garantía de idempotencia central de este paquete). */
  markSent(id: string): Promise<void>;

  /** Falla reintentable, todavía dentro del tope de intentos — vuelve a
   *  `status = 'pending'` con `attempts = attempts` (el valor YA incrementado por
   *  el dispatcher, nunca relativo) y `next_attempt_at` en el futuro (backoff
   *  calculado por el dispatcher, ver `computeBackoffSeconds`). */
  markRetry(id: string, attempts: number, errorClass: string, nextAttemptAtIso: string): Promise<void>;

  /** Falla PERMANENTE — tope de intentos agotado, o un error no reintentable
   *  (payload inválido, error 4xx de negocio de Graph API). `status = 'dead'`: se
   *  queda ahí para inspección manual, nunca se reintenta solo, nunca bloquea el
   *  resto del batch. */
  markDead(id: string, attempts: number, errorClass: string): Promise<void>;
}
