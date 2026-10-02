// Copiloto ("Pregunta a tus datos") de licitaciones: conecta la pagina generica `CopilotoPage` con la API real
// `/licitaciones/:propertyId/chat-datos` (sesion con refresh de `defaultAuthCtx`). El alcance (organizacion) y el rol los decide el
// servidor a partir del token: licitaciones deja pasar a TODO rol de la vertical (la lectura ya es de todo miembro por RLS); un
// usuario que el servidor rechace (403 en /estado) ve el estado "Sin acceso" de la pagina generica.
import { useMemo } from "react";
import { SeccionFijadosCopiloto } from "@atiende/ui";
import { apiBaseUrlFromRequestUrl, withAuthRefresh } from "../../../lib/authed-fetch.ts";
import { COPILOTO_LICITACIONES } from "../../../lib/copiloto/config/licitaciones.ts";
import { crearClienteFijados } from "../../../lib/copiloto/fijados.ts";
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

/** Lo minimo que necesita el tablero de fijados del contexto del shell (la pagina de Resumen lo pasa tal cual). */
export type LicitacionesFijadosCopilotoProps = Pick<LicitacionesShellContext, "apiBaseUrl" | "token" | "propertyId" | "orgSlug">;

/** Tablero de fijados del Copiloto para la pagina de Resumen (si el rol no tiene Copiloto el servidor responde 403 y la seccion no se pinta). */
export function LicitacionesFijadosCopiloto({ apiBaseUrl, token, propertyId, orgSlug }: LicitacionesFijadosCopilotoProps) {
  const cliente = useMemo(() => {
    const baseUrl = urlChatDatosLicitaciones(apiBaseUrl, propertyId);
    const fetchImpl: typeof fetch = (...args) => fetch(...args);
    return crearClienteFijados({ baseUrl, fetchImpl, token, conAuth: (hacer) => withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(baseUrl), defaultAuthCtx(), token, hacer) });
  }, [apiBaseUrl, propertyId, token]);
  return <SeccionFijadosCopiloto cliente={cliente} rutaCopiloto={`/licitaciones/${encodeURIComponent(orgSlug)}/copiloto`} />;
}
