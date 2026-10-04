// Identidad — bóveda de identidad cifrada, registro migratorio y purga con doble control
// (H-01, P0) + pestaña "Privacidad" (H-02: aviso, consentimientos, ARCO, bloqueo previo a la
// purga, retención legal e incidentes; ver Privacidad.tsx). Consume apps/api/src/routes/verticals/hoteles/identidad.ts. Mismo shell y
// mismos componentes de @atiende/ui que el resto del panel de hoteles (Fraude/Catálogo).
//
// UNI-C gestion: las pestanas viven en components/identidad/* (Boveda, captura en FormDialog, Purgas, Migratorio); los motivos que
// pedian `window.prompt` usan useConfirm (Cancelar/Escape nunca llaman a la API) y el feedback va por notify.
//
// Reglas de la pantalla (el servidor es la barrera real, esto solo ordena la UX):
//   - La lista muestra metadatos (tipo, ****últimos4, nacionalidad, retención); el documento
//     completo solo aparece tras "Revelar" (motivo obligatorio, queda en la bitácora) y se
//     descarta con "Ocultar" o al cambiar de pestaña/hotel (vive solo en estado local).
//   - Purga con doble control: quien solicita no puede aprobar su propia solicitud.
//   - Base sin migrar / sin llave: estado honesto "no disponible aún", nunca una pantalla rota.
import { useState } from "react";
import { PageContainer, PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from "@atiende/ui";
import { ADMIN_ROLES, REVEAL_ROLES } from "../lib/identidad-client.ts";
import { BovedaTab } from "../components/identidad/BovedaTab.tsx";
import { MigratorioTab } from "../components/identidad/MigratorioTab.tsx";
import { PurgasTab } from "../components/identidad/PurgasTab.tsx";
import { PrivacidadTab } from "./Privacidad.tsx";
import type { HotelesShellContext } from "../HotelesShell.tsx";

type Tab = "boveda" | "purgas" | "migratorio" | "privacidad";

export function IdentidadPage({ apiBaseUrl, token, propertyId, role }: HotelesShellContext) {
  const canReveal = REVEAL_ROLES.has(role);
  const isAdmin = ADMIN_ROLES.has(role);
  const [tab, setTab] = useState<Tab>("boveda");

  return (
    <PageContainer padding="none" className="gap-4">
      <PageHeader titulo="Identidad y registro migratorio" descripcion="Bóveda cifrada de documentos, purgas con doble control, registro migratorio y privacidad." />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="boveda">Bóveda</TabsTrigger>
          {isAdmin && <TabsTrigger value="purgas">Purgas</TabsTrigger>}
          <TabsTrigger value="migratorio">Registro migratorio</TabsTrigger>
          <TabsTrigger value="privacidad">Privacidad</TabsTrigger>
        </TabsList>
        <TabsContent value="boveda" className="mt-4">
          <BovedaTab apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} canReveal={canReveal} isAdmin={isAdmin} />
        </TabsContent>
        {isAdmin && (
          <TabsContent value="purgas" className="mt-4">
            <PurgasTab apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} />
          </TabsContent>
        )}
        <TabsContent value="migratorio" className="mt-4">
          <MigratorioTab apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} />
        </TabsContent>
        <TabsContent value="privacidad" className="mt-4">
          <PrivacidadTab apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} isAdmin={isAdmin} />
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}
