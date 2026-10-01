// Lógica de datos de la bóveda de identidad (H-01) — consume
// apps/api/src/routes/verticals/hoteles/identidad.ts. Los metadatos se listan sin
// descifrar; el documento completo solo llega por `revealIdentidad` (motivo obligatorio,
// queda en la bitácora) y vive únicamente en el estado de React de quien lo pidió.
import { fetchJson, sendJson } from "./admin-client.ts";

export type DocumentType = "ine" | "pasaporte" | "licencia_conducir" | "forma_migratoria" | "otro";
export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  ine: "INE",
  pasaporte: "Pasaporte",
  licencia_conducir: "Licencia de conducir",
  forma_migratoria: "Forma migratoria",
  otro: "Otro",
};
export type IdentidadEstado = "activo" | "purgado";
export type PurgaEstado = "pendiente" | "ejecutada" | "rechazada";
export type MigratorioEstado = "pendiente" | "reportado";

export const PURGA_ESTADO_LABELS: Record<PurgaEstado, string> = { pendiente: "Pendiente", ejecutada: "Ejecutada", rechazada: "Rechazada" };
export const MIGRATORIO_ESTADO_LABELS: Record<MigratorioEstado, string> = { pendiente: "Pendiente", reportado: "Reportado" };

export interface IdentidadSummary {
  readonly id: string;
  readonly huespedId: string;
  readonly reservaId: string | null;
  readonly tipoDocumento: DocumentType;
  readonly nacionalidad: string | null;
  readonly ultimos4: string | null;
  readonly versionLlave: number;
  readonly estado: IdentidadEstado;
  readonly retencionHasta: string;
  readonly verificadaEn: string | null;
  readonly verificadaPor: string | null;
  readonly capturadaPor: string | null;
  readonly creadaEn: string;
  readonly purgadaEn: string | null;
}

export interface IdentidadList {
  /** `false` = la migración 031 aún no está aplicada en esta base (estado "no disponible aún"). */
  readonly disponible: boolean;
  readonly llaveConfigurada: boolean;
  readonly items: readonly IdentidadSummary[];
}

export interface DocumentoRevelado {
  readonly nombreCompleto: string;
  readonly numeroDocumento: string;
  readonly fechaNacimiento: string | null;
  readonly paisEmisor: string | null;
  readonly vigenciaHasta: string | null;
  readonly mrz: string | null;
}

export interface PurgaSummary {
  readonly id: string;
  readonly identidadId: string;
  readonly solicitadaPor: string;
  readonly motivo: string;
  readonly estado: PurgaEstado;
  readonly decididaPor: string | null;
  readonly decididaEn: string | null;
  readonly notaDecision: string | null;
  readonly creadaEn: string;
}

export interface MigratorioSummary {
  readonly id: string;
  readonly reservaId: string;
  readonly huespedId: string;
  readonly identidadId: string | null;
  readonly nacionalidad: string | null;
  readonly llegada: string;
  readonly salida: string;
  readonly estado: MigratorioEstado;
  readonly constancia: string | null;
  readonly reportadoEn: string | null;
  readonly reportadoPor: string | null;
  readonly creadoEn: string;
  /** Hasta cuando se conserva el registro textual (sin imagen). Opcional: una API anterior no lo envia. */
  readonly retencionRegistroHasta?: string;
}

export interface CaptureIdentidadInput {
  readonly guestId: string;
  readonly reservationId?: string;
  readonly documentType: DocumentType;
  readonly nationality?: string;
  readonly fullName: string;
  readonly documentNumber: string;
  readonly birthDate?: string;
  readonly expiryDate?: string;
  readonly retentionDays?: number;
}

// Politica de retencion de la IMAGEN cifrada. REDECLARADA a proposito (apps/web no depende de
// @atiende/domain-hoteles): debe coincidir con IDENTITY_IMAGE_RETENTION_DAYS_* de
// packages/domain-hoteles/src/identity/service.ts. Es una DECISION DE PRODUCTO (informe
// atiende-loop/expertos/retencion-identidad-hoteles-mx.md), NO un mandato legal.
export const IMAGEN_RETENCION_DIAS_DEFECTO = 30;
export const IMAGEN_RETENCION_DIAS_MIN = 0;
export const IMAGEN_RETENCION_DIAS_MAX = 365;
/** Conservacion del registro textual (sin imagen): MIGRATORY_RETENTION_DAYS_DEFAULT del dominio. */
export const REGISTRO_RETENCION_DIAS_DEFECTO = 365;

function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type PlanRetencion =
  | { readonly valido: false; readonly mensaje: string }
  | { readonly valido: true; readonly dias: number; readonly hasta: string | null };

/** Plazo que aplicara la captura. `diasTexto` vacio = default (30). Con fecha de salida de la
 *  reserva se calcula la fecha exacta; sin reserva solo se informa "N dias desde la captura"
 *  (la fecha la fija el servidor con la zona horaria del hotel). */
export function planRetencionImagen(diasTexto: string, checkOutDate: string | null): PlanRetencion {
  const t = diasTexto.trim();
  let dias = IMAGEN_RETENCION_DIAS_DEFECTO;
  if (t !== "") {
    const n = Number(t);
    if (!Number.isInteger(n) || n < IMAGEN_RETENCION_DIAS_MIN || n > IMAGEN_RETENCION_DIAS_MAX) {
      return { valido: false, mensaje: `Los días de conservación deben ser un entero entre ${IMAGEN_RETENCION_DIAS_MIN} y ${IMAGEN_RETENCION_DIAS_MAX}.` };
    }
    dias = n;
  }
  return { valido: true, dias, hasta: checkOutDate ? addDaysYmd(checkOutDate, dias) : null };
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/hoteles/${propertyId}`;

export function fetchIdentidades(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, estado?: IdentidadEstado): Promise<IdentidadList> {
  return fetchJson<IdentidadList>(fetchImpl, `${base(apiBaseUrl, propertyId)}/identidad${estado ? `?estado=${estado}` : ""}`, token);
}

export async function captureIdentidad(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: CaptureIdentidadInput): Promise<IdentidadSummary> {
  const body: Record<string, unknown> = { ...input };
  for (const k of Object.keys(body)) if (body[k] === undefined || body[k] === "") delete body[k];
  return (await sendJson<{ identidad: IdentidadSummary }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/identidad`, token, "POST", body)).identidad;
}

export async function verifyIdentidad(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string): Promise<IdentidadSummary | null> {
  return (await sendJson<{ identidad: IdentidadSummary | null }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/identidad/${id}/verificar`, token, "POST", {})).identidad;
}

export async function revealIdentidad(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string, motivo: string): Promise<DocumentoRevelado> {
  return (await sendJson<{ documento: DocumentoRevelado }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/identidad/${id}/revelar`, token, "POST", { motivo })).documento;
}

export async function requestPurga(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string, motivo: string): Promise<string> {
  return (await sendJson<{ solicitudId: string }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/identidad/${id}/solicitar-purga`, token, "POST", { motivo })).solicitudId;
}

export function fetchPurgas(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, estado?: PurgaEstado): Promise<{ readonly disponible: boolean; readonly items: readonly PurgaSummary[] }> {
  return fetchJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/identidad-purgas${estado ? `?estado=${estado}` : ""}`, token);
}

export async function decidePurga(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, solicitudId: string, aprobar: boolean, nota?: string): Promise<"ejecutada" | "rechazada"> {
  return (await sendJson<{ resultado: "ejecutada" | "rechazada" }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/identidad-purgas/${solicitudId}/decidir`, token, "POST", { aprobar, nota })).resultado;
}

export function fetchMigratorios(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, estado?: MigratorioEstado): Promise<{ readonly disponible: boolean; readonly items: readonly MigratorioSummary[] }> {
  return fetchJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/registro-migratorio${estado ? `?estado=${estado}` : ""}`, token);
}

export async function createMigratorio(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: { reservaId: string; huespedId: string; identidadId?: string }): Promise<MigratorioSummary> {
  return (await sendJson<{ registro: MigratorioSummary }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/registro-migratorio`, token, "POST", input)).registro;
}

export async function reportMigratorio(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string, constancia: string): Promise<MigratorioSummary> {
  return (await sendJson<{ registro: MigratorioSummary }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/registro-migratorio/${id}/reportar`, token, "POST", { constancia })).registro;
}

/** Los roles de la UI espejan IDENTITY_* de domain-hoteles/src/roles.ts (cosmético: el servidor es la barrera real). */
export const REVEAL_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk"]);
export const ADMIN_ROLES: ReadonlySet<string> = new Set(["owner", "gm"]);
