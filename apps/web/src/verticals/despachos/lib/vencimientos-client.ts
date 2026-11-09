// Lógica de datos de vencimientos fiscales (hallazgo de auditoría severidad ALTA,
// "Siete módulos con ruta HTTP real y sin UI" — primera porción bien delimitada:
// vencimientos). Separada de pages/Vencimientos.tsx a propósito, mismo motivo que el
// resto de lib/*.ts de este panel: probarla con vitest en entorno "node" sin DOM.
// Llama a `GET/POST /despachos/:propertyId/vencimientos*`
// (apps/api/.../despachos/vencimientos.ts) — el motor determinista
// (calendario fiscal con día hábil, prioridad, decisión de
// escalamiento) vive por completo en @atiende/domain-despachos/vencimientos/engine.ts;
// este cliente solo transporta lo que la ruta ya serializa vía `serializeDeadline`.
import { fetchJson, postJson } from "./admin-client.ts";

export type TipoVencimiento = "ISR" | "IVA" | "DIOT" | "Nómina" | "Balanza" | "Anual" | "Retenciones" | "IMSS" | "IMSS-bimestral" | "ISN" | "Informativa";
export type PrioridadVencimiento = "critica" | "alta" | "media" | "baja";
export type EstadoVencimiento = "pendiente" | "en_proceso" | "completado" | "vencido" | "escalado";

export interface FiscalDeadline {
  readonly id: string;
  readonly tipo: TipoVencimiento;
  readonly periodo: string;
  readonly fechaLimite: string;
  readonly prioridad: PrioridadVencimiento;
  readonly estado: EstadoVencimiento;
  readonly fechaPresentacion: string | null;
  readonly comprobanteUrl: string | null;
  readonly diasRestantes: number;
  readonly creadoEn: string;
  /** Fundamento legal del plazo (lo calcula el motor, nunca la UI). */
  readonly fundamento: string;
  /** true = el plazo o el día hábil dependen de una fuente que debe confirmar un fiscalista. */
  readonly validarConFiscalista: boolean;
}

export async function fetchVencimientos(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, filter?: { readonly estado?: EstadoVencimiento }): Promise<readonly FiscalDeadline[]> {
  const qs = filter?.estado ? `?estado=${encodeURIComponent(filter.estado)}` : "";
  return fetchJson<readonly FiscalDeadline[]>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/vencimientos${qs}`, token);
}

export async function calcularVencimientos(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: { readonly year: number; readonly month: number; readonly regimenFiscal?: string }): Promise<readonly FiscalDeadline[]> {
  return postJson<readonly FiscalDeadline[]>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/vencimientos/calcular`, token, input);
}

export async function completarVencimiento(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  deadlineId: string,
  comprobanteUrl?: string | null,
): Promise<FiscalDeadline> {
  return postJson<FiscalDeadline>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/vencimientos/${deadlineId}/completar`, token, comprobanteUrl ? { comprobanteUrl } : {});
}

export interface NivelEscalamientoVencimiento {
  readonly id: string;
  readonly nivel: "nivel_1" | "nivel_2" | "nivel_3" | "nivel_4";
  readonly enviadoEn: string;
  readonly notas: string;
}

export interface EscalarVencimientoResultado {
  readonly escalamiento: NivelEscalamientoVencimiento;
  readonly requiereRevisionHumana: boolean;
  readonly motivoRevisionHumana: string;
  readonly notificacion: { readonly destinatarios: number; readonly correosEncolados: number };
}

export async function escalarVencimiento(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, deadlineId: string): Promise<EscalarVencimientoResultado> {
  return postJson<EscalarVencimientoResultado>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/vencimientos/${deadlineId}/escalar`, token, {});
}

export interface BarridoVencimientosResultado {
  readonly evaluados: number;
  readonly escalados: readonly { readonly id: string; readonly tipo: TipoVencimiento; readonly periodo: string; readonly nivel: string; readonly correosEncolados: number }[];
  readonly yaEscalados: number;
  readonly aunNoToca: number;
  readonly fallidos: readonly { readonly id: string; readonly tipo: TipoVencimiento; readonly periodo: string }[];
}

/** Escala de una vez los vencimientos que vencen hoy o mañana, o ya vencieron (idempotente). */
export async function barrerVencimientos(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<BarridoVencimientosResultado> {
  return postJson<BarridoVencimientosResultado>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/vencimientos/barrido`, token, {});
}
