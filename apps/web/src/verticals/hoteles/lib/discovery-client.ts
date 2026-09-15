// Lógica de datos del descubrimiento de property (Fase 7) — separada de
// HotelesShell.tsx a propósito, mismo motivo que dashboard-client.ts de
// restaurantes: probarla con vitest en entorno "node" (sin DOM) mientras el
// componente solo la conecta a estado/render real. Llama a
// GET /v1/hoteles/:orgSlug/admin/propiedades de apps/api (ver
// apps/api/src/routes/verticals/hoteles/admin-discovery.ts).
import { fetchJson } from "./admin-client.ts";

export interface PropertyOption {
  readonly propertyId: string;
  readonly nombre: string;
}

export async function fetchProperties(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string): Promise<readonly PropertyOption[]> {
  const body = await fetchJson<{ propiedades: readonly PropertyOption[] }>(fetchImpl, `${apiBaseUrl}/v1/hoteles/${orgSlug}/admin/propiedades`, token);
  return body.propiedades;
}

// Hallazgo de auditoría (severidad ALTA, "cadena con 2+ hoteles solo opera el
// primero"): HotelesShell.tsx fijaba `properties[0]` sin importar cuántas
// properties trajera GET .../admin/propiedades — aunque una cadena real con más de
// un hotel es exactamente el caso que este endpoint ya soporta (devuelve la lista
// COMPLETA de properties activas de la organización, ver admin-discovery.ts). No
// hacía falta ningún cambio de esquema/backend: solo faltaba dejar de descartar el
// resto de la lista. `resolveActivePropertyId` es la función pura que decide qué
// property queda activa dado lo que el selector de la UI tenga elegido — extraída
// así (en vez de hardcodearla en el componente), MISMO patrón exacto que
// `resolveActivePropertyId` de despachos/lib/admin-client.ts (leído primero como
// plantilla): probarla sin depender de un DOM/React renderer, que este repo no
// tiene configurado (vitest corre en `environment: "node"`).
export function resolveActivePropertyId(properties: readonly PropertyOption[], selectedPropertyId: string | null): string | null {
  if (properties.length === 0) return null;
  if (selectedPropertyId !== null && properties.some((p) => p.propertyId === selectedPropertyId)) return selectedPropertyId;
  return properties[0]!.propertyId;
}
