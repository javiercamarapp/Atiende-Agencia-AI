// ═══════════════════════════════════════════════════════════════════════════
// `CfdiPort` — contrato de timbrado CFDI 4.0 vía PAC, con dos PAC intercambiables
// como mitigación de riesgo de timbrado mal formado. Puerto de
// `hoteles/packages/mcp-servers/cfdi/src/port.ts`.
//
// DECISIÓN DE FIDELIDAD: el original define este contrato con esquemas Zod
// (`z.object(...)`). `zod` no es dependencia de NINGÚN paquete de atiende-fusion
// hoy (el resto del monorepo — despachos/hoteles/billing — valida a mano con
// funciones `requireString`/`requireNumber` en la capa HTTP, ver p. ej.
// `apps/api/src/routes/verticals/despachos/cfdi.ts`) — introducir una dependencia
// externa nueva solo para este paquete pequeño habría sido inconsistente con el
// patrón ya establecido en el propio repo fusión, que el encargo pide seguir. Este
// archivo expresa el MISMO contrato como interfaces TS planas; la validación de
// entrada en runtime (equivalente a lo que Zod hacía al llamar `.parse()`) vive en
// la capa que arma `TimbrarInput`/`CancelarInput` antes de invocar el puerto —
// `apps/api/src/routes/verticals/hoteles/cfdi.ts` — con el mismo estilo manual que
// ya usa `despachos/cfdi.ts`.
//
// Nombres de PAC (`FinkokAdapter`/`SwSapienAdapter`) son ejemplos de proveedores
// PAC mexicanos reales de conocimiento público — la elección final de proveedor
// queda pendiente del fundador (igual que el original documenta).
// ═══════════════════════════════════════════════════════════════════════════
import type { AdapterStatus } from "./shared.ts";

// ---------------------------------------------------------------------------
// Estado de dominio del CFDI. El SAT/PAC reportan "vigente"/"cancelado" nativamente
// en español, pero cada PAC usa su propio vocabulario intermedio para el proceso de
// cancelación (aceptación/rechazo de cancelación 2022+) — se mapea explícitamente
// para no acoplar el resto del sistema al vocabulario de un PAC.
// ---------------------------------------------------------------------------
export const DOMAIN_CFDI_STATUSES = ["pendiente", "timbrado", "en_proceso_cancelacion", "cancelado", "rechazado"] as const;
export type DomainCfdiStatus = (typeof DOMAIN_CFDI_STATUSES)[number];
export function isDomainCfdiStatus(value: string): value is DomainCfdiStatus {
  return (DOMAIN_CFDI_STATUSES as readonly string[]).includes(value);
}

/** Vocabulario nativo de ejemplo de un PAC (ciclo de vida documentado por el SAT:
 *  timbrado -> vigente -> cancelado, con proceso de aceptación/rechazo de
 *  cancelación 2022+). */
export const PAC_NATIVE_STATUSES = ["stamped", "active", "cancellation_pending", "canceled", "rejected"] as const;
export type PacNativeStatus = (typeof PAC_NATIVE_STATUSES)[number];

export function mapPacStatusToDomain(status: PacNativeStatus): DomainCfdiStatus {
  const map: Record<PacNativeStatus, DomainCfdiStatus> = {
    stamped: "timbrado",
    active: "timbrado",
    cancellation_pending: "en_proceso_cancelacion",
    canceled: "cancelado",
    rejected: "rechazado",
  };
  return map[status];
}

// ---------------------------------------------------------------------------
// Formas de entrada/salida
// ---------------------------------------------------------------------------

/** Subconjunto de "ImpuestosLocales" (ISH/DSA) que el hotel debe declarar por CFDI
 *  de hospedaje — el desglose YA calculado por
 *  `@atiende/domain-hoteles::validarCfdiHospedaje`, nunca recalculado aquí. */
export interface ImpuestosLocales {
  readonly ishTasa: number;
  readonly ishMonto: number;
  readonly dsaMonto?: number;
}

export interface TimbrarInput {
  /** Referencia interna del hotel — clave de idempotencia: timbrar dos veces el
   *  mismo folio NUNCA emite dos UUID. */
  readonly folio: string;
  readonly rfcEmisor: string;
  readonly rfcReceptor: string;
  readonly subtotal: number;
  readonly iva: number;
  readonly impuestosLocales: ImpuestosLocales;
  readonly total: number;
  readonly moneda: "MXN";
  readonly usoCfdi: string;
  readonly metodoPago: "PUE" | "PPD";
}

export interface CfdiTimbrado {
  readonly uuid: string;
  readonly folio: string;
  readonly status: DomainCfdiStatus;
  readonly selloDigital: string;
  readonly fechaTimbrado: string;
  readonly pac: string;
}

export const MOTIVOS_CANCELACION = ["01", "02", "03", "04"] as const;
export type MotivoCancelacion = (typeof MOTIVOS_CANCELACION)[number];

export interface CancelarInput {
  readonly uuid: string;
  readonly motivo: MotivoCancelacion; // catálogo SAT c_MotivoCancelacion
  readonly folioSustitucion?: string; // obligatorio si motivo === "01"
  readonly idempotencyKey: string;
}

export interface CfdiCancelacion {
  readonly uuid: string;
  readonly status: DomainCfdiStatus;
  readonly fechaSolicitud: string;
}

export interface CfdiWebhookEvent {
  readonly eventId: string;
  readonly type: "cfdi.timbrado_confirmado" | "cfdi.cancelado" | "cfdi.cancelacion_rechazada";
  readonly uuid: string;
  readonly status: DomainCfdiStatus;
  readonly occurredAt: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** Rechaza timbrar dos veces con datos DIFERENTES bajo el mismo folio — la
 *  idempotencia no es "ignorar" sino "detectar inconsistencia". */
export class CfdiFolioConflictError extends Error {
  readonly code = "cfdi_folio_conflict";
  readonly folio: string;
  constructor(folio: string) {
    super(`el folio ${folio} ya fue timbrado con datos distintos a los solicitados`);
    this.name = "CfdiFolioConflictError";
    this.folio = folio;
  }
}

/** Fix hallazgo auditoría (rubro 6, ALTA) — otro proceso/instancia ya tiene una
 *  reserva VIVA de este folio ahora mismo (está a medio timbrar). `DualPacCfdiPort`
 *  falla rápido en vez de esperar/reintentar (ver comentario de cabecera de
 *  `dual-pac-cfdi-port.ts` para el trade-off): el llamador (típicamente la ruta
 *  HTTP que invocó `timbrar`) debe traducir esto a un reintento explícito del
 *  cliente poco después, nunca a un 500 genérico. */
export class CfdiFolioStampingInProgressError extends Error {
  readonly code = "cfdi_folio_stamping_in_progress";
  readonly folio: string;
  constructor(folio: string) {
    super(`el folio ${folio} ya tiene un timbrado en curso en otro proceso; reintenta en unos segundos`);
    this.name = "CfdiFolioStampingInProgressError";
    this.folio = folio;
  }
}

// ---------------------------------------------------------------------------
// Puerto
// ---------------------------------------------------------------------------

export interface CfdiPort {
  status(): AdapterStatus;

  /** Idempotente por `input.folio`. Lanza `CfdiFolioConflictError` si el folio ya
   *  se timbró con otros datos. */
  timbrar(input: TimbrarInput): Promise<CfdiTimbrado>;

  /** Idempotente por `input.idempotencyKey`. */
  cancelar(input: CancelarInput): Promise<CfdiCancelacion>;

  consultarEstado(uuid: string): Promise<DomainCfdiStatus>;

  verifyAndNormalizeWebhook(rawBody: string, signatureHeader: string | undefined): Promise<CfdiWebhookEvent>;
}
