// Privacidad — aviso de privacidad versionado, consentimientos, ARCO con plazos, incidentes/vulneraciones,
// retención legal y acceso excepcional a identidades bloqueadas (H-02, P0). Vive como pestaña "Privacidad"
// dentro de Identidad.tsx (mismo shell y mismos componentes de @atiende/ui). Consume
// apps/api/src/routes/verticals/hoteles/privacidad.ts.
//
// AVISO: herramienta de registro y control; NO es asesoría legal (el texto viene del servidor junto con la
// lista "un abogado debe confirmar"). El sistema NUNCA envía nada al titular ni a una autoridad: el recordatorio
// de notificar una vulneración es solo informativo.
//
// El servidor es la barrera real de roles (owner/gm gestionan; front-of-house captura consentimientos y reporta
// incidentes); aquí solo se ordena la UX. Base sin la migración 032: estado honesto "no disponible aún".
//
// UNI-C gestion: cada seccion vive en components/privacidad/* (Aviso, ARCO, Incidentes, Retencion) con DataTable, FormDialog y
// useConfirm en lugar de `window.prompt`; este archivo conserva solo el aviso legal y las sub-pestanas.
import { useEffect, useState } from "react";
import { Callout, Tabs, TabsContent, TabsList, TabsTrigger } from "@atiende/ui";
import { fetchPrivacidadInfo } from "../lib/privacidad-client.ts";
import type { PrivacidadInfo } from "../lib/privacidad-client.ts";
import { ArcoSection } from "../components/privacidad/ArcoSection.tsx";
import { AvisoSection } from "../components/privacidad/AvisoSection.tsx";
import { IncidentesSection } from "../components/privacidad/IncidentesSection.tsx";
import { RetencionSection } from "../components/privacidad/RetencionSection.tsx";

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** owner/gm (cosmético: el servidor es la barrera real). */
  readonly isAdmin: boolean;
}

type Sub = "aviso" | "arco" | "incidentes" | "retencion";

export function PrivacidadTab({ apiBaseUrl, token, propertyId, isAdmin }: Props) {
  const [sub, setSub] = useState<Sub>("aviso");
  const [info, setInfo] = useState<PrivacidadInfo | null>(null);

  useEffect(() => {
    let cancelado = false;
    fetchPrivacidadInfo(fetch, apiBaseUrl, token, propertyId)
      .then((i) => !cancelado && setInfo(i))
      .catch(() => undefined); // el aviso legal es informativo: si falla, la pestaña sigue (el texto fijo de abajo cubre lo esencial)
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId]);

  return (
    <div className="flex flex-col gap-3">
      <Callout tone="neutral" role="note" aria-label="Aviso legal de privacidad">
        <div>
          <p className="font-medium text-foreground" data-testid="aviso-legal">
            {info?.avisoLegal ?? "Esta pantalla es una herramienta de registro y control. NO es asesoría legal ni garantiza el cumplimiento de la LFPDPPP."}
          </p>
          {info && (
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer text-foreground">Un abogado debe confirmar ({info.unAbogadoDebeConfirmar.length} puntos)</summary>
              <ul className="mt-1 list-disc pl-5 flex flex-col gap-1">
                {info.unAbogadoDebeConfirmar.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </Callout>
      <Tabs value={sub} onValueChange={(v) => setSub(v as Sub)}>
        <TabsList>
          <TabsTrigger value="aviso">Aviso y consentimientos</TabsTrigger>
          {isAdmin && <TabsTrigger value="arco">ARCO</TabsTrigger>}
          <TabsTrigger value="incidentes">Incidentes</TabsTrigger>
          {isAdmin && <TabsTrigger value="retencion">Retención y bloqueo</TabsTrigger>}
        </TabsList>
        <TabsContent value="aviso" className="mt-4">
          <AvisoSection apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} isAdmin={isAdmin} />
        </TabsContent>
        {isAdmin && (
          <TabsContent value="arco" className="mt-4">
            <ArcoSection apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} isAdmin={isAdmin} />
          </TabsContent>
        )}
        <TabsContent value="incidentes" className="mt-4">
          <IncidentesSection apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} isAdmin={isAdmin} />
        </TabsContent>
        {isAdmin && (
          <TabsContent value="retencion" className="mt-4">
            <RetencionSection apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} isAdmin={isAdmin} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
