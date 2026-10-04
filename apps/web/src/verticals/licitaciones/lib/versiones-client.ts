// Cliente web de Versiones y Fuentes de una convocatoria (paridad3 L-P3-14/REQ-017/152/153): GET .../tenders/:id/versions (historial con diff por
// campo y por requisito) y GET .../tenders/:id/sources (fuente primaria + fuentes enlazadas por huella cruzada, con sus conflictos). Solo lectura.
import { fetchJson } from "./admin-client.ts";

export type DiffStatus = "sin_cambio" | "modificado" | "nuevo" | "eliminado";

/** Espejo de `TenderFieldChange`. */
export interface TenderFieldChange {
  readonly field: string;
  readonly status: DiffStatus;
  readonly previous: unknown;
  readonly current: unknown;
}

/** Espejo de `TenderRequirementChange` (solo lo que la pantalla muestra). */
export interface TenderRequirementChange {
  readonly key: string;
  readonly status: DiffStatus;
  readonly requirementKind: string | null;
  readonly previous: { readonly text: string } | null;
  readonly current: { readonly text: string } | null;
}

export interface TenderVersionEntry {
  readonly version: number;
  readonly hash: string;
  readonly createdAt: string;
  readonly diff: {
    readonly fields: readonly TenderFieldChange[];
    readonly requirements: readonly TenderRequirementChange[];
    readonly changedFieldNames: readonly string[];
    readonly affectedSectionKeys: readonly string[];
    readonly hasChanges: boolean;
  };
}

export interface SourceFieldConflict {
  readonly field: string;
  readonly current: unknown;
  readonly alternative: unknown;
}

/** Espejo de `TenderSourceLink`. */
export interface TenderSourceLink {
  readonly source: string;
  readonly externalId: string;
  readonly primary: boolean;
  readonly firstSeenAt: string | null;
  readonly lastSeenAt: string | null;
  readonly conflicts: readonly SourceFieldConflict[];
}

export async function fetchTenderVersions(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<readonly TenderVersionEntry[]> {
  const body = await fetchJson<{ versions: readonly TenderVersionEntry[] }>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/versions`, token);
  return body.versions;
}

export async function fetchTenderSources(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<readonly TenderSourceLink[]> {
  const body = await fetchJson<{ sources: readonly TenderSourceLink[] }>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/sources`, token);
  return body.sources;
}

export const CAMPO_LABEL: Readonly<Record<string, string>> = {
  title: "Título",
  submissionDeadline: "Fecha límite",
  submission_deadline: "Fecha límite",
  contractingBody: "Convocante",
  contracting_body: "Convocante",
  cpvCodes: "Clasificadores",
  cpv_codes: "Clasificadores",
  budgetAmount: "Presupuesto",
  budget_amount: "Presupuesto",
  currency: "Moneda",
  state: "Estado",
  procedureTypeRaw: "Tipo de procedimiento",
  procedure_type_raw: "Tipo de procedimiento",
};

export const DIFF_LABEL: Readonly<Record<DiffStatus, string>> = { sin_cambio: "Sin cambio", modificado: "Modificado", nuevo: "Nuevo", eliminado: "Eliminado" };

/** Valor de un campo de diff como texto corto; `null`/vacio se muestra como guion. */
export function valorTexto(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.length === 0 ? "—" : value.join(", ");
  return String(value);
}
