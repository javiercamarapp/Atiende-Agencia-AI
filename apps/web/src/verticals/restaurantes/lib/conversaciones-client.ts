// Cliente HTTP tipado de la bandeja de conversaciones, handoff, turnos y callbacks (R-21, migracion 028).
// Contrato real: apps/api/src/routes/verticals/restaurantes/conversaciones-admin.ts. Mismo criterio que el resto de
// lib/*.ts: `fetchImpl` inyectado y renovacion de sesion via `fetchJson`/`sendJson` (withAuthRefresh).
import { fetchJson, sendJson } from "./admin-client.ts";

export type ConversacionCanal = "whatsapp" | "voz";
/** `agente` = sin toma; el resto son los estados del handoff. */
export type HandoffEstado = "agente" | "pendiente" | "tomada" | "devuelta" | "cerrada";
export type CallbackResultado = "contactado" | "no_contesto" | "buzon" | "numero_invalido" | "reprogramar";

export const ESTADO_LABEL: Readonly<Record<HandoffEstado, string>> = {
  agente: "Con el agente",
  pendiente: "Esperando a una persona",
  tomada: "Con una persona",
  devuelta: "Devuelta al agente",
  cerrada: "Resuelta",
};

export const CANAL_LABEL: Readonly<Record<ConversacionCanal, string>> = { whatsapp: "WhatsApp", voz: "Llamada" };

export const CALLBACK_RESULTADO_LABEL: Readonly<Record<CallbackResultado, string>> = {
  contactado: "Contactado (resuelto)",
  no_contesto: "No contestó",
  buzon: "Buzón de voz",
  numero_invalido: "Número inválido (cerrar)",
  reprogramar: "Reprogramar",
};

export interface EscalacionWire {
  readonly nivel: 0 | 1 | 2;
  readonly minutosEspera: number;
  readonly sinCobertura: boolean;
  readonly avisarAdministracion: boolean;
  readonly destinatarios: readonly { readonly userId: string; readonly nombre: string | null; readonly orden: number }[];
}

export interface BandejaItemWire {
  readonly canal: ConversacionCanal;
  readonly conversationId: string;
  readonly telefono: string | null;
  readonly vistaPrevia: string;
  readonly actividadEn: string;
  readonly estado: HandoffEstado;
  readonly handoffId: string | null;
  readonly motivo: string | null;
  readonly solicitadaEn: string | null;
  readonly tomadaPor: string | null;
  readonly tomadaPorNombre: string | null;
  readonly resultadoVoz: string | null;
  readonly escalacion: EscalacionWire | null;
}

export interface CoberturaWire {
  readonly sinCobertura: boolean;
  readonly turnosVigentes: readonly { readonly id: string; readonly nombre: string; readonly inicia: string; readonly termina: string }[];
  readonly guardia: readonly { readonly userId: string; readonly nombre: string | null; readonly turno: string; readonly orden: number }[];
}

export interface BandejaWire {
  readonly disponible: boolean;
  readonly total: number;
  readonly nextOffset: number | null;
  readonly cobertura: CoberturaWire;
  readonly items: readonly BandejaItemWire[];
}

export interface DetalleWire {
  readonly canal: ConversacionCanal;
  readonly conversationId: string;
  readonly transcripcionDisponible: boolean;
  readonly mensajes: readonly { readonly rol: "cliente" | "agente" | "humano" | "herramienta"; readonly texto: string; readonly creadoEn: string | null }[];
  readonly handoff: {
    readonly handoffId: string;
    readonly estado: Exclude<HandoffEstado, "agente">;
    readonly solicitadoPor: "agente" | "staff";
    readonly motivo: string | null;
    readonly solicitadaEn: string;
    readonly tomadaPor: string | null;
    readonly tomadaPorNombre: string | null;
  } | null;
  readonly notas: readonly { readonly id: string; readonly autor: string | null; readonly texto: string; readonly creadoEn: string }[];
}

export interface TurnoWire {
  readonly id?: string;
  readonly nombre: string;
  readonly dias: readonly number[];
  readonly inicia: string;
  readonly termina: string;
  readonly miembros: readonly { readonly userId: string; readonly nombre?: string | null; readonly orden: number }[];
}

export interface TurnosWire {
  readonly disponible: boolean;
  readonly turnos: readonly TurnoWire[];
  readonly cobertura: CoberturaWire;
}

export type CallbackEstado = "nuevo" | "en_curso" | "resuelto";
export type CallbackAccion = "tomar" | "asignar" | "liberar" | "resolver" | "reabrir";
export type SlaCallbackEstado = "en_plazo" | "por_vencer" | "vencido" | "cumplido" | "incumplido" | "sin_dato";

export const CALLBACK_ESTADO_LABEL: Readonly<Record<CallbackEstado, string>> = { nuevo: "Nuevo", en_curso: "En curso", resuelto: "Resuelto" };

export const SLA_LABEL: Readonly<Record<SlaCallbackEstado, string>> = {
  en_plazo: "En plazo",
  por_vencer: "Por vencer",
  vencido: "Vencido",
  cumplido: "Atendido a tiempo",
  incumplido: "Atendido fuera de plazo",
  sin_dato: "Sin dato",
};

export interface SlaCallbackWire {
  readonly objetivoMin: number;
  readonly venceAt: string;
  readonly estado: SlaCallbackEstado;
  readonly minutosRestantes: number | null;
}

/** Motivo legible: `escalada:queja` (lo que deja escalar_a_humano) -> "Escalada: queja". */
export function textoMotivoCallback(motivo: string | null): string | null {
  if (!motivo) return null;
  if (motivo === "evento") return "Evento o catering";
  return motivo.startsWith("escalada:") ? `Escalada: ${motivo.slice("escalada:".length).replace(/_/g, " ")}` : motivo;
}

export interface CallbackWire {
  readonly id: string;
  readonly nombre: string;
  readonly telefono: string;
  readonly motivo: string | null;
  readonly mensaje: string | null;
  readonly origen: string;
  readonly resuelto: boolean;
  readonly creadoEn: string;
  /** R-12 (migracion 033). `gestionable: false` = base sin 033: solo abierto/resuelto, sin asignacion. */
  readonly sucursalId: string | null;
  readonly estado: CallbackEstado;
  readonly gestionable: boolean;
  readonly asignadoA: string | null;
  readonly asignadoNombre: string | null;
  readonly asignadoEn: string | null;
  readonly tomadoEn: string | null;
  readonly resueltoEn: string | null;
  readonly resueltoPor: string | null;
  readonly notaResolucion: string | null;
  readonly sla: SlaCallbackWire;
  readonly intentos: readonly { readonly id: string; readonly resultado: CallbackResultado; readonly nota: string | null; readonly proximoIntentoEn: string | null; readonly autor: string | null; readonly creadoEn: string }[];
}

const base = (apiBaseUrl: string, propertyId: string): string => `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin`;

export function fetchBandeja(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  filtro: { readonly estado?: HandoffEstado | ""; readonly canal?: ConversacionCanal | ""; readonly offset?: number } = {},
): Promise<BandejaWire> {
  const q = new URLSearchParams({ limit: "25", offset: String(filtro.offset ?? 0) });
  if (filtro.estado) q.set("estado", filtro.estado);
  if (filtro.canal) q.set("canal", filtro.canal);
  return fetchJson<BandejaWire>(fetchImpl, `${base(apiBaseUrl, propertyId)}/conversaciones?${q}`, token);
}

export function fetchDetalle(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, canal: ConversacionCanal, conversationId: string): Promise<DetalleWire> {
  return fetchJson<DetalleWire>(fetchImpl, `${base(apiBaseUrl, propertyId)}/conversaciones/${canal}/${encodeURIComponent(conversationId)}`, token);
}

export function tomarConversacion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, canal: ConversacionCanal, conversationId: string): Promise<{ handoffId: string }> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/conversaciones/${canal}/${encodeURIComponent(conversationId)}/tomar`, token, "POST", {});
}

export function liberarHandoff(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, handoffId: string, accion: "devolver" | "cerrar"): Promise<{ estado: string; cambio: boolean }> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/handoffs/${encodeURIComponent(handoffId)}/${accion}`, token, "POST", {});
}

export function agregarNota(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, handoffId: string, texto: string): Promise<{ id: string }> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/handoffs/${encodeURIComponent(handoffId)}/notas`, token, "POST", { texto });
}

export function responderWhatsapp(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, handoffId: string, texto: string): Promise<{ encolado: boolean }> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/handoffs/${encodeURIComponent(handoffId)}/responder`, token, "POST", { texto });
}

export function fetchTurnos(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<TurnosWire> {
  return fetchJson<TurnosWire>(fetchImpl, `${base(apiBaseUrl, propertyId)}/turnos`, token);
}

export function guardarTurnos(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, turnos: readonly TurnoWire[]): Promise<{ disponible: boolean }> {
  const cuerpo = turnos.map((t) => ({ nombre: t.nombre, dias: t.dias, inicia: t.inicia, termina: t.termina, miembros: t.miembros.map((m) => ({ userId: m.userId, orden: m.orden })) }));
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/turnos`, token, "PUT", { turnos: cuerpo });
}

export function fetchCallbacks(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  filtro: { readonly soloAbiertos?: boolean; readonly estado?: CallbackEstado | "" } = {},
): Promise<{ disponible: boolean; items: readonly CallbackWire[] }> {
  const q = new URLSearchParams();
  if (filtro.soloAbiertos) q.set("soloAbiertos", "1");
  if (filtro.estado) q.set("estado", filtro.estado);
  return fetchJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/callbacks${q.size > 0 ? `?${q}` : ""}`, token);
}

export function actualizarCallback(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  callbackId: string,
  cuerpo: { readonly accion: CallbackAccion; readonly asignadoA?: string; readonly nota?: string },
): Promise<{ estado: CallbackEstado }> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/callbacks/${encodeURIComponent(callbackId)}/estado`, token, "POST", cuerpo);
}

export function registrarIntento(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  callbackId: string,
  intento: { readonly resultado: CallbackResultado; readonly nota?: string },
): Promise<{ id: string }> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/callbacks/${encodeURIComponent(callbackId)}/intentos`, token, "POST", intento);
}

/** Texto de la escalacion para el badge de la bandeja. */
export function textoEscalacion(e: EscalacionWire | null): string | null {
  if (!e) return null;
  if (e.sinCobertura) return "Sin personal de guardia: avisar a administración";
  if (e.nivel === 2) return `${e.minutosEspera} min sin respuesta: avisar a administración`;
  if (e.nivel === 1) return `${e.minutosEspera} min sin respuesta: avisar al respaldo`;
  return null;
}
