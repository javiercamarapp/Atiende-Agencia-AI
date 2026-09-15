// Lógica de datos de migración de catálogo contable — hallazgo de auditoría
// (severidad ALTA, "Siete módulos con ruta HTTP real y sin UI", porción migración de
// catálogo): migracion-catalogo.ts expone POST /clasificar, GET /mapeos,
// GET /mapeos/:id y POST /mapeos/:id/aprobar|rechazar|editar
// (apps/api/.../despachos/migracion-catalogo.ts), pero ningún cliente web ni página
// los usaba. Separada de pages/MigracionCatalogo.tsx a propósito, mismo motivo que el
// resto de lib/*.ts de este panel: probarla con vitest en entorno "node" sin DOM.
// El clasificador (matching exacto/alerta de riesgo/fuzzy) y las guardias de
// cardinalidad 1:N/N:1 viven por completo en
// @atiende/domain-despachos/migracion-catalogo/{matching,migrador}.ts; este cliente
// solo transporta lo que la ruta ya serializa vía `serializeMapeo`. El catálogo
// origen/destino vive en las bases del cliente fuera de este monorepo (ver
// cross-db-port.ts en el paquete de dominio) — por eso `clasificarCatalogo` recibe
// las cuentas ya cargadas, nunca las descubre por sí mismo.
import { fetchJson, postJson } from "./admin-client.ts";

export type TipoMatchMigracion = "exacto" | "alerta_riesgo" | "fuzzy" | "sin_match";
export type EstadoMapeoMigracion = "pendiente" | "aprobado" | "rechazado" | "editado";

/** Cuenta de catálogo contable de cualquiera de los dos lados (origen o destino) de
 * una migración — mismo shape que `CuentaCatalogo` de @atiende/domain-despachos,
 * pero como entrada de red (los campos opcionales toman el mismo default que la ruta:
 * nivel 1, naturaleza "D", tipoAgregado "", sin padre). */
export interface CuentaCatalogoInput {
  readonly id: string;
  readonly codigo: string;
  readonly nombre: string;
  readonly nivel?: number;
  readonly naturaleza?: string;
  readonly tipoAgregado?: string;
  readonly cuentaPadreCodigo?: string | null;
}

export interface MapeoMigracionCuenta {
  readonly id: string;
  readonly origenCuentaId: string;
  readonly destinoCuentaId: string | null;
  readonly tipoMatch: TipoMatchMigracion;
  readonly score: number;
  readonly estado: EstadoMapeoMigracion;
  readonly aprobadoPor: string | null;
  readonly aprobadoEn: string | null;
  readonly nota: string | null;
  readonly estrategiaConciliacionSaldos: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** POST /migracion-catalogo/clasificar — clasifica el catálogo origen completo
 * contra el destino y PERSISTE un mapeo por cada cuenta origen (REQ-MIG-003 a 006).
 * Los exactos quedan auto-aprobados por el motor; el resto queda "pendiente" para
 * decisión humana (ver fetchMapeosMigracion/aprobarMapeoMigracion/etc.). */
export async function clasificarCatalogo(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly catalogoOrigen: readonly CuentaCatalogoInput[]; readonly catalogoDestino: readonly CuentaCatalogoInput[] },
): Promise<readonly MapeoMigracionCuenta[]> {
  const body = await postJson<{ mapeos: readonly MapeoMigracionCuenta[] }>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/migracion-catalogo/clasificar`, token, input);
  return body.mapeos;
}

export async function fetchMapeosMigracion(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  filter?: { readonly estado?: EstadoMapeoMigracion },
): Promise<readonly MapeoMigracionCuenta[]> {
  const qs = filter?.estado ? `?estado=${encodeURIComponent(filter.estado)}` : "";
  const body = await fetchJson<{ mapeos: readonly MapeoMigracionCuenta[] }>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/migracion-catalogo/mapeos${qs}`, token);
  return body.mapeos;
}

export async function fetchMapeoMigracion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, mapeoId: string): Promise<MapeoMigracionCuenta> {
  return fetchJson<MapeoMigracionCuenta>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/migracion-catalogo/mapeos/${mapeoId}`, token);
}

/** POST .../mapeos/:id/aprobar — solo mapeos "pendiente" (TransicionEstadoInvalidaError
 * -> 409 en cualquier otro caso). `estrategiaConciliacionSaldos` es obligatorio SOLO
 * cuando la guardia N:1 lo exige (EstrategiaConciliacionRequeridaError -> 409, ver
 * comentario de cabecera de la ruta); esta función lo manda solo si viene con valor. */
export async function aprobarMapeoMigracion(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  mapeoId: string,
  input: { readonly decididoPor: string; readonly nota?: string; readonly estrategiaConciliacionSaldos?: string },
): Promise<MapeoMigracionCuenta> {
  return postJson<MapeoMigracionCuenta>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/migracion-catalogo/mapeos/${mapeoId}/aprobar`, token, input);
}

/** POST .../mapeos/:id/rechazar — `nota` es obligatoria en el dominio (motivo del
 * rechazo, ver migrador.ts); esta función no lo valida dos veces, deja que el
 * servidor sea la única fuente de verdad y propaga su mensaje si falta. */
export async function rechazarMapeoMigracion(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  mapeoId: string,
  input: { readonly decididoPor: string; readonly nota: string },
): Promise<MapeoMigracionCuenta> {
  return postJson<MapeoMigracionCuenta>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/migracion-catalogo/mapeos/${mapeoId}/rechazar`, token, input);
}

export async function editarMapeoMigracion(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  mapeoId: string,
  input: { readonly decididoPor: string; readonly destinoCuentaId: string; readonly nota: string; readonly estrategiaConciliacionSaldos?: string },
): Promise<MapeoMigracionCuenta> {
  return postJson<MapeoMigracionCuenta>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/migracion-catalogo/mapeos/${mapeoId}/editar`, token, input);
}
