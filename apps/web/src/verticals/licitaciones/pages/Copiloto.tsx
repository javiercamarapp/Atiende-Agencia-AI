// Copiloto ("Pregunta a tus datos") de licitaciones: conecta la pagina generica `CopilotoPage` con la API real
// `/licitaciones/:propertyId/chat-datos` (sesion con refresh de `defaultAuthCtx`). El alcance (organizacion) y el rol los decide el
// servidor a partir del token: licitaciones deja pasar a TODO rol de la vertical (la lectura ya es de todo miembro por RLS); un
// usuario que el servidor rechace (403 en /estado) ve el estado "Sin acceso" de la pagina generica.
import { useMemo } from "react";
import { apiBaseUrlFromRequestUrl, withAuthRefresh } from "../../../lib/authed-fetch.ts";
import { COPILOTO_LICITACIONES } from "../../../lib/copiloto/config/licitaciones.ts";
import { consultarEstadoCopiloto, crearTransporteCopiloto } from "../../../lib/copiloto/transporte.ts";
import type { CopilotoTransporteConfig } from "../../../lib/copiloto/transporte.ts";
import { CopilotoPage } from "../../../pages/CopilotoPage.tsx";
import { defaultAuthCtx } from "../lib/admin-client.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

export function urlChatDatosLicitaciones(apiBaseUrl: string, propertyId: string): string {
  return `${apiBaseUrl}/licitaciones/${encodeURIComponent(propertyId)}/chat-datos`;
}

export function LicitacionesCopilotoPage({ apiBaseUrl, token, propertyId, orgSlug }: LicitacionesShellContext) {
  const cfg = useMemo<CopilotoTransporteConfig>(() => {
    const baseUrl = urlChatDatosLicitaciones(apiBaseUrl, propertyId);
    const fetchImpl: typeof fetch = (...args) => fetch(...args);
    return {
      baseUrl,
      fetchImpl,
      token,
      conAuth: (hacer) => withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(baseUrl), defaultAuthCtx(), token, hacer),
    };
  }, [apiBaseUrl, propertyId, token]);
  const transporte = useMemo(() => crearTransporteCopiloto(cfg), [cfg]);

  return (
    <CopilotoPage
      config={COPILOTO_LICITACIONES}
      transporte={transporte}
      consultarEstado={(senal) => consultarEstadoCopiloto(cfg, senal)}
      propertyId={propertyId}
      orgSlug={orgSlug}
    />
  );
}
