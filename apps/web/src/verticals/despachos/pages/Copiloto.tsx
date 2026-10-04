// Copiloto ("Pregunta a tus datos") de despachos: conecta la pagina generica `CopilotoPage` con la API real
// `/despachos/:propertyId/chat-datos` (sesion con refresh de `despachosAuthContext`). El alcance (organizacion, clientes de la
// membership, zona horaria, rol) lo decide el servidor a partir del token; aqui solo viaja el contribuyente activo en la URL
// (al cambiarlo en el shell la pagina se remonta y el chat arranca limpio). Los roles que el servidor rechazaria NI SIQUIERA
// llaman al backend: ven el estado "sin acceso" directo.
import { useMemo } from "react";
import { Lock } from "lucide-react";
import { EstadoVacio, PageContainer, PageHeader, SeccionFijadosCopiloto } from "@atiende/ui";
import { apiBaseUrlFromRequestUrl, withAuthRefresh } from "../../../lib/authed-fetch.ts";
import { COPILOTO_DESPACHOS } from "../../../lib/copiloto/config/despachos.ts";
import { crearClienteFijados } from "../../../lib/copiloto/fijados.ts";
import { consultarEstadoCopiloto, crearTransporteCopiloto } from "../../../lib/copiloto/transporte.ts";
import type { CopilotoTransporteConfig } from "../../../lib/copiloto/transporte.ts";
import { CopilotoPage } from "../../../pages/CopilotoPage.tsx";
import { despachosAuthContext } from "../lib/admin-client.ts";
import { despachosChatBaseUrl } from "../lib/chat-datos-client.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

/** Mismo conjunto que el servidor (VER_DASHBOARD_ROLES de @atiende/domain-despachos, usado por chat-datos.ts): admin, contador, auditor y readonly. Cosmetico: el servidor manda (403). */
export const COPILOTO_DESPACHOS_ROLES: ReadonlySet<string> = new Set(["admin", "contador", "auditor", "readonly"]);

export function DespachosCopilotoPage(ctx: DespachosShellContext) {
  if (!COPILOTO_DESPACHOS_ROLES.has(ctx.role)) {
    return (
      <PageContainer>
        <PageHeader titulo="Copiloto" descripcion="Pregunta a tus datos." />
        <EstadoVacio icon={Lock} titulo="Sin acceso" mensaje={COPILOTO_DESPACHOS.textoSinAcceso} />
      </PageContainer>
    );
  }
  return <DespachosCopilotoConectado {...ctx} />;
}

function DespachosCopilotoConectado({ apiBaseUrl, token, propertyId, orgSlug }: DespachosShellContext) {
  const cfg = useMemo<CopilotoTransporteConfig>(() => {
    const baseUrl = despachosChatBaseUrl(apiBaseUrl, propertyId);
    const fetchImpl: typeof fetch = (...args) => fetch(...args);
    return {
      baseUrl,
      fetchImpl,
      token,
      conAuth: (hacer) => withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(baseUrl), despachosAuthContext(), token, hacer),
    };
  }, [apiBaseUrl, propertyId, token]);
  const transporte = useMemo(() => crearTransporteCopiloto(cfg), [cfg]);

  return (
    <CopilotoPage
      config={COPILOTO_DESPACHOS}
      transporte={transporte}
      consultarEstado={(senal) => consultarEstadoCopiloto(cfg, senal)}
      propertyId={propertyId}
      orgSlug={orgSlug}
    />
  );
}

/** Lo minimo que necesita el tablero de fijados del contexto del shell (la pagina de Resumen lo pasa tal cual). `role` es opcional: sin el, decide el servidor (403). */
export type DespachosFijadosCopilotoProps = Pick<DespachosShellContext, "apiBaseUrl" | "token" | "propertyId" | "orgSlug"> & { readonly role?: string };

/** Tablero de fijados del Copiloto para la pagina de Resumen (solo los roles con Copiloto). */
export function DespachosFijadosCopiloto({ apiBaseUrl, token, propertyId, orgSlug, role }: DespachosFijadosCopilotoProps) {
  const cliente = useMemo(() => {
    const baseUrl = despachosChatBaseUrl(apiBaseUrl, propertyId);
    const fetchImpl: typeof fetch = (...args) => fetch(...args);
    return crearClienteFijados({ baseUrl, fetchImpl, token, conAuth: (hacer) => withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(baseUrl), despachosAuthContext(), token, hacer) });
  }, [apiBaseUrl, propertyId, token]);
  if (role !== undefined && !COPILOTO_DESPACHOS_ROLES.has(role)) return null;
  return <SeccionFijadosCopiloto cliente={cliente} rutaCopiloto={`/despachos/${encodeURIComponent(orgSlug)}/copiloto`} />;
}
