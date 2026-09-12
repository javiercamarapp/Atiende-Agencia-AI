// Tipos de registro (fila ya mapeada a camelCase) que HotelesRepository devuelve/recibe
// — ninguna función de negocio de folios.ts/pedidosFnb.ts/quotes.ts en apps/api toca
// una fila cruda de SQL directamente, mismo criterio que domain-restaurantes/src/types.ts.
import type { ChargeConcept } from "./folioEngine.ts";
import type { AllergyDeclaredVia } from "./fnbAllergyGuard.ts";
import type { ReservationStatus } from "./reservationStateMachine.ts";
import type { FraudPattern } from "./fraude/deteccion.ts";

export type FolioStatus = "abierto" | "cerrado";
export type FolioCloseReason = "saldo_cero" | "cuenta_por_cobrar";
export type PaymentMethod = "efectivo" | "transferencia" | "tarjeta";
export type PaymentStatus = "pendiente" | "autorizado" | "capturado" | "fallido" | "reembolsado" | "expirado";

export interface ChargeRecord {
  readonly id: string;
  readonly folioId: string;
  readonly description: string;
  readonly amount: number;
  readonly taxAmount: number;
  readonly concept: ChargeConcept;
  readonly reversedBy: string | null;
  readonly reversesChargeId: string | null;
  readonly transferredFromChargeId: string | null;
  readonly discountAuthorizedBy: string | null;
  readonly createdAt: string;
}

export interface PaymentRecord {
  readonly id: string;
  readonly folioId: string;
  readonly amount: number;
  readonly method: PaymentMethod;
  readonly status: PaymentStatus;
  readonly externalRef: string | null;
  readonly tokenRef: string | null;
  readonly createdAt: string;
}

export interface FolioRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly reservationId: string;
  readonly status: FolioStatus;
  readonly label: string;
  readonly isPrimary: boolean;
  readonly closedAt: string | null;
  readonly closeReason: FolioCloseReason | null;
  readonly arApprovedBy: string | null;
  readonly charges: readonly ChargeRecord[];
  readonly payments: readonly PaymentRecord[];
}

export interface NewChargeInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly folioId: string;
  readonly description: string;
  readonly amount: number;
  readonly taxAmount: number;
  readonly concept: ChargeConcept;
  readonly reversesChargeId?: string | null;
  readonly transferredFromChargeId?: string | null;
  readonly discountAuthorizedBy?: string | null;
  readonly stayDate?: string | null;
}

export interface NewPaymentInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly folioId: string;
  readonly amount: number;
  readonly method: PaymentMethod;
  readonly status: PaymentStatus;
  readonly externalRef?: string | null;
  readonly tokenRef?: string | null;
}

export interface FnbOrderItem {
  readonly nombre: string;
  readonly notas?: string;
}

export interface FnbOrderRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly roomId: string | null;
  readonly items: readonly FnbOrderItem[];
  readonly notes: string | null;
  readonly allergyDeclared: boolean;
  readonly allergyDeclaredVia: AllergyDeclaredVia | null;
  readonly kitchenConfirmedBy: string | null;
  readonly kitchenConfirmedAt: string | null;
  readonly kitchenConfirmationNote: string | null;
  readonly safetyAssuranceSentBy: string | null;
  readonly safetyAssuranceSentAt: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export interface NewFnbOrderInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly roomId: string | null;
  readonly items: readonly FnbOrderItem[];
  readonly notes: string | null;
  readonly allergyDeclared: boolean;
  readonly allergyDeclaredVia: AllergyDeclaredVia | null;
  /** `null` cuando el pedido lo creó un canal sin staff humano logueado (Fase 2:
   *  Server Tool de voz o agente de WhatsApp con LLM — actor `system:voz`/
   *  `system:whatsapp`, ver domain-hoteles/src/whatsapp/llm-turn-handler.ts y
   *  apps/api/src/routes/verticals/hoteles/voice-tools.ts). La columna real
   *  (`hoteles.fnb_order.created_by`) ya era `references core.staff_user(id) on
   *  delete set null` — nullable desde Fase 1 — así que ensanchar este tipo no
   *  requiere migración; solo estos dos canales nuevos pasan `null`. */
  readonly createdBy: string | null;
}

export interface TaxConfigRecord {
  readonly ivaRate: number;
  readonly ishRate: number;
  readonly discountThreshold: number;
}

export interface NightlyRateRecord {
  readonly date: string;
  readonly price: number;
  readonly minStay: number;
  readonly closedToArrival: boolean;
  readonly closedToDeparture: boolean;
}

export interface GuestIdentity {
  readonly lastName: string | null;
  readonly phoneLast4: string | null;
}

// ─────────────────────────────────────────────────────────────────────────
// Fase 3 — máquina de estados de reservas (H02, ver diseño Fase 3 §1/§3.3). El
// `status` de una fila real siempre es un `ReservationStatus` (enum en Postgres desde
// migrations/005_reservas_estado.sql) — la validez de una TRANSICIÓN concreta la decide
// siempre `reservationStateMachine.ts::canTransition`, nunca este tipo.
// ─────────────────────────────────────────────────────────────────────────
export interface ReservationRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly guestId: string | null;
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly status: ReservationStatus;
  /** Monto NETO (antes de IVA/ISH) de la estadía completa — el mismo `netAmount` que
   *  devuelve el motor de cotización real (`quote.ts::Quote.netAmount`), NUNCA el
   *  total con impuestos ya incluidos. Decisión deliberada (diseño Fase 3 §3.4): si
   *  aquí se guardara el total CON impuestos, `evaluateNoShowPenaltyBase` +
   *  `computeNoShowPenaltyAmounts` volverían a gravar con IVA un monto que ya lo
   *  llevaba incluido — un bug de doble imposición, no cosmético. Cualquier ruta que
   *  necesite mostrar el total CON impuestos al huésped debe recalcularlo con
   *  `computeQuote`/`applyTaxes`, nunca leerlo de aquí. */
  readonly totalAmount: number;
  readonly cancellationPenaltyAmount: number | null;
  readonly canceledAt: string | null;
  readonly createdAt: string;
}

export interface NewReservationInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly guestId: string | null;
  readonly checkInDate: string;
  readonly checkOutDate: string;
  /** Ver `ReservationRecord.totalAmount`: SIEMPRE el neto (`Quote.netAmount`), nunca
   *  el total con impuestos. */
  readonly totalAmount: number;
  /** Opcional: mismo criterio de idempotencia a nivel de fila que ya usa
   *  `hoteles.idempotency_key`, pero ESTE índice (`(property_id, idempotency_key)`
   *  parcial) vive directo en `hoteles.reservation` porque una reserva es la entidad
   *  raíz de la que cuelga el folio primario — un reintento de creación nunca debe
   *  producir dos reservas ni dos folios primarios. */
  readonly idempotencyKey?: string | null;
}

export interface CancellationPolicyRecord {
  readonly freeUntilHours: number;
  readonly penaltyPct: number;
}

export type { ReservationStatus } from "./reservationStateMachine.ts";

// ─────────────────────────────────────────────────────────────────────────
// Fase 2 — agente de voz (ElevenLabs) y agente de mensajería/WhatsApp con LLM
// real (ver diseño Fase 2 hoteles §1-§3). Estos tipos son NUEVOS: ningún
// dominio de WhatsApp/voz existía en domain-hoteles Fase 1 (a diferencia de
// domain-restaurantes, que ya traía whatsapp/* completo).
// ─────────────────────────────────────────────────────────────────────────

/** Un mensaje de una conversación de WhatsApp ya persistida — mismo shape
 *  reducido (solo texto, nunca tool_calls/resultados crudos) que
 *  `ConversationMessage` en domain-restaurantes (diseño §2.5: el historial
 *  persistido es SIEMPRE texto plano, el arreglo de tool-use es efímero por
 *  turno). */
export interface ConversationMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/** Secreto dedicado por PROPERTY para las Server Tools de voz de ElevenLabs —
 *  decisión explícita del diseño Fase 2 §1/§5.1: a diferencia de
 *  restaurantes (secreto compartido de plataforma, `VOICE_TOOL_SECRET`), aquí
 *  se replica el patrón real del origen (`hotel_voice_agent_config`), porque
 *  el aislamiento por tenant es "el eje de seguridad central" que el origen
 *  documenta para hoteles específicamente. */
export interface VoiceAgentConfig {
  readonly propertyId: string;
  readonly organizationId: string;
  readonly toolWebhookSecret: string;
  readonly enabled: boolean;
}

/** Resultado de resolver a qué property pertenece un `phone_number_id` de
 *  Meta Cloud API — análogo a `resolveOrganizationByPhoneNumberId` de
 *  domain-restaurantes, pero resuelve directo a PROPERTY (no a organización):
 *  en hoteles cada número de WhatsApp real está atado a una sola property
 *  (`hoteles.whatsapp_channel_config.property_id`), así que el agente nunca
 *  necesita elegir sucursal — a diferencia de restaurantes multi-sucursal. */
export interface WhatsAppPropertyRoute {
  readonly propertyId: string;
  readonly organizationId: string;
}

export type ContactoNoOperativoSource = "voice" | "whatsapp";

// ─────────────────────────────────────────────────────────────────────────
// Fase 5 — H16-014/REQ-REC-014: fraude interno. `FraudAlertRecord` es a la vez el
// hallazgo detectado Y el sujeto de la cola de revisión humana (a diferencia de
// domain-despachos, que separa `invoice`/`invoice_review` en dos tablas porque ahí
// SÍ hay un registro primario propio del CFDI ingerido — aquí no existe un
// "registro primario" análogo, la alerta ES lo que se revisa).
// ─────────────────────────────────────────────────────────────────────────
export type FraudAlertStatus = "pendiente" | "confirmado" | "descartado";

export interface FraudAlertRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly pattern: FraudPattern;
  readonly folioId: string | null;
  readonly chargeId: string | null;
  readonly paymentId: string | null;
  readonly reason: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly recipientRoles: readonly string[];
  /** Clave determinista de idempotencia de escaneo (ver fraude/deteccion.ts) —
   *  re-escanear los mismos datos NUNCA duplica la alerta ya generada. */
  readonly dedupeKey: string;
  readonly status: FraudAlertStatus;
  readonly decisionNote: string | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
}

export interface NewFraudAlertInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly pattern: FraudPattern;
  readonly folioId: string | null;
  readonly chargeId: string | null;
  readonly paymentId: string | null;
  readonly reason: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly recipientRoles: readonly string[];
  readonly dedupeKey: string;
}

/** Insumo de lectura del patrón 1 (descuento fuera de política) — filas ya reales
 *  de `hoteles.charge` (concept='descuento', no reversado). */
export interface DiscountChargeForFraudScan {
  readonly chargeId: string;
  readonly folioId: string;
  readonly amount: number;
  readonly discountAuthorizedBy: string | null;
}

/** Insumo de lectura del patrón 2 (folio reabierto) — filas ya reales de
 *  `hoteles.folio` + `hoteles.charge` con `charge.created_at > folio.closed_at`. */
export interface ReopenedFolioChargeForFraudScan {
  readonly folioId: string;
  readonly folioClosedAt: string;
  readonly chargeId: string;
  readonly chargeCreatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Fase 5 — H5/REQ-BO-001/002: CFDI de hospedaje. `status` es el mismo vocabulario
// de dominio que expone `@atiende/mcp-cfdi::DomainCfdiStatus` — copiado aquí como
// tipo PROPIO de domain-hoteles (nunca un import cruzado hacia el paquete de
// transporte MCP) para que este paquete de dominio siga sin depender de un
// adaptador de infraestructura, mismo principio que `PaymentsPort`/
// `PaymentChargeResult.status` ya establecen para pagos.
// ─────────────────────────────────────────────────────────────────────────
export type CfdiEmisionTipo = "hospedaje" | "pago";
export type CfdiEmisionStatus = "pendiente" | "timbrado" | "en_proceso_cancelacion" | "cancelado" | "rechazado";

export interface CfdiEmisionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly folioId: string;
  readonly tipo: CfdiEmisionTipo;
  readonly uuidFiscal: string | null;
  readonly status: CfdiEmisionStatus;
  readonly pac: string | null;
  readonly subtotal: number;
  readonly iva: number;
  readonly ishTasa: number;
  readonly ishMonto: number;
  readonly dsaMonto: number;
  readonly total: number;
  readonly rfcReceptor: string;
  readonly usoCfdi: string;
  readonly metodoPago: string;
  readonly esExtranjero: boolean;
  readonly esGlobal: boolean;
  readonly esNoShow: boolean;
  readonly relatedCfdiId: string | null;
  readonly paymentId: string | null;
  readonly createdAt: string;
  readonly canceledAt: string | null;
}

export interface NewCfdiEmisionInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly folioId: string;
  readonly tipo: CfdiEmisionTipo;
  readonly uuidFiscal: string | null;
  readonly status: CfdiEmisionStatus;
  readonly pac: string | null;
  readonly subtotal: number;
  readonly iva: number;
  readonly ishTasa: number;
  readonly ishMonto: number;
  readonly dsaMonto: number;
  readonly total: number;
  readonly rfcReceptor: string;
  readonly usoCfdi: string;
  readonly metodoPago: string;
  readonly esExtranjero: boolean;
  readonly esGlobal: boolean;
  readonly esNoShow: boolean;
  readonly relatedCfdiId: string | null;
  readonly paymentId: string | null;
}

/** `hoteles.tax_config` YA expone `ivaRate`/`ishRate`/`discountThreshold`
 *  (`TaxConfigRecord`) — Fase 1. Este tipo es ADITIVO, no un reemplazo: separa la
 *  configuración fiscal de EMISIÓN de CFDI (DSA por cuarto-noche, RFC emisor del
 *  hotel) para no forzar a CADA seed/consumer existente de `TaxConfigRecord` (folios,
 *  taxes.ts, decenas de tests ya escritos en Fase 1-4) a aportar campos que solo
 *  necesita el flujo de CFDI nuevo de esta fase. */
export interface HospedajeFiscalConfig {
  /** `hoteles.tax_config.ish_rate` — mismo dato que `TaxConfigRecord.ishRate`,
   *  repetido aquí porque `computeCfdiHospedajeBreakdown` deriva el monto de ISH
   *  como residuo de `taxTotal - ivaAmount` (ver
   *  domain-hoteles/src/cfdi/reglas-fiscales-hospedaje.ts) — la tasa en sí solo se
   *  usa para reportarla en el desglose fiscal del CFDI (`impuestos_locales.ishTasa`
   *  de la migración), nunca para recalcular el monto. */
  readonly ishRate: number;
  /** Derecho de Saneamiento Ambiental — monto FIJO por cuarto-noche, varía por
   *  municipio (nunca un valor "de verdad" fijo en código). */
  readonly dsaPerNight: number;
  /** RFC del hotel emisor. `null` si el hotel todavía no lo configuró — sin él NO
   *  se puede timbrar ningún CFDI (mismo criterio que el original). */
  readonly rfcEmisor: string | null;
}

export interface ContactoNoOperativoRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly guestPhone: string | null;
  readonly guestName: string | null;
  readonly reason: string;
  readonly message: string | null;
  readonly source: ContactoNoOperativoSource;
  readonly createdAt: string;
}

export interface NewContactoNoOperativoInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly guestPhone: string | null;
  readonly guestName: string | null;
  readonly reason: string;
  readonly message: string | null;
  readonly source: ContactoNoOperativoSource;
}

// ─────────────────────────────────────────────────────────────────────────
// Fase 6 — REQ-REV-013: night audit propio. `NightAuditRunRecord` es la fila cruda de
// `hoteles.night_audit_run` (migrations/008) -- el resumen (`NightAuditSummary`) en sí
// se arma en @atiende/domain-hoteles/night-audit/engine.ts (capa pura), esta interfaz
// solo describe el registro de la CORRIDA (idempotencia por property+fecha).
// ─────────────────────────────────────────────────────────────────────────
export type NightAuditRunStatus = "en_progreso" | "completado";

export interface NightAuditRunRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly businessDate: string;
  readonly status: NightAuditRunStatus;
  readonly summary: Readonly<Record<string, unknown>>;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

/** Property de hoteles activa -- insumo de la ruta interna de barrido (mismo patrón
 *  que `CitasRepository.listActiveOrganizations()`, ver
 *  apps/api/src/routes/verticals/citas/reminders.ts). */
export interface ActiveHotelProperty {
  readonly organizationId: string;
  readonly propertyId: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Fase 6 — REQ-HK-011: tickets de mantenimiento correctivo (intake por staff/WhatsApp,
// SOLO turnos LFT + tickets -- explícitamente FUERA de esta fase: asignación
// automática de camaristas/CP-SAT e inspección por foto/OCR, ambas dependientes de
// REQ-INT-001 (conector PMS real), que ninguna vertical de fusion tiene todavía).
// ─────────────────────────────────────────────────────────────────────────
export type MaintenanceTicketOrigin = "huesped" | "staff" | "agente" | "sensor";
export type MaintenanceTicketSeverity = "alta" | "media" | "baja";
export type MaintenanceTicketStatus = "abierto" | "en_progreso" | "cerrado" | "cancelado";

export interface MaintenanceTicketRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly roomId: string | null;
  readonly title: string;
  readonly description: string;
  readonly origin: MaintenanceTicketOrigin;
  readonly severity: MaintenanceTicketSeverity;
  readonly status: MaintenanceTicketStatus;
  readonly assignedTo: string | null;
  readonly estimatedCost: number;
  readonly actualCost: number | null;
  readonly resolutionNote: string | null;
  readonly createdBy: string | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewMaintenanceTicketInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly roomId: string | null;
  readonly title: string;
  readonly description: string;
  readonly origin: MaintenanceTicketOrigin;
  readonly severity: MaintenanceTicketSeverity;
  readonly estimatedCost: number;
  /** `null` cuando el ticket lo levanta un canal sin staff humano logueado (agente de
   *  WhatsApp con LLM, `system:whatsapp` -- mismo criterio que
   *  `NewFnbOrderInput.createdBy`). */
  readonly createdBy: string | null;
}

// ─────────────────────────────────────────────────────────────────────────
// Fase 6 — REQ-HK-008: turnos de camaristas/lavandería. La plantilla se valida contra
// la LFT (`@atiende/domain-hoteles/housekeeping/turnos-lft.ts`, función pura) ANTES de
// publicarse -- solo lo YA válido llega a `hoteles.housekeeping_shift`
// (migrations/009); un intento inválido nunca se persiste (ver
// `assertTurnosLftPublishable`).
// ─────────────────────────────────────────────────────────────────────────
export interface HousekeepingShiftRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly staffId: string;
  readonly workDate: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly createdAt: string;
}

export interface NewHousekeepingShiftInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly staffId: string;
  readonly workDate: string;
  readonly startTime: string;
  readonly endTime: string;
}
