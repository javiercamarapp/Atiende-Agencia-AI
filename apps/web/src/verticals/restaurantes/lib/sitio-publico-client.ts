// R-38: cliente de "Sitio publico" (marca del storefront), admin-sitio-publico.ts. Solo owner/admin (el servidor y la RLS son la
// autoridad). `fetchImpl` inyectado como el resto de lib/*.ts del panel.
import { fetchJson, sendJson } from "./admin-client.ts";

export interface MarcaSitio {
  readonly titular: string | null;
  readonly eslogan: string | null;
  readonly about: string | null;
  readonly portadaUrl: string | null;
  readonly logoUrl: string | null;
  readonly instagramUrl: string | null;
  readonly facebookUrl: string | null;
  readonly tiktokUrl: string | null;
  readonly updatedAt?: string | null;
}

export interface SitioPublicoWire {
  readonly marca: MarcaSitio;
  /** false = nunca se guardo (o la base aun no tiene la migracion 041: guardar responde 503 con el motivo). */
  readonly guardada: boolean;
}

/** Formulario del panel: todo texto (vacio = sin valor). */
export interface FormSitio {
  readonly titular: string;
  readonly eslogan: string;
  readonly about: string;
  readonly portadaUrl: string;
  readonly logoUrl: string;
  readonly instagramUrl: string;
  readonly facebookUrl: string;
  readonly tiktokUrl: string;
}

export const FORM_SITIO_VACIO: FormSitio = { titular: "", eslogan: "", about: "", portadaUrl: "", logoUrl: "", instagramUrl: "", facebookUrl: "", tiktokUrl: "" };

export function formDesdeMarca(m: MarcaSitio | null): FormSitio {
  if (!m) return FORM_SITIO_VACIO;
  return {
    titular: m.titular ?? "",
    eslogan: m.eslogan ?? "",
    about: m.about ?? "",
    portadaUrl: m.portadaUrl ?? "",
    logoUrl: m.logoUrl ?? "",
    instagramUrl: m.instagramUrl ?? "",
    facebookUrl: m.facebookUrl ?? "",
    tiktokUrl: m.tiktokUrl ?? "",
  };
}

/** Marca para la vista previa (vacio -> null). */
export function marcaDesdeForm(f: FormSitio): MarcaSitio {
  const v = (s: string) => (s.trim() === "" ? null : s.trim());
  return { titular: v(f.titular), eslogan: v(f.eslogan), about: v(f.about), portadaUrl: v(f.portadaUrl), logoUrl: v(f.logoUrl), instagramUrl: v(f.instagramUrl), facebookUrl: v(f.facebookUrl), tiktokUrl: v(f.tiktokUrl) };
}

export function hayCambios(a: FormSitio, b: FormSitio): boolean {
  return (Object.keys(a) as Array<keyof FormSitio>).some((k) => a[k].trim() !== b[k].trim());
}

export async function fetchSitioPublico(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<SitioPublicoWire> {
  return fetchJson<SitioPublicoWire>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/config/sitio-publico`, token);
}

export async function guardarSitioPublico(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, form: FormSitio): Promise<SitioPublicoWire> {
  return sendJson<SitioPublicoWire>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/config/sitio-publico`, token, "PUT", marcaDesdeForm(form));
}
