// Rn-19 -- cliente del catálogo (propiedades, unidades, propietarios) de
// `apps/api/src/routes/verticals/rentas/admin-catalogo.ts`. Monedas y rangos son los del servidor, duplicados a propósito
// (apps/web no depende de los paquetes de dominio); el servidor y la base son SIEMPRE la autoridad.
import { fetchJson, sendJson } from "./admin-client.ts";

export const MONEDAS = ["MXN", "USD"] as const;
export type Moneda = (typeof MONEDAS)[number];

export interface PropiedadCatalogo {
  readonly propertyId: string;
  readonly nombre: string;
  readonly zonaHoraria: string | null;
  readonly moneda: string | null;
}

export interface UnidadCatalogo {
  readonly id: string;
  readonly propertyId: string;
  readonly nombre: string;
  readonly duracionMinimaNoches: number;
  readonly propietarioId: string | null;
  readonly propietarioNombre: string | null;
  /** Responsable de limpieza por omision: la tarea de cada checkout nace asignada a el (`null` = cola "Sin asignar"). */
  readonly responsableLimpiezaId?: string | null;
}

export interface Propietario {
  readonly id: string;
  readonly nombre: string;
  readonly email: string | null;
}

export interface Catalogo {
  readonly propiedad: PropiedadCatalogo | null;
  readonly propiedades: readonly PropiedadCatalogo[];
  readonly unidades: readonly UnidadCatalogo[];
  readonly propietarios: readonly Propietario[];
  readonly monedas: readonly Moneda[];
  /** `true` solo para admin_gestora (cosmético: el servidor vuelve a exigirlo en cada escritura). */
  readonly puedeEditar: boolean;
}

const raiz = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/v1/rentas/${propertyId}/admin/catalogo`;

export function fetchCatalogo(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<Catalogo> {
  return fetchJson<Catalogo>(fetchImpl, raiz(apiBaseUrl, propertyId), token);
}

export function editarPropiedad(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  cambios: { readonly nombre?: string; readonly zonaHoraria?: string; readonly moneda?: Moneda },
): Promise<{ propertyId: string }> {
  return sendJson(fetchImpl, `${raiz(apiBaseUrl, propertyId)}/propiedad`, token, "PATCH", cambios);
}

export function crearPropiedad(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  entrada: { readonly nombre: string; readonly zonaHoraria: string; readonly moneda: Moneda },
): Promise<{ propertyId: string }> {
  return sendJson(fetchImpl, `${raiz(apiBaseUrl, propertyId)}/propiedades`, token, "POST", entrada);
}

export function crearUnidad(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  entrada: { readonly nombre: string; readonly propietarioId: string | null; readonly duracionMinimaNoches: number },
): Promise<{ id: string }> {
  return sendJson(fetchImpl, `${raiz(apiBaseUrl, propertyId)}/unidades`, token, "POST", entrada);
}

export function editarUnidad(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  unidadId: string,
  cambios: { readonly nombre?: string; readonly propietarioId?: string | null; readonly duracionMinimaNoches?: number },
): Promise<{ id: string }> {
  return sendJson(fetchImpl, `${raiz(apiBaseUrl, propertyId)}/unidades/${unidadId}`, token, "PATCH", cambios);
}

export function crearPropietario(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, entrada: { readonly nombre: string; readonly email: string | null }): Promise<{ id: string }> {
  return sendJson(fetchImpl, `${raiz(apiBaseUrl, propertyId)}/propietarios`, token, "POST", entrada);
}

export function editarPropietario(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  propietarioId: string,
  cambios: { readonly nombre?: string; readonly email?: string | null },
): Promise<{ id: string }> {
  return sendJson(fetchImpl, `${raiz(apiBaseUrl, propertyId)}/propietarios/${propietarioId}`, token, "PATCH", cambios);
}

/** Responsable de limpieza por omision de la unidad (`null` lo quita). admin_gestora y operador:acceso_total; la persona debe ser
 *  miembro con acceso a la propiedad (422). Base sin la migracion 033: 503 con la migracion que falta. */
export function fijarResponsableLimpieza(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  unidadId: string,
  responsableId: string | null,
): Promise<{ id: string; responsableLimpiezaId: string | null }> {
  return sendJson(fetchImpl, `${raiz(apiBaseUrl, propertyId)}/unidades/${unidadId}/responsable-limpieza`, token, "PUT", { responsableId });
}
