// Lógica de datos de `citas.tenant_config` (Fase 8) — port de
// ConfiguracionSection.tsx del origen, acotado a los 3 campos que domain-citas
// modela (ver admin.ts::GET/PATCH .../tenant-config y
// domain-citas/src/repository.ts::TenantConfigPatch para por qué `name`/`slug`/
// `is_active` del negocio no se editan aquí).
import { fetchJson, sendJson } from "./admin-client.ts";

export interface TenantConfig {
  readonly rubro: string;
  readonly defaultTimezone: string;
  readonly ownerNotificationPhone: string | null;
}

interface TenantConfigApiRow {
  readonly organization_id: string;
  readonly rubro: string;
  readonly default_timezone: string;
  readonly owner_notification_phone: string | null;
}

function mapTenantConfig(row: TenantConfigApiRow): TenantConfig {
  return { rubro: row.rubro, defaultTimezone: row.default_timezone, ownerNotificationPhone: row.owner_notification_phone };
}

export async function fetchTenantConfig(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<TenantConfig> {
  const body = await fetchJson<{ tenant_config: TenantConfigApiRow }>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/tenant-config`, token);
  return mapTenantConfig(body.tenant_config);
}

export interface TenantConfigPatch {
  readonly rubro?: string;
  readonly defaultTimezone?: string;
  readonly ownerNotificationPhone?: string | null;
}

export async function updateTenantConfig(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, patch: TenantConfigPatch): Promise<TenantConfig> {
  const body = await sendJson<{ tenant_config: TenantConfigApiRow }>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/tenant-config`, token, "PATCH", {
    rubro: patch.rubro,
    default_timezone: patch.defaultTimezone,
    owner_notification_phone: patch.ownerNotificationPhone,
  });
  return mapTenantConfig(body.tenant_config);
}

/** Mismos 14 rubros reales de `domain-citas::ALL_VERTICALS` (vertical-config.ts) —
 * duplicado aquí a propósito en vez de importar el paquete de dominio completo al
 * bundle web (mismo criterio que el resto de `apps/web/src/verticals/citas/lib/*`:
 * solo tipos/constantes livianas, nunca lógica de negocio real). Las etiquetas son
 * las mismas que ya usaba `ConfiguracionSection.tsx` del origen para las que
 * comparten rubro; los 6 rubros nuevos de esta vertical (psicologo/gimnasio/
 * farmacia/escuela/seguros/mecanico) llevan una etiqueta nueva, en el mismo estilo. */
export const RUBRO_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "medico", label: "Consultorio médico" },
  { value: "dental", label: "Consultorio dental" },
  { value: "barberia", label: "Barbería" },
  { value: "salon", label: "Salón de belleza" },
  { value: "spa", label: "Spa" },
  { value: "veterinaria", label: "Veterinaria" },
  { value: "restaurante", label: "Restaurante (reservación de mesa)" },
  { value: "psicologo", label: "Psicólogo/a" },
  { value: "gimnasio", label: "Gimnasio" },
  { value: "farmacia", label: "Farmacia" },
  { value: "escuela", label: "Escuela" },
  { value: "seguros", label: "Seguros" },
  { value: "mecanico", label: "Taller mecánico" },
  { value: "otro", label: "Otro" },
];
