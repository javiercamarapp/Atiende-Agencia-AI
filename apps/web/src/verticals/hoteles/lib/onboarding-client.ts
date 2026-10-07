// H-P3-06 -- cliente de "Primeros pasos" de hoteles (`apps/api/src/routes/verticals/hoteles/primeros-pasos.ts`, owner/gm). El estado de
// cada punto lo calcula el servidor con datos reales; aqui nunca se inventa ni se marca nada a mano. La omision del gate dura la sesion
// del navegador y, ademas, el servidor deja constancia en la bitacora de configuracion.
import { fetchJson, sendJson } from "./admin-client.ts";

export type OnboardingEstado = "hecho" | "parcial" | "pendiente";
export type OnboardingResponsable = "dueno" | "plataforma" | "meta";
export type OnboardingPantalla = "catalogo" | "configuracion" | "equipo" | "privacidad" | "mensajeria" | "reservas";
export type OnboardingPestana = "impuestos" | "cancelacion" | "sobreventa" | "tarifas";

export interface OnboardingItem {
  readonly id: string;
  readonly titulo: string;
  readonly estado: OnboardingEstado;
  readonly obligatorio: boolean;
  readonly detalle: string;
  readonly responsable: OnboardingResponsable;
  readonly pantalla: OnboardingPantalla;
  readonly pestana?: OnboardingPestana;
}

export interface OnboardingGate {
  readonly bloquea: boolean;
  readonly obligatoriosPendientes: number;
  readonly operaConReservas: boolean;
}

export interface OnboardingChecklist extends OnboardingGate {
  readonly listoParaOperar: boolean;
  readonly resumen: { readonly hechos: number; readonly total: number; readonly obligatoriosPendientes: number };
  readonly items: readonly OnboardingItem[];
  readonly nochesRequeridas: number;
}

/** Roles que consultan el gate (el servidor responde 403 al resto). */
export const ONBOARDING_ROLES: ReadonlySet<string> = new Set(["owner", "gm"]);

const claveOmitido = (orgSlug: string) => `atiende.hoteles.onboarding-gate-omitido.${orgSlug}`;

export function gateOmitido(orgSlug: string): boolean {
  try {
    return window.sessionStorage.getItem(claveOmitido(orgSlug)) === "1";
  } catch {
    return false;
  }
}

export function recordarOmision(orgSlug: string): void {
  try {
    window.sessionStorage.setItem(claveOmitido(orgSlug), "1");
  } catch {
    /* sin sessionStorage el gate vuelve a ofrecerse: no pasa nada */
  }
}

export const RESPONSABLE_LABEL: Record<OnboardingResponsable, string> = { dueno: "Dueño", plataforma: "Plataforma", meta: "Meta (WhatsApp Business)" };
export const ESTADO_LABEL: Record<OnboardingEstado, string> = { hecho: "Listo", parcial: "Parcial", pendiente: "Pendiente" };

export async function fetchOnboarding(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<OnboardingChecklist> {
  const body = await fetchJson<OnboardingChecklist>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/primeros-pasos`, token);
  if (!body || !Array.isArray(body.items) || typeof body.bloquea !== "boolean") throw new Error("La respuesta del servidor no trae el checklist de primeros pasos.");
  return body;
}

/** Omite el gate: el servidor lo registra en la bitacora (`registrada:false` si la base aun no tiene la migracion) y el navegador lo recuerda. */
export async function omitirGate(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, orgSlug: string): Promise<{ readonly registrada: boolean }> {
  const res = await sendJson<{ omitido: boolean; registrada: boolean }>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/primeros-pasos/omitir`, token, "POST", {});
  recordarOmision(orgSlug);
  return { registrada: res.registrada };
}
