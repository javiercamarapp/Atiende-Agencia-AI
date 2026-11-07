// Puente de la «Guía» (ds3) con GET/PUT /v1/onboarding/progreso (apps/api/src/routes/onboarding-progreso.ts, migracion 0075).
// Sin red, sin sesion o con la base sin migrar devuelve null / no hace nada: la guia sigue con el progreso del navegador. Nunca lanza.
import { normalizarProgresoGuia } from "@atiende/ui";
import type { ProgresoLocal, ServidorProgreso } from "@atiende/ui";

/** Pista del progreso: «<vertical>.<rol>» (el rol se normaliza a minusculas sin espacios) o «superadmin». */
export function pistaGuia(vertical: string, rol: string | undefined): string {
  const crudo = (rol ?? "").slice(0, 60).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z_]+/g, "_");
  let i = 0;
  let f = crudo.length;
  while (i < f && crudo[i] === "_") i++;
  while (f > i && crudo[f - 1] === "_") f--;
  const r = crudo.slice(i, f).slice(0, 20);
  return r.length >= 2 ? `${vertical}.${r}` : vertical;
}

/** `/<vertical>/<orgSlug>/...` -> `{ base: "/<vertical>/<orgSlug>", orgSlug }`. */
export function baseDeConsola(href: string): { base: string; orgSlug: string } | null {
  const m = /^\/([a-z]+)\/([a-z0-9][a-z0-9-]*)(?:\/|$)/.exec(href);
  return m ? { base: `/${m[1]}/${m[2]}`, orgSlug: m[2]! } : null;
}

export function servidorProgresoGuia(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, pista: string, orgSlug: string | null): ServidorProgreso {
  const url = `${apiBaseUrl}/v1/onboarding/progreso`;
  const headers = { authorization: `Bearer ${token}` };
  return {
    async leer() {
      try {
        const q = new URLSearchParams({ pista, ...(orgSlug ? { org: orgSlug } : {}) });
        const res = await fetchImpl(`${url}?${q.toString()}`, { headers });
        if (!res.ok) return null;
        const cuerpo = (await res.json()) as { disponible?: boolean; progreso?: Record<string, unknown> | null };
        if (!cuerpo.disponible || !cuerpo.progreso) return null;
        return normalizarProgresoGuia(cuerpo.progreso);
      } catch {
        return null;
      }
    },
    async guardar(p: ProgresoLocal, opciones?: { readonly keepalive?: boolean }) {
      try {
        await fetchImpl(url, {
          method: "PUT",
          // keepalive: el ultimo guardado sale aunque se cierre la pestaña o la sesion (cuerpo < 2 KB, dentro del limite de keepalive).
          ...(opciones?.keepalive ? { keepalive: true } : {}),
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ pista, org: orgSlug, modo: p.modo, paso: p.paso, visto: p.visto, omitido: p.omitido, descartado: p.descartado, activo: p.activo, terminado: p.terminado }),
        });
      } catch {
        // Sin red: queda lo del navegador; el siguiente cambio vuelve a intentar.
      }
    },
  };
}
