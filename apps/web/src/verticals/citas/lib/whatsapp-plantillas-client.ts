// PL-31 -- cliente del catalogo de plantillas HSM de WhatsApp de citas (ver apps/api/src/routes/verticals/citas/whatsapp-plantillas.ts).
import { deleteJson, fetchJson, sendJson } from "./admin-client.ts";

export type EstadoPlantilla = "borrador" | "enviada" | "aprobada" | "rechazada";
export const ESTADOS_PLANTILLA: readonly EstadoPlantilla[] = ["borrador", "enviada", "aprobada", "rechazada"];

export const ESTADO_PLANTILLA_ETIQUETA: Readonly<Record<EstadoPlantilla, string>> = {
  borrador: "Borrador",
  enviada: "Enviada a Meta",
  aprobada: "Aprobada",
  rechazada: "Rechazada",
};

export interface PlantillaWire {
  readonly evento: string;
  readonly nombre: string;
  readonly idioma: string;
  readonly variables: readonly string[];
  readonly estado: EstadoPlantilla;
  readonly aprobadaEn: string | null;
  readonly actualizadaEn: string;
}

export interface EventoPlantillaWire {
  readonly evento: string;
  readonly etiqueta: string;
  /** Variables que el sistema sabe llenar para este evento. */
  readonly variables: readonly string[];
  readonly plantilla: PlantillaWire | null;
}

export interface PlantillasWire {
  /** `false` cuando la migracion 0048 todavia no esta aplicada: la pantalla no ofrece editar. */
  readonly disponible: boolean;
  readonly estados: readonly EstadoPlantilla[];
  readonly eventos: readonly EventoPlantillaWire[];
}

/** Formulario: las variables viajan como texto separado por comas mientras se escriben. */
export interface FormPlantilla {
  readonly nombre: string;
  readonly idioma: string;
  readonly variables: string;
  readonly estado: EstadoPlantilla;
}

export const FORM_PLANTILLA_VACIO: FormPlantilla = { nombre: "", idioma: "es_MX", variables: "", estado: "borrador" };

export function formDesdePlantilla(p: PlantillaWire | null): FormPlantilla {
  return p ? { nombre: p.nombre, idioma: p.idioma, variables: p.variables.join(", "), estado: p.estado } : FORM_PLANTILLA_VACIO;
}

/** Texto "nombre, fecha, hora" -> ["nombre", "fecha", "hora"]. Sin variables = []. Lo ilegible NO se arregla: el servidor lo rechaza. */
export function variablesDesdeTexto(texto: string): string[] {
  return texto
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export function cuerpoDesdeFormPlantilla(f: FormPlantilla): { nombre: string; idioma: string; variables: string[]; estado: EstadoPlantilla } {
  return { nombre: f.nombre.trim(), idioma: f.idioma.trim(), variables: variablesDesdeTexto(f.variables), estado: f.estado };
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/v1/citas/properties/${propertyId}/admin/whatsapp-plantillas`;

export function fetchPlantillas(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<PlantillasWire> {
  return fetchJson<PlantillasWire>(fetchImpl, base(apiBaseUrl, propertyId), token);
}

export function guardarPlantilla(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, evento: string, form: FormPlantilla): Promise<{ disponible: boolean; plantilla: PlantillaWire | null }> {
  return sendJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/${encodeURIComponent(evento)}`, token, "PUT", cuerpoDesdeFormPlantilla(form));
}

export function eliminarPlantilla(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, evento: string): Promise<{ ok: boolean }> {
  return deleteJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/${encodeURIComponent(evento)}`, token);
}
