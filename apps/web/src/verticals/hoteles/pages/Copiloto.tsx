// Copiloto ("Pregunta a tus datos") de hoteles: conecta la pagina generica `CopilotoPage` con la API real
// `/hoteles/:propertyId/chat-datos` (sesion con refresh de `hotelesAuthContext`). El alcance (organizacion, hoteles, rol)
// lo decide el servidor a partir del token (solo owner/gm: los demas reciben 403); aqui solo viaja el hotel activo en la URL.
// Los roles que el servidor rechazaria NI SIQUIERA llaman al backend: ven el estado "sin acceso" directo.
import { useMemo } from "react";
import { Lock } from "lucide-react";
import { EstadoVacio } from "@atiende/ui";
import { apiBaseUrlFromRequestUrl, withAuthRefresh } from "../../../lib/authed-fetch.ts";
import { COPILOTO_HOTELES } from "../../../lib/copiloto/config/hoteles.ts";
import { consultarEstadoCopiloto, crearTransporteCopiloto } from "../../../lib/copiloto/transporte.ts";
import type { CopilotoTransporteConfig } from "../../../lib/copiloto/transporte.ts";
import { CopilotoPage } from "../../../pages/CopilotoPage.tsx";
import { hotelesAuthContext } from "../lib/data-chat-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

/** Mismo conjunto que el servidor (apps/api/tests/hoteles-guardas-matriz.ts, 'chat-datos'): owner y gm. Cosmetico: el servidor manda (403). */
export const COPILOTO_HOTELES_ROLES: ReadonlySet<string> = new Set(["owner", "gm"]);

export function urlChatDatosHoteles(apiBaseUrl: string, propertyId: string): string {
  return `${apiBaseUrl}/hoteles/${encodeURIComponent(propertyId)}/chat-datos`;
}

export function HotelesCopilotoPage(ctx: HotelesShellContext) {
  if (!COPILOTO_HOTELES_ROLES.has(ctx.role)) {
    return (
      <div className="p-4">
        <EstadoVacio icon={Lock} titulo="Sin acceso" mensaje={COPILOTO_HOTELES.textoSinAcceso} />
      </div>
    );
  }
  return <HotelesCopilotoConectado {...ctx} />;
}

function HotelesCopilotoConectado({ apiBaseUrl, token, propertyId, orgSlug }: HotelesShellContext) {
  const cfg = useMemo<CopilotoTransporteConfig>(() => {
    const baseUrl = urlChatDatosHoteles(apiBaseUrl, propertyId);
    const fetchImpl: typeof fetch = (...args) => fetch(...args);
    return {
      baseUrl,
      fetchImpl,
      token,
      conAuth: (hacer) => withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(baseUrl), hotelesAuthContext(), token, hacer),
    };
  }, [apiBaseUrl, propertyId, token]);
  const transporte = useMemo(() => crearTransporteCopiloto(cfg), [cfg]);

  return (
    <CopilotoPage
      config={COPILOTO_HOTELES}
      transporte={transporte}
      consultarEstado={(senal) => consultarEstadoCopiloto(cfg, senal)}
      propertyId={propertyId}
      orgSlug={orgSlug}
    />
  );
}
