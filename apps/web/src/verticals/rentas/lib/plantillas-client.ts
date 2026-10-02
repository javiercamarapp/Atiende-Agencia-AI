// Rn-24 / Rn-25 -- cliente de Plantillas de mensajes y Automatizaciones de rentas
// (apps/api/src/routes/verticals/rentas/mensajeria-plantillas.ts y mensajes-automaticos.ts).
// Separado de pages/Plantillas.tsx para probarlo en entorno "node". Tipos redeclarados aqui
// (apps/web no depende de @atiende/domain-rentas).
import { fetchJson, sendJson } from "./admin-client.ts";

export const EVENTOS_PLANTILLA = ["confirmacion", "pre_llegada", "check_in", "check_out", "resena"] as const;
export type EventoPlantilla = (typeof EVENTOS_PLANTILLA)[number];
export const EVENTOS_AUTOMATICOS = ["pre_llegada", "check_in", "check_out", "resena"] as const;
export type EventoAutomatico = (typeof EVENTOS_AUTOMATICOS)[number];

export const ETIQUETA_EVENTO: Record<EventoPlantilla, string> = {
  confirmacion: "Confirmación de reserva",
  pre_llegada: "Pre-llegada",
  check_in: "Día de llegada (check-in)",
  check_out: "Día de salida (check-out)",
  resena: "Solicitud de reseña",
};

/** Ancla de cada evento automatico: sobre que fecha de la reserva se cuenta el offset. */
export const ETIQUETA_ANCLA: Record<"check_in" | "check_out", string> = { check_in: "la fecha de llegada", check_out: "la fecha de salida" };

export const CANALES = ["airbnb", "vrbo", "booking"] as const;
export type CanalPlantilla = (typeof CANALES)[number];
export const ETIQUETA_CANAL: Record<CanalPlantilla, string> = { airbnb: "Airbnb", vrbo: "Vrbo", booking: "Booking" };

export type IdiomaPlantilla = "es" | "en";
export const ETIQUETA_IDIOMA: Record<IdiomaPlantilla, string> = { es: "Español", en: "Inglés" };

export interface Plantilla {
  readonly id: string;
  readonly evento: EventoPlantilla;
  readonly idioma: IdiomaPlantilla;
  readonly canal: CanalPlantilla | null;
  readonly cuerpo: string;
  readonly aprobadaPorTenant: boolean;
  readonly activa: boolean;
}

export interface VariablePlantilla {
  readonly nombre: string;
  readonly descripcion: string;
  readonly ejemplo: string;
}

export interface Automatizacion {
  readonly evento: EventoAutomatico;
  readonly programada: boolean;
  readonly activo: boolean;
  readonly offsetHoras: number;
  readonly plantillaId: string | null;
  readonly ancla: "check_in" | "check_out";
  readonly offsetSugerido: number;
}

export interface Automatizaciones {
  readonly disponible: boolean;
  readonly eventos: readonly Automatizacion[];
  readonly variables: readonly VariablePlantilla[];
  readonly ventanaGraciaHoras: number;
  readonly offsetMin: number;
  readonly offsetMax: number;
}

export interface EstadoPlantilla {
  readonly etiqueta: string;
  readonly tono: "success" | "warning" | "neutral";
}

/** Estado visible de una plantilla: aprobada (programable), pendiente de aprobacion o inactiva. */
export function estadoPlantilla(p: Pick<Plantilla, "aprobadaPorTenant" | "activa">): EstadoPlantilla {
  if (!p.activa) return { etiqueta: "Inactiva", tono: "neutral" };
  return p.aprobadaPorTenant ? { etiqueta: "Aprobada", tono: "success" } : { etiqueta: "Pendiente de aprobación", tono: "warning" };
}

const PATRON_VARIABLE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** Vista previa con los valores de EJEMPLO que publica la API; las variables que el sistema no conoce se reportan (no se podra aprobar). */
export function vistaPrevia(cuerpo: string, variables: readonly VariablePlantilla[]): { texto: string; desconocidas: readonly string[] } {
  const ejemplos = new Map(variables.map((v) => [v.nombre, v.ejemplo]));
  const desconocidas = new Set<string>();
  const texto = cuerpo.replace(PATRON_VARIABLE, (m, nombre: string) => {
    const ej = ejemplos.get(nombre);
    if (ej === undefined) {
      desconocidas.add(nombre);
      return m;
    }
    return ej;
  });
  return { texto, desconocidas: [...desconocidas] };
}

export async function fetchPlantillas(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly Plantilla[]> {
  const body = await fetchJson<{ plantillas: readonly Plantilla[] }>(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/plantillas`, token);
  return body.plantillas;
}

export interface NuevaPlantilla {
  readonly evento: EventoPlantilla;
  readonly idioma: IdiomaPlantilla;
  readonly canal: CanalPlantilla | null;
  readonly cuerpo: string;
}

export function crearPlantilla(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, nueva: NuevaPlantilla): Promise<Plantilla> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/plantillas`, token, "POST", nueva);
}

export function actualizarPlantilla(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  id: string,
  cambios: { readonly cuerpo?: string; readonly activa?: boolean; readonly aprobadaPorTenant?: boolean },
): Promise<Plantilla> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/plantillas/${id}`, token, "PATCH", cambios);
}

export function fetchAutomatizaciones(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<Automatizaciones> {
  return fetchJson<Automatizaciones>(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/mensajes-automaticos`, token);
}

export function guardarAutomatizacion(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  evento: EventoAutomatico,
  cuerpo: { readonly activo: boolean; readonly offsetHoras: number; readonly plantillaId: string },
): Promise<unknown> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/mensajes-automaticos/${evento}`, token, "PUT", cuerpo);
}
