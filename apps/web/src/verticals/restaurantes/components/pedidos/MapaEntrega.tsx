// Tarjeta «ENTREGA EN CURSO» (columna derecha de Pedidos): replica el MapaEntrega del repo suelto. El mapa Leaflet se carga bajo demanda
// (MapaLeaflet.tsx, chunk aparte). Sucursal REAL; cliente y repartidor SIMULADOS (insignia «Simulado» que nunca se quita).
import { lazy, Suspense } from "react";
import { MapPinOff, Bike, Package, Radar, User } from "lucide-react";
import { StatusBadge } from "@atiende/ui";
import type { OrderSummary } from "../../lib/orders-client.ts";
import "./mapa-entrega.css";

const MapaLeaflet = lazy(() => import("./MapaLeaflet.tsx"));

export interface SucursalMapa {
  readonly nombre: string;
  readonly lat: number | null;
  readonly lng: number | null;
}

const ALTO_MAPA = "h-[360px]";

export function MapaEntrega({ order, sucursal, repartidorNombre }: { readonly order: OrderSummary | null; readonly sucursal: SucursalMapa | null; readonly repartidorNombre: string | null }) {
  const enCamino = order?.status === "en_camino";
  const conUbicacion = sucursal !== null && sucursal.lat !== null && sucursal.lng !== null;
  const nombreRepartidor = repartidorNombre || "Repartidor";
  return (
    <div className="space-y-3 rounded-2xl border border-border bg-card p-4 xl:sticky xl:top-4" data-testid="mapa-entrega">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 font-mono text-eyebrow uppercase tracking-[0.08em] text-muted-foreground">
          <Radar className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Entrega en curso
        </p>
        <StatusBadge tone="warning" dot={false} className="px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide">
          Simulado
        </StatusBadge>
      </div>

      {!order ? (
        <div className={`${ALTO_MAPA} flex items-center justify-center rounded-xl border border-dashed border-border`}>
          <p className="px-6 text-center text-pill text-muted-foreground">Selecciona un pedido de la lista para ver su entrega en el mapa</p>
        </div>
      ) : !conUbicacion ? (
        <div role="status" data-testid="mapa-sin-ubicacion" className={`${ALTO_MAPA} flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border px-6 text-center`}>
          <MapPinOff className="h-10 w-10 text-muted-foreground/30" strokeWidth={1.5} aria-hidden="true" />
          <p className="text-ui text-foreground">Esta sucursal aún no tiene ubicación en el mapa</p>
          <p className="text-pill text-muted-foreground">Agrégala en Sucursales para ver aquí la entrega.</p>
        </div>
      ) : (
        <Suspense fallback={<div role="status" aria-busy="true" aria-label="Cargando el mapa" className={`${ALTO_MAPA} animate-pulse rounded-xl border border-border bg-canvas`} />}>
          <MapaLeaflet
            sucursal={{ nombre: sucursal.nombre, lat: sucursal.lat as number, lng: sucursal.lng as number }}
            direccionCliente={order.customerAddress}
            repartidorNombre={nombreRepartidor}
            enCamino={enCamino}
            pedidoId={order.id}
          />
        </Suspense>
      )}

      {order && (
        <div className="space-y-1.5 pt-1">
          <div className="flex items-center gap-1.5 text-xs text-foreground">
            <User className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
            {order.customerName}
          </div>
          {enCamino ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Bike className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              {repartidorNombre || "Repartidor asignado"} — posición simulada en tránsito
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Package className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              Aún no sale a reparto — el repartidor se muestra en la sucursal
            </div>
          )}
          <p className="pt-1 text-eyebrow leading-snug text-muted-foreground">
            La ubicación de la sucursal es real. La posición del repartidor y del cliente son simuladas — la integración con GPS en vivo se conecta más adelante.
          </p>
        </div>
      )}
    </div>
  );
}
