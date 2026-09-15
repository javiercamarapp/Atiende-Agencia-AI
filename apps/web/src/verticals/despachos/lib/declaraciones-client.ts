// Cliente de declaraciones fiscales (hallazgo de auditoría severidad ALTA, "Siete
// módulos con ruta HTTP real y sin UI" — siguiente porción tras vencimientos):
// declaraciones.ts expone POST /despachos/:propertyId/declaraciones/isr/pf,
// /isr/pm, /isr/pm-resico y GET /despachos/:propertyId/declaraciones/diot/:periodo
// (apps/api/.../despachos/declaraciones.ts), pero ningún cliente web ni página los
// usaba. Mismo motivo que el resto de lib/*.ts de este panel: separado de
// pages/Declaraciones.tsx para poder probarlo con vitest en entorno "node" sin DOM.
//
// Los tres cálculos ISR son endpoints PUROS sin persistencia (ver comentario de
// declaraciones.ts): el resultado no se guarda aquí — es responsabilidad del
// usuario del panel copiar el ISR neto donde corresponda (ej. adjuntarlo a un
// vencimiento fiscal vía comprobanteUrl, en Vencimientos.tsx). DIOT sí reconstruye
// datos reales ya persistidos (invoices con `diot.proveedoresReportables`), por eso
// es un GET, no un cálculo puro sobre input del usuario.
import { fetchJson, postJson } from "./admin-client.ts";

export type TipoContribuyenteIsr = "PF" | "PM";
export type TablaAplicadaIsr = "monthly" | "annual" | "pm_30%" | "pm_resico";

export interface IsrResultado {
  readonly baseGravable: number;
  readonly isrBruto: number;
  readonly tasaEfectiva: number;
  readonly tipoContribuyente: TipoContribuyenteIsr;
  readonly tablaAplicada: TablaAplicadaIsr;
  readonly isrNeto: number;
  readonly pagosProvisionales: number;
}

export async function calcularIsrPf(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly baseGravable: number; readonly annual?: boolean; readonly pagosProvisionales?: number },
): Promise<IsrResultado> {
  return postJson<IsrResultado>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/declaraciones/isr/pf`, token, input);
}

export async function calcularIsrPm(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly utilidadFiscal: number; readonly pagosProvisionales?: number },
): Promise<IsrResultado> {
  return postJson<IsrResultado>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/declaraciones/isr/pm`, token, input);
}

export async function calcularIsrPmResico(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  // RESICO PM = 30% plano sobre flujo de efectivo (ingresos cobrados − deducciones
  // pagadas), no una tabla progresiva -- ver isr-engine.ts (corrección hallazgo
  // CRÍTICO #2). `deduccionesAutorizadas` es opcional: sin ella, el resultado
  // sobreestima el ISR real en vez de asumir una deducción que nadie dio.
  input: { readonly ingresosCobrados: number; readonly deduccionesAutorizadas?: number; readonly pagosProvisionales?: number },
): Promise<IsrResultado> {
  return postJson<IsrResultado>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/declaraciones/isr/pm-resico`, token, input);
}

/** Tipo de operación DIOT tal como lo emite el motor (`_map_iva_tipo` portado) — es
 * la TASA de IVA codificada con el catálogo del SAT, NO la naturaleza de la
 * operación (ver comentario de @atiende/domain-despachos/declaraciones/types.ts). */
export type DiotTipoOperacion = "03" | "06" | "85";

export interface DiotRegistroAgregado {
  readonly rfcTercero: string;
  readonly nombre: string;
  readonly tipoOperacion: DiotTipoOperacion;
  readonly moneda: string;
  readonly tipoCambio: number;
  readonly fecha: string;
  readonly montoNeto: number;
  readonly ivaTrasladado16: number;
  readonly ivaTrasladado0: number;
  readonly ivaAcreditable16: number;
  readonly ivaAcreditable0: number;
  readonly ivaExento: number;
  readonly count: number;
}

export interface DiotAgregado {
  readonly registros: readonly DiotRegistroAgregado[];
  readonly totalMontoNeto: number;
  readonly totalIvaTrasladado: number;
  readonly totalIvaAcreditable: number;
  readonly periodo: string;
  readonly rfcContribuyente: string | null;
}

export async function fetchDiot(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, periodo: string): Promise<DiotAgregado> {
  return fetchJson<DiotAgregado>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/declaraciones/diot/${periodo}`, token);
}
