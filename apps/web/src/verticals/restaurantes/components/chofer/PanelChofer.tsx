// Contenedor de la pantalla del chofer (fuera del shell de gestion): «En camino», «Historial del dia» y «Mi perfil». Usa el ambito visual de restaurantes
// (UNI-R0b). Mientras la primera lista nueva no responda bien se muestra `legado` (la vista anterior, sin parpadeo); si el servidor aun no tiene las rutas
// (501/no_implementado/404) se queda en `legado`. «Historial del dia» (efectivo a rendir y lo entregado, endpoint vivo `repartidor/historial-dia`) se
// conserva tal cual hasta que «Hoy» del servidor nuevo cubra el mismo cuadre.
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { PageContainer, Tabs, TabsContent, TabsList, TabsTrigger, useAmbitoVertical } from "@atiende/ui";
import { HistorialDiaTab, MiPerfilTab } from "../RepartidorPestanas.tsx";
import { MisEntregas } from "./MisEntregas.tsx";
import type { MisEntregasProps } from "./MisEntregas.tsx";

export interface PanelChoferProps extends Omit<MisEntregasProps, "onNoDisponible" | "onListaLista"> {
  /** Vista anterior del chofer: se muestra hasta que la lista nueva responda bien y para siempre si el servidor no tiene las rutas. */
  readonly legado: ReactNode;
}

type Modo = "probando" | "nuevo" | "legado";

export function PanelChofer({ legado, ...conexion }: PanelChoferProps) {
  useAmbitoVertical("restaurantes");
  const [modo, setModo] = useState<Modo>("probando");
  const alNoDisponible = useCallback(() => setModo("legado"), []);
  const alListaLista = useCallback(() => setModo((m) => (m === "legado" ? m : "nuevo")), []);

  if (modo === "legado") return <>{legado}</>;

  const panel = (
    <div className="min-h-screen bg-background" hidden={modo !== "nuevo"}>
      <PageContainer padding="default" className="mx-auto max-w-2xl gap-4">
        <h1 className="m-0 font-display text-xl font-semibold text-foreground">Mis entregas</h1>
        <Tabs defaultValue="entregas" className="flex flex-col gap-3">
          <TabsList>
            <TabsTrigger value="entregas">En camino</TabsTrigger>
            <TabsTrigger value="historial">Historial del día</TabsTrigger>
            <TabsTrigger value="perfil">Mi perfil</TabsTrigger>
          </TabsList>
          <TabsContent value="entregas" className="mt-0">
            <MisEntregas {...conexion} onNoDisponible={alNoDisponible} onListaLista={alListaLista} />
          </TabsContent>
          <TabsContent value="historial" className="mt-0">
            <HistorialDiaTab apiBaseUrl={conexion.apiBaseUrl} token={conexion.token} propertyId={conexion.propertyId} {...(conexion.fetchImpl ? { fetchImpl: conexion.fetchImpl } : {})} />
          </TabsContent>
          <TabsContent value="perfil" className="mt-0">
            <MiPerfilTab apiBaseUrl={conexion.apiBaseUrl} token={conexion.token} propertyId={conexion.propertyId} />
          </TabsContent>
        </Tabs>
      </PageContainer>
    </div>
  );

  // Probando: la vista anterior es la visible y el panel nuevo corre oculto solo para consultar la lista.
  return (
    <>
      {modo === "probando" && legado}
      {panel}
    </>
  );
}
