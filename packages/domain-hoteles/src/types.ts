// Tipos de registro (fila ya mapeada a camelCase) que HotelesRepository devuelve/recibe
// — ninguna función de negocio de folios.ts/pedidosFnb.ts/quotes.ts en apps/api toca
// una fila cruda de SQL directamente, mismo criterio que domain-restaurantes/src/types.ts.
import type { ChargeConcept } from "./folioEngine.ts";
import type { AllergyDeclaredVia } from "./fnbAllergyGuard.ts";
import type { ReservationStatus } from "./reservationStateMachine.ts";
import type { FraudPattern } from "./fraude/deteccion.ts";
import type { UsaliDepartment, UsaliExpenseCategory, UsaliRevenueDepartment } from "./pl/usaliPL.ts";
import type { RevenueGateState } from "./revenue/revenueEngineGate.ts";
import type { CounterfactualMethod } from "./revenue/walkForwardBacktest.ts";

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
// Fix hallazgo ALTA (hoteles/Reservas.tsx) — catálogos de solo lectura que le
// faltaban al flujo de creación de reservas: hasta ahora `POST .../reservas` exigía
// `roomTypeId`/`guestId` como UUID de memoria (sin ningún GET para descubrirlos), así
// que recepción no podía crear una reserva real sin copiar un UUID desde otro lado
// (SQL/otra pestaña). Ambos tipos son proyecciones de solo lectura de
// `hoteles.room_type`/`hoteles.guest` (migrations/001_hoteles_schema.sql) — mismo
// criterio que `PropertySummary`/`HotelOrganizationSummary` (Fase 7): un tipo NUEVO y
// mínimo para el catálogo, nunca el registro completo de la tabla.
// ─────────────────────────────────────────────────────────────────────────
export interface RoomTypeSummary {
  readonly id: string;
  readonly name: string;
  readonly maxOccupancy: number;
}

export interface GuestSummary {
  readonly id: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly phone: string | null;
}

// ─────────────────────────────────────────────────────────────────────────
// Fix hallazgo CRÍTICO ("Alta de organización/property/tipos-de-habitación/
// tarifas/huéspedes imposible sin SQL directo -- POST /reservas depende de
// tarifas sembradas manualmente"): hasta este cambio `hoteles.room_type`/
// `hoteles.room`/`hoteles.rate_plan`/`hoteles.guest` solo tenían GRANT de
// SELECT para `authenticated` (ver el comentario de la migración 001: "gestión
// de catálogo (insert/update) queda fuera de Fase 1... INSERT/UPDATE quedan
// solo para service_role") -- sin una sola tarifa sembrada por SQL directo,
// `POST .../reservas` SIEMPRE fallaba con `sin_tarifa` (quote.ts), sin que el
// panel tuviera ninguna forma de sembrarla. Ver migrations/018_admin_catalogo_alta.sql
// para el GRANT/policy real que habilita estos 4 métodos nuevos.
//
// Deliberadamente FUERA de este cambio (documentado, no un olvido): alta de
// ORGANIZACIÓN/PROPERTY (`core.organization`/`core.property`) -- ambas tablas
// son núcleo COMPARTIDO por las 6 verticales y solo otorgan INSERT a
// `service_role` (packages/db/migrations/0001_core_schema.sql), que este
// monorepo no aprovisiona (ver el mismo gap ya documentado en
// `packages/domain-rentas/src/onboarding/repository.ts` y, decisión IDÉNTICA
// ya tomada en este mismo repo, `packages/domain-restaurantes/migrations/
// 007_admin_backoffice_grants_and_policies.sql`: "Ampliar esa policy es una
// decisión de plataforma completa, fuera del alcance de una fase de un solo
// vertical"). Crear una property nueva sigue requiriendo el mismo alta manual
// que ya requería antes de este cambio.
// ─────────────────────────────────────────────────────────────────────────

export interface NewRoomTypeInput {
  readonly propertyId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly maxOccupancy: number;
}

export interface RoomSummary {
  readonly id: string;
  readonly code: string;
  readonly status: "disponible" | "ocupada" | "sucia" | "fuera_de_servicio" | "mantenimiento";
  readonly roomTypeId: string;
}

export interface NewRoomInput {
  readonly propertyId: string;
  readonly organizationId: string;
  readonly roomTypeId: string;
  readonly code: string;
}

/** Body real de "crear tarifa" -- un solo submit siembra un RANGO de fechas (no una
 * fecha a la vez, que obligaría a N clics para una temporada completa) con el mismo
 * precio/reglas para todas. Un segundo submit que traslape fechas ya sembradas las
 * SOBREESCRIBE (`ON CONFLICT (room_type_id, date) DO UPDATE`, mismo índice único ya
 * existente desde migrations/001) -- corregir el precio de una temporada ya cargada
 * no exige borrar primero. */
export interface NewRatePlanRangeInput {
  readonly propertyId: string;
  readonly organizationId: string;
  readonly roomTypeId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly price: number;
  readonly currency: string;
  readonly minStay: number;
  readonly closedToArrival: boolean;
  readonly closedToDeparture: boolean;
}

export interface NewGuestInput {
  readonly propertyId: string;
  readonly organizationId: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly phone: string | null;
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
  /** Fix hallazgo CRÍTICO ("asignación de habitación al reservar"): `null` hasta que
   *  el staff asigna una habitación FÍSICA concreta (`hoteles.room`) a la reserva vía
   *  `HotelesRepository.assignRoomToReservation` — la reserva en sí SIEMPRE se crea
   *  contra un `roomTypeId` (tipo de habitación, disponibilidad agregada por tipo,
   *  ver `bookAvailability`), nunca contra una habitación concreta; el número de
   *  cuarto real es una decisión operativa posterior (recepción/night-audit), igual
   *  que en un PMS real. Ninguna validación de traslape por fecha entre dos reservas
   *  que compartan la MISMA habitación se hace hoy (limitación documentada, ver el
   *  comentario de cabecera de `assignRoomToReservation`) -- la disponibilidad real
   *  sigue siendo por TIPO de habitación (`hoteles.availability`), esta asignación es
   *  solo el número de cuarto que se le comunica al huésped. */
  readonly roomId: string | null;
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
// Fase 6b -- flujos de sistema de night-audit/no-show
// (migrations/023_night_audit_sistema_escritura.sql). EXCLUSIVOS de
// `apps/worker/src/jobs/hoteles/{night-audit,no-show}.ts` cuando corren bajo
// `session: "sistema"` -- ver el header de esa migración y de
// `HotelesRepository` (repository.ts, sección "Fase 6b") para el análisis
// completo de por qué el camino de sistema necesita un método/tipo NUEVO por
// operación en vez de reutilizar los de arriba.
// ─────────────────────────────────────────────────────────────────────────

/** Candidata a no-show, versión MÍNIMA system-only -- solo los 3 campos que
 *  `evaluateNoShowPenaltyBase` necesita (folioEngine.ts). A diferencia de
 *  `findDueNoShowReservations` (camino de staff, sin cambio, sigue
 *  devolviendo el `ReservationRecord` completo), esta vía nunca expone el
 *  resto de la fila. */
export interface DueNoShowReservationForSystem {
  readonly reservationId: string;
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly totalAmount: number;
}

/** Input de `HotelesRepository.systemPostNightAuditCharge` -- `netAmount`/
 *  `taxAmount` YA CALCULADOS por `planNightlyHospedajeCharges`/
 *  `computeChargeAmounts` (TypeScript puro); la función SQL detrás de este
 *  método NUNCA recalcula un monto, solo valida invariantes baratos y
 *  persiste (ver migrations/023). */
export interface NewSystemNightAuditChargeInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly reservationId: string;
  readonly folioId: string;
  readonly businessDate: string;
  readonly netAmount: number;
  readonly taxAmount: number;
}

/** Input de `HotelesRepository.systemApplyNoShow` -- `netAmount`/`taxAmount`
 *  YA CALCULADOS por `evaluateNoShowPenaltyBase`/`computeNoShowPenaltyAmounts`
 *  (folioEngine.ts, TypeScript puro) ANTES de reclamar la reserva (ambos solo
 *  dependen de datos ya disponibles en la candidata, ver el header de
 *  migrations/023 para el detalle). */
export interface NewSystemNoShowApplicationInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly reservationId: string;
  readonly netAmount: number;
  readonly taxAmount: number;
}

/** `null` cuando `systemApplyNoShow` perdió el reclamo atómico (la reserva ya
 *  no estaba en 'confirmada' -- carrera perdida, mismo criterio de no-op que
 *  `transitionReservation`). */
export interface SystemNoShowApplicationResult {
  readonly folioId: string;
  readonly chargeId: string;
  readonly chargeCreatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Fase 7 — descubrimiento de organización/property para el panel web de staff
// (apps/web/src/verticals/hoteles): `LoginSession.organizations` (ver
// apps/web/src/lib/auth-client.ts) solo trae {id, slug, nombre, vertical, rol} —
// nunca un propertyId, porque una organización de hoteles puede tener más de un
// hotel (a diferencia del supuesto "1 org = 1 property" que sí vale para algunas
// otras verticales) — mismo problema y misma solución que ya resolvió
// restaurantes (`GET /v1/restaurantes/:orgSlug/admin/branches`, ver
// apps/api/src/routes/verticals/restaurantes/admin-kpis.ts, comentario de
// cabecera de esa ruta). `HotelOrganizationSummary`/`PropertySummary` son un
// espejo de solo-lectura de `core.organization`/`core.property` (vertical
// 'hoteles') — igual que `BranchSummary` en domain-restaurantes, este dominio no
// posee esas filas (viven en `core`), solo las expone para que la ruta de
// descubrimiento no tenga que hablar SQL de `core` directamente.
// ─────────────────────────────────────────────────────────────────────────
export interface HotelOrganizationSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface PropertySummary {
  readonly propertyId: string;
  readonly name: string;
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

// ─────────────────────────────────────────────────────────────────────────
// Fase 8 — REQ-BO-024 (P0/GOB, LFT art.132 fr.XXXIV): checador de asistencia
// INALTERABLE, cruzado contra el horario programado, exportable a la STPS. Distinto
// de `HousekeepingShiftRecord` de arriba (migrations/009): ese es la PLANTILLA de
// turnos ya validada contra la LFT ANTES de publicarse (horario PLANEADO);
// `AttendanceEventRecord` es el registro REAL de cuándo un empleado efectivamente
// entró/salió (`hoteles.attendance_log`, migrations/010_checador_asistencia.sql) --
// append-only, encadenado por hash por empleado, nunca editable ni borrable (ver esa
// migración para la garantía real; esta interfaz solo describe la fila cruda).
// `StaffScheduleRecord` es el horario programado (mutable, administrado por
// owner/gm) contra el que `crossCheckAttendance` (checador/attendance.ts) cruza lo
// trabajado -- separado de `HousekeepingShiftRecord` porque cubre a TODO el staff
// (no solo camaristas/lavandería) y trae `authorizedOvertimeMinutes`, un campo que
// housekeeping_shift no necesita.
// ─────────────────────────────────────────────────────────────────────────
export type AttendanceEventType = "entrada" | "salida";

export interface AttendanceEventRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly staffUserId: string;
  readonly eventType: AttendanceEventType;
  /** ISO-8601, SIEMPRE fijado por el servidor al insertarse (`now()`), nunca por lo
   *  que mande el cliente -- correcto para un registro inalterable de verdad (LFT
   *  art.132 fr.XXXIV): el reloj del checador es el del servidor, no el del celular
   *  de quien ficha. */
  readonly recordedAt: string;
  readonly source: string;
  readonly note: string | null;
  readonly createdAt: string;
}

export interface NewAttendanceEventInput {
  readonly organizationId: string;
  readonly propertyId: string;
  /** SIEMPRE el actor autenticado que hace la petición -- ver
   *  ATTENDANCE_ADMIN_ROLES/roles.ts, comentario de cabecera: ningún caller de este
   *  método (ni la ruta HTTP) debe aceptar un staffUserId ajeno del cliente. */
  readonly staffUserId: string;
  readonly eventType: AttendanceEventType;
  readonly source: string;
  readonly note: string | null;
}

export interface StaffScheduleRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly staffUserId: string;
  /** Fecha de negocio del turno, YYYY-MM-DD. */
  readonly workDate: string;
  /** ISO-8601. */
  readonly scheduledStart: string;
  /** ISO-8601. */
  readonly scheduledEnd: string;
  readonly authorizedOvertimeMinutes: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewStaffScheduleInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly staffUserId: string;
  readonly workDate: string;
  readonly scheduledStart: string;
  readonly scheduledEnd: string;
  readonly authorizedOvertimeMinutes: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Fase 10 — REQ-BO-010 (P0): back-office financiero, P&L USALI + punto de equilibrio
// dinámico. `ExpenseEntryRecord` es la fila cruda de `hoteles.expense_entry`
// (migrations/012_pl_usali.sql) -- el lado de GASTOS reales por departamento que
// `packages/domain-hoteles/src/pl/usaliPL.ts` (capa pura) necesita para armar el
// Summary Operating Statement; el lado de INGRESOS ya existe vía `ChargeRecord.
// concept` (no requiere un tipo nuevo). Append-only (mismo criterio que
// `ChargeRecord`/REQ-REC-004): un gasto registrado no se edita ni se borra, se
// corrige con una contrapartida nueva.
// ─────────────────────────────────────────────────────────────────────────
export interface ExpenseEntryRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly department: UsaliDepartment;
  readonly category: UsaliExpenseCategory;
  readonly description: string;
  readonly amount: number;
  readonly expenseDate: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export interface NewExpenseEntryInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly department: UsaliDepartment;
  readonly category: UsaliExpenseCategory;
  readonly description: string;
  readonly amount: number;
  readonly expenseDate: string;
  readonly createdBy: string | null;
}

/** Una fila de ingreso YA resuelta a departamento USALI para un `fecha` -- ver
 *  `HotelesRepository.loadRevenueByDepartmentAndDateForPl` (`hoteles.charge`, con
 *  `reverses_charge_id` resuelto al departamento del cargo ORIGINAL, 'propina'
 *  excluida -- mismo mapeo que documenta migrations/012_pl_usali.sql). */
export interface PlRevenueByDateRow {
  readonly fecha: string;
  readonly department: UsaliRevenueDepartment;
  readonly revenue: number;
}

/** Una fila de gasto YA agregada por fecha desde `hoteles.expense_entry` -- ver
 *  `HotelesRepository.loadExpensesByDepartmentAndDateForPl`. `department` cubre el
 *  universo completo de `UsaliDepartment` (operados + no distribuidos + debajo de
 *  GOP), a diferencia de `PlRevenueByDateRow` que solo cubre los operados. */
export interface PlExpenseByDateRow {
  readonly fecha: string;
  readonly department: UsaliDepartment;
  readonly category: UsaliExpenseCategory;
  readonly amount: number;
}

/** Habitaciones-noche REALMENTE ocupadas y cobradas de un `fecha` (`hoteles.charge`
 *  con `concept='hospedaje'` y `reversed_by is null`, agrupado por `stay_date`) -- ver
 *  `HotelesRepository.loadOccupiedRoomNightsByDateForPl`. */
export interface PlOccupiedRoomNightsByDateRow {
  readonly fecha: string;
  readonly roomNights: number;
  readonly revenue: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Fase 11 — REQ-CRM-002/003: reputación/CRM. Espejo de aplicación de
// `migrations/013_reputacion.sql` (`hoteles.guest_review`/
// `hoteles.guest_review_action`) -- ver el comentario de cabecera de esa migración y
// de `reputacion/clasificador.ts` para el alcance completo (incluyendo lo que
// deliberadamente NO cubre esta fase: ingesta automática real de Google/Booking/
// TripAdvisor, y la orquestación de `apps/api` que ejecutaría el ticket de
// mantenimiento / enviaría el mensaje proactivo / aplicaría la compensación).
// `GuestReviewRecord.topics`/`sentiment`/`sentimentScore` son la salida YA
// persistida de `clasificarResena()` (packages/domain-hoteles/src/reputacion/
// clasificador.ts), nunca recalculada al leer.
// ─────────────────────────────────────────────────────────────────────────
export type GuestReviewSource = "google" | "booking" | "tripadvisor" | "expedia" | "encuesta_propia" | "otro";
export type GuestReviewStayState = "en_estancia" | "post_estancia" | "desconocido";
export type GuestReviewSentiment = "muy_negativo" | "negativo" | "neutral" | "positivo" | "muy_positivo";

export interface GuestReviewTopicRecord {
  readonly topic: string;
  readonly esConocido: boolean;
  readonly menciones: number;
  readonly palabrasClave: readonly string[];
}

export interface GuestReviewRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly guestId: string | null;
  readonly folioId: string | null;
  readonly source: GuestReviewSource;
  /** Id de la reseña en la plataforma de origen -- `null` para una encuesta propia
   *  capturada directamente (no tiene un id externo que deduplicar). Idempotencia
   *  real vía índice único parcial (`hoteles.guest_review`, ver la migración): la
   *  MISMA reseña externa nunca se clasifica ni se dispara dos veces. */
  readonly externalId: string | null;
  readonly texto: string;
  readonly idioma: string;
  readonly calificacion: number | null;
  readonly stayState: GuestReviewStayState;
  readonly isPublic: boolean;
  readonly topics: readonly GuestReviewTopicRecord[];
  readonly sentiment: GuestReviewSentiment;
  readonly sentimentScore: number;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export interface NewGuestReviewInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly guestId: string | null;
  readonly folioId: string | null;
  readonly source: GuestReviewSource;
  readonly externalId: string | null;
  readonly texto: string;
  readonly idioma: string;
  readonly calificacion: number | null;
  readonly stayState: GuestReviewStayState;
  readonly isPublic: boolean;
  readonly topics: readonly GuestReviewTopicRecord[];
  readonly sentiment: GuestReviewSentiment;
  readonly sentimentScore: number;
  readonly createdBy: string | null;
}

export type GuestReviewActionType = "ticket_mantenimiento" | "mensaje_proactivo" | "compensacion_reglada";
export type GuestReviewActionStatus = "pendiente" | "ejecutada" | "descartada";

export interface GuestReviewActionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly reviewId: string;
  readonly actionType: GuestReviewActionType;
  readonly status: GuestReviewActionStatus;
  /** Solo poblado para `ticket_mantenimiento` cuando la orquestación (fuera de esta
   *  fase, ver comentario de cabecera de `migrations/013_reputacion.sql`) ya haya
   *  creado el ticket real en `hoteles.maintenance_ticket`. */
  readonly ticketId: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly reason: string;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
}

export interface NewGuestReviewActionInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly reviewId: string;
  readonly actionType: GuestReviewActionType;
  readonly status: GuestReviewActionStatus;
  readonly ticketId: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly reason: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Fase 9 — REQ-REV-003/004/005/007: motor de revenue management (pricing).
// Espejo de aplicación de `migrations/011_revenue_engine_gate.sql`
// (`hoteles.revenue_engine_gate`/`hoteles.revenue_backtest_run`) -- gap real
// verificado contra el código de main antes de esta fase de wiring: el dominio puro
// (`revenue/revenueEngineGate.ts`/`walkForwardBacktest.ts`) y la migración SQL ya
// existían (Fase 9), pero `HotelesRepository` no tenía NINGÚN método para las dos
// tablas -- ninguna ruta HTTP podía funcionar sin ellos. La autoridad real de la
// máquina de estados sigue siendo el trigger de Postgres
// (`revenue_engine_gate_transition_guard`); estos tipos son solo el espejo de
// aplicación de las columnas reales de la tabla, mismo criterio que el resto de este
// archivo.
// ─────────────────────────────────────────────────────────────────────────
export interface RevenueGateRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly gate: RevenueGateState;
  readonly shadowStartedAt: string;
  readonly proponeStartedAt: string | null;
  readonly autopilotStartedAt: string | null;
  readonly proponeMaxVariationPct: number;
  /** `null` = sin aprobación vigente -- ver comentario de cabecera de
   *  `migrations/011_revenue_engine_gate.sql` sobre por qué solo "owner" puede
   *  escribir este campo y por qué nunca sobrevive a una democión. */
  readonly ownerApprovedAutopilotAt: string | null;
  readonly updatedBy: string | null;
  readonly updatedAt: string;
  readonly createdAt: string;
}

export interface RevenueBacktestRunRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly counterfactualMethod: CounterfactualMethod;
  readonly windowsEvaluated: number;
  readonly windowsEngineWon: number;
  readonly engineTotalRevenue: number;
  readonly baselineTotalRevenue: number;
  readonly improvementPct: number;
  readonly passes: boolean;
  readonly failureReasons: readonly string[];
  readonly detail: Readonly<Record<string, unknown>>;
  readonly runBy: string | null;
  readonly runAt: string;
  readonly createdAt: string;
}

export interface NewRevenueBacktestRunInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly counterfactualMethod: CounterfactualMethod;
  readonly windowsEvaluated: number;
  readonly windowsEngineWon: number;
  readonly engineTotalRevenue: number;
  readonly baselineTotalRevenue: number;
  readonly improvementPct: number;
  readonly passes: boolean;
  readonly failureReasons: readonly string[];
  readonly detail: Readonly<Record<string, unknown>>;
  readonly runBy: string | null;
}

// ─────────────────────────────────────────────────────────────────────────
// Fase 13 — cierre del wiring de reputación (migrations/
// 021_reputacion_respuestas.sql): la respuesta libre de staff a una reseña
// (distinta de `GuestReviewActionRecord`, que modela ACCIONES REGLADAS
// disparadas por la clasificación -- ver comentario de cabecera de la migración).
// ─────────────────────────────────────────────────────────────────────────
export interface GuestReviewResponseRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly reviewId: string;
  readonly texto: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export interface NewGuestReviewResponseInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly reviewId: string;
  readonly texto: string;
  readonly createdBy: string | null;
}
