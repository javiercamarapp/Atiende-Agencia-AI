// R-33 -- cliente del checklist de onboarding (solo lectura, owner/admin): GET /v1/restaurantes/:propertyId/admin/onboarding.
// El estado de cada punto lo calcula el servidor con datos reales; aqui nunca se inventa ni se marca nada a mano.
import { fetchJson } from "./admin-client.ts";

export type OnboardingEstado = "hecho" | "parcial" | "pendiente" | "externo";
export type OnboardingResponsable = "plataforma" | "dueno" | "meta" | "distribuidor_pos";
export type OnboardingPantalla = "sucursales" | "productos" | "configuracion" | "pedidos" | "conversaciones" | "agente-voz" | "privacidad";

export interface OnboardingItem {
  readonly id: string;
  readonly titulo: string;
  readonly estado: OnboardingEstado;
  readonly obligatorio: boolean;
  readonly detalle: string;
  readonly faltantes: readonly string[];
  readonly responsable: OnboardingResponsable;
  readonly pantalla: OnboardingPantalla;
}

/** Gate: bloquea solo con obligatorios pendientes y sin pedidos registrados (regla en domain-restaurantes/src/onboarding.ts). */
export interface OnboardingGate {
  readonly bloquea: boolean;
  readonly obligatoriosPendientes: number;
  readonly operaConPedidos: boolean;
}

export interface OnboardingChecklist {
  readonly items: readonly OnboardingItem[];
  readonly resumen: { readonly hechos: number; readonly total: number; readonly obligatoriosPendientes: number };
  readonly listoParaOperar: boolean;
  readonly gate: OnboardingGate;
}

export type OnboardingGateEstado = OnboardingGate & { readonly listoParaOperar: boolean };

// Omision del gate: dura SOLO la sesion del navegador (sessionStorage), por organizacion. Nunca se guarda en el servidor.
const claveOmitido = (orgSlug: string) => `atiende.restaurantes.onboarding-gate-omitido.${orgSlug}`;

export function gateOmitido(orgSlug: string): boolean {
  try {
    return window.sessionStorage.getItem(claveOmitido(orgSlug)) === "1";
  } catch {
    return false;
  }
}

export function omitirGate(orgSlug: string): void {
  try {
    window.sessionStorage.setItem(claveOmitido(orgSlug), "1");
  } catch {
    /* sin sessionStorage el gate vuelve a ofrecerse: no pasa nada */
  }
}

export const RESPONSABLE_LABEL: Record<OnboardingResponsable, string> = {
  plataforma: "Plataforma",
  dueno: "Dueño",
  meta: "Meta (WhatsApp Business)",
  distribuidor_pos: "Distribuidor del POS",
};

export const ESTADO_LABEL: Record<OnboardingEstado, string> = { hecho: "Listo", parcial: "Parcial", pendiente: "Pendiente", externo: "Depende de un tercero" };

export async function fetchOnboarding(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<OnboardingChecklist> {
  const body = await fetchJson<OnboardingChecklist>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/onboarding`, token);
  if (!body || !Array.isArray(body.items) || !body.gate) throw new Error("La respuesta del servidor no trae el checklist de onboarding.");
  return body;
}

export async function fetchOnboardingGate(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<OnboardingGateEstado> {
  const body = await fetchJson<OnboardingGateEstado>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/onboarding/gate`, token);
  if (!body || typeof body.bloquea !== "boolean" || typeof body.obligatoriosPendientes !== "number") throw new Error("La respuesta del servidor no trae el estado del gate de onboarding.");
  return body;
}
