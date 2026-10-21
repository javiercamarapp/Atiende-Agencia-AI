// Viajes del panel movil del operador (PLAN-PANEL-OPERADOR §5). ANDAMIAJE: pantalla vacia y honesta que el paquete B reemplaza completa.
// Mientras tanto no hay controles ni datos de ejemplo: solo explica que la funcion aun no esta activa.
import { EstadoVacio, PageContainer } from "@atiende/ui";
import { Hourglass } from "lucide-react";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

export function OperacionViajesPage(_contexto: RestaurantesShellContext) {
  return (
    <PageContainer padding="none">
      <h1 className="sr-only">Viajes</h1>
      <EstadoVacio icon={Hourglass} titulo="Viajes" mensaje="No disponible aún: el despacho de pedidos a choferes se activa cuando el servidor del panel del operador esté listo." />
    </PageContainer>
  );
}
