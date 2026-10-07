// `/superadmin/copiloto`: el Copiloto de plataforma en pagina completa (variante `pagina`). La conversacion abierta se refleja en `?c=<id>` para poder volver
// a ella y para el enlace "Abrir en pagina completa" del panel Cmd+J. El nombre de la pagina lo pinta la barra superior del shell (icono + "Copiloto").
import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CopilotoPlataforma } from "../components/CopilotoPlataforma.tsx";

export interface SuperAdminCopilotoPageProps {
  readonly apiBaseUrl: string;
  readonly token: string;
}

export function SuperAdminCopilotoPage({ apiBaseUrl, token }: SuperAdminCopilotoPageProps) {
  const [params, setParams] = useSearchParams();
  // Se lee UNA vez: el shell abre esa conversacion al montar.
  const [conversacionInicial] = useState(() => params.get("c") ?? undefined);
  const alCambiar = useCallback(
    (id?: string) => {
      setParams(
        (prev) => {
          const sig = new URLSearchParams(prev);
          if (id) sig.set("c", id);
          else sig.delete("c");
          return sig;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  return <CopilotoPlataforma apiBaseUrl={apiBaseUrl} token={token} variante="pagina" {...(conversacionInicial ? { conversacionInicial } : {})} onConversacionCambia={alCambiar} />;
}
