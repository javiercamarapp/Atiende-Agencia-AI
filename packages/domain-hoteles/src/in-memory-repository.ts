// InMemoryHotelesRepository — implementación real (no un mock) de `HotelesRepository`,
// con las mismas restricciones de integridad/idempotencia que las migraciones SQL de
// migrations/001-002 (índice único parcial `charge_folio_stay_date_hospedaje_idx`,
// `idempotency_key` por (organizationId, scope, key) con detección de conflicto).
// Sirve para tests determinísticos y como fallback dev/CI sin Postgres real — mismo
// rol que InMemoryRestaurantesRepository.
import { createHash, randomUUID } from "node:crypto";
import type { HotelesRepository, IdempotencyParams, IdempotentResult, MessagingOutboxRow } from "./repository.ts";
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
  NewHousekeepingShiftInput,
  NewMaintenanceTicketInput,
  NewPaymentInput,
  NewReservationInput,
  NewStaffScheduleInput,
  NightAuditRunRecord,
  NightlyRateRecord,
  ChargeRecord,
  PaymentRecord,
  PlExpenseByDateRow,
  PlOccupiedRoomNightsByDateRow,
  PlRevenueByDateRow,
  PropertySummary,
  ReopenedFolioChargeForFraudScan,
  ReservationRecord,
  StaffScheduleRecord,
  TaxConfigRecord,
  VoiceAgentConfig,
  WhatsAppPropertyRoute,
} from "./types.ts";
import type { ReservationStatus } from "./reservationStateMachine.ts";
import { isCancellable } from "./reservationStateMachine.ts";
import { occupancyPct } from "./overbooking.ts";
import { FraudAlertAlreadyResolvedError, IdempotencyConflictError } from "./errors.ts";
import type { UsaliRevenueDepartment } from "./pl/usaliPL.ts";

/** Serializa operaciones por clave — equivalente en memoria de
 *  `pg_advisory_xact_lock`/row lock de Postgres. */
class KeyedMutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    this.chains.set(
      key,
      previous.then(() => gate),
    );
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

interface StoredFolio {
  id: string;
  organizationId: string;
  propertyId: string;
  reservationId: string;
  status: "abierto" | "cerrado";
  label: string;
  isPrimary: boolean;
  closedAt: string | null;
  closeReason: "saldo_cero" | "cuenta_por_cobrar" | null;
  arApprovedBy: string | null;
}

interface StoredCharge extends Omit<ChargeRecord, "reversedBy"> {
  organizationId: string;
  propertyId: string;
  stayDate: string | null;
  reversedBy: string | null;
}

interface StoredIdempotencyRow {
  requestHash: string;
  response: IdempotentResult<unknown> | null;
}

interface StoredStaffMember {
  propertyId: string;
  userId: string;
  isAdmin: boolean;
}

interface StoredWhatsAppEvent {
  status: "processing" | "processed" | "failed";
  attempts: number;
  claimedAt: number;
}

interface StoredLease {
  ownerMessageId: string;
  lockedUntil: number;
}

interface StoredConversation {
  messages: ConversationMessage[];
  status: "active" | "completed" | "abandoned";
  fnbOrderId: string | null;
}

/** Espejo en memoria de `hoteles.messaging_outbox` (migrations/008) — mismo
 * idioma de claim-con-lease-reclamable que `StoredWhatsAppEvent`/`StoredLease`. */
interface InMemoryOutboxRow {
  id: string;
  propertyId: string;
  organizationId: string;
  channel: "whatsapp" | "email";
  eventType: string;
  dedupeKey: string;
  payload: unknown;
  status: "pending" | "processing" | "sent" | "failed" | "dead";
  attempts: number;
  claimedAt: number | null;
  nextAttemptAt: number;
  lastErrorClass: string | null;
}

interface StoredReservation {
  id: string;
  organizationId: string;
  propertyId: string;
  roomTypeId: string;
  guestId: string | null;
  checkInDate: string;
  checkOutDate: string;
  status: ReservationStatus;
  totalAmount: number;
  cancellationPenaltyAmount: number | null;
  canceledAt: string | null;
  createdAt: string;
}

interface StoredRoomType {
  id: string;
  propertyId: string;
  maxOverbookRooms: number;
  overbookingOccupancyThresholdPct: number;
}

interface StoredAvailability {
  totalRooms: number;
  bookedRooms: number;
}

function hashBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

// Fase 10 (REQ-BO-010) — mismo mapeo concept -> departamento USALI documentado en
// migrations/012_pl_usali.sql, compartido por InMemoryHotelesRepository (aquí, en TS)
// y PostgresHotelesRepository (el `case` SQL equivalente) -- 'propina' se EXCLUYE
// (retorna null), 'reverso' NUNCA se pasa directo aquí (el llamador siempre resuelve
// primero al concept del cargo ORIGINAL vía `reversesChargeId`, ver
// `resolveRevenueDateAndDepartment` abajo).
function resolveRevenueDepartmentForConcept(concept: string): UsaliRevenueDepartment | null {
  switch (concept) {
    case "hospedaje":
      return "rooms";
    case "ab":
      return "food_beverage";
    case "extras":
    case "otro":
      return "otros_departamentos";
    case "ajuste":
    case "descuento":
      return "rooms";
    default:
      return null; // 'propina' (excluida) y cualquier concept no reconocido.
  }
}

export class InMemoryHotelesRepository implements HotelesRepository {
  private readonly folios = new Map<string, StoredFolio>();
  private readonly charges = new Map<string, StoredCharge>();
  private readonly payments = new Map<string, PaymentRecord & { propertyId: string }>();
  private readonly guestIdentityByReservation = new Map<string, GuestIdentity>();
  private readonly staff: StoredStaffMember[] = [];
  private readonly taxConfigByProperty = new Map<string, TaxConfigRecord>();
  private readonly fnbOrders = new Map<string, FnbOrderRecord & { propertyId: string; organizationId: string }>();
  private readonly roomTypes = new Map<string, StoredRoomType>();
  private readonly nightlyRates = new Map<string, NightlyRateRecord[]>(); // key: propertyId:roomTypeId
  private readonly idempotencyKeys = new Map<string, StoredIdempotencyRow>(); // key: organizationId:scope:key

  // ---- Fase 3 — máquina de estados de reservas (H02) ----
  private readonly reservations = new Map<string, StoredReservation>();
  private readonly reservationIdempotency = new Map<string, string>(); // key: propertyId:idempotencyKey -> reservationId
  private readonly availability = new Map<string, StoredAvailability>(); // key: propertyId:roomTypeId:date
  private readonly cancellationPolicies = new Map<string, CancellationPolicyRecord>(); // key: propertyId
  private readonly availabilityLock = new KeyedMutex();

  // ---- Fase 2 — voz/WhatsApp (§1-§3) ----
  private readonly rateLimits = new Map<string, { windowStartedAt: number; requestCount: number }>();
  private readonly voiceAgentConfigs = new Map<string, VoiceAgentConfig>(); // key: propertyId
  private readonly phoneNumberIdToProperty = new Map<string, WhatsAppPropertyRoute>();
  private readonly whatsappEvents = new Map<string, StoredWhatsAppEvent>();
  private readonly whatsappLeases = new Map<string, StoredLease>();
  private readonly whatsappConversations = new Map<string, StoredConversation>(); // key: propertyId:phone
  private readonly contactosNoOperativos = new Map<string, ContactoNoOperativoRecord>();
  private readonly outbox = new Map<string, InMemoryOutboxRow>();

  // ---- Fase 5 — H16-014/REQ-REC-014 fraude interno + H5 CFDI de hospedaje ----
  private readonly fraudAlerts = new Map<string, FraudAlertRecord>();
  private readonly hospedajeFiscalConfigByProperty = new Map<string, HospedajeFiscalConfig>();
  private readonly cfdiEmisiones = new Map<string, CfdiEmisionRecord>();

  // ---- Fase 6 — H5/REQ-REV-013 night audit + REQ-HK-008/011 housekeeping ----
  private readonly activeHotelProperties = new Map<string, ActiveHotelProperty>(); // key: propertyId
  private readonly nightAuditRuns = new Map<string, NightAuditRunRecord>(); // key: propertyId:businessDate
  private readonly maintenanceTickets = new Map<string, MaintenanceTicketRecord>();
  private readonly housekeepingShifts = new Map<string, HousekeepingShiftRecord>();

  // ---- Fase 8 — REQ-BO-024 checador de asistencia inalterable ----
  private readonly attendanceEvents = new Map<string, AttendanceEventRecord>();
  private readonly staffSchedules = new Map<string, StaffScheduleRecord>(); // key: propertyId:staffUserId:workDate

  // ---- Fase 10 — REQ-BO-010 back-office financiero: P&L USALI + punto de
  // equilibrio dinámico (lado de gastos, append-only). ----
  private readonly expenseEntries = new Map<string, ExpenseEntryRecord>();

  // ---- Fase 7 — descubrimiento de organización/property para el panel web de staff
  // (espejo de solo-lectura de `core.organization`/`core.property`, ver
  // types.ts::HotelOrganizationSummary — mismo patrón de duplicación deliberada que
  // `InMemoryRestaurantesRepository.organizations`, necesario porque este adaptador
  // en memoria no comparte almacenamiento con `InMemoryCoreRepository`/
  // `InMemoryTenancyEngine`; el adaptador de Postgres real (postgres-repository.ts)
  // no duplica nada, consulta `core.organization`/`core.property` directo). ----
  private readonly organizations = new Map<string, HotelOrganizationSummary>(); // key: organizationId
  private readonly properties = new Map<string, PropertySummary & { organizationId: string }>(); // key: propertyId

  private readonly idempotencyLock = new KeyedMutex();
  private readonly whatsappLock = new KeyedMutex();
  private readonly fraudAlertLock = new KeyedMutex();
  private readonly cfdiLock = new KeyedMutex();
  private readonly nightAuditRunLock = new KeyedMutex();

  // ---- seeding (equivalente a INSERT manual contra las migraciones SQL) ----

  /** Equivalente en memoria de `insert into hoteles.whatsapp_channel_config(...)`
   *  — asocia el `phone_number_id` real de Meta Cloud API con la property
   *  dueña del canal (diseño §2.1/§2.2: en hoteles, 1 número = 1 property, sin
   *  necesidad de resolver sucursal como en restaurantes). */
  seedWhatsAppChannel(propertyId: string, organizationId: string, phoneNumberId: string): void {
    this.phoneNumberIdToProperty.set(phoneNumberId, { propertyId, organizationId });
  }

  /** Equivalente en memoria de `insert into hoteles.voice_agent_config(...)`. */
  seedVoiceAgentConfig(config: VoiceAgentConfig): void {
    this.voiceAgentConfigs.set(config.propertyId, config);
  }

  seedFolio(folio: StoredFolio): void {
    this.folios.set(folio.id, folio);
  }

  seedGuestIdentity(reservationId: string, identity: GuestIdentity): void {
    this.guestIdentityByReservation.set(reservationId, identity);
  }

  seedStaff(entry: StoredStaffMember): void {
    this.staff.push(entry);
  }

  seedTaxConfig(propertyId: string, config: TaxConfigRecord): void {
    this.taxConfigByProperty.set(propertyId, config);
  }

  /** Equivalente en memoria de `insert into hoteles.tax_config(...)` para las
   *  columnas específicas de CFDI de hospedaje (Fase 5) — ver comentario de
   *  `HospedajeFiscalConfig` en types.ts sobre por qué es un seed/tipo separado de
   *  `seedTaxConfig`. */
  seedHospedajeFiscalConfig(propertyId: string, config: HospedajeFiscalConfig): void {
    this.hospedajeFiscalConfigByProperty.set(propertyId, config);
  }

  /** Fase 6 — equivalente en memoria de `core.organization`/`core.property` con
   *  `vertical='hoteles'`/`status='active'` -- insumo de
   *  `listActiveHotelProperties()` (ruta interna de barrido de night-audit, mismo
   *  patrón que `InMemoryCitasRepository`'s organizaciones activas). */
  seedActiveHotelProperty(organizationId: string, propertyId: string): void {
    this.activeHotelProperties.set(propertyId, { organizationId, propertyId });
  }

  /** Fase 7 — equivalente en memoria de una fila de `core.organization` con
   *  `vertical='hoteles'`, insumo de `findOrganizationBySlug()`. */
  seedOrganization(org: HotelOrganizationSummary): void {
    this.organizations.set(org.id, org);
  }

  /** Fase 7 — equivalente en memoria de una fila de `core.property` con
   *  `status='active'`, insumo de `listPropertiesForOrganization()`. */
  seedPropertySummary(organizationId: string, property: PropertySummary): void {
    this.properties.set(property.propertyId, { ...property, organizationId });
  }

  seedRoomType(
    propertyId: string,
    roomTypeId: string,
    overbooking?: { maxOverbookRooms?: number; overbookingOccupancyThresholdPct?: number },
  ): void {
    this.roomTypes.set(roomTypeId, {
      id: roomTypeId,
      propertyId,
      // Mismos defaults que `hoteles.room_type` en migrations/003_availability.sql.
      maxOverbookRooms: overbooking?.maxOverbookRooms ?? 0,
      overbookingOccupancyThresholdPct: overbooking?.overbookingOccupancyThresholdPct ?? 95,
    });
  }

  seedNightlyRates(propertyId: string, roomTypeId: string, rates: readonly NightlyRateRecord[]): void {
    this.nightlyRates.set(`${propertyId}:${roomTypeId}`, [...rates]);
  }

  /** Equivalente en memoria de `insert into hoteles.availability(...)` — inventario
   *  real por noche que `bookAvailability`/`releaseAvailability` decrementan/liberan. */
  seedAvailability(propertyId: string, roomTypeId: string, date: string, totalRooms: number, bookedRooms = 0): void {
    this.availability.set(`${propertyId}:${roomTypeId}:${date}`, { totalRooms, bookedRooms });
  }

  /** Equivalente en memoria de `insert into hoteles.cancellation_policy(...)`. */
  seedCancellationPolicy(propertyId: string, policy: CancellationPolicyRecord): void {
    this.cancellationPolicies.set(propertyId, policy);
  }

  /** Permite a un test construir una reserva preexistente en un estado arbitrario
   *  (ej. para probar una transición desde `check_in`) sin pasar por la ruta HTTP de
   *  creación — equivalente en memoria de un `INSERT` manual contra
   *  `hoteles.reservation` con `status` ya distinto del default. */
  seedReservation(reservation: StoredReservation): void {
    this.reservations.set(reservation.id, { ...reservation });
  }

  private chargesByFolio(folioId: string): StoredCharge[] {
    return [...this.charges.values()].filter((c) => c.folioId === folioId).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  private paymentsByFolio(folioId: string): PaymentRecord[] {
    return [...this.payments.values()].filter((p) => p.folioId === folioId).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  private toFolioRecord(stored: StoredFolio): FolioRecord {
    return {
      id: stored.id,
      organizationId: stored.organizationId,
      propertyId: stored.propertyId,
      reservationId: stored.reservationId,
      status: stored.status,
      label: stored.label,
      isPrimary: stored.isPrimary,
      closedAt: stored.closedAt,
      closeReason: stored.closeReason,
      arApprovedBy: stored.arApprovedBy,
      charges: this.chargesByFolio(stored.id),
      payments: this.paymentsByFolio(stored.id),
    };
  }

  // ---- HotelesRepository: folios/cargos ----

  async findFolio(propertyId: string, folioId: string): Promise<FolioRecord | null> {
    const stored = this.folios.get(folioId);
    if (!stored || stored.propertyId !== propertyId) return null;
    return this.toFolioRecord(stored);
  }

  async listFoliosByReservation(propertyId: string, reservationId: string): Promise<readonly FolioRecord[]> {
    return [...this.folios.values()]
      .filter((f) => f.propertyId === propertyId && f.reservationId === reservationId)
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
      .map((f) => this.toFolioRecord(f));
  }

  async loadFolioGuestIdentity(reservationId: string): Promise<GuestIdentity> {
    return this.guestIdentityByReservation.get(reservationId) ?? { lastName: null, phoneLast4: null };
  }

  async isAdminStaff(propertyId: string, userId: string): Promise<boolean> {
    return this.staff.some((s) => s.propertyId === propertyId && s.userId === userId && s.isAdmin);
  }

  async loadTaxConfig(propertyId: string): Promise<TaxConfigRecord> {
    const config = this.taxConfigByProperty.get(propertyId);
    if (!config) throw new Error(`No hay hoteles.tax_config sembrado para property "${propertyId}"`);
    return config;
  }

  async insertCharge(input: NewChargeInput): Promise<{ id: string; createdAt: string }> {
    if (input.amount < 0 && !["descuento", "reverso"].includes(input.concept)) {
      throw new Error("charge_amount_check: un cargo real no admite monto negativo.");
    }
    // Espejo del índice único parcial `charge_folio_stay_date_hospedaje_idx`: el
    // night-audit nunca postea dos veces el cargo de hospedaje de la misma noche del
    // mismo folio. Los reversos (reversesChargeId set) no llevan stayDate real, así
    // que nunca chocan contra este índice — mismo criterio que el SQL real.
    if (input.concept === "hospedaje" && input.stayDate && !input.reversesChargeId) {
      const clash = [...this.charges.values()].some(
        (c) => c.folioId === input.folioId && c.concept === "hospedaje" && c.stayDate === input.stayDate && c.reversesChargeId == null,
      );
      if (clash) {
        throw new Error(
          `charge_folio_stay_date_hospedaje_idx: ya existe un cargo de hospedaje para el folio ${input.folioId} en la noche ${input.stayDate}.`,
        );
      }
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const record: StoredCharge = {
      id,
      folioId: input.folioId,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      description: input.description,
      amount: input.amount,
      taxAmount: input.taxAmount,
      concept: input.concept,
      reversedBy: null,
      reversesChargeId: input.reversesChargeId ?? null,
      transferredFromChargeId: input.transferredFromChargeId ?? null,
      discountAuthorizedBy: input.discountAuthorizedBy ?? null,
      stayDate: input.stayDate ?? null,
      createdAt,
    };
    this.charges.set(id, record);
    return { id, createdAt };
  }

  async findCharge(folioId: string, chargeId: string) {
    const charge = this.charges.get(chargeId);
    if (!charge || charge.folioId !== folioId) return null;
    return {
      id: charge.id,
      description: charge.description,
      amount: charge.amount,
      taxAmount: charge.taxAmount,
      concept: charge.concept,
      reversedBy: charge.reversedBy,
    };
  }

  async markChargeReversed(chargeId: string, reversalChargeId: string): Promise<void> {
    const charge = this.charges.get(chargeId);
    if (!charge || charge.reversedBy != null) {
      throw new Error(`reverso_invalido: el cargo ${chargeId} no existe o ya fue reversado`);
    }
    charge.reversedBy = reversalChargeId;
  }

  async insertPayment(input: NewPaymentInput): Promise<{ id: string; createdAt: string }> {
    if (input.tokenRef && /^[0-9]{12,19}$/.test(input.tokenRef)) {
      throw new Error("payment_token_ref_not_pan: token_ref no puede parecer un PAN.");
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.payments.set(id, {
      id,
      folioId: input.folioId,
      propertyId: input.propertyId,
      amount: input.amount,
      method: input.method,
      status: input.status,
      externalRef: input.externalRef ?? null,
      tokenRef: input.tokenRef ?? null,
      createdAt,
    });
    return { id, createdAt };
  }

  async createFolio(propertyId: string, organizationId: string, reservationId: string, label: string): Promise<{ id: string }> {
    const id = randomUUID();
    this.folios.set(id, {
      id,
      organizationId,
      propertyId,
      reservationId,
      status: "abierto",
      label,
      isPrimary: false,
      closedAt: null,
      closeReason: null,
      arApprovedBy: null,
    });
    return { id };
  }

  async closeFolio(folioId: string, reason: "saldo_cero" | "cuenta_por_cobrar", arApprovedBy: string | null): Promise<void> {
    const folio = this.folios.get(folioId);
    if (!folio) throw new Error(`Folio ${folioId} no encontrado.`);
    folio.status = "cerrado";
    folio.closedAt = new Date().toISOString();
    folio.closeReason = reason;
    folio.arApprovedBy = arApprovedBy;
  }

  // ---- HotelesRepository: F&B ----

  async listFnbOrders(propertyId: string): Promise<readonly FnbOrderRecord[]> {
    return [...this.fnbOrders.values()]
      .filter((o) => o.propertyId === propertyId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async findFnbOrder(propertyId: string, orderId: string): Promise<FnbOrderRecord | null> {
    const order = this.fnbOrders.get(orderId);
    if (!order || order.propertyId !== propertyId) return null;
    return order;
  }

  async insertFnbOrder(input: NewFnbOrderInput): Promise<FnbOrderRecord> {
    const id = randomUUID();
    const record = {
      id,
      propertyId: input.propertyId,
      organizationId: input.organizationId,
      roomId: input.roomId,
      items: input.items,
      notes: input.notes,
      allergyDeclared: input.allergyDeclared,
      allergyDeclaredVia: input.allergyDeclaredVia,
      kitchenConfirmedBy: null,
      kitchenConfirmedAt: null,
      kitchenConfirmationNote: null,
      safetyAssuranceSentBy: null,
      safetyAssuranceSentAt: null,
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
    };
    this.fnbOrders.set(id, record);
    return record;
  }

  async confirmFnbKitchen(propertyId: string, orderId: string, userId: string, note: string | null): Promise<FnbOrderRecord | null> {
    const order = this.fnbOrders.get(orderId);
    if (!order || order.propertyId !== propertyId) return null;
    const updated = { ...order, kitchenConfirmedBy: userId, kitchenConfirmedAt: new Date().toISOString(), kitchenConfirmationNote: note };
    this.fnbOrders.set(orderId, updated);
    return updated;
  }

  async assureFnbSafety(propertyId: string, orderId: string, userId: string): Promise<FnbOrderRecord | null> {
    const order = this.fnbOrders.get(orderId);
    if (!order || order.propertyId !== propertyId) return null;
    const updated = { ...order, safetyAssuranceSentBy: userId, safetyAssuranceSentAt: new Date().toISOString() };
    this.fnbOrders.set(orderId, updated);
    return updated;
  }

  // ---- HotelesRepository: quotes ----

  async findRoomType(propertyId: string, roomTypeId: string): Promise<{ id: string } | null> {
    const rt = this.roomTypes.get(roomTypeId);
    if (!rt || rt.propertyId !== propertyId) return null;
    return { id: rt.id };
  }

  async loadNightlyRates(propertyId: string, roomTypeId: string, checkInDate: string, checkOutDate: string): Promise<readonly NightlyRateRecord[]> {
    const rates = this.nightlyRates.get(`${propertyId}:${roomTypeId}`) ?? [];
    return rates.filter((r) => r.date >= checkInDate && r.date <= checkOutDate);
  }

  // ---- HotelesRepository: Fase 3 — máquina de estados de reservas (H02) ----

  private toReservationRecord(stored: StoredReservation): ReservationRecord {
    return {
      id: stored.id,
      organizationId: stored.organizationId,
      propertyId: stored.propertyId,
      roomTypeId: stored.roomTypeId,
      guestId: stored.guestId,
      checkInDate: stored.checkInDate,
      checkOutDate: stored.checkOutDate,
      status: stored.status,
      totalAmount: stored.totalAmount,
      cancellationPenaltyAmount: stored.cancellationPenaltyAmount,
      canceledAt: stored.canceledAt,
      createdAt: stored.createdAt,
    };
  }

  async listReservations(propertyId: string): Promise<readonly ReservationRecord[]> {
    return [...this.reservations.values()]
      .filter((r) => r.propertyId === propertyId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((r) => this.toReservationRecord(r));
  }

  async findReservation(propertyId: string, reservationId: string): Promise<ReservationRecord | null> {
    const stored = this.reservations.get(reservationId);
    if (!stored || stored.propertyId !== propertyId) return null;
    return this.toReservationRecord(stored);
  }

  async insertReservation(input: NewReservationInput): Promise<ReservationRecord> {
    if (input.idempotencyKey) {
      const existingId = this.reservationIdempotency.get(`${input.propertyId}:${input.idempotencyKey}`);
      if (existingId) {
        const existing = this.reservations.get(existingId);
        if (existing) return this.toReservationRecord(existing);
      }
    }
    const id = randomUUID();
    const stored: StoredReservation = {
      id,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      roomTypeId: input.roomTypeId,
      guestId: input.guestId,
      checkInDate: input.checkInDate,
      checkOutDate: input.checkOutDate,
      // Decisión de alcance Fase 3 §3.2: esta fase no expone `cotizada` por HTTP —
      // toda reserva creada por `POST crear` aterriza directo en `confirmada`.
      status: "confirmada",
      totalAmount: input.totalAmount,
      cancellationPenaltyAmount: null,
      canceledAt: null,
      createdAt: new Date().toISOString(),
    };
    this.reservations.set(id, stored);
    if (input.idempotencyKey) {
      this.reservationIdempotency.set(`${input.propertyId}:${input.idempotencyKey}`, id);
    }
    return this.toReservationRecord(stored);
  }

  async ensurePrimaryFolio(propertyId: string, organizationId: string, reservationId: string): Promise<{ id: string }> {
    const existing = [...this.folios.values()].find((f) => f.reservationId === reservationId && f.isPrimary);
    if (existing) return { id: existing.id };
    const id = randomUUID();
    this.folios.set(id, {
      id,
      organizationId,
      propertyId,
      reservationId,
      status: "abierto",
      label: "Principal",
      isPrimary: true,
      closedAt: null,
      closeReason: null,
      arApprovedBy: null,
    });
    return { id };
  }

  async transitionReservation(
    propertyId: string,
    reservationId: string,
    fromStatuses: readonly ReservationStatus[],
    toStatus: ReservationStatus,
    actorUserId: string | null,
  ): Promise<ReservationRecord | null> {
    void actorUserId; // el registro append-only de la transición vive solo en la migración SQL real (§4-punto 3); este adaptador en memoria no lo duplica.
    const stored = this.reservations.get(reservationId);
    if (!stored || stored.propertyId !== propertyId) return null;
    if (!fromStatuses.includes(stored.status)) return null; // reclamo atómico fallido: la fila ya no está en el estado esperado
    stored.status = toStatus;
    return this.toReservationRecord(stored);
  }

  async cancelReservation(propertyId: string, reservationId: string, penaltyAmount: number, actorUserId: string | null): Promise<ReservationRecord | null> {
    void actorUserId;
    const stored = this.reservations.get(reservationId);
    if (!stored || stored.propertyId !== propertyId) return null;
    if (!isCancellable(stored.status)) return null; // reclamo atómico fallido (mismo criterio que transitionReservation)
    stored.status = "cancelada";
    stored.canceledAt = new Date().toISOString();
    stored.cancellationPenaltyAmount = penaltyAmount;
    return this.toReservationRecord(stored);
  }

  async releaseAvailability(propertyId: string, roomTypeId: string, date: string, qty: number): Promise<void> {
    const key = `${propertyId}:${roomTypeId}:${date}`;
    await this.availabilityLock.run(key, async () => {
      const row = this.availability.get(key);
      // Mismo criterio que un UPDATE SQL sin fila que haga match: 0 filas afectadas,
      // nunca un error — la disponibilidad "que nunca se registró" no es un caso que
      // esta operación deba lanzar por ella (ver migrations/005_reservas_estado.sql).
      if (!row) return;
      row.bookedRooms = Math.max(row.bookedRooms - qty, 0);
    });
  }

  async bookAvailability(propertyId: string, roomTypeId: string, date: string, qty: number): Promise<void> {
    if (qty <= 0) throw new Error("cantidad_invalida: qty debe ser mayor a 0");
    const key = `${propertyId}:${roomTypeId}:${date}`;
    await this.availabilityLock.run(key, async () => {
      const roomType = this.roomTypes.get(roomTypeId);
      if (!roomType || roomType.propertyId !== propertyId) {
        throw new Error(`tipo_habitacion_invalido: room_type=${roomTypeId} no pertenece a property=${propertyId}`);
      }
      const row = this.availability.get(key);
      if (!row) {
        throw new Error(`sin_disponibilidad: no existe inventario para property=${propertyId}, room_type=${roomTypeId}, fecha=${date}`);
      }
      // Mismo espejo exacto que `overbooking.ts`/`hoteles.book_availability()` SQL:
      // total_rooms=0 se trata como 100% de ocupación (nunca "sin datos"), así que SÍ
      // puede activar sobreventa hasta maxOverbookRooms.
      const occupied = occupancyPct(row.totalRooms, row.bookedRooms);
      const effectiveCapacity = row.totalRooms + (occupied >= roomType.overbookingOccupancyThresholdPct ? roomType.maxOverbookRooms : 0);
      if (row.bookedRooms + qty > effectiveCapacity) {
        throw new Error(`sin_disponibilidad: no hay habitaciones libres para property=${propertyId}, room_type=${roomTypeId}, fecha=${date}`);
      }
      row.bookedRooms += qty;
    });
  }

  async loadReservationCancellationPolicy(propertyId: string): Promise<CancellationPolicyRecord | null> {
    return this.cancellationPolicies.get(propertyId) ?? null;
  }

  async findDueNoShowReservations(propertyId: string, asOfDate: string | null): Promise<readonly ReservationRecord[]> {
    const cutoff = asOfDate ?? new Date().toISOString().slice(0, 10);
    return [...this.reservations.values()]
      .filter((r) => r.propertyId === propertyId && r.status === "confirmada" && r.checkInDate <= cutoff)
      .map((r) => this.toReservationRecord(r));
  }

  // ---- HotelesRepository: idempotencia ----

  async withIdempotency<T>(params: IdempotencyParams, run: () => Promise<IdempotentResult<T>>): Promise<IdempotentResult<T>> {
    const requestHash = hashBody(params.body);
    const key = `${params.organizationId}:${params.scope}:${params.key}`;
    return this.idempotencyLock.run(key, async () => {
      const existing = this.idempotencyKeys.get(key);
      if (existing) {
        if (existing.requestHash !== requestHash) throw new IdempotencyConflictError();
        if (existing.response == null) {
          throw new Error("La solicitud original con este Idempotency-Key aún no terminó de procesarse.");
        }
        return existing.response as IdempotentResult<T>;
      }
      this.idempotencyKeys.set(key, { requestHash, response: null });
      const result = await run();
      this.idempotencyKeys.set(key, { requestHash, response: result });
      return result;
    });
  }

  // ---- HotelesRepository: Fase 2 — voz/WhatsApp (§1-§3) ----

  async consumeRateLimit(scope: string, actorHash: string, maxRequests: number, windowSeconds: number): Promise<boolean> {
    const key = `${scope}:${actorHash}`;
    const now = Date.now();
    const existing = this.rateLimits.get(key);
    if (!existing || now - existing.windowStartedAt >= windowSeconds * 1000) {
      this.rateLimits.set(key, { windowStartedAt: now, requestCount: 1 });
      return 1 <= maxRequests;
    }
    existing.requestCount += 1;
    return existing.requestCount <= maxRequests;
  }

  async findVoiceAgentConfig(propertyId: string): Promise<VoiceAgentConfig | null> {
    return this.voiceAgentConfigs.get(propertyId) ?? null;
  }

  async upsertVoiceAgentConfig(propertyId: string, organizationId: string, toolWebhookSecret: string, enabled: boolean): Promise<void> {
    this.voiceAgentConfigs.set(propertyId, { propertyId, organizationId, toolWebhookSecret, enabled });
  }

  async resolvePropertyByPhoneNumberId(phoneNumberId: string): Promise<WhatsAppPropertyRoute | null> {
    return this.phoneNumberIdToProperty.get(phoneNumberId) ?? null;
  }

  async claimWhatsAppMessage(propertyId: string, messageId: string, phoneHash: string): Promise<boolean> {
    void propertyId;
    return this.whatsappLock.run(`event:${messageId}`, async () => {
      const existing = this.whatsappEvents.get(messageId);
      const now = Date.now();
      if (!existing) {
        this.whatsappEvents.set(messageId, { status: "processing", attempts: 1, claimedAt: now });
        return true;
      }
      // Mismo criterio que restaurantes: se puede reclamar de nuevo un evento
      // fallido, o uno "processing" cuyo lease de proceso quedó huérfano (>5 min).
      const staleProcessing = existing.status === "processing" && now - existing.claimedAt > 5 * 60 * 1000;
      if (existing.status === "failed" || staleProcessing) {
        existing.status = "processing";
        existing.attempts += 1;
        existing.claimedAt = now;
        return true;
      }
      void phoneHash;
      return false;
    });
  }

  async claimWhatsAppConversation(propertyId: string, phoneHash: string, messageId: string, leaseSeconds: number): Promise<boolean> {
    const key = `${propertyId}:${phoneHash}`;
    return this.whatsappLock.run(`lease:${key}`, async () => {
      const now = Date.now();
      const existing = this.whatsappLeases.get(key);
      if (existing && existing.lockedUntil >= now) return false;
      this.whatsappLeases.set(key, { ownerMessageId: messageId, lockedUntil: now + leaseSeconds * 1000 });
      return true;
    });
  }

  async appendWhatsAppUserMessageOnce(propertyId: string, phone: string, message: ConversationMessage): Promise<readonly ConversationMessage[]> {
    return this.whatsappAppendTurn(propertyId, phone, [message], null, null);
  }

  async whatsappAppendTurn(
    propertyId: string,
    phone: string,
    newMessages: readonly ConversationMessage[],
    status: "active" | "completed" | "abandoned" | null,
    fnbOrderId: string | null,
  ): Promise<readonly ConversationMessage[]> {
    const key = `${propertyId}:${phone}`;
    return this.whatsappLock.run(`conv:${key}`, async () => {
      const existing = this.whatsappConversations.get(key) ?? { messages: [], status: "active" as const, fnbOrderId: null };
      const updated: StoredConversation = {
        messages: [...existing.messages, ...newMessages],
        status: status ?? existing.status,
        fnbOrderId: fnbOrderId ?? existing.fnbOrderId,
      };
      this.whatsappConversations.set(key, updated);
      return updated.messages;
    });
  }

  async finishWhatsAppMessage(propertyId: string, messageId: string, phoneHash: string, status: "processed" | "failed", errorClass: string | null): Promise<void> {
    void errorClass;
    const event = this.whatsappEvents.get(messageId);
    if (event) event.status = status;
    const leaseKey = `${propertyId}:${phoneHash}`;
    const lease = this.whatsappLeases.get(leaseKey);
    if (lease && lease.ownerMessageId === messageId) this.whatsappLeases.delete(leaseKey);
  }

  async markInboundEventFailed(propertyId: string, messageId: string, errorClass: string): Promise<void> {
    void propertyId;
    void errorClass;
    const event = this.whatsappEvents.get(messageId);
    if (event) event.status = "failed";
  }

  // ---- Dispatcher real de messaging_outbox (migrations/008) ----

  getOutbox(): readonly InMemoryOutboxRow[] {
    return [...this.outbox.values()];
  }

  async enqueueMessagingOutbox(propertyId: string, organizationId: string, channel: "whatsapp" | "email", eventType: string, dedupeKey: string, payload: unknown): Promise<void> {
    const existing = [...this.outbox.values()].find((o) => o.propertyId === propertyId && o.channel === channel && o.dedupeKey === dedupeKey);
    if (existing) {
      if (existing.status === "pending" || existing.status === "failed") {
        existing.eventType = eventType;
        existing.payload = payload;
      }
      return;
    }
    const id = randomUUID();
    this.outbox.set(id, { id, propertyId, organizationId, channel, eventType, dedupeKey, payload, status: "pending", attempts: 0, claimedAt: null, nextAttemptAt: 0, lastErrorClass: null });
  }

  async claimMessagingOutboxBatch(limit: number, leaseSeconds: number): Promise<readonly MessagingOutboxRow[]> {
    const now = Date.now();
    const eligible = [...this.outbox.values()]
      .filter(
        (o) =>
          o.channel === "whatsapp" &&
          ((o.status === "pending" && o.nextAttemptAt <= now) || (o.status === "processing" && (o.claimedAt ?? 0) < now - leaseSeconds * 1000)),
      )
      .slice(0, limit);
    for (const row of eligible) {
      row.status = "processing";
      row.claimedAt = now;
    }
    return eligible.map((row) => ({ id: row.id, attempts: row.attempts, payload: row.payload }));
  }

  async markMessagingOutboxSent(id: string): Promise<void> {
    const row = this.outbox.get(id);
    if (!row || row.status !== "processing") return;
    row.status = "sent";
  }

  async markMessagingOutboxRetry(id: string, attempts: number, errorClass: string, nextAttemptAtIso: string): Promise<void> {
    const row = this.outbox.get(id);
    if (!row || row.status !== "processing") return;
    row.status = "pending";
    row.attempts = attempts;
    row.lastErrorClass = errorClass.slice(0, 120);
    row.nextAttemptAt = Date.parse(nextAttemptAtIso);
    row.claimedAt = null;
  }

  async markMessagingOutboxDead(id: string, attempts: number, errorClass: string): Promise<void> {
    const row = this.outbox.get(id);
    if (!row || row.status !== "processing") return;
    row.status = "dead";
    row.attempts = attempts;
    row.lastErrorClass = errorClass.slice(0, 120);
    row.claimedAt = null;
  }

  async insertContactoNoOperativo(input: NewContactoNoOperativoInput): Promise<ContactoNoOperativoRecord> {
    const record: ContactoNoOperativoRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      guestPhone: input.guestPhone,
      guestName: input.guestName,
      reason: input.reason,
      message: input.message,
      source: input.source,
      createdAt: new Date().toISOString(),
    };
    this.contactosNoOperativos.set(record.id, record);
    return record;
  }

  // ---- HotelesRepository: Fase 5 — H16-014/REQ-REC-014 fraude interno ----

  async listDiscountChargesForFraudScan(propertyId: string): Promise<readonly DiscountChargeForFraudScan[]> {
    return [...this.charges.values()]
      .filter((c) => c.propertyId === propertyId && c.concept === "descuento" && c.reversedBy == null)
      .map((c) => ({ chargeId: c.id, folioId: c.folioId, amount: c.amount, discountAuthorizedBy: c.discountAuthorizedBy }));
  }

  async listReopenedFolioChargesForFraudScan(propertyId: string): Promise<readonly ReopenedFolioChargeForFraudScan[]> {
    const rows: ReopenedFolioChargeForFraudScan[] = [];
    for (const folio of this.folios.values()) {
      if (folio.propertyId !== propertyId || folio.closedAt == null) continue;
      for (const charge of this.chargesByFolio(folio.id)) {
        if (charge.createdAt > folio.closedAt) {
          rows.push({ folioId: folio.id, folioClosedAt: folio.closedAt, chargeId: charge.id, chargeCreatedAt: charge.createdAt });
        }
      }
    }
    return rows;
  }

  async recordFraudAlert(input: NewFraudAlertInput): Promise<{ record: FraudAlertRecord; isNew: boolean }> {
    return this.fraudAlertLock.run(`${input.propertyId}:${input.dedupeKey}`, async () => {
      const existing = [...this.fraudAlerts.values()].find((a) => a.propertyId === input.propertyId && a.dedupeKey === input.dedupeKey);
      if (existing) return { record: existing, isNew: false };
      const record: FraudAlertRecord = {
        id: randomUUID(),
        organizationId: input.organizationId,
        propertyId: input.propertyId,
        pattern: input.pattern,
        folioId: input.folioId,
        chargeId: input.chargeId,
        paymentId: input.paymentId,
        reason: input.reason,
        evidence: input.evidence,
        recipientRoles: input.recipientRoles,
        dedupeKey: input.dedupeKey,
        status: "pendiente",
        decisionNote: null,
        resolvedBy: null,
        resolvedAt: null,
        createdAt: new Date().toISOString(),
      };
      this.fraudAlerts.set(record.id, record);
      return { record, isNew: true };
    });
  }

  async listFraudAlerts(propertyId: string, filter?: { readonly status?: FraudAlertStatus }): Promise<readonly FraudAlertRecord[]> {
    return [...this.fraudAlerts.values()]
      .filter((a) => a.propertyId === propertyId && (filter?.status == null || a.status === filter.status))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async findFraudAlert(propertyId: string, alertId: string): Promise<FraudAlertRecord | null> {
    const alert = this.fraudAlerts.get(alertId);
    if (!alert || alert.propertyId !== propertyId) return null;
    return alert;
  }

  async resolveFraudAlert(propertyId: string, alertId: string, resolvedBy: string, status: "confirmado" | "descartado", decisionNote: string | null): Promise<FraudAlertRecord> {
    const alert = this.fraudAlerts.get(alertId);
    if (!alert || alert.propertyId !== propertyId) throw new Error(`Alerta de fraude ${alertId} no encontrada.`);
    if (alert.status !== "pendiente") throw new FraudAlertAlreadyResolvedError();
    const updated: FraudAlertRecord = { ...alert, status, decisionNote, resolvedBy, resolvedAt: new Date().toISOString() };
    this.fraudAlerts.set(alertId, updated);
    return updated;
  }

  // ---- HotelesRepository: Fase 5 — H5/REQ-BO-001/002 CFDI de hospedaje ----

  async loadHospedajeFiscalConfig(propertyId: string): Promise<HospedajeFiscalConfig> {
    const config = this.hospedajeFiscalConfigByProperty.get(propertyId);
    if (!config) throw new Error(`No hay configuración fiscal de hospedaje sembrada para property "${propertyId}"`);
    return config;
  }

  async listChargesForCfdi(folioId: string): Promise<readonly { concept: string; amount: number; taxAmount: number; stayDate: string | null; reversesChargeId: string | null }[]> {
    return this.chargesByFolio(folioId).map((c) => ({ concept: c.concept, amount: c.amount, taxAmount: c.taxAmount, stayDate: c.stayDate, reversesChargeId: c.reversesChargeId }));
  }

  async findCfdiEmisionByFolio(propertyId: string, folioId: string, tipo: "hospedaje"): Promise<CfdiEmisionRecord | null> {
    return [...this.cfdiEmisiones.values()].find((c) => c.propertyId === propertyId && c.folioId === folioId && c.tipo === tipo) ?? null;
  }

  async findCfdiEmisionByPayment(propertyId: string, paymentId: string): Promise<CfdiEmisionRecord | null> {
    return [...this.cfdiEmisiones.values()].find((c) => c.propertyId === propertyId && c.paymentId === paymentId && c.tipo === "pago") ?? null;
  }

  async insertCfdiEmision(input: NewCfdiEmisionInput): Promise<CfdiEmisionRecord> {
    return this.cfdiLock.run(`${input.propertyId}:${input.folioId}:${input.tipo}:${input.paymentId ?? ""}`, async () => {
      // Espejo de los índices únicos parciales de migrations/006_cfdi_hospedaje.sql
      // (REQ-BO-002): a lo más UN CFDI 'hospedaje' por folio, a lo más UNO 'pago' por
      // pago -- "on conflict ... do nothing" en Postgres, aquí devuelve el existente
      // sin duplicar.
      if (input.tipo === "hospedaje") {
        const existing = await this.findCfdiEmisionByFolio(input.propertyId, input.folioId, "hospedaje");
        if (existing) return existing;
      } else if (input.paymentId) {
        const existing = await this.findCfdiEmisionByPayment(input.propertyId, input.paymentId);
        if (existing) return existing;
      }
      const record: CfdiEmisionRecord = {
        id: randomUUID(),
        organizationId: input.organizationId,
        propertyId: input.propertyId,
        folioId: input.folioId,
        tipo: input.tipo,
        uuidFiscal: input.uuidFiscal,
        status: input.status,
        pac: input.pac,
        subtotal: input.subtotal,
        iva: input.iva,
        ishTasa: input.ishTasa,
        ishMonto: input.ishMonto,
        dsaMonto: input.dsaMonto,
        total: input.total,
        rfcReceptor: input.rfcReceptor,
        usoCfdi: input.usoCfdi,
        metodoPago: input.metodoPago,
        esExtranjero: input.esExtranjero,
        esGlobal: input.esGlobal,
        esNoShow: input.esNoShow,
        relatedCfdiId: input.relatedCfdiId,
        paymentId: input.paymentId,
        createdAt: new Date().toISOString(),
        canceledAt: null,
      };
      this.cfdiEmisiones.set(record.id, record);
      return record;
    });
  }

  async findCfdiEmision(propertyId: string, cfdiId: string): Promise<CfdiEmisionRecord | null> {
    const record = this.cfdiEmisiones.get(cfdiId);
    if (!record || record.propertyId !== propertyId) return null;
    return record;
  }

  async listCfdiEmisiones(propertyId: string, filter?: { readonly folioId?: string }): Promise<readonly CfdiEmisionRecord[]> {
    return [...this.cfdiEmisiones.values()]
      .filter((c) => c.propertyId === propertyId && (filter?.folioId == null || c.folioId === filter.folioId))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async updateCfdiEmisionCancelacion(cfdiId: string, status: CfdiEmisionRecord["status"]): Promise<void> {
    const record = this.cfdiEmisiones.get(cfdiId);
    if (!record) throw new Error(`CFDI ${cfdiId} no encontrado.`);
    this.cfdiEmisiones.set(cfdiId, { ...record, status, canceledAt: new Date().toISOString() });
  }

  // ---- HotelesRepository: Fase 7 — descubrimiento de organización/property ----

  async findOrganizationBySlug(slug: string): Promise<HotelOrganizationSummary | null> {
    for (const org of this.organizations.values()) {
      if (org.slug === slug) return org;
    }
    return null;
  }

  async listPropertiesForOrganization(organizationId: string): Promise<readonly PropertySummary[]> {
    return [...this.properties.values()]
      .filter((p) => p.organizationId === organizationId)
      .map((p) => ({ propertyId: p.propertyId, name: p.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---- HotelesRepository: Fase 6 — H5/REQ-REV-013 night audit propio ----

  async listActiveHotelProperties(): Promise<readonly ActiveHotelProperty[]> {
    return [...this.activeHotelProperties.values()];
  }

  async listInHouseReservationsForNightAudit(
    propertyId: string,
    businessDate: string,
  ): Promise<readonly { reservationId: string; folioId: string | null; nightlyPrice: number | null }[]> {
    const inHouse = [...this.reservations.values()].filter(
      (r) =>
        r.propertyId === propertyId &&
        (r.status === "check_in" || r.status === "en_estancia") &&
        r.checkInDate <= businessDate &&
        r.checkOutDate > businessDate,
    );
    return inHouse.map((r) => {
      const folio = [...this.folios.values()].find((f) => f.reservationId === r.id && f.isPrimary);
      const rates = this.nightlyRates.get(`${propertyId}:${r.roomTypeId}`) ?? [];
      const rate = rates.find((x) => x.date === businessDate);
      return { reservationId: r.id, folioId: folio?.id ?? null, nightlyPrice: rate?.price ?? null };
    });
  }

  async postNightlyHospedajeCharge(input: {
    organizationId: string;
    propertyId: string;
    folioId: string;
    businessDate: string;
    netAmount: number;
    taxAmount: number;
  }): Promise<{ id: string; createdAt: string; isNew: boolean }> {
    // Mismo espejo del índice único parcial que ya aplica `insertCharge` -- se
    // verifica primero para devolver `isNew:false` en vez de lanzar (comportamiento
    // "ON CONFLICT DO NOTHING ... RETURNING" del original, no una excepción).
    const existing = [...this.charges.values()].find(
      (c) => c.folioId === input.folioId && c.concept === "hospedaje" && c.stayDate === input.businessDate && c.reversesChargeId == null,
    );
    if (existing) return { id: existing.id, createdAt: existing.createdAt, isNew: false };
    const { id, createdAt } = await this.insertCharge({
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      folioId: input.folioId,
      description: `Hospedaje noche del ${input.businessDate}`,
      amount: input.netAmount,
      taxAmount: input.taxAmount,
      concept: "hospedaje",
      stayDate: input.businessDate,
    });
    return { id, createdAt, isNew: true };
  }

  async claimNightAuditRun(organizationId: string, propertyId: string, businessDate: string): Promise<NightAuditRunRecord> {
    const key = `${propertyId}:${businessDate}`;
    return this.nightAuditRunLock.run(key, async () => {
      const existing = this.nightAuditRuns.get(key);
      if (existing) return existing;
      const record: NightAuditRunRecord = {
        id: randomUUID(),
        organizationId,
        propertyId,
        businessDate,
        status: "en_progreso",
        summary: {},
        startedAt: new Date().toISOString(),
        completedAt: null,
      };
      this.nightAuditRuns.set(key, record);
      return record;
    });
  }

  async finishNightAuditRun(runId: string, summary: Readonly<Record<string, unknown>>): Promise<NightAuditRunRecord> {
    const entry = [...this.nightAuditRuns.entries()].find(([, r]) => r.id === runId);
    if (!entry) throw new Error(`night_audit_run_no_encontrado: ${runId}`);
    const [key, record] = entry;
    // Guarda de estado (mismo criterio que `night_audit_finish`/`resolveFraudAlert`):
    // una corrida ya completada NUNCA se re-termina ni reemplaza su resumen.
    if (record.status === "completado") return record;
    const updated: NightAuditRunRecord = { ...record, status: "completado", summary, completedAt: new Date().toISOString() };
    this.nightAuditRuns.set(key, updated);
    return updated;
  }

  async findNightAuditRun(propertyId: string, businessDate: string): Promise<NightAuditRunRecord | null> {
    return this.nightAuditRuns.get(`${propertyId}:${businessDate}`) ?? null;
  }

  async listNightAuditRuns(propertyId: string, limit = 30): Promise<readonly NightAuditRunRecord[]> {
    return [...this.nightAuditRuns.values()]
      .filter((r) => r.propertyId === propertyId)
      .sort((a, b) => (a.businessDate < b.businessDate ? 1 : -1))
      .slice(0, limit);
  }

  private chargesCreatedOnBusinessDate(propertyId: string, businessDate: string, timezone: string): StoredCharge[] {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    return [...this.charges.values()].filter((c) => c.propertyId === propertyId && fmt.format(new Date(c.createdAt)) === businessDate);
  }

  async sumChargesByConceptForBusinessDate(propertyId: string, businessDate: string, timezone: string): Promise<Readonly<Record<string, number>>> {
    const totals: Record<string, number> = {};
    for (const c of this.chargesCreatedOnBusinessDate(propertyId, businessDate, timezone)) {
      totals[c.concept] = (totals[c.concept] ?? 0) + c.amount + c.taxAmount;
    }
    return totals;
  }

  async sumPaymentsByMethodForBusinessDate(propertyId: string, businessDate: string, timezone: string): Promise<Readonly<Record<string, number>>> {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    const totals: Record<string, number> = {};
    for (const p of this.payments.values()) {
      if (p.propertyId !== propertyId || p.status !== "capturado") continue;
      if (fmt.format(new Date(p.createdAt)) !== businessDate) continue;
      totals[p.method] = (totals[p.method] ?? 0) + p.amount;
    }
    return totals;
  }

  // ---- HotelesRepository: Fase 6 — REQ-HK-011 tickets de mantenimiento ----

  async insertMaintenanceTicket(input: NewMaintenanceTicketInput): Promise<MaintenanceTicketRecord> {
    const record: MaintenanceTicketRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      roomId: input.roomId,
      title: input.title,
      description: input.description,
      origin: input.origin,
      severity: input.severity,
      status: "abierto",
      assignedTo: null,
      estimatedCost: input.estimatedCost,
      actualCost: null,
      resolutionNote: null,
      createdBy: input.createdBy,
      closedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.maintenanceTickets.set(record.id, record);
    return record;
  }

  async listMaintenanceTickets(propertyId: string, filter?: { readonly status?: MaintenanceTicketStatus }): Promise<readonly MaintenanceTicketRecord[]> {
    return [...this.maintenanceTickets.values()]
      .filter((t) => t.propertyId === propertyId && (filter?.status == null || t.status === filter.status))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async findMaintenanceTicket(propertyId: string, ticketId: string): Promise<MaintenanceTicketRecord | null> {
    const ticket = this.maintenanceTickets.get(ticketId);
    if (!ticket || ticket.propertyId !== propertyId) return null;
    return ticket;
  }

  async closeMaintenanceTicket(
    propertyId: string,
    ticketId: string,
    input: { readonly actualCost: number; readonly resolutionNote: string | null },
  ): Promise<MaintenanceTicketRecord | null> {
    const ticket = this.maintenanceTickets.get(ticketId);
    if (!ticket || ticket.propertyId !== propertyId) return null;
    if (ticket.status === "cerrado" || ticket.status === "cancelado") return null;
    const updated: MaintenanceTicketRecord = {
      ...ticket,
      status: "cerrado",
      actualCost: input.actualCost,
      resolutionNote: input.resolutionNote,
      closedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.maintenanceTickets.set(ticketId, updated);
    return updated;
  }

  // ---- HotelesRepository: Fase 6 — REQ-HK-008 turnos de camaristas/lavandería ----

  async replaceHousekeepingShifts(
    propertyId: string,
    staffId: string,
    fromDate: string,
    toDate: string,
    shifts: readonly NewHousekeepingShiftInput[],
  ): Promise<readonly HousekeepingShiftRecord[]> {
    for (const [id, shift] of this.housekeepingShifts) {
      if (shift.propertyId === propertyId && shift.staffId === staffId && shift.workDate >= fromDate && shift.workDate <= toDate) {
        this.housekeepingShifts.delete(id);
      }
    }
    const created: HousekeepingShiftRecord[] = [];
    for (const s of shifts) {
      const record: HousekeepingShiftRecord = {
        id: randomUUID(),
        organizationId: s.organizationId,
        propertyId: s.propertyId,
        staffId: s.staffId,
        workDate: s.workDate,
        startTime: s.startTime,
        endTime: s.endTime,
        createdAt: new Date().toISOString(),
      };
      this.housekeepingShifts.set(record.id, record);
      created.push(record);
    }
    return created;
  }

  async listHousekeepingShifts(propertyId: string, fromDate: string, toDate: string, staffId?: string): Promise<readonly HousekeepingShiftRecord[]> {
    return [...this.housekeepingShifts.values()]
      .filter(
        (s) =>
          s.propertyId === propertyId &&
          s.workDate >= fromDate &&
          s.workDate <= toDate &&
          (staffId == null || s.staffId === staffId),
      )
      .sort((a, b) => (a.workDate < b.workDate ? -1 : 1));
  }

  // ---- HotelesRepository: Fase 8 — REQ-BO-024 checador de asistencia inalterable ----

  /** SOLO para fixtures de prueba -- equivalente en memoria del `insert into
   *  hoteles.attendance_log (..., recorded_at) values (..., $recordedAt)` que el
   *  propio test adversarial del original usa para el caso (d) (cruce contra
   *  horario): el checador real (`recordAttendanceEvent` abajo) SIEMPRE ignora
   *  cualquier `recordedAt` externo -- el reloj del checador es el del servidor,
   *  nunca el que mande el caller (ver comentario de `AttendanceEventRecord`,
   *  types.ts). Esto existe únicamente para que una prueba pueda fijar timestamps
   *  exactos sin esperar en tiempo real un turno de 8+ horas -- lo que se ejercita
   *  end-to-end vía HTTP es la ruta de LECTURA (/cruce, /exportar-stps), no esta. */
  seedAttendanceEvent(record: AttendanceEventRecord): void {
    this.attendanceEvents.set(record.id, record);
  }

  async recordAttendanceEvent(input: NewAttendanceEventInput): Promise<AttendanceEventRecord> {
    // `recordedAt` SIEMPRE lo fija este adaptador (equivalente en memoria de `now()`
    // en Postgres) -- ningún input externo puede fijar cuándo "realmente" ocurrió el
    // fichaje, ver types.ts::AttendanceEventRecord.
    const record: AttendanceEventRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      staffUserId: input.staffUserId,
      eventType: input.eventType,
      recordedAt: new Date().toISOString(),
      source: input.source,
      note: input.note,
      createdAt: new Date().toISOString(),
    };
    this.attendanceEvents.set(record.id, record);
    return record;
  }

  async listAttendanceEvents(
    propertyId: string,
    staffUserId: string,
    range?: { readonly fromDate: string; readonly toDate: string },
  ): Promise<readonly AttendanceEventRecord[]> {
    return [...this.attendanceEvents.values()]
      .filter((e) => {
        if (e.propertyId !== propertyId || e.staffUserId !== staffUserId) return false;
        if (!range) return true;
        const day = e.recordedAt.slice(0, 10);
        return day >= range.fromDate && day <= range.toDate;
      })
      .sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : 1));
  }

  async upsertStaffSchedule(input: NewStaffScheduleInput): Promise<StaffScheduleRecord> {
    const key = `${input.propertyId}:${input.staffUserId}:${input.workDate}`;
    const existing = this.staffSchedules.get(key);
    const now = new Date().toISOString();
    const record: StaffScheduleRecord = {
      id: existing?.id ?? randomUUID(),
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      staffUserId: input.staffUserId,
      workDate: input.workDate,
      scheduledStart: input.scheduledStart,
      scheduledEnd: input.scheduledEnd,
      authorizedOvertimeMinutes: input.authorizedOvertimeMinutes,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.staffSchedules.set(key, record);
    return record;
  }

  async findStaffSchedule(propertyId: string, staffUserId: string, workDate: string): Promise<StaffScheduleRecord | null> {
    return this.staffSchedules.get(`${propertyId}:${staffUserId}:${workDate}`) ?? null;
  }

  // ---- HotelesRepository: Fase 10 — REQ-BO-010 back-office financiero (P&L USALI) ----

  async insertExpenseEntry(input: NewExpenseEntryInput): Promise<ExpenseEntryRecord> {
    if (input.amount < 0) throw new Error("expense_entry_amount_check: un gasto no admite monto negativo.");
    const record: ExpenseEntryRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      department: input.department,
      category: input.category,
      description: input.description,
      amount: input.amount,
      expenseDate: input.expenseDate,
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
    };
    this.expenseEntries.set(record.id, record);
    return record;
  }

  async listExpenseEntries(propertyId: string, desde: string, hasta: string): Promise<readonly ExpenseEntryRecord[]> {
    return [...this.expenseEntries.values()]
      .filter((e) => e.propertyId === propertyId && e.expenseDate >= desde && e.expenseDate <= hasta)
      .sort((a, b) => (a.expenseDate < b.expenseDate ? -1 : 1));
  }

  /** Resuelve fecha+departamento de UN cargo -- `fecha = stayDate ?? createdAt` (mismo
   *  fallback que el original: `coalesce(stay_date, created_at::date)`); un 'reverso'
   *  resuelve su departamento contra el concept del cargo ORIGINAL (nunca contra
   *  'reverso' en sí, que no mapea a ningún departamento por su cuenta) -- devuelve
   *  `null` cuando el concept resuelto es 'propina' (excluida) o el original ya no
   *  existe (dato roto, se descarta en vez de fabricar un departamento). */
  private resolveRevenueDateAndDepartment(charge: StoredCharge): { fecha: string; department: UsaliRevenueDepartment } | null {
    const original = charge.reversesChargeId != null ? this.charges.get(charge.reversesChargeId) : undefined;
    const effectiveConcept = original ? original.concept : charge.concept;
    const department = resolveRevenueDepartmentForConcept(effectiveConcept);
    if (department == null) return null;
    const fecha = charge.stayDate ?? charge.createdAt.slice(0, 10);
    return { fecha, department };
  }

  async loadRevenueByDepartmentAndDateForPl(propertyId: string, desde: string, hasta: string): Promise<readonly PlRevenueByDateRow[]> {
    const totals = new Map<string, number>(); // key: fecha:department
    for (const charge of this.charges.values()) {
      if (charge.propertyId !== propertyId) continue;
      const resolved = this.resolveRevenueDateAndDepartment(charge);
      if (!resolved || resolved.fecha < desde || resolved.fecha > hasta) continue;
      const key = `${resolved.fecha}:${resolved.department}`;
      totals.set(key, (totals.get(key) ?? 0) + charge.amount);
    }
    return [...totals.entries()].map(([key, revenue]) => {
      const [fecha, department] = key.split(":") as [string, UsaliRevenueDepartment];
      return { fecha, department, revenue };
    });
  }

  async loadExpensesByDepartmentAndDateForPl(propertyId: string, desde: string, hasta: string): Promise<readonly PlExpenseByDateRow[]> {
    return [...this.expenseEntries.values()]
      .filter((e) => e.propertyId === propertyId && e.expenseDate >= desde && e.expenseDate <= hasta)
      .map((e) => ({ fecha: e.expenseDate, department: e.department, category: e.category, amount: e.amount }));
  }

  async loadOccupiedRoomNightsByDateForPl(
    propertyId: string,
    desde: string,
    hasta: string,
  ): Promise<readonly PlOccupiedRoomNightsByDateRow[]> {
    const totals = new Map<string, { roomNights: number; revenue: number }>(); // key: fecha
    for (const charge of this.charges.values()) {
      if (charge.propertyId !== propertyId) continue;
      if (charge.concept !== "hospedaje" || charge.reversedBy != null) continue;
      if (!charge.stayDate || charge.stayDate < desde || charge.stayDate > hasta) continue;
      const entry = totals.get(charge.stayDate) ?? { roomNights: 0, revenue: 0 };
      entry.roomNights += 1;
      entry.revenue += charge.amount;
      totals.set(charge.stayDate, entry);
    }
    return [...totals.entries()].map(([fecha, v]) => ({ fecha, roomNights: v.roomNights, revenue: v.revenue }));
  }

  async sumAvailableRoomNightsForDateRange(propertyId: string, desde: string, hasta: string): Promise<number> {
    let total = 0;
    for (const [key, value] of this.availability.entries()) {
      const [rowPropertyId, , date] = key.split(":");
      if (rowPropertyId !== propertyId || !date || date < desde || date > hasta) continue;
      total += value.totalRooms;
    }
    return total;
  }
}
