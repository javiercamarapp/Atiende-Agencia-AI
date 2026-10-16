// Copiloto ("Pregunta a tus datos") de restaurantes: conecta la pagina generica `CopilotoPage` con la API real
// `/v1/restaurantes/:propertyId/admin/chat-datos` (sesion con refresh de `restaurantesAuthContext`). El alcance
// (organizacion, sucursales, rol) lo decide el servidor a partir del token; aqui solo viaja la sucursal activa en la URL.
import { useMemo } from "react";
import { SeccionFijadosCopiloto } from "@atiende/ui";
import { apiBaseUrlFromRequestUrl, withAuthRefresh } from "../../../lib/authed-fetch.ts";
import { COPILOTO_RESTAURANTES, COPILOTO_RESTAURANTES_SIN_CFO } from "../../../lib/copiloto/config/restaurantes.ts";
import { crearClienteFijados } from "../../../lib/copiloto/fijados.ts";
import { consultarEstadoCopiloto, crearTransporteCopiloto } from "../../../lib/copiloto/transporte.ts";
import type { CopilotoTransporteConfig } from "../../../lib/copiloto/transporte.ts";
import { CopilotoPage } from "../../../pages/CopilotoPage.tsx";
import { restaurantesAuthContext } from "../dashboard-client.ts";
import { puedeEn } from "../lib/permisos.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

export function urlChatDatosRestaurantes(apiBaseUrl: string, propertyId: string): string {
  return `${apiBaseUrl}/v1/restaurantes/${encodeURIComponent(propertyId)}/admin/chat-datos`;
}

export function RestaurantesCopilotoPage({ apiBaseUrl, token, propertyId, orgSlug, role }: RestaurantesShellContext) {
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
      config={puedeEn(role, "cfo.ver") ? COPILOTO_RESTAURANTES : COPILOTO_RESTAURANTES_SIN_CFO}
      transporte={transporte}
      consultarEstado={(senal) => consultarEstadoCopiloto(cfg, senal)}
      propertyId={propertyId}
      orgSlug={orgSlug}
    />
  );
}

/** Lo minimo que necesita el tablero de fijados del contexto del shell (la pagina de Resumen lo pasa tal cual). */
export type RestaurantesFijadosCopilotoProps = Pick<RestaurantesShellContext, "apiBaseUrl" | "token" | "propertyId" | "orgSlug">;

/** Tablero de fijados del Copiloto para la pagina de Resumen (si el rol no tiene Copiloto el servidor responde 403 y la seccion no se pinta). */
export function RestaurantesFijadosCopiloto({ apiBaseUrl, token, propertyId, orgSlug }: RestaurantesFijadosCopilotoProps) {
  const cliente = useMemo(() => {
    const baseUrl = urlChatDatosRestaurantes(apiBaseUrl, propertyId);
    const fetchImpl: typeof fetch = (...args) => fetch(...args);
    return crearClienteFijados({ baseUrl, fetchImpl, token, conAuth: (hacer) => withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(baseUrl), restaurantesAuthContext(), token, hacer) });
  }, [apiBaseUrl, propertyId, token]);
  return <SeccionFijadosCopiloto cliente={cliente} rutaCopiloto={`/restaurantes/${encodeURIComponent(orgSlug)}/copiloto`} />;
}
