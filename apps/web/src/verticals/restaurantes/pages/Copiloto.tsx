// Copiloto ("Pregunta a tus datos") de restaurantes: conecta la pagina generica `CopilotoPage` con la API real
// `/v1/restaurantes/:propertyId/admin/chat-datos` (sesion con refresh de `restaurantesAuthContext`). El alcance
// (organizacion, sucursales, rol) lo decide el servidor a partir del token; aqui solo viaja la sucursal activa en la URL.
import { useMemo } from "react";
import { apiBaseUrlFromRequestUrl, withAuthRefresh } from "../../../lib/authed-fetch.ts";
import { COPILOTO_RESTAURANTES } from "../../../lib/copiloto/config/restaurantes.ts";
import { consultarEstadoCopiloto, crearTransporteCopiloto } from "../../../lib/copiloto/transporte.ts";
import type { CopilotoTransporteConfig } from "../../../lib/copiloto/transporte.ts";
import { CopilotoPage } from "../../../pages/CopilotoPage.tsx";
import { restaurantesAuthContext } from "../dashboard-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

export function urlChatDatosRestaurantes(apiBaseUrl: string, propertyId: string): string {
  return `${apiBaseUrl}/v1/restaurantes/${encodeURIComponent(propertyId)}/admin/chat-datos`;
}

export function RestaurantesCopilotoPage({ apiBaseUrl, token, propertyId, orgSlug }: RestaurantesShellContext) {
  const cfg = useMemo<CopilotoTransporteConfig>(() => {
    const baseUrl = urlChatDatosRestaurantes(apiBaseUrl, propertyId);
    const fetchImpl: typeof fetch = (...args) => fetch(...args);
    return {
      baseUrl,
      fetchImpl,
      token,
      conAuth: (hacer) => withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(baseUrl), restaurantesAuthContext(), token, hacer),
    };
  }, [apiBaseUrl, propertyId, token]);
  const transporte = useMemo(() => crearTransporteCopiloto(cfg), [cfg]);

  return (
    <CopilotoPage
      config={COPILOTO_RESTAURANTES}
      transporte={transporte}
      consultarEstado={(senal) => consultarEstadoCopiloto(cfg, senal)}
      propertyId={propertyId}
      orgSlug={orgSlug}
    />
  );
}
