// H-P3-03 -- logica de datos de los mensajes automaticos al huesped. Consume apps/api/.../hoteles/mensajes-huesped.ts. Cada control de la
// pantalla llama a uno de estos endpoints reales; nada se inventa en el navegador (estados, motivos y textos vienen del servidor).
import { fetchJson, sendJson } from "./admin-client.ts";

const url = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/hoteles/${propertyId}/mensajes-huesped`;

export type EventoMensaje = "hold.aprobado" | "hold.rechazado" | "hold.confirmado" | "hold.vencido" | "reserva.confirmada" | "pre_llegada" | "post_estancia" | "lista_espera.ofrecida";
export type EstadoPlantilla = "borrador" | "enviada" | "aprobada" | "rechazada";

export interface PlantillaCatalogo {
  readonly nombre: string;
  readonly idioma: string;
  readonly variables: readonly string[];
  readonly estado: EstadoPlantilla;
  readonly aprobadaEn: string | null;
  readonly actualizadaEn: string;
}

export interface EventoConfig {
  readonly evento: EventoMensaje;
  readonly etiqueta: string;
  readonly transaccional: boolean;
  /** Variables que el evento sabe llenar, en el orden sugerido. */
  readonly variables: readonly string[];
  readonly activo: boolean;
  readonly horasAntes: number | null;
  readonly resenaUrl: string | null;
  readonly configurada: boolean;
  readonly actualizadoEn: string | null;
  readonly plantilla: PlantillaCatalogo | null;
}

export interface MensajesHuespedEstado {
  /** `false`: la base aun no tiene la migracion 046 (estado honesto "no disponible aun"). */
  readonly disponible: boolean;
  readonly catalogoDisponible: boolean;
  readonly puedeConfigurar: boolean;
  readonly whatsapp: { readonly canalConfigurado: boolean; readonly canalHabilitado: boolean; readonly credencialMeta: boolean; readonly listo: boolean; readonly aviso: string | null };
  readonly ventanaGraciaHoras: number;
  readonly horasAntesPorOmision: number;
  readonly horasAntesMin: number;
  readonly horasAntesMax: number;
  readonly horaPostEstancia: number;
  readonly estadosPlantilla: readonly EstadoPlantilla[];
  readonly eventos: readonly EventoConfig[];
}

export interface EnvioHistorial {
  readonly id: string;
  readonly evento: EventoMensaje;
  readonly etiqueta: string;
  readonly estado: "encolado" | "no_enviado";
  readonly canal: "whatsapp" | "email" | null;
  readonly motivo: string | null;
  readonly motivoTexto: string | null;
  /** Estado real del outbox: pending, processing, sent, failed, dead (null = no se encolo nada). */
  readonly envio: string | null;
  readonly errorClase: string | null;
  readonly creadoEn: string;
}

export interface HistorialMensajes {
  readonly disponible: boolean;
  readonly envios: readonly EnvioHistorial[];
}

export interface EntradaConfig {
  readonly activo: boolean;
  readonly horasAntes?: number | null;
  readonly resenaUrl?: string | null;
}

export interface EntradaPlantilla {
  readonly nombre: string;
  readonly idioma: string;
  readonly variables: readonly string[];
  readonly estado: EstadoPlantilla;
}

export function fetchMensajesHuesped(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<MensajesHuespedEstado> {
  return fetchJson<MensajesHuespedEstado>(fetchImpl, url(apiBaseUrl, propertyId), token);
}

export function fetchHistorialMensajes(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, limite = 30): Promise<HistorialMensajes> {
  return fetchJson<HistorialMensajes>(fetchImpl, `${url(apiBaseUrl, propertyId)}/historial?limite=${limite}`, token);
}

export function guardarConfigEvento(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, evento: EventoMensaje, entrada: EntradaConfig): Promise<unknown> {
  return sendJson(fetchImpl, `${url(apiBaseUrl, propertyId)}/${encodeURIComponent(evento)}`, token, "PUT", entrada);
}

export function guardarPlantillaEvento(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, evento: EventoMensaje, entrada: EntradaPlantilla): Promise<unknown> {
  return sendJson(fetchImpl, `${url(apiBaseUrl, propertyId)}/${encodeURIComponent(evento)}/plantilla`, token, "PUT", entrada);
}

export function eliminarPlantillaEvento(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, evento: EventoMensaje): Promise<unknown> {
  return sendJson(fetchImpl, `${url(apiBaseUrl, propertyId)}/${encodeURIComponent(evento)}/plantilla`, token, "DELETE", {});
}

/** Variables de una plantilla a partir del texto del formulario ("nombre, hotel llegada" -> ["nombre","hotel","llegada"]). */
export function parsearVariables(texto: string): string[] {
  return texto
    .split(/[\s,;]+/u)
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

export type TonoEnvio = "neutral" | "info" | "success" | "warning" | "danger";

/** Etiqueta y tono del estado de un envio del historial, a partir del estado real del outbox. */
export function estadoDeEnvio(e: Pick<EnvioHistorial, "estado" | "canal" | "envio">): { readonly texto: string; readonly tono: TonoEnvio } {
  if (e.estado === "no_enviado") return { texto: "No enviado", tono: "warning" };
  if (e.envio === null) return { texto: "Correo de confirmación de la reserva", tono: "info" };
  switch (e.envio) {
    case "sent":
      return { texto: "Enviado", tono: "success" };
    case "pending":
    case "processing":
      return { texto: "En cola", tono: "info" };
    case "failed":
      return { texto: "Reintentando", tono: "warning" };
    case "dead":
      return { texto: "No se pudo entregar", tono: "danger" };
    default:
      return { texto: "En cola", tono: "neutral" };
  }
}
