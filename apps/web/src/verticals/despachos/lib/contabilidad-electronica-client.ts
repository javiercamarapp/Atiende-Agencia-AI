// Cliente de contabilidad electrónica SAT (Anexo 24) — hallazgo de auditoría:
// el motor completo de @atiende/domain-despachos/contabilidad-electronica/
// (catálogo de cuentas XML, balanza XML, paquete completo con hash SHA-1,
// transición de estado) ya existía con tests, pero ningún cliente web ni
// página lo usaba. Mismo criterio que el resto de lib/*.ts de este panel:
// separado de pages/ContabilidadElectronica.tsx para poder probarlo con
// vitest en entorno "node" sin DOM. `fetchJson`/`postJson` (admin-client.ts)
// ya envuelven cada llamada con withAuthRefresh -- ver cabecera de ese
// archivo.
//
// Los tipos de abajo son un espejo deliberado de
// @atiende/domain-despachos/contabilidad-electronica/types.ts (mismo criterio
// que devolucion-iva-client.ts/conciliacion-client.ts: este paquete web no
// depende en tiempo de build del paquete de dominio). Ningún "paquete de
// contabilidad electrónica" se persiste server-side en esta fase (ver
// cabecera de contabilidad-electronica.ts en apps/api): el estado que este
// cliente manda a /listo-para-timbrar es el que la propia página conserva en
// memoria desde la última respuesta de /paquete.
import { fetchJson, postJson } from "./admin-client.ts";

export type NaturalezaCuentaAnexo24 = "D" | "A";
export type EstadoPaqueteContabilidad = "borrador" | "listo_para_timbrar" | "timbrado" | "enviado";
export type TipoEnvioBalanza = "B" | "C";

export interface CuentaAnexo24 {
  readonly codigo: string;
  readonly descripcion: string;
  readonly nivel: number;
  readonly naturaleza: NaturalezaCuentaAnexo24;
  readonly grupo: string;
}

export interface AsientoContable {
  readonly cuenta: string;
  readonly debe?: number | string;
  readonly haber?: number | string;
  /** "YYYY-MM-DD" (o cualquier cadena cuyos primeros 7 caracteres sean
   * "YYYY-MM"). Un asiento sin fecha nunca se excluye por período. */
  readonly fecha?: string | null;
}

export interface LineaBalanza {
  readonly cuenta: string;
  readonly descripcion: string;
  readonly nivel: number;
  readonly naturaleza: NaturalezaCuentaAnexo24;
  readonly saldoInicial: string;
  readonly debe: string;
  readonly haber: string;
  readonly saldoFinal: string;
}

export interface ResumenBalanza {
  readonly periodo: string | null;
  readonly cuentas: number;
  readonly totalDebe: string;
  readonly totalHaber: string;
  readonly cuadrada: boolean;
  readonly saldosAnomalos: readonly string[];
  readonly lineas: readonly LineaBalanza[];
}

export interface ArchivoContabilidadElectronica {
  readonly xml: string;
  readonly sha1: string;
}

export interface PaqueteContabilidadElectronica {
  readonly periodo: string;
  readonly ejercicio: number;
  readonly mes: number;
  readonly rfc: string;
  readonly razonSocial: string;
  readonly catalogo: ArchivoContabilidadElectronica & { readonly cuentas: number };
  readonly balanza: ArchivoContabilidadElectronica & { readonly cuadrada: boolean; readonly cuentas: number };
  readonly resumenBalanza: ResumenBalanza;
  readonly estado: EstadoPaqueteContabilidad;
  readonly generadoEn: string;
}

export interface PeriodoOpciones {
  readonly rfc?: string;
  readonly ejercicio?: number;
  readonly mes?: number;
}

/** GET .../contabilidad-electronica/catalogo-base -- catálogo Anexo 24 por
 * defecto del SAT, para mostrar/editar antes de generar el XML. */
export async function fetchCatalogoBaseContabilidadElectronica(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly CuentaAnexo24[]> {
  const body = await fetchJson<{ catalogo: readonly CuentaAnexo24[] }>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/contabilidad-electronica/catalogo-base`, token);
  return body.catalogo;
}

/** POST .../contabilidad-electronica/catalogo -- XML del catálogo de cuentas
 * Anexo 24 (`CatalogoCuentas_1_3.xsd`) + hash SHA-1. Si `catalogo` se omite,
 * el servidor usa el catálogo base del SAT. */
export async function postCatalogoContabilidadElectronica(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  opciones: PeriodoOpciones & { readonly catalogo?: readonly CuentaAnexo24[] } = {},
): Promise<{ readonly catalogo: readonly CuentaAnexo24[]; readonly xml: string; readonly sha1: string }> {
  return postJson(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/contabilidad-electronica/catalogo`, token, opciones);
}

export interface BalanzaOpciones extends PeriodoOpciones {
  readonly catalogo?: readonly CuentaAnexo24[];
  readonly asientos: readonly AsientoContable[];
  readonly periodo?: string;
  readonly saldosIniciales?: Readonly<Record<string, number | string>>;
  readonly tipoEnvio?: TipoEnvioBalanza;
}

/** POST .../contabilidad-electronica/balanza -- balanza de comprobación
 * (desde los asientos del período) + su XML (`BalanzaComprobacion_1_3.xsd`) +
 * hash SHA-1. */
export async function postBalanzaContabilidadElectronica(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  opciones: BalanzaOpciones,
): Promise<{ readonly resumen: ResumenBalanza; readonly xml: string; readonly sha1: string }> {
  return postJson(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/contabilidad-electronica/balanza`, token, opciones);
}

export interface PaqueteOpciones extends PeriodoOpciones {
  readonly catalogo?: readonly CuentaAnexo24[];
  readonly razonSocial?: string;
  readonly asientos: readonly AsientoContable[];
  readonly saldosIniciales?: Readonly<Record<string, number | string>>;
}

/** POST .../contabilidad-electronica/paquete -- paquete completo (catálogo +
 * balanza + hashes + estado inicial `listo_para_timbrar`) -- lo que la tarea
 * "contabilidad_elect" del cierre mensual necesita generar. */
export async function postPaqueteContabilidadElectronica(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, opciones: PaqueteOpciones): Promise<PaqueteContabilidadElectronica> {
  return postJson(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/contabilidad-electronica/paquete`, token, opciones);
}

/** POST .../contabilidad-electronica/listo-para-timbrar -- transiciona el
 * estado (que la página conserva en memoria desde /paquete, ver cabecera del
 * archivo) a `listo_para_timbrar`. */
export async function postListoParaTimbrarContabilidadElectronica(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  estadoActual: EstadoPaqueteContabilidad,
): Promise<{ readonly estado: EstadoPaqueteContabilidad }> {
  return postJson(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/contabilidad-electronica/listo-para-timbrar`, token, { estadoActual });
}
