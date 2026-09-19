// PostgresHotelesRepository — adaptador de producción de `HotelesRepository`, sobre
// el `TenantDbSession` genérico de `@atiende/core-tenancy` (mismo contrato que
// consume `core-auth/src/middleware.ts`). Ejecuta las queries reales contra el
// esquema `hoteles` de migrations/001-003 (RLS real vía
// `core.has_property_access`/`hoteles.can_access_money`).
import { createHash } from "node:crypto";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { FraudAlertAlreadyResolvedError, GuestReviewActionAlreadyResolvedError, IdempotencyConflictError } from "./errors.ts";
import type { EmailOutboxJobRow, HotelesRepository, IdempotencyParams, IdempotentResult, MessagingOutboxRow, ReservationPage } from "./repository.ts";
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
  FnbOrderItem,
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
  ChargeRecord,
  PaymentRecord,
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
import type { UsaliRevenueDepartment } from "./pl/usaliPL.ts";

// Ventana de protección contra reintento de un Idempotency-Key — mismo criterio que
// hoteles/apps/api/src/lib/idempotency.ts (migración 0022): 7 días cubre un
// reintento manual/de integración externa real sin ser indefinido.
const IDEMPOTENCY_KEY_TTL_DAYS = 7;

function hashBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

// Fase 10 (REQ-BO-010) — mismo mapeo `charge.concept` -> departamento USALI
// documentado en migrations/012_pl_usali.sql, compartido en SQL (este `case`, para
// `loadRevenueByDepartmentAndDateForPl`) y en TS (`InMemoryHotelesRepository`,
// mismo criterio). 'propina' resuelve a null (columna omitida por el `where`),
// 'reverso' se resuelve al concept del cargo ORIGINAL vía el `left join` sobre
// `reverses_charge_id`.
const PL_REVENUE_DEPARTMENT_CASE = `
  case coalesce(orig.concept, c.concept)
    when 'hospedaje' then 'rooms'
    when 'ab' then 'food_beverage'
    when 'extras' then 'otros_departamentos'
    when 'otro' then 'otros_departamentos'
    when 'ajuste' then 'rooms'
    when 'descuento' then 'rooms'
    else null
  end
`;

interface ExpenseEntryRawRow {
  id: string;
  organization_id: string;
  property_id: string;
  department: ExpenseEntryRecord["department"];
  category: ExpenseEntryRecord["category"];
  description: string;
  amount: string;
  expense_date: string;
  created_by: string | null;
  created_at: string;
}

const EXPENSE_ENTRY_COLUMNS = "id, organization_id, property_id, department, category, description, amount, expense_date, created_by, created_at";

function mapExpenseEntry(row: ExpenseEntryRawRow): ExpenseEntryRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    propertyId: row.property_id,
    department: row.department,
    category: row.category,
    description: row.description,
    amount: Number(row.amount),
    expenseDate: row.expense_date,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

interface ChargeRawRow {
  id: string;
  folio_id: string;
  description: string;
  amount: string;
  tax_amount: string;
  concept: ChargeRecord["concept"];
  reversed_by: string | null;
  reverses_charge_id: string | null;
  transferred_from_charge_id: string | null;
  discount_authorized_by: string | null;
  created_at: string;
}

interface PaymentRawRow {
  id: string;
  folio_id: string;
  amount: string;
  method: PaymentRecord["method"];
  status: PaymentRecord["status"];
  external_ref: string | null;
  token_ref: string | null;
  created_at: string;
}

interface FolioRawRow {
  id: string;
  organization_id: string;
  property_id: string;
  reservation_id: string;
  status: FolioRecord["status"];
  label: string;
  is_primary: boolean;
  closed_at: string | null;
  close_reason: FolioRecord["closeReason"];
  ar_approved_by: string | null;
}

function mapCharge(row: ChargeRawRow): ChargeRecord {
  return {
    id: row.id,
    folioId: row.folio_id,
    description: row.description,
    amount: Number(row.amount),
    taxAmount: Number(row.tax_amount),
    concept: row.concept,
    reversedBy: row.reversed_by,
    reversesChargeId: row.reverses_charge_id,
    transferredFromChargeId: row.transferred_from_charge_id,
    discountAuthorizedBy: row.discount_authorized_by,
    createdAt: row.created_at,
  };
}

function mapPayment(row: PaymentRawRow): PaymentRecord {
  return {
    id: row.id,
    folioId: row.folio_id,
    amount: Number(row.amount),
    method: row.method,
    status: row.status,
    externalRef: row.external_ref,
    tokenRef: row.token_ref,
    createdAt: row.created_at,
  };
}

interface FnbOrderRawRow {
  id: string;
  property_id: string;
  room_id: string | null;
  items: unknown;
  notes: string | null;
  allergy_declared: boolean;
  allergy_declared_via: FnbOrderRecord["allergyDeclaredVia"];
  kitchen_confirmed_by: string | null;
  kitchen_confirmed_at: string | null;
  kitchen_confirmation_note: string | null;
  safety_assurance_sent_by: string | null;
  safety_assurance_sent_at: string | null;
  created_by: string | null;
  created_at: string;
}

function mapFnbOrder(row: FnbOrderRawRow): FnbOrderRecord {
  return {
    id: row.id,
    propertyId: row.property_id,
    roomId: row.room_id,
    items: (row.items as FnbOrderItem[]) ?? [],
    notes: row.notes,
    allergyDeclared: row.allergy_declared,
    allergyDeclaredVia: row.allergy_declared_via,
    kitchenConfirmedBy: row.kitchen_confirmed_by,
    kitchenConfirmedAt: row.kitchen_confirmed_at,
    kitchenConfirmationNote: row.kitchen_confirmation_note,
    safetyAssuranceSentBy: row.safety_assurance_sent_by,
    safetyAssuranceSentAt: row.safety_assurance_sent_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

const FNB_ORDER_COLUMNS = `id, property_id, room_id, items, notes, allergy_declared, allergy_declared_via,
       kitchen_confirmed_by, kitchen_confirmed_at::text as kitchen_confirmed_at,
       kitchen_confirmation_note, safety_assurance_sent_by,
       safety_assurance_sent_at::text as safety_assurance_sent_at, created_by, created_at::text as created_at`;

interface ReservationRawRow {
  id: string;
  organization_id: string;
  property_id: string;
  room_type_id: string;
  guest_id: string | null;
  check_in_date: string;
  check_out_date: string;
  status: ReservationStatus;
  total_amount: string;
  cancellation_penalty_amount: string | null;
  canceled_at: string | null;
  created_at: string;
  room_id: string | null;
}

const RESERVATION_COLUMNS = `id, organization_id, property_id, room_type_id, guest_id,
       check_in_date::text as check_in_date, check_out_date::text as check_out_date, status,
       total_amount, cancellation_penalty_amount, canceled_at::text as canceled_at,
       created_at::text as created_at, room_id`;

function mapReservation(row: ReservationRawRow): ReservationRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    propertyId: row.property_id,
    roomTypeId: row.room_type_id,
    guestId: row.guest_id,
    checkInDate: row.check_in_date,
    checkOutDate: row.check_out_date,
    status: row.status,
    totalAmount: Number(row.total_amount),
    cancellationPenaltyAmount: row.cancellation_penalty_amount == null ? null : Number(row.cancellation_penalty_amount),
    canceledAt: row.canceled_at,
    createdAt: row.created_at,
    roomId: row.room_id,
  };
}

interface FraudAlertRawRow {
  id: string;
  organization_id: string;
  property_id: string;
  pattern: FraudAlertRecord["pattern"];
  folio_id: string | null;
  charge_id: string | null;
  payment_id: string | null;
  reason: string;
  evidence: unknown;
  recipient_roles: unknown;
  dedupe_key: string;
  status: FraudAlertStatus;
  decision_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

const FRAUD_ALERT_COLUMNS = `id, organization_id, property_id, pattern, folio_id, charge_id, payment_id, reason,
       evidence, recipient_roles, dedupe_key, status, decision_note, resolved_by,
       resolved_at::text as resolved_at, created_at::text as created_at`;

function mapFraudAlert(row: FraudAlertRawRow): FraudAlertRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    propertyId: row.property_id,
    pattern: row.pattern,
    folioId: row.folio_id,
    chargeId: row.charge_id,
    paymentId: row.payment_id,
    reason: row.reason,
    evidence: (row.evidence as Record<string, unknown>) ?? {},
    recipientRoles: (row.recipient_roles as string[]) ?? [],
    dedupeKey: row.dedupe_key,
    status: row.status,
    decisionNote: row.decision_note,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

// ---- Fase 11/13 (REQ-CRM-002/003) — reputación/CRM (migrations/013_reputacion.sql
// + migrations/021_reputacion_respuestas.sql). ----

interface GuestReviewRawRow {
  id: string;
  organization_id: string;
  property_id: string;
  guest_id: string | null;
  folio_id: string | null;
  source: GuestReviewRecord["source"];
  external_id: string | null;
  texto: string;
  idioma: string;
  calificacion: number | null;
  stay_state: GuestReviewRecord["stayState"];
  is_public: boolean;
  topics: unknown;
  sentiment: GuestReviewRecord["sentiment"];
  sentiment_score: string;
  created_by: string | null;
  created_at: string;
}

const GUEST_REVIEW_COLUMNS = `id, organization_id, property_id, guest_id, folio_id, source, external_id, texto,
       idioma, calificacion, stay_state, is_public, topics, sentiment,
       sentiment_score::text as sentiment_score, created_by, created_at::text as created_at`;

function mapGuestReview(row: GuestReviewRawRow): GuestReviewRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    propertyId: row.property_id,
    guestId: row.guest_id,
    folioId: row.folio_id,
    source: row.source,
    externalId: row.external_id,
    texto: row.texto,
    idioma: row.idioma,
    calificacion: row.calificacion,
    stayState: row.stay_state,
    isPublic: row.is_public,
    topics: (row.topics as GuestReviewRecord["topics"]) ?? [],
    sentiment: row.sentiment,
    sentimentScore: Number(row.sentiment_score),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

interface GuestReviewActionRawRow {
  id: string;
  organization_id: string;
  property_id: string;
  review_id: string;
  action_type: GuestReviewActionRecord["actionType"];
  status: GuestReviewActionStatus;
  ticket_id: string | null;
  detail: unknown;
  reason: string;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

const GUEST_REVIEW_ACTION_COLUMNS = `id, organization_id, property_id, review_id, action_type, status, ticket_id,
       detail, reason, resolved_by, resolved_at::text as resolved_at, created_at::text as created_at`;

function mapGuestReviewAction(row: GuestReviewActionRawRow): GuestReviewActionRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    propertyId: row.property_id,
    reviewId: row.review_id,
    actionType: row.action_type,
    status: row.status,
    ticketId: row.ticket_id,
    detail: (row.detail as Record<string, unknown>) ?? {},
    reason: row.reason,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

interface GuestReviewResponseRawRow {
  id: string;
  organization_id: string;
  property_id: string;
  review_id: string;
  texto: string;
  created_by: string | null;
  created_at: string;
}

const GUEST_REVIEW_RESPONSE_COLUMNS = `id, organization_id, property_id, review_id, texto, created_by, created_at::text as created_at`;

function mapGuestReviewResponse(row: GuestReviewResponseRawRow): GuestReviewResponseRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    propertyId: row.property_id,
    reviewId: row.review_id,
    texto: row.texto,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

interface CfdiEmisionRawRow {
  id: string;
  organization_id: string;
  property_id: string;
  folio_id: string;
  tipo: CfdiEmisionRecord["tipo"];
  uuid_fiscal: string | null;
  status: CfdiEmisionRecord["status"];
  pac: string | null;
  subtotal: string;
  iva: string;
  ish_tasa: string;
  ish_monto: string;
  dsa_monto: string;
  total: string;
  rfc_receptor: string;
  uso_cfdi: string;
  metodo_pago: string;
  es_extranjero: boolean;
  es_global: boolean;
  es_no_show: boolean;
  related_cfdi_id: string | null;
  payment_id: string | null;
  created_at: string;
  canceled_at: string | null;
}

const CFDI_EMISION_COLUMNS = `id, organization_id, property_id, folio_id, tipo, uuid_fiscal, status, pac,
       subtotal::text as subtotal, iva::text as iva, ish_tasa::text as ish_tasa, ish_monto::text as ish_monto,
       dsa_monto::text as dsa_monto, total::text as total, rfc_receptor, uso_cfdi, metodo_pago,
       es_extranjero, es_global, es_no_show, related_cfdi_id, payment_id,
       created_at::text as created_at, canceled_at::text as canceled_at`;

function mapCfdiEmision(row: CfdiEmisionRawRow): CfdiEmisionRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    propertyId: row.property_id,
    folioId: row.folio_id,
    tipo: row.tipo,
    uuidFiscal: row.uuid_fiscal,
    status: row.status,
    pac: row.pac,
    subtotal: Number(row.subtotal),
    iva: Number(row.iva),
    ishTasa: Number(row.ish_tasa),
    ishMonto: Number(row.ish_monto),
    dsaMonto: Number(row.dsa_monto),
    total: Number(row.total),
    rfcReceptor: row.rfc_receptor,
    usoCfdi: row.uso_cfdi,
    metodoPago: row.metodo_pago,
    esExtranjero: row.es_extranjero,
    esGlobal: row.es_global,
    esNoShow: row.es_no_show,
    relatedCfdiId: row.related_cfdi_id,
    paymentId: row.payment_id,
    createdAt: row.created_at,
    canceledAt: row.canceled_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Fase 6 — H5/REQ-REV-013 night audit + REQ-HK-008/011 housekeeping.
// ─────────────────────────────────────────────────────────────────────────

interface NightAuditRunRawRow {
  id: string;
  organization_id: string;
  property_id: string;
  business_date: string;
  status: NightAuditRunRecord["status"];
  summary: unknown;
  started_at: string;
  completed_at: string | null;
}

const NIGHT_AUDIT_RUN_COLUMNS = `id, organization_id, property_id, business_date::text as business_date, status, summary,
       started_at::text as started_at, completed_at::text as completed_at`;

function mapNightAuditRun(row: NightAuditRunRawRow): NightAuditRunRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    propertyId: row.property_id,
    businessDate: row.business_date,
    status: row.status,
    summary: (row.summary as Record<string, unknown>) ?? {},
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

interface MaintenanceTicketRawRow {
  id: string;
  organization_id: string;
  property_id: string;
  room_id: string | null;
  title: string;
  description: string;
  origin: MaintenanceTicketRecord["origin"];
  severity: MaintenanceTicketRecord["severity"];
  status: MaintenanceTicketStatus;
  assigned_to: string | null;
  estimated_cost: string;
  actual_cost: string | null;
  resolution_note: string | null;
  created_by: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

const MAINTENANCE_TICKET_COLUMNS = `id, organization_id, property_id, room_id, title, description, origin, severity, status,
       assigned_to, estimated_cost::text as estimated_cost, actual_cost::text as actual_cost, resolution_note,
       created_by, closed_at::text as closed_at, created_at::text as created_at, updated_at::text as updated_at`;

function mapMaintenanceTicket(row: MaintenanceTicketRawRow): MaintenanceTicketRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    propertyId: row.property_id,
    roomId: row.room_id,
    title: row.title,
    description: row.description,
    origin: row.origin,
    severity: row.severity,
    status: row.status,
    assignedTo: row.assigned_to,
    estimatedCost: Number(row.estimated_cost),
    actualCost: row.actual_cost == null ? null : Number(row.actual_cost),
    resolutionNote: row.resolution_note,
    createdBy: row.created_by,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface HousekeepingShiftRawRow {
  id: string;
  organization_id: string;
  property_id: string;
  staff_id: string;
  work_date: string;
  start_time: string;
  end_time: string;
  created_at: string;
}

const HOUSEKEEPING_SHIFT_COLUMNS = `id, organization_id, property_id, staff_id, work_date::text as work_date,
       to_char(start_time, 'HH24:MI') as start_time, to_char(end_time, 'HH24:MI') as end_time,
       created_at::text as created_at`;

function mapHousekeepingShift(row: HousekeepingShiftRawRow): HousekeepingShiftRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    propertyId: row.property_id,
    staffId: row.staff_id,
    workDate: row.work_date,
    startTime: row.start_time,
    endTime: row.end_time,
    createdAt: row.created_at,
  };
}

interface AttendanceEventRawRow {
  id: string;
  organization_id: string;
  property_id: string;
  staff_user_id: string;
  event_type: AttendanceEventRecord["eventType"];
  recorded_at: string;
  source: string;
  note: string | null;
  created_at: string;
}

const ATTENDANCE_EVENT_COLUMNS = `id, organization_id, property_id, staff_user_id, event_type,
       recorded_at::text as recorded_at, source, note, created_at::text as created_at`;

function mapAttendanceEvent(row: AttendanceEventRawRow): AttendanceEventRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    propertyId: row.property_id,
    staffUserId: row.staff_user_id,
    eventType: row.event_type,
    recordedAt: row.recorded_at,
    source: row.source,
    note: row.note,
    createdAt: row.created_at,
  };
}

interface StaffScheduleRawRow {
  id: string;
  organization_id: string;
  property_id: string;
  staff_user_id: string;
  work_date: string;
  scheduled_start: string;
  scheduled_end: string;
  authorized_overtime_minutes: number;
  created_at: string;
  updated_at: string;
}

const STAFF_SCHEDULE_COLUMNS = `id, organization_id, property_id, staff_user_id, work_date::text as work_date,
       scheduled_start::text as scheduled_start, scheduled_end::text as scheduled_end,
       authorized_overtime_minutes, created_at::text as created_at, updated_at::text as updated_at`;

function mapStaffSchedule(row: StaffScheduleRawRow): StaffScheduleRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    propertyId: row.property_id,
    staffUserId: row.staff_user_id,
    workDate: row.work_date,
    scheduledStart: row.scheduled_start,
    scheduledEnd: row.scheduled_end,
    authorizedOvertimeMinutes: row.authorized_overtime_minutes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresHotelesRepository implements HotelesRepository {
  constructor(private readonly db: TenantDbSession) {}

  private async loadCharges(folioId: string): Promise<ChargeRecord[]> {
    const { rows } = await this.db.query<ChargeRawRow>(
      `select id, folio_id, description, amount, tax_amount, concept, reversed_by, reverses_charge_id,
              transferred_from_charge_id, discount_authorized_by, created_at::text as created_at
       from hoteles.charge where folio_id = $1 order by created_at asc;`,
      [folioId],
    );
    return rows.map(mapCharge);
  }

  private async loadPayments(folioId: string): Promise<PaymentRecord[]> {
    const { rows } = await this.db.query<PaymentRawRow>(
      `select id, folio_id, amount, method, status, external_ref, token_ref, created_at::text as created_at
       from hoteles.payment where folio_id = $1 order by created_at asc;`,
      [folioId],
    );
    return rows.map(mapPayment);
  }

  private async toFolioRecord(row: FolioRawRow): Promise<FolioRecord> {
    const [charges, payments] = await Promise.all([this.loadCharges(row.id), this.loadPayments(row.id)]);
    return {
      id: row.id,
      organizationId: row.organization_id,
      propertyId: row.property_id,
      reservationId: row.reservation_id,
      status: row.status,
      label: row.label,
      isPrimary: row.is_primary,
      closedAt: row.closed_at,
      closeReason: row.close_reason,
      arApprovedBy: row.ar_approved_by,
      charges,
      payments,
    };
  }

  async findFolio(propertyId: string, folioId: string): Promise<FolioRecord | null> {
    const { rows } = await this.db.query<FolioRawRow>(
      `select id, organization_id, property_id, reservation_id, status, label, is_primary,
              closed_at::text as closed_at, close_reason, ar_approved_by
       from hoteles.folio where id = $1 and property_id = $2;`,
      [folioId, propertyId],
    );
    const row = rows[0];
    return row ? this.toFolioRecord(row) : null;
  }

  async listFoliosByReservation(propertyId: string, reservationId: string): Promise<readonly FolioRecord[]> {
    const { rows } = await this.db.query<FolioRawRow>(
      `select id, organization_id, property_id, reservation_id, status, label, is_primary,
              closed_at::text as closed_at, close_reason, ar_approved_by
       from hoteles.folio where reservation_id = $1 and property_id = $2 order by is_primary desc, id asc;`,
      [reservationId, propertyId],
    );
    return Promise.all(rows.map((row) => this.toFolioRecord(row)));
  }

  async loadFolioGuestIdentity(reservationId: string): Promise<GuestIdentity> {
    const { rows } = await this.db.query<{ full_name: string | null; phone: string | null }>(
      `select g.full_name, g.phone
       from hoteles.reservation r
       join hoteles.guest g on g.id = r.guest_id
       where r.id = $1;`,
      [reservationId],
    );
    const row = rows[0];
    if (!row) return { lastName: null, phoneLast4: null };
    const nameParts = (row.full_name ?? "").trim().split(/\s+/).filter(Boolean);
    const lastName = nameParts.length > 0 ? nameParts[nameParts.length - 1]! : null;
    const phoneLast4 = row.phone && row.phone.length >= 4 ? row.phone.slice(-4) : null;
    return { lastName, phoneLast4 };
  }

  async isAdminStaff(propertyId: string, userId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ vertical_role: string }>(
      `select m.vertical_role
       from core.membership m
       join core.property p on p.organization_id = m.organization_id
       where p.id = $1 and m.user_id = $2 and (m.property_ids is null or p.id = any(m.property_ids));`,
      [propertyId, userId],
    );
    return rows.length > 0 && ["owner", "gm"].includes(rows[0]!.vertical_role);
  }

  async loadTaxConfig(propertyId: string): Promise<TaxConfigRecord> {
    const { rows } = await this.db.query<{ iva_rate: string; ish_rate: string; discount_threshold: string }>(
      `select iva_rate, ish_rate, discount_threshold from hoteles.tax_config where property_id = $1;`,
      [propertyId],
    );
    const row = rows[0];
    if (!row) throw new Error(`No hay hoteles.tax_config configurado para property "${propertyId}".`);
    return { ivaRate: Number(row.iva_rate), ishRate: Number(row.ish_rate), discountThreshold: Number(row.discount_threshold) };
  }

  async insertCharge(input: NewChargeInput): Promise<{ id: string; createdAt: string }> {
    const { rows } = await this.db.query<{ id: string; created_at: string }>(
      `insert into hoteles.charge
         (organization_id, property_id, folio_id, description, amount, tax_amount, concept,
          reverses_charge_id, transferred_from_charge_id, discount_authorized_by, stay_date)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning id, created_at::text as created_at;`,
      [
        input.organizationId,
        input.propertyId,
        input.folioId,
        input.description,
        input.amount,
        input.taxAmount,
        input.concept,
        input.reversesChargeId ?? null,
        input.transferredFromChargeId ?? null,
        input.discountAuthorizedBy ?? null,
        input.stayDate ?? null,
      ],
    );
    return { id: rows[0]!.id, createdAt: rows[0]!.created_at };
  }

  async findCharge(folioId: string, chargeId: string) {
    const { rows } = await this.db.query<ChargeRawRow>(
      `select id, folio_id, description, amount, tax_amount, concept, reversed_by, reverses_charge_id,
              transferred_from_charge_id, discount_authorized_by, created_at::text as created_at
       from hoteles.charge where id = $1 and folio_id = $2;`,
      [chargeId, folioId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      description: row.description,
      amount: Number(row.amount),
      taxAmount: Number(row.tax_amount),
      concept: row.concept,
      reversedBy: row.reversed_by,
    };
  }

  async markChargeReversed(chargeId: string, reversalChargeId: string): Promise<void> {
    await this.db.query("select hoteles.mark_charge_reversed($1, $2);", [chargeId, reversalChargeId]);
  }

  async insertPayment(input: NewPaymentInput): Promise<{ id: string; createdAt: string }> {
    const { rows } = await this.db.query<{ id: string; created_at: string }>(
      `insert into hoteles.payment (organization_id, property_id, folio_id, amount, method, status, external_ref, token_ref)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id, created_at::text as created_at;`,
      [input.organizationId, input.propertyId, input.folioId, input.amount, input.method, input.status, input.externalRef ?? null, input.tokenRef ?? null],
    );
    return { id: rows[0]!.id, createdAt: rows[0]!.created_at };
  }

  async createFolio(propertyId: string, organizationId: string, reservationId: string, label: string): Promise<{ id: string }> {
    const { rows } = await this.db.query<{ id: string }>(
      `insert into hoteles.folio (organization_id, property_id, reservation_id, label, is_primary)
       values ($1, $2, $3, $4, false)
       returning id;`,
      [organizationId, propertyId, reservationId, label],
    );
    return rows[0]!;
  }

  async ensurePrimaryFolio(propertyId: string, organizationId: string, reservationId: string): Promise<{ id: string }> {
    const inserted = await this.db.query<{ id: string }>(
      `insert into hoteles.folio (organization_id, property_id, reservation_id, label, is_primary)
       values ($1, $2, $3, 'Principal', true)
       on conflict (reservation_id) where is_primary do nothing
       returning id;`,
      [organizationId, propertyId, reservationId],
    );
    if (inserted.rows[0]) return inserted.rows[0];
    const existing = await this.db.query<{ id: string }>(
      `select id from hoteles.folio where reservation_id = $1 and is_primary limit 1;`,
      [reservationId],
    );
    if (!existing.rows[0]) {
      throw new Error(`ensurePrimaryFolio: no se pudo crear ni encontrar el folio primario de la reserva ${reservationId}.`);
    }
    return existing.rows[0];
  }

  async closeFolio(folioId: string, reason: "saldo_cero" | "cuenta_por_cobrar", arApprovedBy: string | null): Promise<void> {
    await this.db.query(
      `update hoteles.folio set status = 'cerrado', closed_at = now(), close_reason = $1, ar_approved_by = $2, updated_at = now()
       where id = $3;`,
      [reason, arApprovedBy, folioId],
    );
  }

  async listFnbOrders(propertyId: string): Promise<readonly FnbOrderRecord[]> {
    const { rows } = await this.db.query<FnbOrderRawRow>(
      `select ${FNB_ORDER_COLUMNS} from hoteles.fnb_order where property_id = $1 order by created_at desc;`,
      [propertyId],
    );
    return rows.map(mapFnbOrder);
  }

  async findFnbOrder(propertyId: string, orderId: string): Promise<FnbOrderRecord | null> {
    const { rows } = await this.db.query<FnbOrderRawRow>(
      `select ${FNB_ORDER_COLUMNS} from hoteles.fnb_order where id = $1 and property_id = $2;`,
      [orderId, propertyId],
    );
    const row = rows[0];
    return row ? mapFnbOrder(row) : null;
  }

  async insertFnbOrder(input: NewFnbOrderInput): Promise<FnbOrderRecord> {
    const { rows } = await this.db.query<FnbOrderRawRow>(
      `insert into hoteles.fnb_order
         (organization_id, property_id, room_id, items, notes, allergy_declared, allergy_declared_via, created_by)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
       returning ${FNB_ORDER_COLUMNS};`,
      [input.organizationId, input.propertyId, input.roomId, JSON.stringify(input.items), input.notes, input.allergyDeclared, input.allergyDeclaredVia, input.createdBy],
    );
    return mapFnbOrder(rows[0]!);
  }

  async confirmFnbKitchen(propertyId: string, orderId: string, userId: string, note: string | null): Promise<FnbOrderRecord | null> {
    const { rows } = await this.db.query<FnbOrderRawRow>(
      `update hoteles.fnb_order
       set kitchen_confirmed_by = $1, kitchen_confirmed_at = now(), kitchen_confirmation_note = $2, updated_at = now()
       where id = $3 and property_id = $4
       returning ${FNB_ORDER_COLUMNS};`,
      [userId, note, orderId, propertyId],
    );
    const row = rows[0];
    return row ? mapFnbOrder(row) : null;
  }

  async assureFnbSafety(propertyId: string, orderId: string, userId: string): Promise<FnbOrderRecord | null> {
    const { rows } = await this.db.query<FnbOrderRawRow>(
      `update hoteles.fnb_order
       set safety_assurance_sent_by = $1, safety_assurance_sent_at = now(), updated_at = now()
       where id = $2 and property_id = $3
       returning ${FNB_ORDER_COLUMNS};`,
      [userId, orderId, propertyId],
    );
    const row = rows[0];
    return row ? mapFnbOrder(row) : null;
  }

  async findRoomType(propertyId: string, roomTypeId: string): Promise<{ id: string } | null> {
    const { rows } = await this.db.query<{ id: string }>(
      `select id from hoteles.room_type where id = $1 and property_id = $2;`,
      [roomTypeId, propertyId],
    );
    return rows[0] ?? null;
  }

  /** Fase 12 — insumo de guest-email-notifications.ts (nombre real del tipo de
   *  habitación para el correo de confirmación de reserva). */
  async findRoomTypeSummary(propertyId: string, roomTypeId: string): Promise<RoomTypeSummary | null> {
    const { rows } = await this.db.query<{ id: string; name: string; max_occupancy: number }>(
      `select id, name, max_occupancy from hoteles.room_type where id = $1 and property_id = $2;`,
      [roomTypeId, propertyId],
    );
    const row = rows[0];
    return row ? { id: row.id, name: row.name, maxOccupancy: row.max_occupancy } : null;
  }

  async loadNightlyRates(propertyId: string, roomTypeId: string, checkInDate: string, checkOutDate: string): Promise<readonly NightlyRateRecord[]> {
    const { rows } = await this.db.query<{
      date: string;
      price: string;
      min_stay: number;
      closed_to_arrival: boolean;
      closed_to_departure: boolean;
    }>(
      `select date::text as date, price, min_stay, closed_to_arrival, closed_to_departure
       from hoteles.rate_plan
       where property_id = $1 and room_type_id = $2 and date >= $3 and date <= $4
       order by date asc;`,
      [propertyId, roomTypeId, checkInDate, checkOutDate],
    );
    return rows.map((r) => ({
      date: r.date,
      price: Number(r.price),
      minStay: r.min_stay,
      closedToArrival: r.closed_to_arrival,
      closedToDeparture: r.closed_to_departure,
    }));
  }

  // ---- HotelesRepository: Fix hallazgo ALTA — catálogos para "crear reserva" ----

  async listRoomTypes(propertyId: string): Promise<readonly RoomTypeSummary[]> {
    const { rows } = await this.db.query<{ id: string; name: string; max_occupancy: number }>(
      `select id, name, max_occupancy from hoteles.room_type where property_id = $1 order by name asc;`,
      [propertyId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, maxOccupancy: r.max_occupancy }));
  }

  async searchGuests(propertyId: string, query: string | null, limit = 20): Promise<readonly GuestSummary[]> {
    const needle = query?.trim() ?? "";
    // `ilike` insensible a mayúsculas, mismo criterio de "contains" que el adaptador
    // en memoria -- `%needle%` vacío (`%%`) matchea cualquier fila, así que una
    // búsqueda sin texto simplemente devuelve las primeras `limit` en orden
    // alfabético (insumo de un autocomplete recién abierto, antes de que el staff
    // escriba nada).
    const { rows } = await this.db.query<{ id: string; full_name: string; email: string | null; phone: string | null }>(
      `select id, full_name, email, phone
       from hoteles.guest
       where property_id = $1 and (full_name ilike $2 or email ilike $2 or phone ilike $2)
       order by full_name asc
       limit $3;`,
      [propertyId, `%${needle}%`, limit],
    );
    return rows.map((r) => ({ id: r.id, fullName: r.full_name, email: r.email, phone: r.phone }));
  }

  // ---- Fix hallazgo CRÍTICO — alta REAL de catálogo (ver migrations/018_admin_catalogo_alta.sql
  // para el GRANT/policy que habilita estos 6 métodos, antes solo SELECT). `23505`
  // (unique_violation de Postgres) se traduce SIEMPRE a un `Error` con un prefijo
  // reconocible en vez de dejar propagar el error crudo del driver — MISMO patrón
  // exacto que `insertReservation`/`bookAvailability` ya usan para que la ruta HTTP
  // (reservas.ts) traduzca `err.message.startsWith(...)` a un status HTTP real. ----

  async insertRoomType(input: NewRoomTypeInput): Promise<RoomTypeSummary> {
    try {
      const { rows } = await this.db.query<{ id: string; name: string; max_occupancy: number }>(
        `insert into hoteles.room_type (organization_id, property_id, name, max_occupancy)
         values ($1, $2, $3, $4)
         returning id, name, max_occupancy;`,
        [input.organizationId, input.propertyId, input.name, input.maxOccupancy],
      );
      const row = rows[0]!;
      return { id: row.id, name: row.name, maxOccupancy: row.max_occupancy };
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new Error(`nombre_duplicado: ya existe un tipo de habitación llamado "${input.name}" en esta property.`);
      throw err;
    }
  }

  async listRooms(propertyId: string, roomTypeId?: string | null): Promise<readonly RoomSummary[]> {
    const { rows } = await this.db.query<{ id: string; code: string; status: RoomSummary["status"]; room_type_id: string }>(
      roomTypeId
        ? `select id, code, status, room_type_id from hoteles.room where property_id = $1 and room_type_id = $2 order by code asc;`
        : `select id, code, status, room_type_id from hoteles.room where property_id = $1 order by code asc;`,
      roomTypeId ? [propertyId, roomTypeId] : [propertyId],
    );
    return rows.map((r) => ({ id: r.id, code: r.code, status: r.status, roomTypeId: r.room_type_id }));
  }

  async findRoom(propertyId: string, roomId: string): Promise<RoomSummary | null> {
    const { rows } = await this.db.query<{ id: string; code: string; status: RoomSummary["status"]; room_type_id: string }>(
      `select id, code, status, room_type_id from hoteles.room where id = $1 and property_id = $2;`,
      [roomId, propertyId],
    );
    const row = rows[0];
    return row ? { id: row.id, code: row.code, status: row.status, roomTypeId: row.room_type_id } : null;
  }

  async insertRoom(input: NewRoomInput): Promise<RoomSummary> {
    try {
      const { rows } = await this.db.query<{ id: string; code: string; status: RoomSummary["status"]; room_type_id: string }>(
        `insert into hoteles.room (organization_id, property_id, room_type_id, code)
         values ($1, $2, $3, $4)
         returning id, code, status, room_type_id;`,
        [input.organizationId, input.propertyId, input.roomTypeId, input.code],
      );
      const row = rows[0]!;
      return { id: row.id, code: row.code, status: row.status, roomTypeId: row.room_type_id };
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new Error(`codigo_duplicado: ya existe una habitación con el código "${input.code}" en esta property.`);
      throw err;
    }
  }

  async upsertRatePlanRange(input: NewRatePlanRangeInput): Promise<{ datesWritten: number }> {
    // Una fila por fecha del rango [startDate, endDate] (inclusive en ambos
    // extremos) -- `generate_series` sobre `date` en vez de un loop en TS, para que
    // el INSERT completo sea una sola ida y vuelta a Postgres, atómica. El
    // `ON CONFLICT (room_type_id, date)` reutiliza el índice único YA existente
    // desde migrations/001 (`unique (room_type_id, date)`): un rango que traslapa
    // fechas ya sembradas las SOBREESCRIBE, nunca lanza por duplicado.
    const { rows } = await this.db.query<{ n: string }>(
      `insert into hoteles.rate_plan (organization_id, property_id, room_type_id, date, price, currency, min_stay, closed_to_arrival, closed_to_departure)
       select $1, $2, $3, d::date, $4, $5, $6, $7, $8
       from generate_series($9::date, $10::date, interval '1 day') as d
       on conflict (room_type_id, date) do update
         set price = excluded.price,
             currency = excluded.currency,
             min_stay = excluded.min_stay,
             closed_to_arrival = excluded.closed_to_arrival,
             closed_to_departure = excluded.closed_to_departure,
             updated_at = now()
       returning 1 as n;`,
      [
        input.organizationId,
        input.propertyId,
        input.roomTypeId,
        input.price,
        input.currency,
        input.minStay,
        input.closedToArrival,
        input.closedToDeparture,
        input.startDate,
        input.endDate,
      ],
    );
    return { datesWritten: rows.length };
  }

  async insertGuest(input: NewGuestInput): Promise<GuestSummary> {
    const { rows } = await this.db.query<{ id: string; full_name: string; email: string | null; phone: string | null }>(
      `insert into hoteles.guest (organization_id, property_id, full_name, email, phone)
       values ($1, $2, $3, $4, $5)
       returning id, full_name, email, phone;`,
      [input.organizationId, input.propertyId, input.fullName, input.email, input.phone],
    );
    const row = rows[0]!;
    return { id: row.id, fullName: row.full_name, email: row.email, phone: row.phone };
  }

  async assignRoomToReservation(propertyId: string, reservationId: string, roomId: string): Promise<ReservationRecord | null> {
    const { rows } = await this.db.query<ReservationRawRow>(
      `update hoteles.reservation
       set room_id = $1
       where id = $2 and property_id = $3
       returning ${RESERVATION_COLUMNS};`,
      [roomId, reservationId, propertyId],
    );
    const row = rows[0];
    return row ? mapReservation(row) : null;
  }

  /** Fase 12 — insumo de guest-email-notifications.ts (huésped YA ligado a una
   *  reserva concreta, a diferencia de `searchGuests`, que es el catálogo completo
   *  de la property para el autocomplete de "crear reserva"). */
  async findGuestById(propertyId: string, guestId: string): Promise<GuestSummary | null> {
    const { rows } = await this.db.query<{ id: string; full_name: string; email: string | null; phone: string | null }>(
      `select id, full_name, email, phone from hoteles.guest where id = $1 and property_id = $2;`,
      [guestId, propertyId],
    );
    const row = rows[0];
    return row ? { id: row.id, fullName: row.full_name, email: row.email, phone: row.phone } : null;
  }

  // ---- HotelesRepository: Fase 3 — máquina de estados de reservas (H02) ----

  async listReservations(propertyId: string): Promise<readonly ReservationRecord[]> {
    const { rows } = await this.db.query<ReservationRawRow>(
      `select ${RESERVATION_COLUMNS} from hoteles.reservation where property_id = $1 order by created_at desc;`,
      [propertyId],
    );
    return rows.map(mapReservation);
  }

  async listReservationsPage(propertyId: string, opts: { readonly limit: number; readonly offset: number }): Promise<ReservationPage> {
    const { rows } = await this.db.query<ReservationRawRow & { total: string }>(
      `select ${RESERVATION_COLUMNS}, count(*) over ()::text as total from hoteles.reservation where property_id = $1 order by created_at desc limit $2 offset $3;`,
      [propertyId, opts.limit, opts.offset],
    );
    const items = rows.map(mapReservation);
    const total = rows[0] ? Number(rows[0].total) : 0;
    const nextOffset = opts.offset + items.length < total ? opts.offset + items.length : null;
    return { items, total, nextOffset };
  }

  async findReservation(propertyId: string, reservationId: string): Promise<ReservationRecord | null> {
    const { rows } = await this.db.query<ReservationRawRow>(
      `select ${RESERVATION_COLUMNS} from hoteles.reservation where id = $1 and property_id = $2;`,
      [reservationId, propertyId],
    );
    const row = rows[0];
    return row ? mapReservation(row) : null;
  }

  async insertReservation(input: NewReservationInput): Promise<ReservationRecord> {
    // `POST crear` aterriza directo en `confirmada` (diseño §3.2). El `ON CONFLICT`
    // apunta al índice único parcial `reservation_property_idempotency_key_idx` — con
    // `idempotency_key IS NULL` (llamador sin Idempotency-Key) Postgres nunca considera
    // esta fila candidata a conflicto (los NULL no participan en un índice parcial
    // `where idempotency_key is not null`), así que el INSERT procede normal.
    const inserted = await this.db.query<ReservationRawRow>(
      `insert into hoteles.reservation
         (organization_id, property_id, room_type_id, guest_id, check_in_date, check_out_date, status, total_amount, idempotency_key)
       values ($1, $2, $3, $4, $5, $6, 'confirmada', $7, $8)
       on conflict (property_id, idempotency_key) where idempotency_key is not null do nothing
       returning ${RESERVATION_COLUMNS};`,
      [
        input.organizationId,
        input.propertyId,
        input.roomTypeId,
        input.guestId,
        input.checkInDate,
        input.checkOutDate,
        input.totalAmount,
        input.idempotencyKey ?? null,
      ],
    );
    if (inserted.rows[0]) return mapReservation(inserted.rows[0]);

    // Conflicto: ya existía una reserva con este idempotencyKey para esta property —
    // se devuelve la existente (mismo criterio idempotente que `withIdempotency`).
    const existing = await this.db.query<ReservationRawRow>(
      `select ${RESERVATION_COLUMNS} from hoteles.reservation where property_id = $1 and idempotency_key = $2;`,
      [input.propertyId, input.idempotencyKey],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new Error("insertReservation: conflicto de idempotencia sin fila existente (la fila que causó el conflicto se revirtió entre el INSERT y este SELECT).");
    }
    return mapReservation(row);
  }

  /** Fija el actor lógico de la transición para que el trigger AFTER
   *  (`reservation_log_status_event`) lo lea vía `current_setting('hoteles.actor_user_id', true)`
   *  — `null` (actor "system", ver migrations/005 §3) se traduce a cadena vacía, que el
   *  trigger normaliza de vuelta a NULL con `nullif(...)`. */
  private async setActorForTransition(actorUserId: string | null): Promise<void> {
    await this.db.query(`select set_config('hoteles.actor_user_id', $1, true);`, [actorUserId ?? ""]);
  }

  async transitionReservation(
    propertyId: string,
    reservationId: string,
    fromStatuses: readonly ReservationStatus[],
    toStatus: ReservationStatus,
    actorUserId: string | null,
  ): Promise<ReservationRecord | null> {
    await this.setActorForTransition(actorUserId);
    const { rows } = await this.db.query<ReservationRawRow>(
      `update hoteles.reservation
       set status = $1
       where id = $2 and property_id = $3 and status = any($4::hoteles.reservation_status[])
       returning ${RESERVATION_COLUMNS};`,
      [toStatus, reservationId, propertyId, fromStatuses],
    );
    const row = rows[0];
    return row ? mapReservation(row) : null;
  }

  async cancelReservation(propertyId: string, reservationId: string, penaltyAmount: number, actorUserId: string | null): Promise<ReservationRecord | null> {
    await this.setActorForTransition(actorUserId);
    const { rows } = await this.db.query<ReservationRawRow>(
      `update hoteles.reservation
       set status = 'cancelada', canceled_at = now(), cancellation_penalty_amount = $1
       where id = $2 and property_id = $3 and status in ('cotizada', 'confirmada')
       returning ${RESERVATION_COLUMNS};`,
      [penaltyAmount, reservationId, propertyId],
    );
    const row = rows[0];
    return row ? mapReservation(row) : null;
  }

  async releaseAvailability(propertyId: string, roomTypeId: string, date: string, qty: number): Promise<void> {
    await this.db.query(`select hoteles.release_availability($1, $2, $3, $4);`, [propertyId, roomTypeId, date, qty]);
  }

  async bookAvailability(propertyId: string, roomTypeId: string, date: string, qty: number): Promise<void> {
    await this.db.query(`select hoteles.book_availability($1, $2, $3, $4);`, [propertyId, roomTypeId, date, qty]);
  }

  async loadReservationCancellationPolicy(propertyId: string): Promise<CancellationPolicyRecord | null> {
    const { rows } = await this.db.query<{ free_until_hours: number; penalty_pct: string }>(
      `select free_until_hours, penalty_pct from hoteles.cancellation_policy where property_id = $1;`,
      [propertyId],
    );
    const row = rows[0];
    if (!row) return null;
    return { freeUntilHours: row.free_until_hours, penaltyPct: Number(row.penalty_pct) };
  }

  async findDueNoShowReservations(propertyId: string, asOfDate: string | null): Promise<readonly ReservationRecord[]> {
    const { rows } = await this.db.query<ReservationRawRow>(
      `select ${RESERVATION_COLUMNS} from hoteles.reservation
       where property_id = $1 and status = 'confirmada' and check_in_date <= coalesce($2::date, current_date)
       order by check_in_date asc;`,
      [propertyId, asOfDate],
    );
    return rows.map(mapReservation);
  }

  async withIdempotency<T>(params: IdempotencyParams, run: () => Promise<IdempotentResult<T>>): Promise<IdempotentResult<T>> {
    const requestHash = hashBody(params.body);

    // Una llave ya EXPIRADA se reclama de nuevo atómicamente vía
    // `DO UPDATE ... WHERE expires_at < now()` — mismo patrón que
    // hoteles/apps/api/src/lib/idempotency.ts.
    const claim = await this.db.query<{ id: string }>(
      `insert into hoteles.idempotency_key (organization_id, scope, key, request_hash, expires_at)
       values ($1, $2, $3, $4, now() + ($5 || ' days')::interval)
       on conflict (organization_id, scope, key) do update
         set request_hash = excluded.request_hash,
             response = null,
             created_at = now(),
             expires_at = excluded.expires_at
         where hoteles.idempotency_key.expires_at < now()
       returning id;`,
      [params.organizationId, params.scope, params.key, requestHash, String(IDEMPOTENCY_KEY_TTL_DAYS)],
    );

    if (claim.rows.length === 0) {
      const existing = await this.db.query<{ request_hash: string; response: IdempotentResult<T> | null }>(
        `select request_hash, response from hoteles.idempotency_key
         where organization_id = $1 and scope = $2 and key = $3;`,
        [params.organizationId, params.scope, params.key],
      );
      const row = existing.rows[0];
      if (!row) {
        // La fila que causó el conflicto se revirtió (rollback) entre el INSERT y
        // este SELECT: trátese como si nunca hubiera existido, reintenta una sola vez.
        return this.withIdempotency(params, run);
      }
      if (row.request_hash !== requestHash) throw new IdempotencyConflictError();
      if (row.response == null) {
        throw new Error("La solicitud original con este Idempotency-Key aún no terminó de procesarse.");
      }
      return row.response;
    }

    const result = await run();

    await this.db.query(`update hoteles.idempotency_key set response = $1 where organization_id = $2 and scope = $3 and key = $4;`, [
      JSON.stringify(result),
      params.organizationId,
      params.scope,
      params.key,
    ]);

    return result;
  }

  // ---- HotelesRepository: Fase 2 — voz/WhatsApp (§1-§3) ----

  async consumeRateLimit(scope: string, actorHash: string, maxRequests: number, windowSeconds: number): Promise<boolean> {
    const { rows } = await this.db.query<{ consume_api_rate_limit: boolean }>(
      `select hoteles.consume_api_rate_limit($1, $2, $3, $4) as consume_api_rate_limit;`,
      [scope, actorHash, maxRequests, windowSeconds],
    );
    return rows[0]?.consume_api_rate_limit === true;
  }

  async findVoiceAgentConfig(propertyId: string): Promise<VoiceAgentConfig | null> {
    // Fase "flujos de sistema": `findVoiceAgentConfig` SOLO se invoca hoy
    // bajo sesión de sistema (`POST /v1/hoteles/:propertyId/voz/tickets-fnb`
    // y `.../voz/contacto-no-operativo`, sin caller de staff autenticado). Un
    // SELECT directo contra `hoteles.voice_agent_config` queda bloqueado por
    // la policy `for all` (exige `auth.uid()` real) -- se usa la función
    // `security definer` de solo-sistema
    // `hoteles.system_find_voice_agent_config` (migración
    // `..._022_hoteles_sistema_voz_whatsapp_escritura.sql`) en su lugar. Ver
    // el header de esa migración para el diagnóstico completo (incluye por
    // qué NO se usa escape hatch de policy aquí: la tabla trae una
    // credencial, `tool_webhook_secret`).
    const { rows } = await this.db.query<{ out_property_id: string; out_organization_id: string; out_tool_webhook_secret: string; out_enabled: boolean }>(
      `select * from hoteles.system_find_voice_agent_config($1);`,
      [propertyId],
    );
    const row = rows[0];
    if (!row) return null;
    return { propertyId: row.out_property_id, organizationId: row.out_organization_id, toolWebhookSecret: row.out_tool_webhook_secret, enabled: row.out_enabled };
  }

  async upsertVoiceAgentConfig(propertyId: string, organizationId: string, toolWebhookSecret: string, enabled: boolean): Promise<void> {
    await this.db.query(
      `insert into hoteles.voice_agent_config (property_id, organization_id, tool_webhook_secret, enabled)
       values ($1, $2, $3, $4)
       on conflict (property_id) do update
         set tool_webhook_secret = excluded.tool_webhook_secret, enabled = excluded.enabled, updated_at = now();`,
      [propertyId, organizationId, toolWebhookSecret, enabled],
    );
  }

  async resolvePropertyByPhoneNumberId(phoneNumberId: string): Promise<WhatsAppPropertyRoute | null> {
    const { rows } = await this.db.query<{ property_id: string; organization_id: string }>(
      `select property_id, organization_id from hoteles.whatsapp_channel_config where phone_number_id = $1 and enabled;`,
      [phoneNumberId],
    );
    const row = rows[0];
    return row ? { propertyId: row.property_id, organizationId: row.organization_id } : null;
  }

  async claimWhatsAppMessage(propertyId: string, messageId: string, phoneHash: string): Promise<boolean> {
    const { rows } = await this.db.query<{ claim_whatsapp_message: boolean }>(
      `select hoteles.claim_whatsapp_message($1, $2, $3) as claim_whatsapp_message;`,
      [propertyId, messageId, phoneHash],
    );
    return rows[0]?.claim_whatsapp_message === true;
  }

  async claimWhatsAppConversation(propertyId: string, phoneHash: string, messageId: string, leaseSeconds: number): Promise<boolean> {
    const { rows } = await this.db.query<{ claim_whatsapp_conversation: boolean }>(
      `select hoteles.claim_whatsapp_conversation($1, $2, $3, $4) as claim_whatsapp_conversation;`,
      [propertyId, phoneHash, messageId, leaseSeconds],
    );
    return rows[0]?.claim_whatsapp_conversation === true;
  }

  async appendWhatsAppUserMessageOnce(propertyId: string, phone: string, message: ConversationMessage): Promise<readonly ConversationMessage[]> {
    const route = await this.resolvePropertyOrganization(propertyId);
    const { rows } = await this.db.query<{ append_whatsapp_user_message_once: ConversationMessage[] }>(
      `select hoteles.append_whatsapp_user_message_once($1, $2, $3, $4, $5::jsonb) as append_whatsapp_user_message_once;`,
      [propertyId, route, `msg:${phone}:${Date.now()}`, phone, JSON.stringify(message)],
    );
    return rows[0]?.append_whatsapp_user_message_once ?? [message];
  }

  async whatsappAppendTurn(
    propertyId: string,
    phone: string,
    newMessages: readonly ConversationMessage[],
    status: "active" | "completed" | "abandoned" | null,
    fnbOrderId: string | null,
  ): Promise<readonly ConversationMessage[]> {
    const route = await this.resolvePropertyOrganization(propertyId);
    const { rows } = await this.db.query<{ whatsapp_append_turn: ConversationMessage[] }>(
      `select hoteles.whatsapp_append_turn($1, $2, $3, $4::jsonb, $5, $6) as whatsapp_append_turn;`,
      [propertyId, route, phone, JSON.stringify(newMessages), status, fnbOrderId],
    );
    return rows[0]?.whatsapp_append_turn ?? [];
  }

  async finishWhatsAppMessage(propertyId: string, messageId: string, phoneHash: string, status: "processed" | "failed", errorClass: string | null): Promise<void> {
    await this.db.query(`select hoteles.finish_whatsapp_message($1, $2, $3, $4, $5);`, [propertyId, messageId, phoneHash, status, errorClass]);
  }

  async markInboundEventFailed(propertyId: string, messageId: string, errorClass: string): Promise<void> {
    await this.db.query(
      `update hoteles.whatsapp_inbound_events set status = 'failed', last_error_class = $3
       where message_id = $2 and property_id = $1;`,
      [propertyId, messageId, errorClass],
    );
  }

  // ---- Dispatcher real de messaging_outbox (migrations/008) ----

  async enqueueMessagingOutbox(propertyId: string, organizationId: string, channel: "whatsapp" | "email", eventType: string, dedupeKey: string, payload: unknown): Promise<void> {
    await this.db.query(`select hoteles.enqueue_messaging_outbox($1, $2, $3, $4, $5, $6::jsonb);`, [propertyId, organizationId, channel, eventType, dedupeKey, JSON.stringify(payload)]);
  }

  async claimMessagingOutboxBatch(limit: number, leaseSeconds: number): Promise<readonly MessagingOutboxRow[]> {
    const { rows } = await this.db.query<{ id: string; attempts: number; payload: unknown }>(`select id, attempts, payload from hoteles.claim_messaging_outbox_batch($1, $2);`, [limit, leaseSeconds]);
    return rows.map((r) => ({ id: r.id, attempts: r.attempts, payload: r.payload }));
  }

  async markMessagingOutboxSent(id: string): Promise<void> {
    await this.db.query(`select hoteles.complete_messaging_outbox_sent($1);`, [id]);
  }

  async markMessagingOutboxRetry(id: string, attempts: number, errorClass: string, nextAttemptAtIso: string): Promise<void> {
    await this.db.query(`select hoteles.complete_messaging_outbox_retry($1, $2, $3, $4);`, [id, attempts, errorClass, nextAttemptAtIso]);
  }

  async markMessagingOutboxDead(id: string, attempts: number, errorClass: string): Promise<void> {
    await this.db.query(`select hoteles.complete_messaging_outbox_dead($1, $2, $3);`, [id, attempts, errorClass]);
  }

  async insertContactoNoOperativo(input: NewContactoNoOperativoInput): Promise<ContactoNoOperativoRecord> {
    const { rows } = await this.db.query<{
      id: string;
      organization_id: string;
      property_id: string;
      guest_phone: string | null;
      guest_name: string | null;
      reason: string;
      message: string | null;
      source: ContactoNoOperativoRecord["source"];
      created_at: string;
    }>(
      `insert into hoteles.contacto_no_operativo (organization_id, property_id, guest_phone, guest_name, reason, message, source)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, organization_id, property_id, guest_phone, guest_name, reason, message, source, created_at::text as created_at;`,
      [input.organizationId, input.propertyId, input.guestPhone, input.guestName, input.reason, input.message, input.source],
    );
    const row = rows[0]!;
    return {
      id: row.id,
      organizationId: row.organization_id,
      propertyId: row.property_id,
      guestPhone: row.guest_phone,
      guestName: row.guest_name,
      reason: row.reason,
      message: row.message,
      source: row.source,
      createdAt: row.created_at,
    };
  }

  /** `whatsapp_append_turn`/`append_whatsapp_user_message_once` de hoteles
   *  necesitan `organization_id` además de `property_id` (a diferencia de
   *  restaurantes, que solo particiona por `organization_id`) porque
   *  `hoteles.whatsapp_conversations.organization_id` es `not null` — la
   *  conversación ya viene resuelta desde `resolvePropertyByPhoneNumberId` en
   *  el webhook, así que esto solo re-lee la fila de config canónica. */
  private async resolvePropertyOrganization(propertyId: string): Promise<string> {
    const { rows } = await this.db.query<{ organization_id: string }>(
      `select organization_id from core.property where id = $1;`,
      [propertyId],
    );
    const organizationId = rows[0]?.organization_id;
    if (!organizationId) throw new Error(`Property "${propertyId}" no encontrada al resolver su organización para WhatsApp.`);
    return organizationId;
  }

  // ---- HotelesRepository: Fase 5 — H16-014/REQ-REC-014 fraude interno ----

  async listDiscountChargesForFraudScan(propertyId: string): Promise<readonly DiscountChargeForFraudScan[]> {
    const { rows } = await this.db.query<{ charge_id: string; folio_id: string; amount: string; discount_authorized_by: string | null }>(
      `select c.id as charge_id, c.folio_id, c.amount::text as amount, c.discount_authorized_by
       from hoteles.charge c
       where c.property_id = $1 and c.concept = 'descuento' and c.reversed_by is null;`,
      [propertyId],
    );
    return rows.map((r) => ({ chargeId: r.charge_id, folioId: r.folio_id, amount: Number(r.amount), discountAuthorizedBy: r.discount_authorized_by }));
  }

  async listReopenedFolioChargesForFraudScan(propertyId: string): Promise<readonly ReopenedFolioChargeForFraudScan[]> {
    const { rows } = await this.db.query<{ folio_id: string; closed_at: string; charge_id: string; charge_created_at: string }>(
      `select f.id as folio_id, f.closed_at::text as closed_at, c.id as charge_id, c.created_at::text as charge_created_at
       from hoteles.folio f
       join hoteles.charge c on c.folio_id = f.id
       where f.property_id = $1 and f.closed_at is not null and c.created_at > f.closed_at;`,
      [propertyId],
    );
    return rows.map((r) => ({ folioId: r.folio_id, folioClosedAt: r.closed_at, chargeId: r.charge_id, chargeCreatedAt: r.charge_created_at }));
  }

  async recordFraudAlert(input: NewFraudAlertInput): Promise<{ record: FraudAlertRecord; isNew: boolean }> {
    const inserted = await this.db.query<FraudAlertRawRow>(
      `insert into hoteles.fraud_alert
         (organization_id, property_id, pattern, folio_id, charge_id, payment_id, reason, evidence, recipient_roles, dedupe_key)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (property_id, dedupe_key) do nothing
       returning ${FRAUD_ALERT_COLUMNS};`,
      [input.organizationId, input.propertyId, input.pattern, input.folioId, input.chargeId, input.paymentId, input.reason, JSON.stringify(input.evidence), JSON.stringify(input.recipientRoles), input.dedupeKey],
    );
    if (inserted.rows[0]) return { record: mapFraudAlert(inserted.rows[0]), isNew: true };
    const existing = await this.db.query<FraudAlertRawRow>(
      `select ${FRAUD_ALERT_COLUMNS} from hoteles.fraud_alert where property_id = $1 and dedupe_key = $2;`,
      [input.propertyId, input.dedupeKey],
    );
    if (!existing.rows[0]) throw new Error(`recordFraudAlert: no se pudo crear ni encontrar la alerta con dedupe_key "${input.dedupeKey}".`);
    return { record: mapFraudAlert(existing.rows[0]), isNew: false };
  }

  async listFraudAlerts(propertyId: string, filter?: { readonly status?: FraudAlertStatus }): Promise<readonly FraudAlertRecord[]> {
    const { rows } = await this.db.query<FraudAlertRawRow>(
      filter?.status
        ? `select ${FRAUD_ALERT_COLUMNS} from hoteles.fraud_alert where property_id = $1 and status = $2 order by created_at desc limit 200;`
        : `select ${FRAUD_ALERT_COLUMNS} from hoteles.fraud_alert where property_id = $1 order by created_at desc limit 200;`,
      filter?.status ? [propertyId, filter.status] : [propertyId],
    );
    return rows.map(mapFraudAlert);
  }

  async findFraudAlert(propertyId: string, alertId: string): Promise<FraudAlertRecord | null> {
    const { rows } = await this.db.query<FraudAlertRawRow>(`select ${FRAUD_ALERT_COLUMNS} from hoteles.fraud_alert where id = $1 and property_id = $2;`, [alertId, propertyId]);
    return rows[0] ? mapFraudAlert(rows[0]) : null;
  }

  async resolveFraudAlert(propertyId: string, alertId: string, resolvedBy: string, status: "confirmado" | "descartado", decisionNote: string | null): Promise<FraudAlertRecord> {
    const { rows } = await this.db.query<FraudAlertRawRow>(
      `update hoteles.fraud_alert
       set status = $1, decision_note = $2, resolved_by = $3, resolved_at = now()
       where id = $4 and property_id = $5 and status = 'pendiente'
       returning ${FRAUD_ALERT_COLUMNS};`,
      [status, decisionNote, resolvedBy, alertId, propertyId],
    );
    if (rows[0]) return mapFraudAlert(rows[0]);
    const existing = await this.findFraudAlert(propertyId, alertId);
    if (!existing) throw new Error(`Alerta de fraude ${alertId} no encontrada.`);
    throw new FraudAlertAlreadyResolvedError();
  }

  // ---- HotelesRepository: Fase 5 — H5/REQ-BO-001/002 CFDI de hospedaje ----

  async loadHospedajeFiscalConfig(propertyId: string): Promise<HospedajeFiscalConfig> {
    const { rows } = await this.db.query<{ ish_rate: string; dsa_per_night: string; rfc_emisor: string | null }>(
      `select ish_rate, dsa_per_night, rfc_emisor from hoteles.tax_config where property_id = $1;`,
      [propertyId],
    );
    const row = rows[0];
    if (!row) throw new Error(`No hay hoteles.tax_config configurado para property "${propertyId}".`);
    return { ishRate: Number(row.ish_rate), dsaPerNight: Number(row.dsa_per_night), rfcEmisor: row.rfc_emisor };
  }

  async listChargesForCfdi(folioId: string): Promise<readonly { concept: string; amount: number; taxAmount: number; stayDate: string | null; reversesChargeId: string | null }[]> {
    const { rows } = await this.db.query<{ concept: string; amount: string; tax_amount: string; stay_date: string | null; reverses_charge_id: string | null }>(
      `select concept, amount::text as amount, tax_amount::text as tax_amount, stay_date::text as stay_date, reverses_charge_id
       from hoteles.charge where folio_id = $1;`,
      [folioId],
    );
    return rows.map((r) => ({ concept: r.concept, amount: Number(r.amount), taxAmount: Number(r.tax_amount), stayDate: r.stay_date, reversesChargeId: r.reverses_charge_id }));
  }

  async findCfdiEmisionByFolio(propertyId: string, folioId: string, tipo: "hospedaje"): Promise<CfdiEmisionRecord | null> {
    // Fix hallazgo auditoría — desde 015_cfdi_hospedaje_reemision_tras_cancelacion.sql
    // un folio puede acumular MÁS de un CFDI 'hospedaje' en su historial (los
    // cancelados quedan; cada reemisión crea uno nuevo). El vigente (no cancelado,
    // a lo más UNO por el índice único parcial) es el que le importa a quien llama
    // este método; si no hay ninguno vigente, cae al cancelado más reciente (mismo
    // criterio de "última verdad" que `listCfdiEmisiones` ya usa para ordenar).
    const { rows } = await this.db.query<CfdiEmisionRawRow>(
      `select ${CFDI_EMISION_COLUMNS} from hoteles.cfdi_emision
       where property_id = $1 and folio_id = $2 and tipo = $3
       order by (status <> 'cancelado') desc, created_at desc
       limit 1;`,
      [propertyId, folioId, tipo],
    );
    return rows[0] ? mapCfdiEmision(rows[0]) : null;
  }

  async findCfdiEmisionByPayment(propertyId: string, paymentId: string): Promise<CfdiEmisionRecord | null> {
    const { rows } = await this.db.query<CfdiEmisionRawRow>(
      `select ${CFDI_EMISION_COLUMNS} from hoteles.cfdi_emision where property_id = $1 and payment_id = $2 and tipo = 'pago';`,
      [propertyId, paymentId],
    );
    return rows[0] ? mapCfdiEmision(rows[0]) : null;
  }

  async insertCfdiEmision(input: NewCfdiEmisionInput): Promise<CfdiEmisionRecord> {
    const inserted = await this.db.query<CfdiEmisionRawRow>(
      `insert into hoteles.cfdi_emision
         (organization_id, property_id, folio_id, tipo, uuid_fiscal, status, pac, subtotal, iva, ish_tasa, ish_monto,
          dsa_monto, total, rfc_receptor, uso_cfdi, metodo_pago, es_extranjero, es_global, es_no_show, related_cfdi_id, payment_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       on conflict (folio_id) where tipo = 'hospedaje' and status <> 'cancelado' do nothing
       returning ${CFDI_EMISION_COLUMNS};`,
      [
        input.organizationId,
        input.propertyId,
        input.folioId,
        input.tipo,
        input.uuidFiscal,
        input.status,
        input.pac,
        input.subtotal,
        input.iva,
        input.ishTasa,
        input.ishMonto,
        input.dsaMonto,
        input.total,
        input.rfcReceptor,
        input.usoCfdi,
        input.metodoPago,
        input.esExtranjero,
        input.esGlobal,
        input.esNoShow,
        input.relatedCfdiId,
        input.paymentId,
      ],
    );
    if (inserted.rows[0]) return mapCfdiEmision(inserted.rows[0]);
    // La carrera perdió contra el índice único parcial (REQ-BO-002) -- el CFDI de
    // hospedaje VIGENTE (no cancelado) / pago YA existe, se devuelve tal cual (mismo
    // UUID) sin timbrar dos veces. Un hospedaje cancelado NUNCA causa este conflicto
    // (el índice desde 015_cfdi_hospedaje_reemision_tras_cancelacion.sql lo excluye
    // a propósito, para permitir reemitirlo).
    const existing =
      input.tipo === "hospedaje" ? await this.findCfdiEmisionByFolio(input.propertyId, input.folioId, "hospedaje") : input.paymentId ? await this.findCfdiEmisionByPayment(input.propertyId, input.paymentId) : null;
    if (!existing) throw new Error(`insertCfdiEmision: conflicto de índice único sin fila existente recuperable (folio=${input.folioId}, tipo=${input.tipo}).`);
    return existing;
  }

  async findCfdiEmision(propertyId: string, cfdiId: string): Promise<CfdiEmisionRecord | null> {
    const { rows } = await this.db.query<CfdiEmisionRawRow>(`select ${CFDI_EMISION_COLUMNS} from hoteles.cfdi_emision where id = $1 and property_id = $2;`, [cfdiId, propertyId]);
    return rows[0] ? mapCfdiEmision(rows[0]) : null;
  }

  async listCfdiEmisiones(propertyId: string, filter?: { readonly folioId?: string }): Promise<readonly CfdiEmisionRecord[]> {
    const { rows } = await this.db.query<CfdiEmisionRawRow>(
      filter?.folioId
        ? `select ${CFDI_EMISION_COLUMNS} from hoteles.cfdi_emision where property_id = $1 and folio_id = $2 order by created_at asc;`
        : `select ${CFDI_EMISION_COLUMNS} from hoteles.cfdi_emision where property_id = $1 order by created_at desc limit 200;`,
      filter?.folioId ? [propertyId, filter.folioId] : [propertyId],
    );
    return rows.map(mapCfdiEmision);
  }

  // Hallazgo auditoría — mismo fix que InMemoryHotelesRepository: `canceled_at`
  // solo se sella cuando el status es 'cancelado' de verdad. Antes de este fix se
  // escribía `canceled_at = now()` con CUALQUIER status devuelto por el PAC
  // (incluyendo 'en_proceso_cancelacion'), dejando un CFDI con fecha de
  // cancelación sin haber cancelado en realidad.
  async updateCfdiEmisionCancelacion(cfdiId: string, status: CfdiEmisionRecord["status"]): Promise<void> {
    await this.db.query(`update hoteles.cfdi_emision set status = $1, canceled_at = case when $1 = 'cancelado' then now() else canceled_at end where id = $2;`, [status, cfdiId]);
  }

  // Webhook entrante del PAC (sin propertyId/sesión de usuario) — la política RLS
  // "dinero: staff con acceso ... cfdi de hospedaje" (hoteles.can_access_money())
  // nunca la satisface una sesión de sistema (auth.uid() is null), así que un
  // UPDATE normal aquí no tocaría ninguna fila. `hoteles.apply_cfdi_webhook_status`
  // (security definer, ver
  // migrations/020_cfdi_webhook_status_security_definer.sql) localiza + aplica la
  // transición por uuid_fiscal en una sola sentencia atómica, bypassando RLS SOLO
  // para esta operación puntual.
  async applyCfdiWebhookStatus(uuidFiscal: string, status: CfdiEmisionRecord["status"]): Promise<CfdiEmisionRecord | null> {
    const { rows } = await this.db.query<CfdiEmisionRawRow>(`select ${CFDI_EMISION_COLUMNS} from hoteles.apply_cfdi_webhook_status($1, $2);`, [uuidFiscal, status]);
    return rows[0] ? mapCfdiEmision(rows[0]) : null;
  }

  // ---- HotelesRepository: Fase 7 — descubrimiento de organización/property ----

  async findOrganizationBySlug(slug: string): Promise<HotelOrganizationSummary | null> {
    const { rows } = await this.db.query<{ id: string; slug: string; name: string }>(
      `select id, slug, name from core.organization where slug = $1 and vertical = 'hoteles';`,
      [slug],
    );
    return rows[0] ?? null;
  }

  async listPropertiesForOrganization(organizationId: string): Promise<readonly PropertySummary[]> {
    const { rows } = await this.db.query<{ property_id: string; name: string }>(
      `select id as property_id, name
       from core.property
       where organization_id = $1 and status = 'active'
       order by name asc;`,
      [organizationId],
    );
    return rows.map((row) => ({ propertyId: row.property_id, name: row.name }));
  }

  /** Fase 12 — insumo de guest-email-notifications.ts (nombre real del hotel para
   *  el saludo/asunto del correo). A diferencia de `listPropertiesForOrganization`
   *  (todas las properties activas de una organización, insumo del selector del
   *  panel), este busca UNA property por id sin filtrar por `status` -- el correo
   *  de un evento real (reserva/folio/CFDI) de una property que se desactivó
   *  después sigue debiendo mostrar su nombre real. */
  async findPropertyById(propertyId: string): Promise<{ readonly id: string; readonly name: string; readonly organizationId: string } | null> {
    const { rows } = await this.db.query<{ id: string; name: string; organization_id: string }>(
      `select id, name, organization_id from core.property where id = $1;`,
      [propertyId],
    );
    const row = rows[0];
    return row ? { id: row.id, name: row.name, organizationId: row.organization_id } : null;
  }

  // ---- HotelesRepository: Fase 6 — H5/REQ-REV-013 night audit propio ----

  async listActiveHotelProperties(): Promise<readonly ActiveHotelProperty[]> {
    // Mismo patrón exacto que `CitasRepository.listActiveOrganizations()`
    // (apps/api/src/routes/verticals/citas/reminders.ts): ejecutado bajo
    // `engine.withAppSession({ userId: null }, ...)` desde la ruta interna de
    // barrido, sin `auth.uid()` real.
    const { rows } = await this.db.query<{ organization_id: string; property_id: string }>(
      `select p.id as property_id, p.organization_id
       from core.property p
       join core.organization o on o.id = p.organization_id
       where o.vertical = 'hoteles' and o.status = 'active' and p.status = 'active';`,
    );
    return rows.map((r) => ({ organizationId: r.organization_id, propertyId: r.property_id }));
  }

  async listInHouseReservationsForNightAudit(
    propertyId: string,
    businessDate: string,
  ): Promise<readonly { reservationId: string; folioId: string | null; nightlyPrice: number | null }[]> {
    const { rows } = await this.db.query<{ reservation_id: string; folio_id: string | null; nightly_price: string | null }>(
      `select r.id as reservation_id, f.id as folio_id, rp.price::text as nightly_price
       from hoteles.reservation r
       left join hoteles.folio f on f.reservation_id = r.id and f.is_primary
       left join hoteles.rate_plan rp on rp.room_type_id = r.room_type_id and rp.property_id = r.property_id and rp.date = $2::date
       where r.property_id = $1
         and r.status in ('check_in', 'en_estancia')
         and r.check_in_date <= $2::date
         and r.check_out_date > $2::date;`,
      [propertyId, businessDate],
    );
    return rows.map((r) => ({ reservationId: r.reservation_id, folioId: r.folio_id, nightlyPrice: r.nightly_price == null ? null : Number(r.nightly_price) }));
  }

  async postNightlyHospedajeCharge(input: {
    organizationId: string;
    propertyId: string;
    folioId: string;
    businessDate: string;
    netAmount: number;
    taxAmount: number;
  }): Promise<{ id: string; createdAt: string; isNew: boolean }> {
    const inserted = await this.db.query<{ id: string; created_at: string }>(
      `insert into hoteles.charge (organization_id, property_id, folio_id, description, amount, tax_amount, concept, stay_date)
       values ($1, $2, $3, $4, $5, $6, 'hospedaje', $7::date)
       on conflict (folio_id, stay_date) where concept = 'hospedaje' and stay_date is not null and reverses_charge_id is null
       do nothing
       returning id, created_at::text as created_at;`,
      [input.organizationId, input.propertyId, input.folioId, `Hospedaje noche del ${input.businessDate}`, input.netAmount, input.taxAmount, input.businessDate],
    );
    if (inserted.rows[0]) return { id: inserted.rows[0].id, createdAt: inserted.rows[0].created_at, isNew: true };
    const { rows } = await this.db.query<{ id: string; created_at: string }>(
      `select id, created_at::text as created_at from hoteles.charge
       where folio_id = $1 and stay_date = $2::date and concept = 'hospedaje' and reverses_charge_id is null;`,
      [input.folioId, input.businessDate],
    );
    if (!rows[0]) throw new Error(`postNightlyHospedajeCharge: conflicto de índice único sin fila existente recuperable (folio=${input.folioId}, noche=${input.businessDate}).`);
    return { id: rows[0].id, createdAt: rows[0].created_at, isNew: false };
  }

  async claimNightAuditRun(organizationId: string, propertyId: string, businessDate: string): Promise<NightAuditRunRecord> {
    // Sin advisory lock explícito (a diferencia del origen): el índice único
    // `(property_id, business_date)` de migrations/008 ya serializa la carrera vía
    // `on conflict do nothing` -- mismo patrón exacto que `recordFraudAlert` arriba,
    // consistente con el resto de este adaptador (ninguna otra escritura de
    // domain-hoteles usa una función SQL SECURITY DEFINER dedicada para esto).
    const inserted = await this.db.query<NightAuditRunRawRow>(
      `insert into hoteles.night_audit_run (organization_id, property_id, business_date, status, summary)
       values ($1, $2, $3::date, 'en_progreso', '{}'::jsonb)
       on conflict (property_id, business_date) do nothing
       returning ${NIGHT_AUDIT_RUN_COLUMNS};`,
      [organizationId, propertyId, businessDate],
    );
    if (inserted.rows[0]) return mapNightAuditRun(inserted.rows[0]);
    const { rows } = await this.db.query<NightAuditRunRawRow>(
      `select ${NIGHT_AUDIT_RUN_COLUMNS} from hoteles.night_audit_run where property_id = $1 and business_date = $2::date;`,
      [propertyId, businessDate],
    );
    if (!rows[0]) throw new Error(`claimNightAuditRun: conflicto de índice único sin fila existente recuperable (property=${propertyId}, fecha=${businessDate}).`);
    return mapNightAuditRun(rows[0]);
  }

  async finishNightAuditRun(runId: string, summary: Readonly<Record<string, unknown>>): Promise<NightAuditRunRecord> {
    const { rows } = await this.db.query<NightAuditRunRawRow>(
      `update hoteles.night_audit_run
       set status = 'completado', summary = $1, completed_at = now()
       where id = $2 and status = 'en_progreso'
       returning ${NIGHT_AUDIT_RUN_COLUMNS};`,
      [JSON.stringify(summary), runId],
    );
    if (rows[0]) return mapNightAuditRun(rows[0]);
    // Guarda de estado (mismo criterio que `resolveFraudAlert`): si perdió la carrera
    // contra otra corrida que ya terminó primero, devuelve esa fila ya completada en
    // vez de lanzar -- nunca reemplaza un resumen ya guardado.
    const { rows: existing } = await this.db.query<NightAuditRunRawRow>(`select ${NIGHT_AUDIT_RUN_COLUMNS} from hoteles.night_audit_run where id = $1;`, [runId]);
    if (!existing[0]) throw new Error(`night_audit_run_no_encontrado: ${runId}`);
    return mapNightAuditRun(existing[0]);
  }

  async findNightAuditRun(propertyId: string, businessDate: string): Promise<NightAuditRunRecord | null> {
    const { rows } = await this.db.query<NightAuditRunRawRow>(
      `select ${NIGHT_AUDIT_RUN_COLUMNS} from hoteles.night_audit_run where property_id = $1 and business_date = $2::date;`,
      [propertyId, businessDate],
    );
    return rows[0] ? mapNightAuditRun(rows[0]) : null;
  }

  async listNightAuditRuns(propertyId: string, limit = 30): Promise<readonly NightAuditRunRecord[]> {
    const { rows } = await this.db.query<NightAuditRunRawRow>(
      `select ${NIGHT_AUDIT_RUN_COLUMNS} from hoteles.night_audit_run where property_id = $1 order by business_date desc limit $2;`,
      [propertyId, limit],
    );
    return rows.map(mapNightAuditRun);
  }

  // P1/auditoria-2 (heredado del origen, ver jobs/nightAudit.ts): el resumen de caja
  // debe agrupar por la FECHA DE NEGOCIO (hora local `timezone`), no por
  // `created_at::date` crudo en la zona de sesión del servidor (típicamente UTC) --
  // comparar eso directo contra `businessDate` casi nunca coincide para un cargo
  // hecho cerca de medianoche hora local.
  async sumChargesByConceptForBusinessDate(propertyId: string, businessDate: string, timezone: string): Promise<Readonly<Record<string, number>>> {
    const { rows } = await this.db.query<{ concept: string; total: string }>(
      `select concept, sum(amount + tax_amount)::text as total
       from hoteles.charge
       where property_id = $1 and (created_at at time zone $3)::date = $2::date
       group by concept;`,
      [propertyId, businessDate, timezone],
    );
    return Object.fromEntries(rows.map((r) => [r.concept, Number(r.total)]));
  }

  async sumPaymentsByMethodForBusinessDate(propertyId: string, businessDate: string, timezone: string): Promise<Readonly<Record<string, number>>> {
    const { rows } = await this.db.query<{ method: string; total: string }>(
      `select method, sum(amount)::text as total
       from hoteles.payment
       where property_id = $1 and (created_at at time zone $3)::date = $2::date and status = 'capturado'
       group by method;`,
      [propertyId, businessDate, timezone],
    );
    return Object.fromEntries(rows.map((r) => [r.method, Number(r.total)]));
  }

  // ---- HotelesRepository: Fase 6b — flujos de sistema de night-audit/no-show
  // (migrations/023_night_audit_sistema_escritura.sql). EXCLUSIVOS de
  // `apps/worker/src/jobs/hoteles/{night-audit,no-show}.ts` bajo `session: "sistema"` --
  // ver el header de esa migración para el análisis completo. ----

  async systemListInHouseReservationsForNightAudit(
    propertyId: string,
    businessDate: string,
  ): Promise<readonly { reservationId: string; folioId: string | null; nightlyPrice: number | null }[]> {
    const { rows } = await this.db.query<{ out_reservation_id: string; out_folio_id: string | null; out_nightly_price: string | null }>(
      `select * from hoteles.system_list_in_house_reservations_for_night_audit($1, $2::date);`,
      [propertyId, businessDate],
    );
    return rows.map((r) => ({
      reservationId: r.out_reservation_id,
      folioId: r.out_folio_id,
      nightlyPrice: r.out_nightly_price == null ? null : Number(r.out_nightly_price),
    }));
  }

  async systemLoadTaxConfig(propertyId: string): Promise<TaxConfigRecord> {
    const { rows } = await this.db.query<{ out_iva_rate: string; out_ish_rate: string; out_discount_threshold: string }>(
      `select * from hoteles.system_load_tax_config($1);`,
      [propertyId],
    );
    const row = rows[0];
    if (!row) throw new Error(`No hay hoteles.tax_config configurado para property "${propertyId}".`);
    return { ivaRate: Number(row.out_iva_rate), ishRate: Number(row.out_ish_rate), discountThreshold: Number(row.out_discount_threshold) };
  }

  async systemSumChargesByConceptForBusinessDate(propertyId: string, businessDate: string, timezone: string): Promise<Readonly<Record<string, number>>> {
    const { rows } = await this.db.query<{ out_concept: string; out_total: string }>(
      `select * from hoteles.system_sum_charges_by_concept_for_business_date($1, $2::date, $3);`,
      [propertyId, businessDate, timezone],
    );
    return Object.fromEntries(rows.map((r) => [r.out_concept, Number(r.out_total)]));
  }

  async systemSumPaymentsByMethodForBusinessDate(propertyId: string, businessDate: string, timezone: string): Promise<Readonly<Record<string, number>>> {
    const { rows } = await this.db.query<{ out_method: string; out_total: string }>(
      `select * from hoteles.system_sum_payments_by_method_for_business_date($1, $2::date, $3);`,
      [propertyId, businessDate, timezone],
    );
    return Object.fromEntries(rows.map((r) => [r.out_method, Number(r.out_total)]));
  }

  async systemPostNightAuditCharge(input: NewSystemNightAuditChargeInput): Promise<{ id: string; createdAt: string; isNew: boolean }> {
    const { rows } = await this.db.query<{ out_id: string; out_created_at: string; out_is_new: boolean }>(
      `select * from hoteles.system_post_night_audit_charge($1, $2, $3, $4, $5::date, $6, $7);`,
      [input.organizationId, input.propertyId, input.reservationId, input.folioId, input.businessDate, input.netAmount, input.taxAmount],
    );
    const row = rows[0];
    if (!row) throw new Error(`systemPostNightAuditCharge: la función no devolvió fila (reserva=${input.reservationId}).`);
    return { id: row.out_id, createdAt: row.out_created_at, isNew: row.out_is_new };
  }

  async systemFindDueNoShowReservations(propertyId: string, asOfDate: string | null): Promise<readonly DueNoShowReservationForSystem[]> {
    const { rows } = await this.db.query<{
      out_reservation_id: string;
      out_check_in_date: string;
      out_check_out_date: string;
      out_total_amount: string;
    }>(`select * from hoteles.system_find_due_no_show_reservations($1, $2::date);`, [propertyId, asOfDate]);
    return rows.map((r) => ({
      reservationId: r.out_reservation_id,
      checkInDate: r.out_check_in_date,
      checkOutDate: r.out_check_out_date,
      totalAmount: Number(r.out_total_amount),
    }));
  }

  async systemApplyNoShow(input: NewSystemNoShowApplicationInput): Promise<SystemNoShowApplicationResult | null> {
    const { rows } = await this.db.query<{ out_folio_id: string; out_charge_id: string; out_charge_created_at: string }>(
      `select * from hoteles.system_apply_no_show($1, $2, $3, $4, $5);`,
      [input.organizationId, input.propertyId, input.reservationId, input.netAmount, input.taxAmount],
    );
    const row = rows[0];
    if (!row) return null; // carrera perdida: la reserva ya no estaba en 'confirmada'.
    return { folioId: row.out_folio_id, chargeId: row.out_charge_id, chargeCreatedAt: row.out_charge_created_at };
  }

  // ---- HotelesRepository: Fase 6 — REQ-HK-011 tickets de mantenimiento ----

  async insertMaintenanceTicket(input: NewMaintenanceTicketInput): Promise<MaintenanceTicketRecord> {
    const { rows } = await this.db.query<MaintenanceTicketRawRow>(
      `insert into hoteles.maintenance_ticket
         (organization_id, property_id, room_id, title, description, origin, severity, estimated_cost, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning ${MAINTENANCE_TICKET_COLUMNS};`,
      [input.organizationId, input.propertyId, input.roomId, input.title, input.description, input.origin, input.severity, input.estimatedCost, input.createdBy],
    );
    return mapMaintenanceTicket(rows[0]!);
  }

  async listMaintenanceTickets(propertyId: string, filter?: { readonly status?: MaintenanceTicketStatus }): Promise<readonly MaintenanceTicketRecord[]> {
    const { rows } = await this.db.query<MaintenanceTicketRawRow>(
      filter?.status
        ? `select ${MAINTENANCE_TICKET_COLUMNS} from hoteles.maintenance_ticket where property_id = $1 and status = $2 order by created_at desc limit 200;`
        : `select ${MAINTENANCE_TICKET_COLUMNS} from hoteles.maintenance_ticket where property_id = $1 order by created_at desc limit 200;`,
      filter?.status ? [propertyId, filter.status] : [propertyId],
    );
    return rows.map(mapMaintenanceTicket);
  }

  async findMaintenanceTicket(propertyId: string, ticketId: string): Promise<MaintenanceTicketRecord | null> {
    const { rows } = await this.db.query<MaintenanceTicketRawRow>(
      `select ${MAINTENANCE_TICKET_COLUMNS} from hoteles.maintenance_ticket where id = $1 and property_id = $2;`,
      [ticketId, propertyId],
    );
    return rows[0] ? mapMaintenanceTicket(rows[0]) : null;
  }

  async closeMaintenanceTicket(
    propertyId: string,
    ticketId: string,
    input: { readonly actualCost: number; readonly resolutionNote: string | null },
  ): Promise<MaintenanceTicketRecord | null> {
    const { rows } = await this.db.query<MaintenanceTicketRawRow>(
      `update hoteles.maintenance_ticket
       set status = 'cerrado', actual_cost = $1, resolution_note = $2, closed_at = now(), updated_at = now()
       where id = $3 and property_id = $4 and status not in ('cerrado', 'cancelado')
       returning ${MAINTENANCE_TICKET_COLUMNS};`,
      [input.actualCost, input.resolutionNote, ticketId, propertyId],
    );
    return rows[0] ? mapMaintenanceTicket(rows[0]) : null;
  }

  // ---- HotelesRepository: Fase 6 — REQ-HK-008 turnos de camaristas/lavandería ----

  async replaceHousekeepingShifts(
    propertyId: string,
    staffId: string,
    fromDate: string,
    toDate: string,
    shifts: readonly NewHousekeepingShiftInput[],
  ): Promise<readonly HousekeepingShiftRecord[]> {
    await this.db.query(
      `delete from hoteles.housekeeping_shift
       where property_id = $1 and staff_id = $2 and work_date >= $3::date and work_date <= $4::date;`,
      [propertyId, staffId, fromDate, toDate],
    );
    const created: HousekeepingShiftRecord[] = [];
    for (const s of shifts) {
      const { rows } = await this.db.query<HousekeepingShiftRawRow>(
        `insert into hoteles.housekeeping_shift (organization_id, property_id, staff_id, work_date, start_time, end_time)
         values ($1, $2, $3, $4::date, $5::time, $6::time)
         returning ${HOUSEKEEPING_SHIFT_COLUMNS};`,
        [s.organizationId, s.propertyId, s.staffId, s.workDate, s.startTime, s.endTime],
      );
      created.push(mapHousekeepingShift(rows[0]!));
    }
    return created;
  }

  async listHousekeepingShifts(propertyId: string, fromDate: string, toDate: string, staffId?: string): Promise<readonly HousekeepingShiftRecord[]> {
    const { rows } = await this.db.query<HousekeepingShiftRawRow>(
      staffId
        ? `select ${HOUSEKEEPING_SHIFT_COLUMNS} from hoteles.housekeeping_shift
           where property_id = $1 and work_date >= $2::date and work_date <= $3::date and staff_id = $4
           order by work_date asc, start_time asc;`
        : `select ${HOUSEKEEPING_SHIFT_COLUMNS} from hoteles.housekeeping_shift
           where property_id = $1 and work_date >= $2::date and work_date <= $3::date
           order by work_date asc, start_time asc;`,
      staffId ? [propertyId, fromDate, toDate, staffId] : [propertyId, fromDate, toDate],
    );
    return rows.map(mapHousekeepingShift);
  }

  // ---- HotelesRepository: Fase 8 — REQ-BO-024 checador de asistencia inalterable ----

  async recordAttendanceEvent(input: NewAttendanceEventInput): Promise<AttendanceEventRecord> {
    // `recorded_at` lo fija SIEMPRE `now()` de Postgres (default de columna, ver
    // migrations/010_checador_asistencia.sql) -- ningún valor de `input` lo
    // sobreescribe aquí a propósito. `hash`/`prev_hash`/`seq` los calcula el trigger
    // `attendance_log_set_hash` (SECURITY DEFINER); este INSERT nunca los toca.
    const { rows } = await this.db.query<AttendanceEventRawRow>(
      `insert into hoteles.attendance_log (organization_id, property_id, staff_user_id, event_type, source, note)
       values ($1, $2, $3, $4, $5, $6)
       returning ${ATTENDANCE_EVENT_COLUMNS};`,
      [input.organizationId, input.propertyId, input.staffUserId, input.eventType, input.source, input.note],
    );
    return mapAttendanceEvent(rows[0]!);
  }

  async listAttendanceEvents(
    propertyId: string,
    staffUserId: string,
    range?: { readonly fromDate: string; readonly toDate: string },
  ): Promise<readonly AttendanceEventRecord[]> {
    const { rows } = await this.db.query<AttendanceEventRawRow>(
      range
        ? `select ${ATTENDANCE_EVENT_COLUMNS} from hoteles.attendance_log
           where property_id = $1 and staff_user_id = $2
             and recorded_at >= $3::date and recorded_at < ($4::date + interval '1 day')
           order by recorded_at asc;`
        : `select ${ATTENDANCE_EVENT_COLUMNS} from hoteles.attendance_log
           where property_id = $1 and staff_user_id = $2
           order by recorded_at asc;`,
      range ? [propertyId, staffUserId, range.fromDate, range.toDate] : [propertyId, staffUserId],
    );
    return rows.map(mapAttendanceEvent);
  }

  async upsertStaffSchedule(input: NewStaffScheduleInput): Promise<StaffScheduleRecord> {
    const { rows } = await this.db.query<StaffScheduleRawRow>(
      `insert into hoteles.staff_schedule
         (organization_id, property_id, staff_user_id, work_date, scheduled_start, scheduled_end, authorized_overtime_minutes)
       values ($1, $2, $3, $4::date, $5::timestamptz, $6::timestamptz, $7)
       on conflict (property_id, staff_user_id, work_date) do update set
         scheduled_start = excluded.scheduled_start,
         scheduled_end = excluded.scheduled_end,
         authorized_overtime_minutes = excluded.authorized_overtime_minutes
       returning ${STAFF_SCHEDULE_COLUMNS};`,
      [
        input.organizationId,
        input.propertyId,
        input.staffUserId,
        input.workDate,
        input.scheduledStart,
        input.scheduledEnd,
        input.authorizedOvertimeMinutes,
      ],
    );
    return mapStaffSchedule(rows[0]!);
  }

  async findStaffSchedule(propertyId: string, staffUserId: string, workDate: string): Promise<StaffScheduleRecord | null> {
    const { rows } = await this.db.query<StaffScheduleRawRow>(
      `select ${STAFF_SCHEDULE_COLUMNS} from hoteles.staff_schedule
       where property_id = $1 and staff_user_id = $2 and work_date = $3::date;`,
      [propertyId, staffUserId, workDate],
    );
    return rows[0] ? mapStaffSchedule(rows[0]) : null;
  }

  // ---- HotelesRepository: Fase 10 — REQ-BO-010 back-office financiero (P&L USALI) ----

  async insertExpenseEntry(input: NewExpenseEntryInput): Promise<ExpenseEntryRecord> {
    const { rows } = await this.db.query<ExpenseEntryRawRow>(
      `insert into hoteles.expense_entry
         (organization_id, property_id, department, category, description, amount, expense_date, created_by)
       values ($1, $2, $3, $4, $5, $6, $7::date, $8)
       returning ${EXPENSE_ENTRY_COLUMNS};`,
      [input.organizationId, input.propertyId, input.department, input.category, input.description, input.amount, input.expenseDate, input.createdBy],
    );
    return mapExpenseEntry(rows[0]!);
  }

  async listExpenseEntries(propertyId: string, desde: string, hasta: string): Promise<readonly ExpenseEntryRecord[]> {
    const { rows } = await this.db.query<ExpenseEntryRawRow>(
      `select ${EXPENSE_ENTRY_COLUMNS} from hoteles.expense_entry
       where property_id = $1 and expense_date between $2::date and $3::date
       order by expense_date asc;`,
      [propertyId, desde, hasta],
    );
    return rows.map(mapExpenseEntry);
  }

  /** Ingreso por fecha+departamento USALI ya resuelto (ver `PL_REVENUE_DEPARTMENT_CASE`
   *  arriba y el header de migrations/012_pl_usali.sql para el mapeo completo) --
   *  `c.amount` es SIEMPRE neto (antes de IVA/ISH, mismo criterio que el `netAmount`
   *  de `folioEngine.ts`), nunca `amount + tax_amount`. */
  async loadRevenueByDepartmentAndDateForPl(propertyId: string, desde: string, hasta: string): Promise<readonly PlRevenueByDateRow[]> {
    const { rows } = await this.db.query<{ fecha: string; department: UsaliRevenueDepartment | null; revenue: string }>(
      `select
         coalesce(c.stay_date, c.created_at::date)::text as fecha,
         ${PL_REVENUE_DEPARTMENT_CASE} as department,
         sum(c.amount)::text as revenue
       from hoteles.charge c
       left join hoteles.charge orig on orig.id = c.reverses_charge_id
       where c.property_id = $1
         and coalesce(c.stay_date, c.created_at::date) between $2::date and $3::date
         and coalesce(orig.concept, c.concept) <> 'propina'
       group by fecha, department;`,
      [propertyId, desde, hasta],
    );
    return rows
      .filter((r): r is { fecha: string; department: UsaliRevenueDepartment; revenue: string } => r.department != null)
      .map((r) => ({ fecha: r.fecha, department: r.department, revenue: Number(r.revenue) }));
  }

  async loadExpensesByDepartmentAndDateForPl(propertyId: string, desde: string, hasta: string): Promise<readonly PlExpenseByDateRow[]> {
    const { rows } = await this.db.query<{ fecha: string; department: PlExpenseByDateRow["department"]; category: PlExpenseByDateRow["category"]; amount: string }>(
      `select expense_date::text as fecha, department::text as department, category::text as category, sum(amount)::text as amount
       from hoteles.expense_entry
       where property_id = $1 and expense_date between $2::date and $3::date
       group by fecha, department, category;`,
      [propertyId, desde, hasta],
    );
    return rows.map((r) => ({ fecha: r.fecha, department: r.department, category: r.category, amount: Number(r.amount) }));
  }

  /** Habitaciones-noche REALMENTE ocupadas y cobradas (un cargo `concept='hospedaje'`
   *  vigente = una noche ocupada -- night-audit postea exactamente uno por
   *  habitación/noche, ver `night-audit/engine.ts::planNightlyHospedajeCharges`).
   *  Excluye cargos ya reversados (`reversed_by is not null`): esa noche se cancela
   *  por completo, tanto en ingreso (el reverso lo neutraliza en
   *  `loadRevenueByDepartmentAndDateForPl`) como en el conteo de ocupación real. */
  async loadOccupiedRoomNightsByDateForPl(
    propertyId: string,
    desde: string,
    hasta: string,
  ): Promise<readonly PlOccupiedRoomNightsByDateRow[]> {
    const { rows } = await this.db.query<{ fecha: string; room_nights: string; revenue: string }>(
      `select stay_date::text as fecha, count(*)::text as room_nights, sum(amount)::text as revenue
       from hoteles.charge
       where property_id = $1 and concept = 'hospedaje' and reversed_by is null
         and stay_date between $2::date and $3::date
       group by fecha;`,
      [propertyId, desde, hasta],
    );
    return rows.map((r) => ({ fecha: r.fecha, roomNights: Number(r.room_nights), revenue: Number(r.revenue) }));
  }

  async sumAvailableRoomNightsForDateRange(propertyId: string, desde: string, hasta: string): Promise<number> {
    const { rows } = await this.db.query<{ total: string | null }>(
      `select sum(total_rooms)::text as total
       from hoteles.availability
       where property_id = $1 and date between $2::date and $3::date;`,
      [propertyId, desde, hasta],
    );
    return Number(rows[0]?.total ?? 0);
  }

  // ============================================================================
  // Fase 12 — dispatcher real de correo al huésped (ver migrations/014_email_outbox_dispatch.sql)
  // ============================================================================

  async claimEmailOutboxBatch(limit: number): Promise<readonly EmailOutboxJobRow[]> {
    const { rows } = await this.db.query<{ id: string; property_id: string; organization_id: string; attempts: number; payload: Record<string, unknown> }>(
      `select id, property_id, organization_id, attempts, payload from hoteles.claim_email_outbox_batch($1);`,
      [limit],
    );
    return rows.map((r) => ({ id: r.id, propertyId: r.property_id, organizationId: r.organization_id, attempts: r.attempts, payload: r.payload ?? {} }));
  }

  async completeEmailOutboxJob(id: string, status: "sent" | "failed" | "dead", error: string | null): Promise<void> {
    await this.db.query(`select hoteles.complete_email_outbox_job($1, $2, $3);`, [id, status, error]);
  }

  // ============================================================================
  // Fase 9 (REQ-REV-003/004/005/007) — motor de revenue management: wiring de
  // hoteles.revenue_engine_gate/hoteles.revenue_backtest_run (migrations/
  // 011_revenue_engine_gate.sql). La autoridad real de la máquina de estados es el
  // trigger `revenue_engine_gate_transition_guard_trg` — este adaptador solo
  // ejecuta el INSERT/UPDATE y traduce las filas, nunca reimplementa las reglas.
  // ============================================================================

  private readonly REVENUE_GATE_COLUMNS =
    `id, organization_id, property_id, gate, shadow_started_at, propone_started_at, autopilot_started_at,
     propone_max_variation_pct::text as propone_max_variation_pct, owner_approved_autopilot_at, updated_by, updated_at, created_at`;

  private toRevenueGateRecord(r: RevenueGateRow): RevenueGateRecord {
    return {
      id: r.id,
      organizationId: r.organization_id,
      propertyId: r.property_id,
      gate: r.gate,
      shadowStartedAt: r.shadow_started_at,
      proponeStartedAt: r.propone_started_at,
      autopilotStartedAt: r.autopilot_started_at,
      proponeMaxVariationPct: Number(r.propone_max_variation_pct),
      ownerApprovedAutopilotAt: r.owner_approved_autopilot_at,
      updatedBy: r.updated_by,
      updatedAt: r.updated_at,
      createdAt: r.created_at,
    };
  }

  async findRevenueGate(propertyId: string): Promise<RevenueGateRecord | null> {
    const { rows } = await this.db.query<RevenueGateRow>(
      `select ${this.REVENUE_GATE_COLUMNS} from hoteles.revenue_engine_gate where property_id = $1;`,
      [propertyId],
    );
    return rows[0] ? this.toRevenueGateRecord(rows[0]) : null;
  }

  async ensureRevenueGate(propertyId: string, organizationId: string, actorUserId: string): Promise<RevenueGateRecord> {
    void actorUserId; // el trigger fija updated_by = auth.uid() por su cuenta, ver migrations/011.
    const existing = await this.findRevenueGate(propertyId);
    if (existing) return existing;
    const { rows } = await this.db.query<RevenueGateRow>(
      `insert into hoteles.revenue_engine_gate (organization_id, property_id, gate) values ($1, $2, 'shadow')
       returning ${this.REVENUE_GATE_COLUMNS};`,
      [organizationId, propertyId],
    );
    return this.toRevenueGateRecord(rows[0]!);
  }

  async updateRevenueGateState(propertyId: string, to: RevenueGateState, actorUserId: string): Promise<RevenueGateRecord> {
    void actorUserId; // el trigger fija updated_by = auth.uid(), no confía en este parámetro.
    const { rows } = await this.db.query<RevenueGateRow>(
      `update hoteles.revenue_engine_gate set gate = $2 where property_id = $1 returning ${this.REVENUE_GATE_COLUMNS};`,
      [propertyId, to],
    );
    if (!rows[0]) throw new Error(`revenue_gate_no_encontrado: la property ${propertyId} no tiene un gate de revenue inicializado todavía.`);
    return this.toRevenueGateRecord(rows[0]);
  }

  async setRevenueGateOwnerApproval(propertyId: string, granted: boolean, actorUserId: string): Promise<RevenueGateRecord> {
    void actorUserId; // el trigger exige que quien escribe esta columna sea "owner" (can_approve_revenue_autopilot).
    const { rows } = await this.db.query<RevenueGateRow>(
      `update hoteles.revenue_engine_gate set owner_approved_autopilot_at = case when $2 then now() else null end
       where property_id = $1 returning ${this.REVENUE_GATE_COLUMNS};`,
      [propertyId, granted],
    );
    if (!rows[0]) throw new Error(`revenue_gate_no_encontrado: la property ${propertyId} no tiene un gate de revenue inicializado todavía.`);
    return this.toRevenueGateRecord(rows[0]);
  }

  private toRevenueBacktestRunRecord(r: RevenueBacktestRunRow): RevenueBacktestRunRecord {
    return {
      id: r.id,
      organizationId: r.organization_id,
      propertyId: r.property_id,
      counterfactualMethod: r.counterfactual_method,
      windowsEvaluated: r.windows_evaluated,
      windowsEngineWon: r.windows_engine_won,
      engineTotalRevenue: Number(r.engine_total_revenue),
      baselineTotalRevenue: Number(r.baseline_total_revenue),
      improvementPct: Number(r.improvement_pct),
      passes: r.passes,
      failureReasons: r.failure_reasons ?? [],
      detail: r.detail ?? {},
      runBy: r.run_by,
      runAt: r.run_at,
      createdAt: r.created_at,
    };
  }

  async listRevenueBacktestRuns(propertyId: string): Promise<readonly RevenueBacktestRunRecord[]> {
    const { rows } = await this.db.query<RevenueBacktestRunRow>(
      `select id, organization_id, property_id, counterfactual_method, windows_evaluated, windows_engine_won,
              engine_total_revenue::text as engine_total_revenue, baseline_total_revenue::text as baseline_total_revenue,
              improvement_pct::text as improvement_pct, passes, failure_reasons, detail, run_by, run_at, created_at
       from hoteles.revenue_backtest_run where property_id = $1 order by run_at desc;`,
      [propertyId],
    );
    return rows.map((r) => this.toRevenueBacktestRunRecord(r));
  }

  async insertRevenueBacktestRun(input: NewRevenueBacktestRunInput): Promise<RevenueBacktestRunRecord> {
    const { rows } = await this.db.query<RevenueBacktestRunRow>(
      `insert into hoteles.revenue_backtest_run
         (organization_id, property_id, counterfactual_method, windows_evaluated, windows_engine_won,
          engine_total_revenue, baseline_total_revenue, improvement_pct, passes, failure_reasons, detail, run_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)
       returning id, organization_id, property_id, counterfactual_method, windows_evaluated, windows_engine_won,
                 engine_total_revenue::text as engine_total_revenue, baseline_total_revenue::text as baseline_total_revenue,
                 improvement_pct::text as improvement_pct, passes, failure_reasons, detail, run_by, run_at, created_at;`,
      [
        input.organizationId,
        input.propertyId,
        input.counterfactualMethod,
        input.windowsEvaluated,
        input.windowsEngineWon,
        input.engineTotalRevenue,
        input.baselineTotalRevenue,
        input.improvementPct,
        input.passes,
        JSON.stringify(input.failureReasons),
        JSON.stringify(input.detail),
        input.runBy,
      ],
    );
    return this.toRevenueBacktestRunRecord(rows[0]!);
  }

  // ============================================================================
  // Fase 11/13 (REQ-CRM-002/003) — reputación/CRM (ver migrations/013_reputacion.sql
  // + migrations/021_reputacion_respuestas.sql).
  // ============================================================================

  async insertGuestReview(input: NewGuestReviewInput): Promise<GuestReviewRecord> {
    const { rows } = await this.db.query<GuestReviewRawRow>(
      `insert into hoteles.guest_review
         (organization_id, property_id, guest_id, folio_id, source, external_id, texto, idioma,
          calificacion, stay_state, is_public, topics, sentiment, sentiment_score, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15)
       returning ${GUEST_REVIEW_COLUMNS};`,
      [
        input.organizationId,
        input.propertyId,
        input.guestId,
        input.folioId,
        input.source,
        input.externalId,
        input.texto,
        input.idioma,
        input.calificacion,
        input.stayState,
        input.isPublic,
        JSON.stringify(input.topics),
        input.sentiment,
        input.sentimentScore,
        input.createdBy,
      ],
    );
    return mapGuestReview(rows[0]!);
  }

  async listGuestReviews(propertyId: string, filter?: { readonly sentiment?: GuestReviewRecord["sentiment"] }): Promise<readonly GuestReviewRecord[]> {
    const { rows } = await this.db.query<GuestReviewRawRow>(
      filter?.sentiment
        ? `select ${GUEST_REVIEW_COLUMNS} from hoteles.guest_review where property_id = $1 and sentiment = $2 order by created_at desc limit 200;`
        : `select ${GUEST_REVIEW_COLUMNS} from hoteles.guest_review where property_id = $1 order by created_at desc limit 200;`,
      filter?.sentiment ? [propertyId, filter.sentiment] : [propertyId],
    );
    return rows.map(mapGuestReview);
  }

  async findGuestReview(propertyId: string, reviewId: string): Promise<GuestReviewRecord | null> {
    const { rows } = await this.db.query<GuestReviewRawRow>(
      `select ${GUEST_REVIEW_COLUMNS} from hoteles.guest_review where id = $1 and property_id = $2;`,
      [reviewId, propertyId],
    );
    return rows[0] ? mapGuestReview(rows[0]) : null;
  }

  async insertGuestReviewAction(input: NewGuestReviewActionInput): Promise<GuestReviewActionRecord> {
    const { rows } = await this.db.query<GuestReviewActionRawRow>(
      `insert into hoteles.guest_review_action
         (organization_id, property_id, review_id, action_type, status, ticket_id, detail, reason)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       returning ${GUEST_REVIEW_ACTION_COLUMNS};`,
      [input.organizationId, input.propertyId, input.reviewId, input.actionType, input.status, input.ticketId, JSON.stringify(input.detail), input.reason],
    );
    return mapGuestReviewAction(rows[0]!);
  }

  async listGuestReviewActions(propertyId: string, reviewId: string): Promise<readonly GuestReviewActionRecord[]> {
    const { rows } = await this.db.query<GuestReviewActionRawRow>(
      `select ${GUEST_REVIEW_ACTION_COLUMNS} from hoteles.guest_review_action where property_id = $1 and review_id = $2 order by created_at asc;`,
      [propertyId, reviewId],
    );
    return rows.map(mapGuestReviewAction);
  }

  async findGuestReviewAction(propertyId: string, actionId: string): Promise<GuestReviewActionRecord | null> {
    const { rows } = await this.db.query<GuestReviewActionRawRow>(
      `select ${GUEST_REVIEW_ACTION_COLUMNS} from hoteles.guest_review_action where id = $1 and property_id = $2;`,
      [actionId, propertyId],
    );
    return rows[0] ? mapGuestReviewAction(rows[0]) : null;
  }

  async resolveGuestReviewAction(
    propertyId: string,
    actionId: string,
    resolvedBy: string,
    status: Exclude<GuestReviewActionStatus, "pendiente">,
    ticketId: string | null,
  ): Promise<GuestReviewActionRecord> {
    const { rows } = await this.db.query<GuestReviewActionRawRow>(
      `update hoteles.guest_review_action
       set status = $1, ticket_id = coalesce($2, ticket_id), resolved_by = $3, resolved_at = now()
       where id = $4 and property_id = $5 and status = 'pendiente'
       returning ${GUEST_REVIEW_ACTION_COLUMNS};`,
      [status, ticketId, resolvedBy, actionId, propertyId],
    );
    if (rows[0]) return mapGuestReviewAction(rows[0]);
    const existing = await this.findGuestReviewAction(propertyId, actionId);
    if (!existing) throw new Error(`Acción de reputación ${actionId} no encontrada.`);
    throw new GuestReviewActionAlreadyResolvedError();
  }

  async insertGuestReviewResponse(input: NewGuestReviewResponseInput): Promise<GuestReviewResponseRecord> {
    const { rows } = await this.db.query<GuestReviewResponseRawRow>(
      `insert into hoteles.guest_review_response (organization_id, property_id, review_id, texto, created_by)
       values ($1, $2, $3, $4, $5)
       returning ${GUEST_REVIEW_RESPONSE_COLUMNS};`,
      [input.organizationId, input.propertyId, input.reviewId, input.texto, input.createdBy],
    );
    return mapGuestReviewResponse(rows[0]!);
  }

  async listGuestReviewResponses(propertyId: string, reviewId: string): Promise<readonly GuestReviewResponseRecord[]> {
    const { rows } = await this.db.query<GuestReviewResponseRawRow>(
      `select ${GUEST_REVIEW_RESPONSE_COLUMNS} from hoteles.guest_review_response where property_id = $1 and review_id = $2 order by created_at asc;`,
      [propertyId, reviewId],
    );
    return rows.map(mapGuestReviewResponse);
  }
}

interface RevenueGateRow {
  id: string;
  organization_id: string;
  property_id: string;
  gate: RevenueGateState;
  shadow_started_at: string;
  propone_started_at: string | null;
  autopilot_started_at: string | null;
  propone_max_variation_pct: string;
  owner_approved_autopilot_at: string | null;
  updated_by: string | null;
  updated_at: string;
  created_at: string;
}

interface RevenueBacktestRunRow {
  id: string;
  organization_id: string;
  property_id: string;
  counterfactual_method: NewRevenueBacktestRunInput["counterfactualMethod"];
  windows_evaluated: number;
  windows_engine_won: number;
  engine_total_revenue: string;
  baseline_total_revenue: string;
  improvement_pct: string;
  passes: boolean;
  failure_reasons: readonly string[];
  detail: Readonly<Record<string, unknown>>;
  run_by: string | null;
  run_at: string;
  created_at: string;
}
