// Cliente HTTP de la cola de cobranza de despachos (D-11). Llama a `/despachos/:propertyId/cola-cobranza/*`
// (apps/api/.../despachos/cola-cobranza.ts). Los montos viajan en CENTAVOS enteros MXN; la pantalla captura pesos
// como texto y los convierte SIN pasar por flotantes (`pesosTextoACentavos`).
import { fetchBlob, fetchJson, postJson } from "./admin-client.ts";

export type GestionTipo = "promesa_pago" | "recordatorio" | "llamada" | "nota";
export type GestionEstado = "pendiente" | "cumplida" | "incumplida" | "cancelada";
export type GestionResolucion = "cumplida" | "incumplida" | "cancelada";
export type UrgenciaGestion = "promesa_vencida" | "seguimiento_vencido" | "vence_hoy" | "programada";
export type CobranzaEtapa = "pre_vencimiento" | "vencimiento" | "recordatorio_formal" | "segundo_recordatorio" | "escalamiento";

export const GESTION_TIPOS: readonly GestionTipo[] = ["promesa_pago", "recordatorio", "llamada", "nota"];

export const ETIQUETAS_GESTION_TIPO: Readonly<Record<GestionTipo, string>> = {
  promesa_pago: "Promesa de pago",
  recordatorio: "Recordatorio",
  llamada: "Llamada",
  nota: "Nota",
};

export const ETIQUETAS_URGENCIA: Readonly<Record<UrgenciaGestion, string>> = {
  promesa_vencida: "Promesa vencida",
  seguimiento_vencido: "Seguimiento vencido",
  vence_hoy: "Toca hoy",
  programada: "Programada",
};

export interface GestionCobranza {
  readonly id: string;
  readonly receivableId: string;
  readonly tipo: GestionTipo;
  readonly estado: GestionEstado;
  readonly montoPromesaCentavos: number | null;
  readonly fechaPromesa: string | null;
  readonly fechaSeguimiento: string | null;
  readonly nota: string | null;
  readonly creadoEn: string;
}

export interface ItemCola {
  readonly urgencia: UrgenciaGestion;
  readonly gestion: GestionCobranza;
  readonly cuenta: {
    readonly id: string;
    readonly folioFiscal: string | null;
    readonly rfcReceptor: string | null;
    readonly clienteNombre: string | null;
    readonly saldoCentavos: number | null;
    readonly fechaVencimiento: string;
    readonly diasVencido: number;
  };
}

export interface ColaCobranza {
  readonly disponible: boolean;
  readonly hoy: string;
  readonly items: readonly ItemCola[];
}

export interface ConsentimientoWhatsApp {
  readonly rfcReceptor: string;
  readonly telefono: string;
  readonly estado: "opt_in" | "opt_out";
  readonly evidencia: string | null;
  readonly actualizadoEn: string;
}

export interface MensajeOutbox {
  readonly id: string;
  readonly receivableId: string;
  readonly rfcReceptor: string;
  readonly cuerpo: string;
  readonly estado: "pendiente" | "cancelado" | "enviado" | "fallido";
  readonly creadoEn: string;
}

export interface NuevaGestionForm {
  readonly receivableId: string;
  readonly tipo: GestionTipo;
  readonly nota?: string | null;
  readonly montoPromesaCentavos?: number | null;
  readonly fechaPromesa?: string | null;
  readonly fechaSeguimiento?: string | null;
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/despachos/${propertyId}/cola-cobranza`;

/** "1,500.50" / "1500" / "$ 99.9" -> centavos enteros sin flotantes; `null` si no es un monto valido (> 0, max 2 decimales). */
export function pesosTextoACentavos(texto: string): number | null {
  const limpio = texto.trim().replace(/^\$\s*/, "").replace(/,/g, "");
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(limpio);
  if (!m) return null;
  const centavos = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  return Number.isSafeInteger(centavos) && centavos > 0 ? centavos : null;
}

/** Centavos enteros -> "$1,160.00" sin pasar por flotantes. */
export function formatearCentavos(centavos: number | null): string {
  if (centavos === null) return "—";
  const negativo = centavos < 0;
  const abs = Math.abs(centavos);
  const pesos = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negativo ? "-" : ""}$${pesos}.${String(abs % 100).padStart(2, "0")}`;
}

export function fetchGestiones(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, filtro: { readonly receivableId?: string; readonly estado?: GestionEstado } = {}) {
  const qs = new URLSearchParams();
  if (filtro.receivableId) qs.set("receivableId", filtro.receivableId);
  if (filtro.estado) qs.set("estado", filtro.estado);
  const sufijo = qs.toString() ? `?${qs.toString()}` : "";
  return fetchJson<{ readonly disponible: boolean; readonly gestiones: readonly GestionCobranza[] }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/gestiones${sufijo}`, token);
}

export function fetchCola(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string) {
  return fetchJson<ColaCobranza>(fetchImpl, `${base(apiBaseUrl, propertyId)}/cola`, token);
}

export function crearGestion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: NuevaGestionForm) {
  return postJson<{ readonly id: string }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/gestiones`, token, input);
}

export function resolverGestion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, gestionId: string, estado: GestionResolucion, nota?: string | null) {
  return postJson<{ readonly id: string; readonly estado: GestionResolucion }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/gestiones/${gestionId}/estado`, token, { estado, nota: nota ?? null });
}

export function descargarReporteCartera(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string) {
  return fetchBlob(fetchImpl, `${base(apiBaseUrl, propertyId)}/reporte-cartera?formato=pdf`, token, "cartera-antiguedad.pdf");
}

export function fetchConsentimientos(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string) {
  return fetchJson<{ readonly disponible: boolean; readonly consentimientos: readonly ConsentimientoWhatsApp[] }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/whatsapp/consentimientos`, token);
}

export function fijarConsentimiento(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly rfcReceptor: string; readonly telefono: string; readonly estado: "opt_in" | "opt_out"; readonly evidencia?: string | null },
) {
  return postJson<{ readonly rfcReceptor: string; readonly estado: string }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/whatsapp/consentimientos`, token, input);
}

export function encolarWhatsApp(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, receivableId: string, etapa?: CobranzaEtapa) {
  return postJson<{ readonly id: string; readonly etapa: CobranzaEtapa; readonly duplicado: boolean; readonly enviado: false; readonly nota: string }>(
    fetchImpl,
    `${base(apiBaseUrl, propertyId)}/cuentas/${receivableId}/whatsapp`,
    token,
    etapa ? { etapa } : {},
  );
}

export function fetchOutbox(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string) {
  return fetchJson<{ readonly disponible: boolean; readonly mensajes: readonly MensajeOutbox[] }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/whatsapp/outbox`, token);
}
