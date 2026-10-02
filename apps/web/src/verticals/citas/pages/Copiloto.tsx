// Copiloto ("Pregunta a tus datos") de citas: conecta la pagina generica `CopilotoPage` con la API real
// `/citas/:propertyId/chat-datos` (sesion con refresh de `defaultAuthCtx`). El alcance (organizacion, sucursales, rol) lo decide
// el servidor a partir del token (solo owner/admin, DATA_CHAT_ROLES: el catalogo lee ingresos y tasas por profesional); aqui
// solo viaja la sucursal activa en la URL. Los roles que el servidor rechazaria NI SIQUIERA llaman al backend: ven "sin acceso".
import { useMemo } from "react";
import { Lock } from "lucide-react";
import { EstadoVacio } from "@atiende/ui";
import { apiBaseUrlFromRequestUrl, withAuthRefresh } from "../../../lib/authed-fetch.ts";
import { COPILOTO_CITAS } from "../../../lib/copiloto/config/citas.ts";
import { consultarEstadoCopiloto, crearTransporteCopiloto } from "../../../lib/copiloto/transporte.ts";
import type { CopilotoTransporteConfig } from "../../../lib/copiloto/transporte.ts";
import { CopilotoPage } from "../../../pages/CopilotoPage.tsx";
import { defaultAuthCtx } from "../lib/admin-client.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

/** Mismo conjunto que el servidor (DATA_CHAT_ROLES de packages/domain-citas/src/roles.ts): owner y admin. Cosmetico: el servidor manda (403). */
export const COPILOTO_CITAS_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

export function urlChatDatosCitas(apiBaseUrl: string, propertyId: string): string {
  return `${apiBaseUrl}/citas/${encodeURIComponent(propertyId)}/chat-datos`;
}

export function CitasCopilotoPage(ctx: CitasShellContext) {
  if (!COPILOTO_CITAS_ROLES.has(ctx.role)) {
    return (
      <div className="p-4">
        <EstadoVacio icon={Lock} titulo="Sin acceso" mensaje={COPILOTO_CITAS.textoSinAcceso} />
      </div>
    );
  }
  return <CitasCopilotoConectado {...ctx} />;
}

function CitasCopilotoConectado({ apiBaseUrl, token, propertyId, orgSlug }: CitasShellContext) {
  const cfg = useMemo<CopilotoTransporteConfig>(() => {
    const baseUrl = urlChatDatosCitas(apiBaseUrl, propertyId);
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
      config={COPILOTO_CITAS}
      transporte={transporte}
      consultarEstado={(senal) => consultarEstadoCopiloto(cfg, senal)}
      propertyId={propertyId}
      orgSlug={orgSlug}
    />
  );
}
