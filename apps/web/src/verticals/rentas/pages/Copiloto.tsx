// Copiloto ("Pregunta a tus datos") de rentas: conecta la pagina generica `CopilotoPage` con la API real
// `/rentas/:propertyId/chat-datos` (sesion con refresh de `rentasAuthContext`). El alcance (organizacion, propiedades, rol
// admin_gestora/contador) lo decide el servidor a partir del token; aqui solo viaja la propiedad activa en la URL.
import { useMemo } from "react";
import { SeccionFijadosCopiloto } from "@atiende/ui";
import { apiBaseUrlFromRequestUrl, withAuthRefresh } from "../../../lib/authed-fetch.ts";
import { COPILOTO_RENTAS } from "../../../lib/copiloto/config/rentas.ts";
import { crearClienteFijados } from "../../../lib/copiloto/fijados.ts";
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

/** Lo minimo que necesita el tablero de fijados del contexto del shell (la pagina de Resumen lo pasa tal cual). */
export type RentasFijadosCopilotoProps = Pick<RentasShellContext, "apiBaseUrl" | "token" | "propertyId" | "orgSlug">;

/** Tablero de fijados del Copiloto para la pagina de Resumen (si el rol no tiene Copiloto el servidor responde 403 y la seccion no se pinta). */
export function RentasFijadosCopiloto({ apiBaseUrl, token, propertyId, orgSlug }: RentasFijadosCopilotoProps) {
  const cliente = useMemo(() => {
    const baseUrl = urlChatDatosRentas(apiBaseUrl, propertyId);
    const fetchImpl: typeof fetch = (...args) => fetch(...args);
    return crearClienteFijados({ baseUrl, fetchImpl, token, conAuth: (hacer) => withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(baseUrl), rentasAuthContext(), token, hacer) });
  }, [apiBaseUrl, propertyId, token]);
  return <SeccionFijadosCopiloto cliente={cliente} rutaCopiloto={`/rentas/${encodeURIComponent(orgSlug)}/copiloto`} />;
}
