// Cliente de bookkeeping / auto-clasificador de pólizas (hallazgo de auditoría
// severidad ALTA, "Siete módulos con ruta HTTP real y sin UI" -- última porción,
// tras cobranza/revisión-CFDI/vencimientos/declaraciones/nómina/conciliación/
// migración-catálogo): bookkeeping.ts expone GET /catalogo, POST /clasificar,
// POST /poliza, POST /ajuste y GET (POST) /overrides/sugerencias sobre el motor
// determinista de @atiende/domain-despachos/bookkeeping/* (puerto de
// b2b_ai/features/bookkeeping/, ver domain-despachos/src/bookkeeping/) -- SIN el
// nivel ML (ver cabecera de clasificador.ts) -- pero ningún cliente web ni página
// los usaba. Mismo criterio "endpoint puro/calculadora" que conciliacion-client.ts:
// este motor no guarda estado propio, el cliente HTTP manda los CFDI ya
// clasificables y las correcciones humanas (overrides) ya persistidas en cada
// llamada. Separado de pages/Bookkeeping.tsx para poder probarlo con vitest en
// entorno "node" sin DOM.
//
// Los tipos de abajo son un espejo deliberado de
// @atiende/domain-despachos/bookkeeping/types.ts (mismo criterio que
// vencimientos-client.ts/conciliacion-client.ts: este paquete web no depende en
// tiempo de build del paquete de dominio, solo lo referencia en comentarios) -- la
// ruta HTTP serializa exactamente estas formas vía `c.json(...)`.
import { fetchJson, postJson } from "./admin-client.ts";

export type TipoCfdiBookkeeping = "I" | "E" | "T" | "P" | "N";
export type PolizaType = "ingreso" | "egreso" | "diario";
export type LineaTipo = "cargo" | "abono";

export interface CfdiClassification {
  readonly cfdiUuid: string;
  readonly rfcEmisor: string;
  readonly rfcReceptor: string;
  readonly descripcion: string;
  readonly subtotal: number;
  readonly iva: number;
  readonly total: number;
  readonly tasaIva: number;
  readonly tipoCfdi: TipoCfdiBookkeeping;
  readonly categoria: string;
  readonly confidence: number;
  readonly needsHumanReview: boolean;
}

/** Forma que este cliente MANDA a POST /clasificar -- espejo de `CfdiBody` en
 * bookkeeping.ts (sin `categoria`/`confidence`/`needsHumanReview`: los calcula
 * el servidor). */
export interface CfdiClasificarInput {
  readonly cfdiUuid: string;
  readonly rfcEmisor: string;
  readonly rfcReceptor?: string;
  readonly descripcion?: string;
  readonly subtotal?: number;
  readonly iva?: number;
  readonly total?: number;
  readonly tasaIva?: number;
  readonly tipoCfdi: TipoCfdiBookkeeping;
}

export interface OverrideRecord {
  readonly cfdiUuid: string;
  readonly rfcEmisor: string;
  readonly newCategoria: string;
  readonly tenantId: string;
}

export interface LineaPoliza {
  readonly cuenta: string;
  readonly concepto: string;
  readonly debe: number;
  readonly haber: number;
  readonly tipo: LineaTipo;
}

export interface PolizaContable {
  readonly tipo: PolizaType;
  readonly fecha: string;
  readonly concepto: string;
  readonly referencia: string;
  readonly lineas: readonly LineaPoliza[];
  readonly totalDebe: number;
  readonly totalHaber: number;
  readonly cuadrada: boolean;
  readonly tenantId: string;
}

export interface PolizaResultado {
  readonly cfdiUuid: string;
  readonly poliza: PolizaContable | null;
  readonly errores: readonly string[];
}

export interface EntradaAjusteInput {
  readonly cuenta: string;
  readonly debe?: number;
  readonly haber?: number;
  readonly concepto?: string;
}

export interface SuggestionRetraining {
  readonly rfc: string;
  readonly suggestedCategoria: string;
  readonly overrideCount: number;
  readonly totalCorrections: number;
  readonly confidence: number;
}

export interface CatalogoBookkeeping {
  readonly catalogoCuentas: Readonly<Record<string, string>>;
  readonly mapeosDefault: Readonly<Record<string, { readonly cargo: string; readonly abono: string; readonly ivaCargo: string | null; readonly ivaAbono: string | null; readonly polizaType: PolizaType }>>;
}

/** Catálogo de cuentas SAT (subset) + mapeos default -- datos estáticos, sin
 * dependencia de ningún lote capturado por el usuario. */
export async function fetchCatalogoBookkeeping(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<CatalogoBookkeeping> {
  return fetchJson<CatalogoBookkeeping>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/bookkeeping/catalogo`, token);
}

/** Clasifica un lote de CFDI: override humano exacto por RFC (prioridad
 * máxima, `overrides` ya persistidos) -> fallback de reglas por keyword. */
export async function clasificarCfdisBookkeeping(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  cfdis: readonly CfdiClasificarInput[],
  overrides: readonly OverrideRecord[] = [],
): Promise<{ readonly clasificaciones: readonly CfdiClassification[] }> {
  return postJson<{ readonly clasificaciones: readonly CfdiClassification[] }>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/bookkeeping/clasificar`, token, { cfdis, overrides });
}

/** Genera + valida una póliza por cada CFDI ya clasificado (normalmente el
 * output de `clasificarCfdisBookkeeping`, con `categoria` ya elegida). */
export async function generarPolizasBookkeeping(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  clasificaciones: readonly CfdiClassification[],
  tenantId?: string,
  fecha?: string,
): Promise<{ readonly polizas: readonly PolizaResultado[] }> {
  const payload: Record<string, unknown> = { clasificaciones };
  if (tenantId) payload.tenantId = tenantId;
  if (fecha) payload.fecha = fecha;
  return postJson<{ readonly polizas: readonly PolizaResultado[] }>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/bookkeeping/poliza`, token, payload);
}

/** Póliza de ajuste manual (diario) -- el cliente debe mandar entradas ya
 * balanceadas; `errores` (validatePoliza) confirma si lo logró. */
export async function generarAjusteBookkeeping(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  fecha: string,
  concepto: string,
  entries: readonly EntradaAjusteInput[],
  tenantId?: string,
): Promise<{ readonly poliza: PolizaContable; readonly errores: readonly string[] }> {
  const payload: Record<string, unknown> = { fecha, concepto, entries };
  if (tenantId) payload.tenantId = tenantId;
  return postJson<{ readonly poliza: PolizaContable; readonly errores: readonly string[] }>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/bookkeeping/ajuste`, token, payload);
}

/** Agregación de correcciones humanas por RFC -- el cliente manda el
 * historial completo de overrides ya persistido (este motor no guarda
 * estado propio, mismo criterio que el resto de este módulo). */
export async function fetchSugerenciasOverridesBookkeeping(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  overrides: readonly OverrideRecord[],
): Promise<{ readonly sugerencias: readonly SuggestionRetraining[] }> {
  return postJson<{ readonly sugerencias: readonly SuggestionRetraining[] }>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/bookkeeping/overrides/sugerencias`, token, { overrides });
}
