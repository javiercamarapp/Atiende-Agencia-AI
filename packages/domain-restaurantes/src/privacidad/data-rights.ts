// PM PR-9 (restaurantes) -- solicitudes de derechos ARCO (acceso, rectificacion, cancelacion,
// oposicion): tipos, plazos de referencia, estado de vencimiento y textos de la respuesta guiada
// del agente de WhatsApp y de voz. Persistencia en migrations/030_privacidad_arco_aviso_retencion.sql;
// deteccion de intencion en arco-intent.ts. Mismo patron que domain-citas/src/data-rights.ts.
//
// Esto es documentacion operativa, NO asesoria legal: los plazos son una referencia conservadora
// (dias de calendario) y cada responsable debe validar su aviso de privacidad y su procedimiento
// con su asesor juridico.

export const DATA_RIGHT_TYPES = ["acceso", "rectificacion", "cancelacion", "oposicion"] as const;
export type DataRightType = (typeof DATA_RIGHT_TYPES)[number];

export const DATA_RIGHT_STATUSES = [
  "pendiente_confirmacion",
  "recibida",
  "en_proceso",
  "bloqueada",
  "resuelta",
  "rechazada",
  "cancelada_titular",
  "expirada",
] as const;
export type DataRightStatus = (typeof DATA_RIGHT_STATUSES)[number];

/** Estados a los que el STAFF puede mover una solicitud. Espeja la lista permitida de
 * `restaurantes.update_data_rights_request_status`. */
export const DATA_RIGHT_STAFF_TARGET_STATUSES = ["en_proceso", "bloqueada", "resuelta", "rechazada"] as const;
export type DataRightStaffTargetStatus = (typeof DATA_RIGHT_STAFF_TARGET_STATUSES)[number];

/** Estados "abiertos": la solicitud sigue corriendo plazos. */
export const DATA_RIGHT_OPEN_STATUSES: readonly DataRightStatus[] = ["recibida", "en_proceso", "bloqueada"];

export const DATA_RIGHTS_RESPONSE_DAYS = 20;
export const DATA_RIGHTS_EXECUTION_DAYS = 15;
/** Una confirmacion pendiente caduca a las 24 h (misma constante que la SQL). */
export const DATA_RIGHTS_CONFIRMATION_WINDOW_HOURS = 24;

export type DataRightsChannel = "whatsapp" | "voice";
/** Con que se verifico la identidad: el numero que escribe por WhatsApp lo autentica Meta; el
 * identificador de llamada puede falsearse, asi que el staff debe verificar al titular por otra
 * via ANTES de responder. */
export type DataRightsIdentityBasis = "whatsapp_numero" | "llamada_identificador";

export const DATA_RIGHT_LABEL: Readonly<Record<DataRightType, string>> = {
  acceso: "acceso",
  rectificacion: "rectificación",
  cancelacion: "cancelación",
  oposicion: "oposición",
};

export interface DataRightsRequestRow {
  readonly id: string;
  readonly customerPhone: string;
  readonly rightType: DataRightType;
  readonly channel: DataRightsChannel;
  readonly identityBasis: DataRightsIdentityBasis;
  readonly status: DataRightStatus;
  readonly detail: string | null;
  readonly requestedAt: string;
  readonly confirmedAt: string | null;
  readonly responseDueAt: string | null;
  readonly executionDueAt: string | null;
  readonly resolvedAt: string | null;
  readonly resolutionNote: string | null;
  readonly handledBy: string | null;
  readonly updatedAt: string;
}

export interface DataRightsEventRow {
  readonly id: string;
  readonly requestId: string;
  readonly actorKind: "titular" | "sistema" | "staff";
  readonly actorUserId: string | null;
  readonly event: string;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
  readonly note: string | null;
  readonly createdAt: string;
}

export interface DataRightsRequestsFiltro {
  readonly status?: DataRightStatus | null;
  readonly rightType?: DataRightType | null;
}

export interface DataRightsPaginacion {
  readonly limit?: number;
  readonly offset?: number;
}

export interface DataRightsRequestsPage {
  /** `false` (nunca lanza) cuando la migracion 030 todavia no esta aplicada en esta base
   * (SQLSTATE 42883/42P01/42703): la pantalla debe decir "no disponible aun", nunca confundirlo con
   * una lista real vacia. */
  readonly disponible: boolean;
  readonly items: readonly DataRightsRequestRow[];
  readonly total: number;
  readonly nextOffset: number | null;
}

export type RegisterDataRightsOutcome =
  | { readonly available: false }
  | { readonly available: true; readonly id: string; readonly status: DataRightStatus; readonly alreadyOpen: boolean; readonly responseDueAt: string | null };

export type ConfirmDataRightsOutcome =
  | { readonly available: false }
  | { readonly available: true; readonly found: false }
  | {
      readonly available: true;
      readonly found: true;
      readonly id: string;
      readonly rightType: DataRightType;
      readonly status: DataRightStatus;
      readonly responseDueAt: string | null;
      readonly executionDueAt: string | null;
    };

export type UpdateDataRightsStatusResult =
  | { readonly outcome: "updated"; readonly id: string; readonly status: DataRightStatus }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "invalid_transition" }
  | { readonly outcome: "invalid_input" }
  | { readonly outcome: "forbidden" }
  | { readonly outcome: "unavailable" };

export type DataRightsDeadlineState = "en_plazo" | "por_vencer" | "vencida";

/** Estado de vencimiento operativo de una solicitud abierta (null si ya cerro o todavia no corre
 * plazo). En `recibida` corre el plazo de respuesta; en `en_proceso`/`bloqueada` el de ejecucion.
 * "Por vencer" = faltan 5 dias o menos. */
export function dataRightsDeadlineState(
  row: Pick<DataRightsRequestRow, "status" | "responseDueAt" | "executionDueAt">,
  now: Date = new Date(),
): DataRightsDeadlineState | null {
  if (!DATA_RIGHT_OPEN_STATUSES.includes(row.status)) return null;
  const dueIso = row.status === "recibida" ? row.responseDueAt : row.executionDueAt;
  if (!dueIso) return null;
  const dueMs = new Date(dueIso).getTime();
  if (Number.isNaN(dueMs)) return null;
  const remainingMs = dueMs - now.getTime();
  if (remainingMs < 0) return "vencida";
  if (remainingMs <= 5 * 24 * 60 * 60 * 1000) return "por_vencer";
  return "en_plazo";
}

/** Folio corto que se le da al titular (8 primeros caracteres del id, en mayusculas). */
export function dataRightsFolio(id: string): string {
  return id.replace(/-/g, "").slice(0, 8).toUpperCase();
}

function formatDueDate(iso: string | null, timezone: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("es-MX", { timeZone: timezone, day: "numeric", month: "long", year: "numeric" }).format(date);
  } catch {
    return new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", day: "numeric", month: "long", year: "numeric" }).format(date);
  }
}

// ---------------------------------------------------------------------------
// Textos de la respuesta guiada. Nunca incluyen datos personales del titular ni de nadie mas:
// solo folio, tipo de derecho y fechas.
// ---------------------------------------------------------------------------

export const ARCO_MENU_REPLY =
  "Puede ejercer sus derechos sobre los datos personales asociados a este número (derechos ARCO):\n" +
  "• Acceso: conocer qué datos suyos tenemos.\n" +
  "• Rectificación: corregir datos incorrectos.\n" +
  "• Cancelación: pedir que se supriman sus datos.\n" +
  "• Oposición: oponerse a cierto uso de sus datos.\n" +
  "Dígame cuál desea, por ejemplo: \"quiero acceso a mis datos personales\". Solo atiendo solicitudes sobre los datos de quien escribe desde este número.\n" +
  "Si solo quería hacer un pedido o pedir su factura, dígamelo y seguimos; su pedido en curso no se pierde.";

export const ARCO_THIRD_PARTY_REPLY =
  "Por seguridad solo puedo recibir solicitudes sobre los datos personales asociados a este mismo número, hechas por su titular. " +
  "Si necesita ejercer derechos sobre los datos de otra persona, ella debe escribir desde su propio número o contactar directamente al restaurante. No puedo compartir información de otras personas.";

export function arcoPendingConfirmationReply(rightType: DataRightType, id: string): string {
  return (
    `Recibí su solicitud de ${DATA_RIGHT_LABEL[rightType]} sobre los datos personales asociados a este número (folio ${dataRightsFolio(id)}). ` +
    "Para confirmar que la hace usted, responda CONFIRMO. Si no la hizo usted o desea retirarla, responda CANCELAR SOLICITUD. " +
    "La confirmación vale por 24 horas."
  );
}

export function arcoConfirmedReply(rightType: DataRightType, id: string, responseDueAt: string | null, executionDueAt: string | null, timezone: string): string {
  const responseDate = formatDueDate(responseDueAt, timezone);
  const executionDate = formatDueDate(executionDueAt, timezone);
  const plazos = responseDate
    ? `El restaurante debe responderle a más tardar el ${responseDate} (${DATA_RIGHTS_RESPONSE_DAYS} días)${executionDate ? ` y, si procede, hacerla efectiva a más tardar el ${executionDate} (${DATA_RIGHTS_EXECUTION_DAYS} días más)` : ""}. `
    : `El restaurante debe responderle en un máximo de ${DATA_RIGHTS_RESPONSE_DAYS} días y, si procede, hacerla efectiva en los ${DATA_RIGHTS_EXECUTION_DAYS} días siguientes. `;
  const extra =
    rightType === "cancelacion"
      ? "En cancelación, sus datos se bloquean primero y se suprimen después, salvo que exista una obligación de conservarlos. "
      : "";
  return (
    `Listo, su solicitud de ${DATA_RIGHT_LABEL[rightType]} quedó registrada (folio ${dataRightsFolio(id)}). ` +
    plazos +
    extra +
    "Por seguridad no envío datos personales por este chat: el equipo lo contactará por este mismo número tras verificar su identidad."
  );
}

export function arcoWithdrawnReply(rightType: DataRightType, id: string): string {
  return `Listo, retiré su solicitud de ${DATA_RIGHT_LABEL[rightType]} (folio ${dataRightsFolio(id)}). Si necesita algo más, aquí estoy.`;
}

export function arcoAlreadyOpenReply(rightType: DataRightType, id: string, status: DataRightStatus, responseDueAt: string | null, timezone: string): string {
  if (status === "pendiente_confirmacion") return arcoPendingConfirmationReply(rightType, id);
  const date = formatDueDate(responseDueAt, timezone);
  return (
    `Ya tiene una solicitud de ${DATA_RIGHT_LABEL[rightType]} abierta (folio ${dataRightsFolio(id)}). ` +
    (date ? `El restaurante debe responderle a más tardar el ${date}. ` : "") +
    "No hace falta repetirla; lo contactarán por este mismo número."
  );
}
