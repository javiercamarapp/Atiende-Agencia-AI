// Puerto de acceso a datos de domain-hoteles — mismo patrón dual de adaptador que
// domain-restaurantes/src/repository.ts: un puerto TS explícito, con un adaptador real
// en memoria (tests determinísticos) y un adaptador real de Postgres (sobre
// TenantDbSession, contra las migraciones de migrations/001-003). Ninguna función de
// negocio de las rutas de apps/api toca SQL directamente — todas pasan por aquí.
import type {
  ActiveHotelProperty,
  CancellationPolicyRecord,
  CfdiEmisionRecord,
  ConversationMessage,
  ContactoNoOperativoRecord,
  DiscountChargeForFraudScan,
  FnbOrderRecord,
  FolioRecord,
  FraudAlertRecord,
  FraudAlertStatus,
  GuestIdentity,
  HospedajeFiscalConfig,
  HotelOrganizationSummary,
  HousekeepingShiftRecord,
  MaintenanceTicketRecord,
  MaintenanceTicketStatus,
  NewCfdiEmisionInput,
  NewChargeInput,
  NewContactoNoOperativoInput,
  NewFnbOrderInput,
  NewFraudAlertInput,
  NewHousekeepingShiftInput,
  NewMaintenanceTicketInput,
  NewPaymentInput,
  NewReservationInput,
  NightAuditRunRecord,
  NightlyRateRecord,
  PropertySummary,
  ReopenedFolioChargeForFraudScan,
  ReservationRecord,
  TaxConfigRecord,
  VoiceAgentConfig,
  WhatsAppPropertyRoute,
} from "./types.ts";
import type { ReservationStatus } from "./reservationStateMachine.ts";

export interface IdempotencyParams {
  readonly organizationId: string;
  readonly scope: string;
  readonly key: string;
  readonly body: unknown;
}

export interface IdempotentResult<T> {
  readonly status: number;
  readonly body: T;
}

export interface HotelesRepository {
  // ---- Folios/cargos (flujo 1) ----
  findFolio(propertyId: string, folioId: string): Promise<FolioRecord | null>;
  listFoliosByReservation(propertyId: string, reservationId: string): Promise<readonly FolioRecord[]>;
  loadFolioGuestIdentity(reservationId: string): Promise<GuestIdentity>;
  /** true si `userId` pertenece al staff de `propertyId` con un rol administrativo
   *  (owner/gm) — usado para autorizar un descuento/identidad/cuenta-por-cobrar
   *  aplicado por OTRO actor (p.ej. frontdesk trae la autorización de un gm que no
   *  está logueado en esta sesión). Nunca confía en un id que venga del cuerpo de la
   *  solicitud sin verificarlo contra `core.membership`. */
  isAdminStaff(propertyId: string, userId: string): Promise<boolean>;
  loadTaxConfig(propertyId: string): Promise<TaxConfigRecord>;
  insertCharge(input: NewChargeInput): Promise<{ id: string; createdAt: string }>;
  findCharge(folioId: string, chargeId: string): Promise<
    | { id: string; description: string; amount: number; taxAmount: number; concept: NewChargeInput["concept"]; reversedBy: string | null }
    | null
  >;
  /** Marca el cargo original como reversado — equivalente a
   *  `hoteles.mark_charge_reversed()` (SECURITY DEFINER). Lanza si el cargo no existe
   *  o ya fue reversado. */
  markChargeReversed(chargeId: string, reversalChargeId: string): Promise<void>;
  insertPayment(input: NewPaymentInput): Promise<{ id: string; createdAt: string }>;
  createFolio(propertyId: string, organizationId: string, reservationId: string, label: string): Promise<{ id: string }>;
  closeFolio(folioId: string, reason: "saldo_cero" | "cuenta_por_cobrar", arApprovedBy: string | null): Promise<void>;

  /** Crea el folio PRIMARIO de una reserva la primera vez que se llama — idempotente
   *  (`ON CONFLICT (reservation_id) WHERE is_primary DO NOTHING`, mismo índice único
   *  parcial `folio_reservation_primary_idx` de migrations/001) y devuelve su id; si ya
   *  existía, devuelve el existente sin crear uno nuevo. Deliberadamente un método
   *  NUEVO y distinto de `createFolio` (que SIEMPRE crea un folio SECUNDARIO,
   *  `is_primary=false`, exclusivamente para split de folio) — `createFolio` no cambia
   *  ni de firma ni de comportamiento (diseño Fase 3 §3.3); este método resuelve el
   *  punto de unión real: el folio primario nace cuando la reserva llega a
   *  `confirmada` (diseño §1), y "si no existe, la ruta lo repara" (§1) es exactamente
   *  lo que la idempotencia de este método ya garantiza sin lógica adicional en la
   *  ruta HTTP. */
  ensurePrimaryFolio(propertyId: string, organizationId: string, reservationId: string): Promise<{ id: string }>;

  // ---- F&B (flujo 2) ----
  listFnbOrders(propertyId: string): Promise<readonly FnbOrderRecord[]>;
  findFnbOrder(propertyId: string, orderId: string): Promise<FnbOrderRecord | null>;
  insertFnbOrder(input: NewFnbOrderInput): Promise<FnbOrderRecord>;
  confirmFnbKitchen(propertyId: string, orderId: string, userId: string, note: string | null): Promise<FnbOrderRecord | null>;
  assureFnbSafety(propertyId: string, orderId: string, userId: string): Promise<FnbOrderRecord | null>;

  // ---- Quotes (flujo 3) — SOLO lectura, ninguna escritura de precio ----
  findRoomType(propertyId: string, roomTypeId: string): Promise<{ id: string } | null>;
  loadNightlyRates(propertyId: string, roomTypeId: string, checkInDate: string, checkOutDate: string): Promise<readonly NightlyRateRecord[]>;

  // ---- Idempotencia (transversal a folios y F&B) ----
  withIdempotency<T>(params: IdempotencyParams, run: () => Promise<IdempotentResult<T>>): Promise<IdempotentResult<T>>;

  // ---- Fase 2 — Server Tools de voz + agente de WhatsApp con LLM (§1-§3) ----

  /** Rate limiting genérico por scope+actorHash — mismo contrato que
   *  `RestaurantesRepository.consumeRateLimit` (diseño §4: portado, no
   *  reinventado; candidato futuro a promoción a paquete compartido). */
  consumeRateLimit(scope: string, actorHash: string, maxRequests: number, windowSeconds: number): Promise<boolean>;

  /** Config del secreto dedicado de voz de ESTA property (diseño §1/§5.1,
   *  aislamiento por tenant real, no secreto compartido de plataforma).
   *  `null` si la property nunca configuró su agente de voz. */
  findVoiceAgentConfig(propertyId: string): Promise<VoiceAgentConfig | null>;
  /** Crea o rota el secreto de voz de una property — único punto de escritura,
   *  usado por el endpoint de rotación autenticado (staff ADMIN_ROLES). */
  upsertVoiceAgentConfig(propertyId: string, organizationId: string, toolWebhookSecret: string, enabled: boolean): Promise<void>;

  /** Resuelve a qué property pertenece un `phone_number_id` de Meta Cloud API
   *  — `null` cuando el número no está configurado en la plataforma (el
   *  caller responde ack silencioso, nunca reintento). */
  resolvePropertyByPhoneNumberId(phoneNumberId: string): Promise<WhatsAppPropertyRoute | null>;
  claimWhatsAppMessage(propertyId: string, messageId: string, phoneHash: string): Promise<boolean>;
  claimWhatsAppConversation(propertyId: string, phoneHash: string, messageId: string, leaseSeconds: number): Promise<boolean>;
  appendWhatsAppUserMessageOnce(propertyId: string, phone: string, message: ConversationMessage): Promise<readonly ConversationMessage[]>;
  whatsappAppendTurn(
    propertyId: string,
    phone: string,
    newMessages: readonly ConversationMessage[],
    status: "active" | "completed" | "abandoned" | null,
    fnbOrderId: string | null,
  ): Promise<readonly ConversationMessage[]>;
  finishWhatsAppMessage(propertyId: string, messageId: string, phoneHash: string, status: "processed" | "failed", errorClass: string | null): Promise<void>;
  markInboundEventFailed(propertyId: string, messageId: string, errorClass: string): Promise<void>;

  /** `registrar_contacto_no_operativo` (voz y WhatsApp) — mismo rol que
   *  `registerCallbackRequest` de domain-restaurantes: deriva a un humano
   *  cualquier mensaje que NO sea una petición operativa de F&B (diseño §2.3). */
  insertContactoNoOperativo(input: NewContactoNoOperativoInput): Promise<ContactoNoOperativoRecord>;

  // ---- Fase 3 — máquina de estados de reservas (H02, diseño §3.3) ----

  /** Superficie mínima consultable (diseño §5: sin esto las otras 5 rutas son
   *  imposibles de probar/usar desde el front) — no enumerado explícitamente en la
   *  lista de firmas de §3.3, pero requerido literalmente por §5. */
  listReservations(propertyId: string): Promise<readonly ReservationRecord[]>;

  findReservation(propertyId: string, reservationId: string): Promise<ReservationRecord | null>;

  /** `POST crear` aterriza directo en `confirmada` (diseño §3.2: esta fase no expone
   *  `cotizada` por HTTP) y crea el folio primario en la MISMA operación lógica — mismo
   *  punto del ciclo de vida donde el origen lo hace (`toStatus === 'confirmada'`),
   *  aquí simplemente coincide con la creación porque se salta el paso intermedio. Si
   *  `input.idempotencyKey` ya existe para esta property, devuelve la reserva existente
   *  en vez de lanzar (mismo criterio idempotente que el `ON CONFLICT ... DO NOTHING`
   *  del folio primario en el origen). */
  insertReservation(input: NewReservationInput): Promise<ReservationRecord>;

  /** UPDATE atómico con guardia `WHERE status = ANY(fromStatuses)` — mismo patrón de
   *  "reclamo atómico" que ya usa el no-show del origen; devuelve `null` si la fila ya
   *  no estaba en ninguno de los estados esperados (reintento/doble-clic/carrera),
   *  NUNCA lanza por eso — el caller decide 409 vs no-op idempotente. No valida por su
   *  cuenta que `(from,to)` sea una transición declarada — eso es responsabilidad del
   *  caller vía `canTransition`/`canRolePerformTransition` de reservationStateMachine.ts
   *  ANTES de llamar este método (mismo reparto de responsabilidad que la RLS real: la
   *  tabla de transiciones es la autoridad final, esta guardia solo evita una carrera). */
  transitionReservation(
    propertyId: string,
    reservationId: string,
    fromStatuses: readonly ReservationStatus[],
    toStatus: ReservationStatus,
    actorUserId: string | null,
  ): Promise<ReservationRecord | null>;

  /** Cancelación con efectos secundarios propios (libera TODAS las noches restantes,
   *  registra penalización) — nunca se ejecuta a través de `transitionReservation`
   *  genérico (diseño §5: el endpoint genérico de transición excluye deliberadamente
   *  `cancelada`/`no_show`). `null` si la reserva ya no está en un estado cancelable. */
  cancelReservation(propertyId: string, reservationId: string, penaltyAmount: number, actorUserId: string | null): Promise<ReservationRecord | null>;

  /** Contraparte de `bookAvailability` — faltaba por completo en el paquete (diseño
   *  §2/§4-punto 4), se agrega en esta fase. `qty` siempre positivo; nunca deja
   *  `bookedRooms` negativo (`greatest(booked_rooms - qty, 0)`, mismo criterio que el
   *  origen). */
  releaseAvailability(propertyId: string, roomTypeId: string, date: string, qty: number): Promise<void>;

  /** Espejo de `hoteles.book_availability()` (ya existe como función SQL desde Fase 1,
   *  ver migrations/003_availability.sql) expuesto en el puerto de repositorio para que
   *  `POST crear` reserva pueda reservarlo noche por noche sin que la ruta HTTP hable
   *  SQL directamente. Lanza si no hay disponibilidad (mismo comportamiento que la
   *  función SQL real). */
  bookAvailability(propertyId: string, roomTypeId: string, date: string, qty: number): Promise<void>;

  /** `null` si la property nunca configuró una política de cancelación propia — el
   *  caller decide el default (mismo patrón que `findVoiceAgentConfig`). */
  loadReservationCancellationPolicy(propertyId: string): Promise<CancellationPolicyRecord | null>;

  /** Candidatas a no-show: reservas `confirmada` cuya fecha de check-in ya pasó
   *  respecto a `asOfDate` (o "hoy" si `asOfDate` es `null`) — el job de no-show
   *  reclama cada una atómicamente vía `transitionReservation` antes de aplicar
   *  efectos secundarios (mismo patrón de "lee candidatas, reclama una por una" que el
   *  origen documenta para evitar que dos corridas compitan sobre la MISMA fila). */
  findDueNoShowReservations(propertyId: string, asOfDate: string | null): Promise<readonly ReservationRecord[]>;

  // ---- Fase 5 — H16-014/REQ-REC-014: fraude interno ----

  /** Insumo de lectura del patrón 1 — TODOS los cargos `concept='descuento'` no
   *  reversados de la property (la reconciliación es independiente del camino feliz
   *  de folios.ts, ver fraude/deteccion.ts). */
  listDiscountChargesForFraudScan(propertyId: string): Promise<readonly DiscountChargeForFraudScan[]>;

  /** Insumo de lectura del patrón 2 — cargos cuyo `createdAt` es posterior al
   *  `closedAt` del folio al que pertenecen. */
  listReopenedFolioChargesForFraudScan(propertyId: string): Promise<readonly ReopenedFolioChargeForFraudScan[]>;

  /** Idempotente por `(propertyId, dedupeKey)` — un re-escaneo del mismo hallazgo
   *  NUNCA inserta una segunda fila; `isNew` distingue ambos casos para que el
   *  llamador decida si además despacha una notificación nueva. */
  recordFraudAlert(input: NewFraudAlertInput): Promise<{ record: FraudAlertRecord; isNew: boolean }>;
  listFraudAlerts(propertyId: string, filter?: { readonly status?: FraudAlertStatus }): Promise<readonly FraudAlertRecord[]>;
  findFraudAlert(propertyId: string, alertId: string): Promise<FraudAlertRecord | null>;
  /** Lanza `FraudAlertAlreadyResolvedError` si `status` ya no es "pendiente". */
  resolveFraudAlert(propertyId: string, alertId: string, resolvedBy: string, status: "confirmado" | "descartado", decisionNote: string | null): Promise<FraudAlertRecord>;

  // ---- Fase 5 — H5/REQ-BO-001/002: CFDI de hospedaje ----

  loadHospedajeFiscalConfig(propertyId: string): Promise<HospedajeFiscalConfig>;
  /** Cargos facturables del folio (excluida propina — el filtro real vive en
   *  `summarizeFacturableCharges()`, aquí solo se leen TODOS los cargos del folio,
   *  igual que `findFolio` ya hace para folios.ts). */
  listChargesForCfdi(folioId: string): Promise<readonly { concept: string; amount: number; taxAmount: number; stayDate: string | null; reversesChargeId: string | null }[]>;
  /** `null` si este folio todavía no tiene CFDI de tipo 'hospedaje' — idempotencia a
   *  nivel de aplicación (REQ-BO-002): a lo más UN CFDI de tipo 'hospedaje' por folio. */
  findCfdiEmisionByFolio(propertyId: string, folioId: string, tipo: "hospedaje"): Promise<CfdiEmisionRecord | null>;
  findCfdiEmisionByPayment(propertyId: string, paymentId: string): Promise<CfdiEmisionRecord | null>;
  insertCfdiEmision(input: NewCfdiEmisionInput): Promise<CfdiEmisionRecord>;
  findCfdiEmision(propertyId: string, cfdiId: string): Promise<CfdiEmisionRecord | null>;
  listCfdiEmisiones(propertyId: string, filter?: { readonly folioId?: string }): Promise<readonly CfdiEmisionRecord[]>;
  updateCfdiEmisionCancelacion(cfdiId: string, status: CfdiEmisionRecord["status"]): Promise<void>;

  // ---- Fase 7 — descubrimiento de organización/property para el panel web de staff ----

  /** `null` si no existe una organización de vertical 'hoteles' con ese slug — mismo
   *  contrato que `RestaurantesRepository.findOrganizationBySlug` (domain-restaurantes),
   *  ver types.ts::HotelOrganizationSummary para por qué existe. */
  findOrganizationBySlug(slug: string): Promise<HotelOrganizationSummary | null>;
  /** Properties ACTIVAS de una organización de hoteles — a diferencia de
   *  `listActiveHotelProperties()` (Fase 6, global, sin nombre, insumo del barrido
   *  interno), esta SÍ trae el nombre real y SÍ está acotada a una sola
   *  organización — insumo del selector de property del panel de staff. */
  listPropertiesForOrganization(organizationId: string): Promise<readonly PropertySummary[]>;

  // ---- Fase 6 — H5/REQ-REV-013: night audit propio ----

  /** Properties de hoteles activas -- insumo de la ruta interna de barrido
   *  (`POST /internal/hoteles/night-audit`), mismo patrón que
   *  `CitasRepository.listActiveOrganizations()`. */
  listActiveHotelProperties(): Promise<readonly ActiveHotelProperty[]>;

  /** Reservas "en casa" la noche de `businessDate` (check-in ya hecho, check-out
   *  todavía no) -- `folioId`/`nightlyPrice` en `null` cuando faltan (ver
   *  `night-audit/engine.ts::planNightlyHospedajeCharges`, nunca se inventa un dato
   *  faltante aquí). */
  listInHouseReservationsForNightAudit(
    propertyId: string,
    businessDate: string,
  ): Promise<readonly { reservationId: string; folioId: string | null; nightlyPrice: number | null }[]>;

  /** Postea el cargo de hospedaje de la noche -- idempotente vía el índice único
   *  parcial `charge_folio_stay_date_hospedaje_idx` (ya existente desde
   *  migrations/001): un segundo intento para el MISMO folio+noche nunca duplica el
   *  cargo, devuelve `isNew:false` con el cargo ya existente. */
  postNightlyHospedajeCharge(input: {
    readonly organizationId: string;
    readonly propertyId: string;
    readonly folioId: string;
    readonly businessDate: string;
    readonly netAmount: number;
    readonly taxAmount: number;
  }): Promise<{ id: string; createdAt: string; isNew: boolean }>;

  /** Reclama la corrida de `(propertyId, businessDate)` -- si ya existe (completada o
   *  en progreso), devuelve la fila existente en vez de crear una segunda (mismo
   *  criterio de idempotencia por índice único que `recordFraudAlert`, sin necesitar
   *  un advisory lock de Postgres: el índice único de la tabla ya serializa la
   *  carrera). */
  claimNightAuditRun(organizationId: string, propertyId: string, businessDate: string): Promise<NightAuditRunRecord>;

  /** Marca la corrida como completada con el resumen final -- SOLO si seguía
   *  `en_progreso` (guarda de estado, mismo criterio que
   *  `resolveFraudAlert`/`night_audit_finish` del origen: una corrida ya
   *  `completado` NUNCA se re-termina ni reemplaza su resumen). Devuelve la fila
   *  final (la que acaba de escribir, o la que ya existía si perdió la carrera). */
  finishNightAuditRun(runId: string, summary: Readonly<Record<string, unknown>>): Promise<NightAuditRunRecord>;

  findNightAuditRun(propertyId: string, businessDate: string): Promise<NightAuditRunRecord | null>;
  listNightAuditRuns(propertyId: string, limit?: number): Promise<readonly NightAuditRunRecord[]>;

  /** Resumen de caja del día -- cargos por concepto / pagos por método, agrupados por
   *  la FECHA DE NEGOCIO (hora local `timezone`, ver
   *  `night-audit/engine.ts::DEFAULT_PROPERTY_TIMEZONE`), nunca por `created_at::date`
   *  crudo en UTC del servidor (un cargo de las 23:00 hora local puede caer en el día
   *  calendario siguiente en UTC). */
  sumChargesByConceptForBusinessDate(propertyId: string, businessDate: string, timezone: string): Promise<Readonly<Record<string, number>>>;
  sumPaymentsByMethodForBusinessDate(propertyId: string, businessDate: string, timezone: string): Promise<Readonly<Record<string, number>>>;

  // ---- Fase 6 — REQ-HK-011: tickets de mantenimiento ----

  insertMaintenanceTicket(input: NewMaintenanceTicketInput): Promise<MaintenanceTicketRecord>;
  listMaintenanceTickets(propertyId: string, filter?: { readonly status?: MaintenanceTicketStatus }): Promise<readonly MaintenanceTicketRecord[]>;
  findMaintenanceTicket(propertyId: string, ticketId: string): Promise<MaintenanceTicketRecord | null>;
  /** Cierra el ticket con su costo real -- `null` si el ticket no existe o ya estaba
   *  cerrado/cancelado (el caller decide 404 vs 409). */
  closeMaintenanceTicket(
    propertyId: string,
    ticketId: string,
    input: { readonly actualCost: number; readonly resolutionNote: string | null },
  ): Promise<MaintenanceTicketRecord | null>;

  // ---- Fase 6 — REQ-HK-008: turnos de camaristas/lavandería ----

  /** Reemplaza TODOS los turnos publicados de `staffId` en el rango
   *  [`fromDate`,`toDate`] por `shifts` -- SIEMPRE se llama después de
   *  `assertTurnosLftPublishable()` (la ruta HTTP valida antes de invocar esto, este
   *  método nunca valida por su cuenta) para que solo la plantilla YA válida llegue a
   *  persistirse. */
  replaceHousekeepingShifts(
    propertyId: string,
    staffId: string,
    fromDate: string,
    toDate: string,
    shifts: readonly NewHousekeepingShiftInput[],
  ): Promise<readonly HousekeepingShiftRecord[]>;

  listHousekeepingShifts(propertyId: string, fromDate: string, toDate: string, staffId?: string): Promise<readonly HousekeepingShiftRecord[]>;

  // ---- Dispatcher real de messaging_outbox (migrations/008) — hoteles NO tenía
  // NINGÚN concepto de outbox antes de este cambio (a diferencia de citas, que ya
  // traía la tabla desde su Fase 1): `outcome.reply` del turn handler de WhatsApp
  // solo se guardaba en `whatsapp_conversations.messages`, nunca se encolaba para
  // envío real (ver @atiende/whatsapp-gateway/README.md). Partición por
  // PROPERTY (no organización) — mismo eje que el resto de tablas de WhatsApp de
  // este dominio, porque 1 número de WhatsApp = 1 property aquí. ----
  enqueueMessagingOutbox(propertyId: string, organizationId: string, channel: "whatsapp" | "email", eventType: string, dedupeKey: string, payload: unknown): Promise<void>;
  claimMessagingOutboxBatch(limit: number, leaseSeconds: number): Promise<readonly MessagingOutboxRow[]>;
  markMessagingOutboxSent(id: string): Promise<void>;
  markMessagingOutboxRetry(id: string, attempts: number, errorClass: string, nextAttemptAtIso: string): Promise<void>;
  markMessagingOutboxDead(id: string, attempts: number, errorClass: string): Promise<void>;
}

/** Fila de `hoteles.messaging_outbox` reclamada para despacho real — mismo shape
 * que `@atiende/domain-citas::MessagingOutboxRow` (ver
 * @atiende/whatsapp-gateway::MessagingOutboxPort, el puerto genérico que
 * `createHotelesMessagingOutboxPort` en whatsapp/outbox-adapter.ts implementa). */
export interface MessagingOutboxRow {
  readonly id: string;
  readonly attempts: number;
  readonly payload: unknown;
}

export type { FolioRecord, ChargeRecord, PaymentRecord, NewChargeInput, NewPaymentInput, FnbOrderRecord, NewFnbOrderInput, NightlyRateRecord, TaxConfigRecord, GuestIdentity } from "./types.ts";
export type { ConversationMessage, ContactoNoOperativoRecord, NewContactoNoOperativoInput, VoiceAgentConfig, WhatsAppPropertyRoute } from "./types.ts";
export type { ReservationRecord, NewReservationInput, CancellationPolicyRecord } from "./types.ts";
export type { FraudAlertRecord, FraudAlertStatus, NewFraudAlertInput, DiscountChargeForFraudScan, ReopenedFolioChargeForFraudScan } from "./types.ts";
export type { CfdiEmisionRecord, CfdiEmisionTipo, CfdiEmisionStatus, NewCfdiEmisionInput, HospedajeFiscalConfig } from "./types.ts";
export type { NightAuditRunRecord, NightAuditRunStatus, ActiveHotelProperty } from "./types.ts";
export type { HotelOrganizationSummary, PropertySummary } from "./types.ts";
export type {
  MaintenanceTicketRecord,
  MaintenanceTicketOrigin,
  MaintenanceTicketSeverity,
  MaintenanceTicketStatus,
  NewMaintenanceTicketInput,
  HousekeepingShiftRecord,
  NewHousekeepingShiftInput,
} from "./types.ts";
