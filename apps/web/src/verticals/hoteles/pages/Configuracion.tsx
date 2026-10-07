// H-P3-04 -- Configuracion del hotel: impuestos, politica de cancelacion, sobreventa y tarifas, mas la bitacora de cambios. Cada pestana
// llama a un endpoint real (apps/api/.../hoteles/configuracion.ts: owner/gm escriben, accountant lee). La pestana activa vive en `?tab=`
// para que "Primeros pasos" enlace directo a la que falta.
import { useSearchParams } from "react-router-dom";
import { PageContainer, Tabs, TabsContent, TabsList, TabsTrigger } from "@atiende/ui";
import { BitacoraTab } from "../components/configuracion/BitacoraTab.tsx";
import { CancelacionTab } from "../components/configuracion/CancelacionTab.tsx";
import { ImpuestosTab } from "../components/configuracion/ImpuestosTab.tsx";
import { SobreventaTab } from "../components/configuracion/SobreventaTab.tsx";
import { TarifasTab } from "../components/configuracion/TarifasTab.tsx";
import { CONFIGURACION_ESCRITURA_ROLES, CONFIGURACION_ROLES } from "../lib/configuracion-client.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

const PESTANAS = ["impuestos", "cancelacion", "sobreventa", "tarifas", "bitacora"] as const;
type Pestana = (typeof PESTANAS)[number];

export function ConfiguracionPage({ apiBaseUrl, token, propertyId, role }: HotelesShellContext) {
  const [params, setParams] = useSearchParams();
  const puedeEscribir = CONFIGURACION_ESCRITURA_ROLES.has(role);
  const pedida = params.get("tab");
  const activa: Pestana = PESTANAS.includes(pedida as Pestana) && (pedida !== "bitacora" || puedeEscribir) ? (pedida as Pestana) : "impuestos";

  if (!CONFIGURACION_ROLES.has(role)) {
    return (
      <PageContainer padding="none" className="gap-4">
        <h1 className="sr-only">Configuración</h1>
        <p className="m-0 text-sm text-muted-foreground">La configuración del hotel está reservada al propietario, al gerente general y a contabilidad (solo lectura).</p>
      </PageContainer>
    );
  }
  const props = { apiBaseUrl, token, propertyId, puedeEscribir };

  return (
    <PageContainer padding="none" className="gap-4">
      <h1 className="sr-only">Configuración</h1>
      <Tabs value={activa} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
        <TabsList>
          <TabsTrigger value="impuestos">Impuestos</TabsTrigger>
          <TabsTrigger value="cancelacion">Política de cancelación</TabsTrigger>
          <TabsTrigger value="sobreventa">Sobreventa</TabsTrigger>
          <TabsTrigger value="tarifas">Tarifas</TabsTrigger>
          {puedeEscribir && <TabsTrigger value="bitacora">Bitácora</TabsTrigger>}
        </TabsList>
        <TabsContent value="impuestos" className="mt-4">
          <ImpuestosTab {...props} />
        </TabsContent>
        <TabsContent value="cancelacion" className="mt-4">
          <CancelacionTab {...props} />
        </TabsContent>
        <TabsContent value="sobreventa" className="mt-4">
          <SobreventaTab {...props} />
        </TabsContent>
        <TabsContent value="tarifas" className="mt-4">
          <TarifasTab {...props} />
        </TabsContent>
        {puedeEscribir && (
          <TabsContent value="bitacora" className="mt-4">
            <BitacoraTab {...props} />
          </TabsContent>
        )}
      </Tabs>
    </PageContainer>
  );
}
