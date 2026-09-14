// Lógica de datos de cobranza (Fase 10 -- hallazgo de auditoría severidad
// ALTA: "cobranza tiene motor + persistencia completos pero cero rutas HTTP y
// cero UI"). Separada de pages/Cobranza.tsx a propósito, mismo motivo que el
// resto de lib/*.ts de este panel: probarla con vitest en entorno "node" sin
// DOM. Llama a `GET/POST /despachos/:propertyId/cobranza/*`
// (apps/api/.../despachos/cobranza.ts) -- el motor real (aging/score de
// cobrabilidad/proyección/resumen ejecutivo, contenido de recordatorio) vive
// por completo en @atiende/domain-despachos; este cliente solo transporta lo
// que la ruta ya serializa.
import { fetchJson, postJson } from "./admin-client.ts";

export type CobranzaAgeBucket = "0-30" | "31-60" | "61-90" | "90+";
export type CobranzaReminderStage = "pre_vencimiento" | "vencimiento" | "recordatorio_formal" | "segundo_recordatorio" | "escalamiento";

export const COBRANZA_REMINDER_STAGES: readonly CobranzaReminderStage[] = ["pre_vencimiento", "vencimiento", "recordatorio_formal", "segundo_recordatorio", "escalamiento"];

export interface CuentaCobranza {
  readonly id: string;
  readonly invoiceId: string;
  readonly facturaId: string | null;
  readonly monto: number | null;
  readonly fechaVencimiento: string;
  readonly diasVencido: number;
  readonly bucket: CobranzaAgeBucket;
  readonly score: number;
  readonly clienteNombre: string | null;
  readonly clienteEmail: string | null;
  readonly montoPagado: number | null;
  readonly pagadoEn: string | null;
  readonly creadoEn: string;
}

export interface EventoCobranza {
  readonly id: string;
  readonly etapa: string;
  readonly canal: string;
  readonly respuesta: string | null;
  readonly creadoEn: string;
}

export interface CuentaCobranzaDetalle {
  readonly cuenta: CuentaCobranza;
  readonly eventos: readonly EventoCobranza[];
}

export interface BucketResumen {
  readonly count: number;
  readonly monto: number;
  readonly porcentaje: number;
}

export interface TopMontoResumen {
  readonly facturaId: string;
  readonly nombreCliente: string;
  readonly monto: number;
  readonly diasVencido: number;
  readonly bucket: CobranzaAgeBucket;
  readonly score: number;
}

export interface ResumenCobranza {
  readonly totalCartera: number;
  readonly totalCount: number;
  readonly totalEsperado: number;
  readonly tasaRecuperacionEsperada: number;
  readonly porAntiguedad: Record<CobranzaAgeBucket, BucketResumen>;
  readonly alertas: readonly string[];
  readonly topMontos: readonly TopMontoResumen[];
}

export async function fetchCuentasCobranza(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, filter?: { readonly pendiente?: boolean }): Promise<readonly CuentaCobranza[]> {
  const qs = filter?.pendiente !== undefined ? `?pendiente=${filter.pendiente}` : "";
  return fetchJson<readonly CuentaCobranza[]>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/cobranza/cuentas${qs}`, token);
}

export async function fetchResumenCobranza(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<ResumenCobranza> {
  return fetchJson<ResumenCobranza>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/cobranza/resumen`, token);
}

export async function fetchCuentaCobranzaDetalle(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, receivableId: string): Promise<CuentaCobranzaDetalle> {
  return fetchJson<CuentaCobranzaDetalle>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/cobranza/cuentas/${receivableId}`, token);
}

export async function registrarCuentaCobranza(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly invoiceId: string; readonly fechaVencimiento: string; readonly clienteNombre?: string | null; readonly clienteEmail?: string | null },
): Promise<CuentaCobranza> {
  return postJson<CuentaCobranza>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/cobranza/cuentas`, token, input);
}

export async function marcarCuentaPagada(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  receivableId: string,
  input: { readonly montoPagado?: number | null; readonly pagadoEn?: string } = {},
): Promise<CuentaCobranza> {
  return postJson<CuentaCobranza>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/cobranza/cuentas/${receivableId}/pagar`, token, input);
}

export interface RecordatorioEnviado {
  readonly etapa: CobranzaReminderStage;
  readonly diasVencido: number;
  readonly enviado: boolean;
  readonly motivo: "no_email" | null;
}

export async function enviarRecordatorioCobranza(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  receivableId: string,
  stage?: CobranzaReminderStage,
): Promise<RecordatorioEnviado> {
  return postJson<RecordatorioEnviado>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/cobranza/cuentas/${receivableId}/recordatorio`, token, stage ? { stage } : {});
}
