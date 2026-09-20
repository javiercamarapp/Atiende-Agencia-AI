// Puerto de acceso a datos de domain-hoteles — mismo patrón dual de adaptador que
// domain-restaurantes/src/repository.ts: un puerto TS explícito, con un adaptador real
// en memoria (tests determinísticos) y un adaptador real de Postgres (sobre
// TenantDbSession, contra las migraciones de migrations/001-003). Ninguna función de
// negocio de las rutas de apps/api toca SQL directamente — todas pasan por aquí.
import type {
  ActiveHotelProperty,
  AttendanceEventRecord,
  CancellationPolicyRecord,
  CfdiEmisionRecord,
  ConversationMessage,
  ContactoNoOperativoRecord,
  DiscountChargeForFraudScan,
  DueNoShowReservationForSystem,
  ExpenseEntryRecord,
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
  NewAttendanceEventInput,
  NewCfdiEmisionInput,
  NewChargeInput,
  NewContactoNoOperativoInput,
  NewExpenseEntryInput,
  NewFnbOrderInput,
  NewFraudAlertInput,
  NewGuestInput,
  NewHousekeepingShiftInput,
  NewMaintenanceTicketInput,
  NewPaymentInput,
  NewRatePlanRangeInput,
  NewReservationInput,
  NewRoomInput,
  NewRoomTypeInput,
  NewStaffScheduleInput,
  NewSystemNightAuditChargeInput,
  NewSystemNoShowApplicationInput,
  NightAuditRunRecord,
  NightlyRateRecord,
  PlExpenseByDateRow,
  PlOccupiedRoomNightsByDateRow,
  PlRevenueByDateRow,
  PropertySummary,
  ReopenedFolioChargeForFraudScan,
  ReservationRecord,
  RoomSummary,
  RoomTypeSummary,
  GuestSummary,
  StaffScheduleRecord,
  SystemNoShowApplicationResult,
  TaxConfigRecord,
  VoiceAgentConfig,
  WhatsAppPropertyRoute,
  RevenueGateRecord,
  RevenueBacktestRunRecord,
  NewRevenueBacktestRunInput,
  PricingRuleRecord,
  NewPricingRuleInput,
  LocalEventRecord,
  NewLocalEventInput,
  CompetitorRateRecord,
  NewCompetitorRateInput,
  RateRecommendationRecord,
  NewRateRecommendationInput,
  RateRecommendationStatus,
  GuestReviewRecord,
  NewGuestReviewInput,
  GuestReviewActionRecord,
  NewGuestReviewActionInput,
  GuestReviewActionStatus,
  GuestReviewResponseRecord,
  NewGuestReviewResponseInput,
} from "./types.ts";
import type { ReservationStatus } from "./reservationStateMachine.ts";
import type { RevenueGateState } from "./revenue/revenueEngineGate.ts";

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

/** Página de `listReservationsPage` -- mismo criterio de forma que
 * `CitasRepository::CustomerPage` (@atiende/domain-citas): `total` es el conteo
 * completo (no solo `items.length`), `nextOffset` es `null` cuando ya no queda
 * página siguiente. */
export interface ReservationPage {
  readonly items: readonly ReservationRecord[];
  readonly total: number;
  readonly nextOffset: number | null;
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

  // ---- Fix hallazgo ALTA — catálogos para el formulario de "crear reserva" del
  // panel de recepción (ver types.ts::RoomTypeSummary/GuestSummary). Ambos de solo
  // lectura, cualquier staff de la property (mismo criterio de acceso que
  // `listReservations`) -- la restricción fina de QUIÉN puede crear la reserva ya la
  // aplica `MANAGE_RESERVATIONS_ROLES` en la ruta de creación, no aquí. ----

  /** Catálogo completo de tipos de habitación configurados para la property —
   *  insumo directo del <select> de "tipo de habitación" al crear una reserva. */
  listRoomTypes(propertyId: string): Promise<readonly RoomTypeSummary[]>;

  /** Búsqueda de huéspedes YA REGISTRADOS de la property por nombre/email/teléfono
   *  (contains, insensible a mayúsculas) — insumo del autocomplete de "huésped" al
   *  crear una reserva. `query` `null`/vacío devuelve las primeras `limit` filas
   *  (orden alfabético) para poblar el autocomplete antes de que el staff escriba
   *  nada. */
  searchGuests(propertyId: string, query: string | null, limit?: number): Promise<readonly GuestSummary[]>;

  // ---- Fix hallazgo CRÍTICO ("Alta de organización/property/tipos-de-habitación/
  // tarifas/huéspedes imposible sin SQL directo") — alta REAL de catálogo desde el
  // producto. Ver migrations/018_admin_catalogo_alta.sql para el GRANT/policy que
  // habilita estos 6 métodos (antes solo SELECT). `NewRoomTypeInput`/`NewRoomInput`/
  // `NewRatePlanRangeInput`/`NewGuestInput`/`RoomSummary` en types.ts, ver el
  // comentario de cabecera ahí para por qué alta de ORGANIZACIÓN/PROPERTY queda
  // deliberadamente fuera de este cambio. ----

  /** Crea un tipo de habitación nuevo — `unique (property_id, name)` ya existe desde
   *  migrations/001, así que un nombre duplicado en la MISMA property lanza (el
   *  caller HTTP lo traduce a 409, mismo criterio que `StaffInviteInvalidError`). */
  insertRoomType(input: NewRoomTypeInput): Promise<RoomTypeSummary>;

  /** Habitaciones físicas (`hoteles.room`) de un tipo de habitación concreto —
   *  insumo del selector de "asignar habitación" al reservar. `roomTypeId` `null`
   *  trae TODAS las habitaciones de la property (insumo de un catálogo general,
   *  aunque el flujo real de asignación siempre filtra por tipo). */
  listRooms(propertyId: string, roomTypeId?: string | null): Promise<readonly RoomSummary[]>;

  findRoom(propertyId: string, roomId: string): Promise<RoomSummary | null>;

  /** Crea una habitación física nueva dentro de un tipo de habitación ya existente —
   *  `unique (property_id, code)` ya existe desde migrations/001 (un número de
   *  cuarto no se repite dentro de la misma property, sin importar el tipo), así que
   *  un código duplicado lanza (409, mismo criterio que `insertRoomType`). Nace
   *  siempre en `status = 'disponible'` (default de la columna). */
  insertRoom(input: NewRoomInput): Promise<RoomSummary>;

  /** Siembra/corrige tarifa real para un RANGO de fechas de un tipo de habitación —
   *  la pieza que de verdad bloqueaba `POST .../reservas` con `sin_tarifa`
   *  (quote.ts) cuando nadie había sembrado `hoteles.rate_plan` por SQL directo.
   *  `ON CONFLICT (room_type_id, date) DO UPDATE` (mismo índice único de
   *  migrations/001): un rango que traslapa fechas ya sembradas las SOBREESCRIBE,
   *  nunca falla por duplicado. Devuelve cuántas fechas se escribieron (para que la
   *  ruta HTTP confirme al staff "se sembraron N noches" en vez de un 200 opaco). */
  upsertRatePlanRange(input: NewRatePlanRangeInput): Promise<{ datesWritten: number }>;

  /** Alta de huésped nuevo — antes de este cambio `guestId` en `POST .../reservas`
   *  solo podía apuntar a un huésped YA sembrado por SQL directo (`searchGuests` era
   *  puramente de lectura); ahora recepción puede registrar uno real desde el
   *  formulario de "crear reserva". */
  insertGuest(input: NewGuestInput): Promise<GuestSummary>;

  /** Asigna una habitación FÍSICA concreta a una reserva ya existente — `null` si la
   *  reserva no existe en esta property (el caller HTTP valida ANTES que
   *  `room.roomTypeId === reservation.roomTypeId`, esta escritura no lo revalida por
   *  su cuenta, mismo reparto de responsabilidad que `transitionReservation`/
   *  `canTransition`). LIMITACIÓN DOCUMENTADA (ver types.ts::ReservationRecord.roomId):
   *  no valida traslape de fechas contra otra reserva que ya tenga asignada la MISMA
   *  habitación — la disponibilidad real sigue siendo por TIPO de habitación
   *  (`hoteles.availability`/`bookAvailability`), esta asignación es solo el número
   *  de cuarto comunicado al huésped/housekeeping, no una segunda fuente de verdad
   *  de disponibilidad. */
  assignRoomToReservation(propertyId: string, reservationId: string, roomId: string): Promise<ReservationRecord | null>;

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
  /** Versión PAGINADA de `listReservations`, para `GET /hoteles/:propertyId/reservas`
   * (el listado que el panel de recepción navega) -- hallazgo de auditoría (rubro 10,
   * "performance y escalabilidad", severidad BAJA: "listados sin paginación en 4
   * verticales"). Un hotel activo acumula miles de reservas a lo largo de los años;
   * la query ahora está acotada por `limit`/`offset` reales en vez de traer TODA la
   * tabla en un solo array. `listReservations` (arriba) se queda intacta -- hoy no
   * tiene otro consumidor, pero cambiar su contrato es una decisión distinta a
   * agregar el camino paginado que la ruta HTTP necesita. */
  listReservationsPage(propertyId: string, opts: { readonly limit: number; readonly offset: number }): Promise<ReservationPage>;

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
   *  origen documenta para evitar que dos corridas compitan sobre la MISMA fila).
   *  "hoy" (`asOfDate: null`) es el día de NEGOCIO (`@atiende/core-tenancy::
   *  hoyFechaNegocio()`), resuelto dentro de cada implementación -- nunca
   *  `current_date`/el reloj UTC crudo del proceso (bug real, ver comentario de
   *  cabecera de `PostgresHotelesRepository.findDueNoShowReservations`). */
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
  /**
   * Localiza + aplica la transición de estado de un evento de webhook ENTRANTE
   * del PAC (`apps/api/src/routes/verticals/hoteles/cfdi-webhook.ts`), por
   * `uuidFiscal` en vez de por `id`+`propertyId` — el PAC no manda sesión de
   * usuario ni `organizationId`/`propertyId`, así que ninguno de los otros
   * métodos de esta sección (todos requieren `propertyId`, protegidos por RLS de
   * `hoteles.can_access_money`) sirven aquí. `null` si el UUID fiscal no
   * corresponde a ningún CFDI conocido de esta plataforma — el llamador debe
   * responder 2xx sin reintento (nunca se debe hacer que el PAC reintente por
   * siempre un UUID que esta plataforma nunca va a reconocer).
   *
   * MISMA semántica de transición que `updateCfdiEmisionCancelacion`
   * (`canceledAt` solo se sella al ENTRAR a 'cancelado', nunca se vuelve a tocar
   * si ya estaba cancelado) — nunca una lógica paralela — lo que además hace que
   * reintentar el MISMO evento (mismo `status`) sea idempotente por diseño: un
   * segundo `applyCfdiWebhookStatus(uuid, 'cancelado')` no mueve `canceledAt` ni
   * ningún otro campo.
   */
  applyCfdiWebhookStatus(uuidFiscal: string, status: CfdiEmisionRecord["status"]): Promise<CfdiEmisionRecord | null>;

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

  // ---- Fase 6b — flujos de sistema de night-audit/no-show
  // (migrations/023_night_audit_sistema_escritura.sql). EXCLUSIVOS de
  // `apps/worker/src/jobs/hoteles/{night-audit,no-show}.ts` bajo `session: "sistema"`
  // (cableados SOLO en la ruta interna gateada por secreto,
  // `POST /internal/hoteles/night-audit`) -- el camino de staff (disparo manual de
  // night-audit, `POST .../reservas/procesar-no-show`) sigue usando los métodos
  // ORIGINALES de arriba, sin ningún cambio. `runNightAuditForProperty`/
  // `runNoShowSweep` (apps/worker) reciben `session: "staff" | "sistema"` y deciden en
  // tiempo de ejecución cuál juego de métodos invocar -- ver el header de la migración
  // 023 para el análisis completo de por qué (código COMPARTIDO entre ambos caminos,
  // tablas de dinero, ninguna policy de INSERT/UPDATE/DELETE de
  // reservation/folio/charge/payment se abre a sesión de sistema). ----

  /** Espejo system-only de `listInHouseReservationsForNightAudit` -- misma forma de
   *  retorno, respaldado por `hoteles.system_list_in_house_reservations_for_night_audit`
   *  (security definer, solo-sistema). */
  systemListInHouseReservationsForNightAudit(
    propertyId: string,
    businessDate: string,
  ): Promise<readonly { reservationId: string; folioId: string | null; nightlyPrice: number | null }[]>;

  /** Espejo system-only de `loadTaxConfig` -- lanza el MISMO error si la property no
   *  tiene `hoteles.tax_config` sembrado. Compartida por night-audit y no-show. */
  systemLoadTaxConfig(propertyId: string): Promise<TaxConfigRecord>;

  /** Espejo system-only de `sumChargesByConceptForBusinessDate`/
   *  `sumPaymentsByMethodForBusinessDate` -- insumo de
   *  `NightAuditSummary.cargosPorConcepto`/`pagosPorMetodo` bajo sesión de sistema. */
  systemSumChargesByConceptForBusinessDate(propertyId: string, businessDate: string, timezone: string): Promise<Readonly<Record<string, number>>>;
  systemSumPaymentsByMethodForBusinessDate(propertyId: string, businessDate: string, timezone: string): Promise<Readonly<Record<string, number>>>;

  /** Postea el cargo de hospedaje de la noche bajo sesión de sistema -- misma
   *  idempotencia que `postNightlyHospedajeCharge` (índice único parcial
   *  `charge_folio_stay_date_hospedaje_idx`), pero la función SQL detrás de este
   *  método ADEMÁS valida que `reservationId` pertenezca a `propertyId`/
   *  `organizationId` y esté en un estado que admite el cargo, y que `folioId` sea el
   *  folio PRIMARIO de esa reserva -- invariantes que la policy de staff resolvía vía
   *  RLS y que aquí debe validar la función misma (la sesión de sistema no tiene
   *  `auth.uid()`). */
  systemPostNightAuditCharge(input: NewSystemNightAuditChargeInput): Promise<{ id: string; createdAt: string; isNew: boolean }>;

  /** Candidatas a no-show, versión MÍNIMA system-only -- ver
   *  `DueNoShowReservationForSystem` (types.ts) para por qué expone solo 3 campos en
   *  vez del `ReservationRecord` completo que devuelve `findDueNoShowReservations`. */
  systemFindDueNoShowReservations(propertyId: string, asOfDate: string | null): Promise<readonly DueNoShowReservationForSystem[]>;

  /** Aplica no-show COMPLETO a una reserva bajo sesión de sistema -- transición
   *  'confirmada'->'no_show' (reclamo atómico, `null` si perdió la carrera) + libera
   *  disponibilidad de todas las noches + asegura folio primario + postea la
   *  penalización YA CALCULADA (`netAmount`/`taxAmount`, nunca recalculada aquí) --
   *  TODO en una sola operación atómica (a diferencia del camino de staff, que sigue
   *  siendo `transitionReservation`+`releaseAvailability`+`ensurePrimaryFolio`+
   *  `insertCharge` como 4 pasos separados, sin cambio). `null` si la reserva ya no
   *  estaba en 'confirmada' (carrera perdida, mismo criterio de no-op que
   *  `transitionReservation`). */
  systemApplyNoShow(input: NewSystemNoShowApplicationInput): Promise<SystemNoShowApplicationResult | null>;

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

  // ---- Fase 8 — REQ-BO-024 (LFT art.132 fr.XXXIV): checador de asistencia
  // inalterable + horario programado (staff_schedule). El caller (ruta HTTP) es
  // responsable de que `input.staffUserId` en `recordAttendanceEvent` SIEMPRE sea el
  // actor autenticado -- este puerto no lo revalida (la autoridad real de esa
  // invariante es la RLS `with check (staff_user_id = auth.uid())` de
  // migrations/010_checador_asistencia.sql, defensa en profundidad si un bug futuro
  // de la ruta la violara). `recordedAt` NUNCA lo decide el input: lo fija el
  // adaptador (`now()` real en Postgres, `new Date().toISOString()` en memoria).

  recordAttendanceEvent(input: NewAttendanceEventInput): Promise<AttendanceEventRecord>;
  /** Historial de fichaje de UN empleado, opcionalmente acotado a un rango de fechas
   *  de negocio (`recordedAt`, YYYY-MM-DD inclusive en ambos extremos). */
  listAttendanceEvents(
    propertyId: string,
    staffUserId: string,
    range?: { readonly fromDate: string; readonly toDate: string },
  ): Promise<readonly AttendanceEventRecord[]>;

  /** Crea o reemplaza el horario programado de `(propertyId, staffUserId, workDate)`
   *  -- un segundo upsert para la misma clave reemplaza el turno en vez de duplicarlo
   *  (mismo criterio que `replaceHousekeepingShifts`). El caller ya validó que
   *  `staffUserId` pertenece al staff de `propertyId` (ver ATTENDANCE_ADMIN_ROLES/
   *  roles.ts) -- este puerto no repite esa validación de membership. */
  upsertStaffSchedule(input: NewStaffScheduleInput): Promise<StaffScheduleRecord>;
  findStaffSchedule(propertyId: string, staffUserId: string, workDate: string): Promise<StaffScheduleRecord | null>;

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

  /** Re-revisión de PR #158 (r3, blocker) — `executeToolCall` (whatsapp/llm-turn-
   * handler.ts) corre DENTRO de la misma transacción de `withAppSession` que abre el
   * webhook completo (apps/api/src/production/deps.ts) y envuelve toda tool call en
   * un `try/catch` que traga CUALQUIER error, incluido un error real de Postgres
   * (una tool contra una función/tabla/columna que la migración pendiente todavía no
   * creó). Sin aislar cada tool call, ese error deja ABORTADA la transacción del
   * turno completo: hoy (sin la defensa del motor) el commit final se silencia a un
   * ROLLBACK y el huésped igual recibe su respuesta por WhatsApp; con la defensa
   * (`AbortedTransactionCommitError`, `managed-postgres-engine.ts`) ese mismo commit
   * LANZA, el webhook responde 500 a Meta, Meta reintenta sin tope y cada reintento
   * re-corre el turno LLM completo sin que el huésped reciba respuesta jamás. Mismo
   * patrón/mismo helper que `PostgresCitasRepository.runWithRowSavepoint`
   * (`@atiende/domain-citas`, ver su comentario de cabecera para el diseño completo
   * del helper): aísla el cuerpo de UNA tool call con un SAVEPOINT propio -- si
   * falla, `ROLLBACK TO SAVEPOINT` deja la transacción del turno utilizable de
   * nuevo (el commit final SÍ corre como `COMMIT` real) y el mismo error se
   * repropaga tal cual al `catch` de `executeToolCall`, que ya lo convierte en una
   * respuesta de error normal para el huésped -- nunca enmascara el fallo, solo
   * evita que tumbe el resto del turno. No-op en `InMemoryHotelesRepository` (sin
   * transacción real que aislar). */
  runWithRowSavepoint<T>(fn: () => Promise<T>): Promise<T>;

  // ---- Fase 12 — dispatcher real de correo (migrations/014) — hallazgo ALTA:
  // hoteles no enviaba NINGÚN correo/notificación al huésped, a diferencia de
  // citas/rentas/licitaciones/despachos. Acotado a channel='email' del mismo
  // `hoteles.messaging_outbox` de arriba — mismo patrón exacto que
  // `CitasRepository.claimEmailOutboxBatch`/`completeEmailOutboxJob`, nunca toca
  // una fila channel='whatsapp' (ver email-dispatch.ts). ----
  claimEmailOutboxBatch(limit: number): Promise<readonly EmailOutboxJobRow[]>;
  completeEmailOutboxJob(id: string, status: "sent" | "failed" | "dead", error: string | null): Promise<void>;

  // ---- Fase 12 — insumos de lectura para armar el correo real al huésped (ver
  // guest-email-notifications.ts): nombre/email del huésped ya ligado a la
  // reserva, nombre real de la property (para el saludo/asunto del correo) y
  // nombre real del tipo de habitación. Ninguno es nuevo conceptualmente
  // (`searchGuests`/`listRoomTypes`/`listPropertiesForOrganization` ya exponen
  // estos mismos datos) — son variantes de "un solo id conocido" que esos 3
  // listados no cubren. ----
  findGuestById(propertyId: string, guestId: string): Promise<GuestSummary | null>;
  findPropertyById(propertyId: string): Promise<{ readonly id: string; readonly name: string; readonly organizationId: string } | null>;
  findRoomTypeSummary(propertyId: string, roomTypeId: string): Promise<RoomTypeSummary | null>;

  // ---- Fase 10 (REQ-BO-010, P0) — back-office financiero: P&L USALI + punto de
  // equilibrio dinámico. El lado de INGRESOS reutiliza `hoteles.charge` (ya
  // existente, mismo motor de agregación por concepto/fecha de negocio que
  // `sumChargesByConceptForBusinessDate` ya construyó para night-audit, extendido
  // aquí a un RANGO de fechas + resolución de `reverses_charge_id` al departamento
  // del cargo original); el lado de GASTOS es NUEVO (`hoteles.expense_entry`,
  // migrations/012_pl_usali.sql), append-only. ----
  insertExpenseEntry(input: NewExpenseEntryInput): Promise<ExpenseEntryRecord>;
  listExpenseEntries(propertyId: string, desde: string, hasta: string): Promise<readonly ExpenseEntryRecord[]>;
  /** Ingreso por fecha+departamento USALI, ya resuelto (concept -> departamento,
   *  reversos netos contra el departamento del cargo ORIGINAL, 'propina' excluida)
   *  -- ver el mapeo completo documentado en migrations/012_pl_usali.sql. */
  loadRevenueByDepartmentAndDateForPl(propertyId: string, desde: string, hasta: string): Promise<readonly PlRevenueByDateRow[]>;
  loadExpensesByDepartmentAndDateForPl(propertyId: string, desde: string, hasta: string): Promise<readonly PlExpenseByDateRow[]>;
  /** Habitaciones-noche REALMENTE ocupadas y cobradas por fecha (`concept='hospedaje'`,
   *  `reversed_by is null`, agrupado por `stay_date`) -- la base real de ADR/RevPAR/
   *  ocupación del periodo, nunca la tarifa de rack. */
  loadOccupiedRoomNightsByDateForPl(propertyId: string, desde: string, hasta: string): Promise<readonly PlOccupiedRoomNightsByDateRow[]>;
  /** Suma de `hoteles.availability.total_rooms` del rango -- habitaciones-noche
   *  DISPONIBLES reales (inventario por fecha, nunca un conteo estático de
   *  `hoteles.room`; una property puede tener más de un `room_type` con distinto
   *  inventario por noche). */
  sumAvailableRoomNightsForDateRange(propertyId: string, desde: string, hasta: string): Promise<number>;

  // ---- Fase 9 (REQ-REV-003/004/005/007) — motor de revenue management: wiring de
  // `hoteles.revenue_engine_gate`/`hoteles.revenue_backtest_run` (migrations/
  // 011_revenue_engine_gate.sql). Gap real verificado antes de esta fase: la
  // migración/dominio puro (`revenue/revenueEngineGate.ts`) ya existían pero
  // `HotelesRepository` no tenía ningún método para ninguna de las dos tablas --
  // ver comentario de cabecera de `types.ts::RevenueGateRecord`. La autoridad real
  // de la máquina de estados sigue siendo el trigger de Postgres
  // (`revenue_engine_gate_transition_guard`), nunca esta capa. ----

  findRevenueGate(propertyId: string): Promise<RevenueGateRecord | null>;
  /** Idempotente (mismo criterio que `ensurePrimaryFolio`): si ya existe una fila
   *  para `propertyId`, la devuelve sin tocarla; si no, la crea en "shadow" (única
   *  entrada permitida por el trigger en un INSERT, ver migrations/011). */
  ensureRevenueGate(propertyId: string, organizationId: string, actorUserId: string): Promise<RevenueGateRecord>;
  /** Intenta la transición `to` sobre la fila YA existente -- el trigger de Postgres
   *  es quien de verdad decide si es válida (90 días en shadow, backtest vigente +
   *  aprobación de owner para autopilot, democión siempre permitida); esta capa solo
   *  ejecuta el UPDATE y deja que la excepción de Postgres se propague si el trigger
   *  la rechaza. La ruta HTTP debe validar con `evaluateGateTransition` ANTES de
   *  llamar aquí para devolver un 409 explicado -- este método nunca debe ser la
   *  primera línea de defensa. */
  updateRevenueGateState(propertyId: string, to: RevenueGateState, actorUserId: string): Promise<RevenueGateRecord>;
  /** Otorga (`granted: true`) o revoca (`granted: false`) la aprobación de "owner"
   *  para habilitar autopilot pleno (`owner_approved_autopilot_at`) -- el trigger
   *  reafirma que solo "owner" puede tocar esta columna
   *  (`hoteles.can_approve_revenue_autopilot`), esta capa no lo verifica de nuevo. */
  setRevenueGateOwnerApproval(propertyId: string, granted: boolean, actorUserId: string): Promise<RevenueGateRecord>;
  listRevenueBacktestRuns(propertyId: string): Promise<readonly RevenueBacktestRunRecord[]>;
  insertRevenueBacktestRun(input: NewRevenueBacktestRunInput): Promise<RevenueBacktestRunRecord>;

  // ---- Fase 10 — motor de recomendaciones de tarifa v1 (migrations/
  // 029_rate_recommendation_engine.sql). REGLA DURA DE COMPATIBILIDAD: toda
  // lectura degrada a un vacío honesto (lista vacía / null) si la migración aún no
  // está aplicada (42883/42P01/42703, vía `runWithSavepointFallback` +
  // `isMigrationPendingError`) -- ver `postgres-repository.ts` para el detalle. ----

  /** `null` si el room_type no tiene reglas configuradas -- el llamador (motor de
   *  cómputo) usa `DEFAULT_PRICING_RULES` en ese caso, nunca inventa un default
   *  distinto aquí. */
  findPricingRule(roomTypeId: string): Promise<PricingRuleRecord | null>;
  /** Upsert por `room_type_id` (unique de la migración) -- crea o reemplaza la
   *  configuración vigente, nunca acumula historial (a diferencia de
   *  local_event/competitor_rate, que SÍ son append-only). */
  upsertPricingRule(input: NewPricingRuleInput, actorUserId: string): Promise<PricingRuleRecord>;

  /** Eventos locales de `propertyId` cuyo rango [fechaInicio,fechaFin] se traslapa
   *  con [desde,hasta] -- el motor de cómputo solo necesita los relevantes a la
   *  fecha que está evaluando. */
  listLocalEvents(propertyId: string, desde: string, hasta: string): Promise<readonly LocalEventRecord[]>;
  insertLocalEvent(input: NewLocalEventInput, actorUserId: string): Promise<LocalEventRecord>;

  listCompetitorRates(propertyId: string, fecha: string): Promise<readonly CompetitorRateRecord[]>;
  insertCompetitorRate(input: NewCompetitorRateInput, actorUserId: string): Promise<CompetitorRateRecord>;

  /** Listado paginado con orden TOTAL (fecha desc, room_type_id, id) -- mismo
   *  criterio de paginación estable que `listAuditoria` de otras verticales.
   *  `beforeCursor` es el `(fecha, roomTypeId, id)` de la última fila de la página
   *  anterior (keyset, nunca OFFSET -- estable aunque se inserten filas nuevas
   *  entre páginas). */
  listRateRecommendations(
    propertyId: string,
    opts: { readonly estado?: RateRecommendationStatus; readonly limit: number; readonly beforeCursor?: { readonly fecha: string; readonly roomTypeId: string; readonly id: string } },
  ): Promise<readonly RateRecommendationRecord[]>;
  findRateRecommendation(id: string): Promise<RateRecommendationRecord | null>;
  /** SIEMPRE sesión de sistema (el cron de cómputo) -- el trigger real
   *  (`rate_recommendation_status_guard`) rechaza cualquier otro caller. */
  insertRateRecommendationAsSystem(input: NewRateRecommendationInput): Promise<RateRecommendationRecord>;
  /** Sesión de STAFF (owner/gm) -- solo cambia el estado a "aprobada"/"descartada".
   *  El trigger real exige que el gate esté en "propone" para aprobar (para
   *  descartar, cualquier gate). NUNCA escribe `hoteles.rate_plan` -- ver
   *  `applyRateRecommendationAsSystem`. */
  approveRateRecommendation(id: string, actorUserId: string): Promise<RateRecommendationRecord>;
  discardRateRecommendation(id: string, actorUserId: string): Promise<RateRecommendationRecord>;
  /** SIEMPRE sesión de sistema -- única vía que escribe la tarifa BAR real
   *  (`hoteles.system_apply_rate_recommendation`, security definer, solo-sistema).
   *  Ni siquiera owner/gm puede invocar esto directo -- ver comentario de cabecera
   *  de la migración 029. */
  applyRateRecommendationAsSystem(id: string): Promise<RateRecommendationRecord>;
  /** Recomendaciones "pendiente"/"aprobada" cuya `fecha` ya pasó -- candidatas a
   *  expirar (limpieza de sistema, ver cron). */
  listExpirableRateRecommendationsAsSystem(propertyId: string): Promise<readonly RateRecommendationRecord[]>;
  expireRateRecommendationAsSystem(id: string): Promise<RateRecommendationRecord>;

  // ---- Fase 11/13 (REQ-CRM-002/003) — reputación/CRM: wiring de
  // hoteles.guest_review/hoteles.guest_review_action (migrations/013_reputacion.sql)
  // + hoteles.guest_review_response (migrations/021_reputacion_respuestas.sql). Gap
  // real verificado antes de esta fase: el dominio puro (`reputacion/clasificador.ts`/
  // `indice.ts`) y el modelo de datos ya existían, pero `HotelesRepository` no tenía
  // ningún método para ninguna de las 3 tablas -- ninguna ruta HTTP podía
  // funcionar. ----

  insertGuestReview(input: NewGuestReviewInput): Promise<GuestReviewRecord>;
  listGuestReviews(propertyId: string, filter?: { readonly sentiment?: GuestReviewRecord["sentiment"] }): Promise<readonly GuestReviewRecord[]>;
  findGuestReview(propertyId: string, reviewId: string): Promise<GuestReviewRecord | null>;

  insertGuestReviewAction(input: NewGuestReviewActionInput): Promise<GuestReviewActionRecord>;
  listGuestReviewActions(propertyId: string, reviewId: string): Promise<readonly GuestReviewActionRecord[]>;
  findGuestReviewAction(propertyId: string, actionId: string): Promise<GuestReviewActionRecord | null>;
  /** Resuelve (marca ejecutada/descartada) una acción pendiente -- `ticketId` solo
   *  se persiste cuando `actionType === 'ticket_mantenimiento'` Y `status ===
   *  'ejecutada'` (el llamador ya creó el ticket real vía `insertMaintenanceTicket`
   *  antes de llamar aquí, ver reputacion.ts). Lanza si la acción no existe o ya
   *  fue resuelta (mismo criterio que `resolveFraudAlert`/
   *  `FraudAlertAlreadyResolvedError`). */
  resolveGuestReviewAction(
    propertyId: string,
    actionId: string,
    resolvedBy: string,
    status: Exclude<GuestReviewActionStatus, "pendiente">,
    ticketId: string | null,
  ): Promise<GuestReviewActionRecord>;

  insertGuestReviewResponse(input: NewGuestReviewResponseInput): Promise<GuestReviewResponseRecord>;
  listGuestReviewResponses(propertyId: string, reviewId: string): Promise<readonly GuestReviewResponseRecord[]>;
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

/** Fila de `hoteles.messaging_outbox` reclamada para despacho real de correo — mismo
 * shape que `@atiende/domain-citas::EmailOutboxJobRow` (ver email-dispatch.ts). A
 * diferencia de `MessagingOutboxRow` (el reclamo de WhatsApp, sin
 * propertyId/organizationId porque el dispatcher de WhatsApp real es un puerto
 * genérico de plataforma), este SÍ trae ambos porque `email-dispatch.ts` es
 * self-contained dentro de domain-hoteles. */
export interface EmailOutboxJobRow {
  readonly id: string;
  readonly propertyId: string;
  readonly organizationId: string;
  readonly attempts: number;
  readonly payload: Record<string, unknown>;
}

export type { FolioRecord, ChargeRecord, PaymentRecord, NewChargeInput, NewPaymentInput, FnbOrderRecord, NewFnbOrderInput, NightlyRateRecord, TaxConfigRecord, GuestIdentity } from "./types.ts";
export type { ExpenseEntryRecord, NewExpenseEntryInput, PlRevenueByDateRow, PlExpenseByDateRow, PlOccupiedRoomNightsByDateRow } from "./types.ts";
export type { ConversationMessage, ContactoNoOperativoRecord, NewContactoNoOperativoInput, VoiceAgentConfig, WhatsAppPropertyRoute } from "./types.ts";
export type { ReservationRecord, NewReservationInput, CancellationPolicyRecord } from "./types.ts";
export type { RoomTypeSummary, GuestSummary, RoomSummary, NewRoomTypeInput, NewRoomInput, NewRatePlanRangeInput, NewGuestInput } from "./types.ts";
export type { FraudAlertRecord, FraudAlertStatus, NewFraudAlertInput, DiscountChargeForFraudScan, ReopenedFolioChargeForFraudScan } from "./types.ts";
export type { CfdiEmisionRecord, CfdiEmisionTipo, CfdiEmisionStatus, NewCfdiEmisionInput, HospedajeFiscalConfig } from "./types.ts";
export type { NightAuditRunRecord, NightAuditRunStatus, ActiveHotelProperty } from "./types.ts";
export type {
  DueNoShowReservationForSystem,
  NewSystemNightAuditChargeInput,
  NewSystemNoShowApplicationInput,
  SystemNoShowApplicationResult,
} from "./types.ts";
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
export type {
  AttendanceEventType,
  AttendanceEventRecord,
  NewAttendanceEventInput,
  StaffScheduleRecord,
  NewStaffScheduleInput,
} from "./types.ts";
export type { RevenueGateRecord, RevenueBacktestRunRecord, NewRevenueBacktestRunInput } from "./types.ts";
export type {
  PricingRuleRecord,
  NewPricingRuleInput,
  LocalEventRecord,
  NewLocalEventInput,
  LocalEventImpacto,
  CompetitorRateRecord,
  NewCompetitorRateInput,
  RateRecommendationRecord,
  NewRateRecommendationInput,
  RateRecommendationStatus,
} from "./types.ts";
export type { GuestReviewResponseRecord, NewGuestReviewResponseInput } from "./types.ts";
