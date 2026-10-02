// Copiloto ("Pregunta a tus datos") de rentas: conecta la pagina generica `CopilotoPage` con la API real
// `/rentas/:propertyId/chat-datos` (sesion con refresh de `rentasAuthContext`). El alcance (organizacion, propiedades, rol
// admin_gestora/contador) lo decide el servidor a partir del token; aqui solo viaja la propiedad activa en la URL.
import { useMemo } from "react";
import { apiBaseUrlFromRequestUrl, withAuthRefresh } from "../../../lib/authed-fetch.ts";
import { COPILOTO_RENTAS } from "../../../lib/copiloto/config/rentas.ts";
import { consultarEstadoCopiloto, crearTransporteCopiloto } from "../../../lib/copiloto/transporte.ts";
import type { CopilotoTransporteConfig } from "../../../lib/copiloto/transporte.ts";
import { CopilotoPage } from "../../../pages/CopilotoPage.tsx";
import { rentasAuthContext } from "../lib/data-chat-client.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

export function urlChatDatosRentas(apiBaseUrl: string, propertyId: string): string {
  return `${apiBaseUrl}/rentas/${encodeURIComponent(propertyId)}/chat-datos`;
}

export function RentasCopilotoPage({ apiBaseUrl, token, propertyId, orgSlug }: RentasShellContext) {
  const cfg = useMemo<CopilotoTransporteConfig>(() => {
    const baseUrl = urlChatDatosRentas(apiBaseUrl, propertyId);
    const fetchImpl: typeof fetch = (...args) => fetch(...args);
    return {
      baseUrl,
      fetchImpl,
      token,
      conAuth: (hacer) => withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(baseUrl), rentasAuthContext(), token, hacer),
    };
  }, [apiBaseUrl, propertyId, token]);
  const transporte = useMemo(() => crearTransporteCopiloto(cfg), [cfg]);

  return (
    <CopilotoPage
      config={COPILOTO_RENTAS}
      transporte={transporte}
      consultarEstado={(senal) => consultarEstadoCopiloto(cfg, senal)}
      propertyId={propertyId}
      orgSlug={orgSlug}
    />
  );
}
