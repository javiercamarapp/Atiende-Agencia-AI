// L-P3-17 -- cliente de la bitacora de ESCRITURAS de la organizacion (GET .../audit-trail y .../audit-trail/tenders/:id/trace, solo owner/admin).
// Mismo aislamiento que el resto de apps/web: no depende de `@atiende/domain-licitaciones`. El servidor decide el rol y la organizacion.
import { fetchJson } from "./admin-client.ts";

export interface AuditTrailEntry {
  readonly id: string;
  readonly seq: string;
  readonly entity: string;
  readonly entityId: string | null;
  readonly action: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly actorId: string | null;
  readonly correlationId: string | null;
  readonly createdAt: string;
}

export interface AuditTrailPage {
  readonly items: readonly AuditTrailEntry[];
  readonly nextCursor: string | null;
  /** `false` = la migracion 038 aun no esta aplicada: estado honesto "no disponible aun". */
  readonly available: boolean;
  readonly entities: readonly string[];
  /** actorId -> nombre (solo de la organizacion; sin correos). */
  readonly people: Readonly<Record<string, string>>;
}

export interface AuditTrailFilters {
  readonly entity?: string;
  readonly actorId?: string;
  readonly desde?: string;
  readonly hasta?: string;
  readonly correlationId?: string;
}

export const ENTIDAD_LABEL: Readonly<Record<string, string>> = {
  documento_empresa: "Documento de empresa",
  tarifa: "Tarifa",
  capacidad: "Capacidad",
  experiencia: "Experiencia",
  firmante: "Firmante",
  configuracion: "Configuración",
  perfil_matching: "Perfil de matching",
  staff_invitacion: "Invitación de staff",
  staff_miembro: "Miembro del staff",
  convocatoria: "Convocatoria",
  expediente: "Expediente",
  paquete: "Paquete",
};

const ACCION_LABEL: Readonly<Record<string, string>> = {
  creado: "creado",
  creada: "creada",
  editado: "editado",
  editada: "editada",
  aprobado: "aprobado",
  rechazado: "rechazado",
  revocada: "revocada",
  rol_cambiado: "rol cambiado",
  actualizada: "actualizada",
  ingerida: "ingerida por la ingesta automática",
  version_registrada: "nueva versión registrada",
  etapa_aprobada: "etapa aprobada",
  manifiesto_generado: "manifiesto generado",
};

/** `tarifa.editado` -> "Tarifa editado" legible; una accion desconocida se muestra tal cual (nunca se inventa). */
export function accionLegible(entity: string, action: string): string {
  const verbo = action.includes(".") ? action.slice(action.indexOf(".") + 1) : action;
  return `${ENTIDAD_LABEL[entity] ?? entity} · ${ACCION_LABEL[verbo] ?? verbo}`;
}

export interface CambioCampo {
  readonly campo: string;
  readonly antes: string;
  readonly despues: string;
}

function texto(v: unknown): string {
  if (v === undefined || v === null) return "—";
  if (Array.isArray(v)) return v.length === 0 ? "(vacío)" : v.join(", ");
  return String(v);
}

/** Campos cuyo valor cambio entre `antes` y `despues` (un alta muestra todos con antes "—"). Orden estable por nombre de campo. */
export function cambiosDe(antes: Record<string, unknown> | null, despues: Record<string, unknown> | null): readonly CambioCampo[] {
  const campos = [...new Set([...Object.keys(antes ?? {}), ...Object.keys(despues ?? {})])].sort();
  const out: CambioCampo[] = [];
  for (const campo of campos) {
    const a = texto(antes?.[campo]);
    const d = texto(despues?.[campo]);
    if (a !== d) out.push({ campo, antes: a, despues: d });
  }
  return out;
}

function query(filters: AuditTrailFilters, cursor: string | null, limit: number): string {
  const p = new URLSearchParams();
  if (filters.entity) p.set("entity", filters.entity);
  if (filters.actorId) p.set("actorId", filters.actorId);
  if (filters.correlationId) p.set("correlationId", filters.correlationId);
  // Fechas de calendario (yyyy-mm-dd) -> instante ISO; `hasta` incluye todo el dia.
  if (filters.desde) p.set("desde", new Date(`${filters.desde}T00:00:00-06:00`).toISOString());
  if (filters.hasta) p.set("hasta", new Date(`${filters.hasta}T23:59:59.999-06:00`).toISOString());
  if (cursor) p.set("cursor", cursor);
  p.set("limit", String(limit));
  return p.toString();
}

export function fetchAuditTrail(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, filters: AuditTrailFilters, cursor: string | null, limit = 25): Promise<AuditTrailPage> {
  return fetchJson<AuditTrailPage>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/audit-trail?${query(filters, cursor, limit)}`, token);
}

export function fetchAuditTrace(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<Omit<AuditTrailPage, "entities">> {
  return fetchJson<Omit<AuditTrailPage, "entities">>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/audit-trail/tenders/${encodeURIComponent(tenderId)}/trace`, token);
}
