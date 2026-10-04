// Cliente de la post-adjudicacion estructurada (L-27): garantias, hitos, convenios modificatorios y plazos de firma/
// entrega de garantia. Llama a `.../tenders/:tenderId/contract/post-award` (apps/api/.../licitaciones/postAdjudicacion.ts).
// El servidor es la autoridad (roles, validacion, maquina de estados, plazos en dias habiles con el calendario efectivo);
// esta capa solo refleja lo que responde. Los montos viajan SIEMPRE como cadena decimal ("125000.50"), nunca como `number`.
//
// Las altas (POST) exigen `Idempotency-Key`: cada intento de alta genera UNA clave (`nuevaClaveIdempotencia`) que la
// pantalla conserva mientras el dialogo siga abierto, de modo que reintentar tras un fallo de red no duplica el registro.
import { fetchJson, patchJson, postJson, putJson } from "./admin-client.ts";

export type GarantiaTipo = "cumplimiento" | "anticipo" | "vicios_ocultos";
export type GarantiaEstado = "pendiente_entrega" | "entregada" | "liberada" | "ejecutada" | "vencida";
export type HitoEstado = "pendiente" | "cumplido" | "cancelado";
export type ConvenioTipo = "monto" | "plazo" | "monto_plazo";

export const GARANTIA_TIPO_LABELS: Readonly<Record<GarantiaTipo, string>> = {
  cumplimiento: "Cumplimiento",
  anticipo: "Anticipo",
  vicios_ocultos: "Vicios ocultos",
};

export const GARANTIA_ESTADO_LABELS: Readonly<Record<GarantiaEstado, string>> = {
  pendiente_entrega: "Pendiente de entrega",
  entregada: "Entregada",
  liberada: "Liberada",
  ejecutada: "Ejecutada",
  vencida: "Vencida",
};

export const CONVENIO_TIPO_LABELS: Readonly<Record<ConvenioTipo, string>> = {
  monto: "Monto",
  plazo: "Plazo",
  monto_plazo: "Monto y plazo",
};

export interface GarantiaVigencia {
  readonly estadoEfectivo: GarantiaEstado;
  readonly vencidaPorFecha: boolean;
  readonly porVencer: boolean;
  readonly diasParaVencer: number;
  readonly entregaVencida: boolean;
}

export interface GarantiaRecord {
  readonly id: string;
  readonly contractId: string;
  readonly tipo: GarantiaTipo;
  readonly monto: string;
  readonly porcentaje: number | null;
  readonly afianzadora: string | null;
  readonly numeroPoliza: string | null;
  readonly vigenciaDesde: string;
  readonly vigenciaHasta: string;
  readonly fechaLimiteEntrega: string | null;
  readonly entregadaEn: string | null;
  readonly estado: GarantiaEstado;
  readonly notas: string | null;
  readonly vigencia: GarantiaVigencia;
}

export interface HitoVigencia {
  readonly estadoEfectivo: HitoEstado | "vencido";
  readonly vencido: boolean;
  readonly diasDeRetraso: number;
}

export interface HitoRecord {
  readonly id: string;
  readonly contractId: string;
  readonly titulo: string;
  readonly descripcion: string | null;
  readonly responsableId: string | null;
  readonly fechaCompromiso: string;
  readonly estado: HitoEstado;
  readonly cumplidoEn: string | null;
  readonly vigencia: HitoVigencia;
}

export interface ConvenioRecord {
  readonly id: string;
  readonly numero: number;
  readonly tipo: ConvenioTipo;
  readonly montoDelta: string | null;
  readonly nuevaFechaFin: string | null;
  readonly fechaFinAnterior: string | null;
  readonly fechaFirma: string;
  readonly motivo: string;
  readonly createdAt: string;
}

export interface PlazosRecord {
  readonly falloNotificadoEn: string | null;
  readonly plazoFirmaDias: number | null;
  readonly firmadoEn: string | null;
  readonly plazoGarantiaDias: number | null;
}

export interface PlazosCalculados {
  readonly fechaLimiteFirma: string | null;
  readonly fechaLimiteEntregaGarantia: string | null;
  readonly firmaVencida: boolean;
  readonly nota: string;
  readonly calendarioNota: string;
  readonly avisos?: readonly string[];
}

export interface ResumenPostAdjudicacion {
  readonly garantiasEntregadas: number;
  readonly garantiasPendientes: number;
  readonly garantiasPorVencer: number;
  readonly garantiasVencidas: number;
  readonly garantiasEntregaVencida: number;
  readonly hitosPendientes: number;
  readonly hitosVencidos: number;
  readonly ajusteDeMontoAcumulado: string;
}

export interface PostAwardOverview {
  /** `false` con la base sin la migracion 035: no hay nada que mostrar ni editar (estado honesto "no disponible aun"). */
  readonly available: boolean;
  readonly hoy: string;
  readonly puedeEscribir: boolean;
  readonly puedeDecidir: boolean;
  readonly contract?: { readonly id: string; readonly status: string; readonly endDate: string | null };
  readonly plazos?: PlazosRecord | null;
  readonly plazosCalculados?: PlazosCalculados;
  readonly garantias?: readonly GarantiaRecord[];
  readonly hitos?: readonly HitoRecord[];
  readonly convenios?: readonly ConvenioRecord[];
  readonly resumen?: ResumenPostAdjudicacion;
}

export interface BitacoraEntrada {
  readonly id: string;
  readonly entidad: "plazos" | "garantia" | "hito" | "convenio";
  readonly entidadId: string;
  readonly accion: "crear" | "editar" | "cambio_estado";
  readonly detalle: Readonly<Record<string, unknown>>;
  readonly actorId: string | null;
  readonly createdAt: string;
}

export interface Responsable {
  readonly userId: string;
  readonly nombre: string;
  readonly rol: string;
}

export interface NuevaGarantia {
  readonly tipo: GarantiaTipo;
  /** Cadena decimal, p. ej. "125000.50". */
  readonly monto: string;
  readonly porcentaje?: number | null;
  readonly afianzadora?: string | null;
  readonly numeroPoliza?: string | null;
  readonly vigenciaDesde: string;
  readonly vigenciaHasta: string;
  readonly fechaLimiteEntrega?: string | null;
  readonly entregadaEn?: string | null;
  readonly notas?: string | null;
}

export type CambioGarantia = Partial<Omit<NuevaGarantia, "tipo">> & { readonly estado?: GarantiaEstado };

export interface NuevoHito {
  readonly titulo: string;
  readonly descripcion?: string | null;
  readonly responsableId: string;
  readonly fechaCompromiso: string;
}

export interface CambioHito {
  readonly titulo?: string;
  readonly descripcion?: string | null;
  readonly responsableId?: string;
  readonly fechaCompromiso?: string;
  readonly estado?: "cumplido" | "cancelado";
  readonly cumplidoEn?: string | null;
}

export interface NuevoConvenio {
  readonly tipo: ConvenioTipo;
  /** Cadena decimal con signo ("12000.00" / "-5000.00"); nunca cero. */
  readonly montoDelta?: string;
  readonly nuevaFechaFin?: string;
  readonly fechaFirma: string;
  readonly motivo: string;
}

const base = (apiBaseUrl: string, propertyId: string, tenderId: string) => `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/contract/post-award`;

/** Una clave por intento de alta: se conserva mientras el dialogo siga abierto para que un reintento no duplique. */
export function nuevaClaveIdempotencia(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function fetchPostAward(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<PostAwardOverview> {
  return fetchJson<PostAwardOverview>(f, base(apiBaseUrl, propertyId, tenderId), token);
}

export async function fetchPostAwardBitacora(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<readonly BitacoraEntrada[]> {
  return (await fetchJson<{ bitacora: readonly BitacoraEntrada[] }>(f, `${base(apiBaseUrl, propertyId, tenderId)}/bitacora`, token)).bitacora;
}

export async function fetchResponsables(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<readonly Responsable[]> {
  return (await fetchJson<{ responsables: readonly Responsable[] }>(f, `${base(apiBaseUrl, propertyId, tenderId)}/responsables`, token)).responsables;
}

export function guardarPlazos(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string, input: Partial<PlazosRecord>): Promise<{ plazos: PlazosRecord; plazosCalculados: PlazosCalculados; garantiasActualizadas: number }> {
  return putJson(f, `${base(apiBaseUrl, propertyId, tenderId)}/plazos`, token, input);
}

export function crearGarantia(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string, input: NuevaGarantia, claveIdempotencia: string): Promise<GarantiaRecord> {
  return postJson<GarantiaRecord>(f, `${base(apiBaseUrl, propertyId, tenderId)}/garantias`, token, input, { "idempotency-key": claveIdempotencia });
}

export function actualizarGarantia(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string, id: string, cambio: CambioGarantia): Promise<GarantiaRecord> {
  return patchJson<GarantiaRecord>(f, `${base(apiBaseUrl, propertyId, tenderId)}/garantias/${encodeURIComponent(id)}`, token, cambio);
}

export function crearHito(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string, input: NuevoHito, claveIdempotencia: string): Promise<HitoRecord> {
  return postJson<HitoRecord>(f, `${base(apiBaseUrl, propertyId, tenderId)}/hitos`, token, input, { "idempotency-key": claveIdempotencia });
}

export function actualizarHito(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string, id: string, cambio: CambioHito): Promise<HitoRecord> {
  return patchJson<HitoRecord>(f, `${base(apiBaseUrl, propertyId, tenderId)}/hitos/${encodeURIComponent(id)}`, token, cambio);
}

export function crearConvenio(
  f: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tenderId: string,
  input: NuevoConvenio,
  claveIdempotencia: string,
  stepUpToken: string | null,
): Promise<{ convenio: ConvenioRecord; contratoFechaFin: string | null }> {
  return postJson(f, `${base(apiBaseUrl, propertyId, tenderId)}/convenios`, token, input, { "idempotency-key": claveIdempotencia, ...(stepUpToken ? { "x-step-up-token": stepUpToken } : {}) });
}
