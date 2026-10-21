// Contenedor de la pantalla del chofer (fuera del shell de gestion): «Mis entregas», «Hecho hoy» y «Mi perfil». Usa el ambito visual de restaurantes
// (UNI-R0b) como el resto del producto. Si el servidor aun no tiene las rutas del panel (501), muestra `legado`: la vista anterior, para que el chofer
// nunca se quede sin su pantalla mientras el backend se despliega.
import { useState } from "react";
import type { ReactNode } from "react";
import { PageContainer, Tabs, TabsContent, TabsList, TabsTrigger, useAmbitoVertical } from "@atiende/ui";
import { MiPerfilTab } from "../RepartidorPestanas.tsx";
import { HechoHoy } from "./HechoHoy.tsx";
import { MisEntregas } from "./MisEntregas.tsx";
import type { MisEntregasProps } from "./MisEntregas.tsx";

export interface PanelChoferProps extends Omit<MisEntregasProps, "onNoDisponible"> {
  /** Vista anterior del chofer, que se muestra tal cual si el servidor no tiene aun las rutas nuevas. */
  readonly legado: ReactNode;
}

export function PanelChofer({ legado, ...conexion }: PanelChoferProps) {
  useAmbitoVertical("restaurantes");
  const [sinRutas, setSinRutas] = useState(false);
  if (sinRutas) return <>{legado}</>;

  return (
    <div className="min-h-screen bg-background">
      <PageContainer padding="default" className="mx-auto max-w-2xl gap-4">
        <h1 className="m-0 font-display text-xl font-semibold text-foreground">Mis entregas</h1>
        <Tabs defaultValue="entregas" className="flex flex-col gap-3">
          <TabsList>
            <TabsTrigger value="entregas">En camino</TabsTrigger>
            <TabsTrigger value="hoy">Hecho hoy</TabsTrigger>
            <TabsTrigger value="perfil">Mi perfil</TabsTrigger>
          </TabsList>
          <TabsContent value="entregas" className="mt-0">
            <MisEntregas {...conexion} onNoDisponible={() => setSinRutas(true)} />
          </TabsContent>
          <TabsContent value="hoy" className="mt-0">
            <HechoHoy apiBaseUrl={conexion.apiBaseUrl} token={conexion.token} propertyId={conexion.propertyId} {...(conexion.fetchImpl ? { fetchImpl: conexion.fetchImpl } : {})} />
          </TabsContent>
          <TabsContent value="perfil" className="mt-0">
            <MiPerfilTab apiBaseUrl={conexion.apiBaseUrl} token={conexion.token} propertyId={conexion.propertyId} />
          </TabsContent>
        </Tabs>
      </PageContainer>
    </div>
  );
}
