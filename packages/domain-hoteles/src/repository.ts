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
