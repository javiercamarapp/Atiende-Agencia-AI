// Copiloto ("Pregunta a tus datos") de despachos: conecta la pagina generica `CopilotoPage` con la API real
// `/despachos/:propertyId/chat-datos` (sesion con refresh de `despachosAuthContext`). El alcance (organizacion, clientes de la
// membership, zona horaria, rol) lo decide el servidor a partir del token; aqui solo viaja el contribuyente activo en la URL
// (al cambiarlo en el shell la pagina se remonta y el chat arranca limpio). Los roles que el servidor rechazaria NI SIQUIERA
// llaman al backend: ven el estado "sin acceso" directo.
import { useMemo } from "react";
import { Lock } from "lucide-react";
import { EstadoVacio } from "@atiende/ui";
import { apiBaseUrlFromRequestUrl, withAuthRefresh } from "../../../lib/authed-fetch.ts";
import { COPILOTO_DESPACHOS } from "../../../lib/copiloto/config/despachos.ts";
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
      <div className="p-4">
        <EstadoVacio icon={Lock} titulo="Sin acceso" mensaje={COPILOTO_DESPACHOS.textoSinAcceso} />
      </div>
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
