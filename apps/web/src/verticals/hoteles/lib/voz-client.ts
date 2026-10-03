// Cliente de la voz de hoteles: estado honesto de la escalera y sesion de vista previa. Consume apps/api/.../hoteles/voice-tools.ts (solo owner/gm).
// Sin llaves ni secretos: el estado solo dice que escalon tiene credencial; la sesion trae tokens efimeros de un solo uso.
import type { SesionPreviewVoz } from "../../../lib/voz/tipos.ts";
import { fetchJson, sendJson } from "./admin-client.ts";

const url = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/hoteles/${propertyId}/voz`;

export type EscalonVoz = "gemini-3.8-live" | "cascada-openrouter";

export interface EstadoVozHoteles {
  readonly agente: { readonly configurado: boolean; readonly habilitado: boolean };
  readonly escalera: {
    readonly operativa: boolean;
    readonly escalones: readonly { readonly escalon: EscalonVoz; readonly configurado: boolean; readonly detalle: string }[];
  };
  /** Precio ESTIMADO por minuto de llamada (micro-USD, el mismo para todas las verticales). */
  readonly precioMicroUsdPorMinuto: Readonly<Record<EscalonVoz, number>>;
  /** `motivo` = por que no se puede (null si se puede). */
  readonly preview: { readonly disponible: boolean; readonly motivo: string | null };
}

export function fetchEstadoVoz(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<EstadoVozHoteles> {
  return fetchJson<EstadoVozHoteles>(fetchImpl, `${url(apiBaseUrl, propertyId)}/estado`, token);
}

export function crearSesionPreviewVoz(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, opts: { readonly voiceId?: string } = {}): Promise<SesionPreviewVoz> {
  return sendJson<SesionPreviewVoz>(fetchImpl, `${url(apiBaseUrl, propertyId)}/preview/sesion`, token, "POST", opts);
}

/** "US$0.018" por minuto: micro-USD enteros a dolares, sin Intl (el formato lo controla el guard de la base de codigo). */
export function formatoUsdPorMinuto(microUsd: number): string {
  return `US$${(microUsd / 1_000_000).toFixed(3)}`;
}

export const NOMBRE_ESCALON: Readonly<Record<EscalonVoz, string>> = {
  "gemini-3.8-live": "Gemini Live (principal)",
  "cascada-openrouter": "Cascada OpenRouter (respaldo)",
};
