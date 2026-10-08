// Mapa Leaflet + OpenStreetMap (sin llave) del tablero de Pedidos. Se carga con React.lazy desde MapaEntrega.tsx (chunk aparte, igual que
// superadmin/cerebro/Calles.tsx): Leaflet y su CSS no entran al bundle de las demas pantallas.
//
// Marcador de la SUCURSAL = real (lat/lng de la sucursal). El CLIENTE (desplazamiento fijo de ~900 m) y el REPARTIDOR (va y vuelve entre la
// sucursal y el cliente mientras el pedido va en camino) son SIMULADOS: no hay geocodificacion de direcciones ni GPS del repartidor todavia.
// Por eso MapaEntrega muestra siempre la insignia «Simulado».
import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import type * as Leaflet from "leaflet";

/** Desplazamiento fijo (~900 m) usado como «zona del cliente» simulada: no hay lat/lng real del cliente. */
export const DESPLAZAMIENTO_CLIENTE_SIMULADO = { dLat: 0.0065, dLng: 0.006 } as const;
/** Ciclo completo de ida y vuelta del repartidor simulado. */
export const CICLO_ANIMACION_MS = 26_000;
/** Centro inicial (Merida), el mismo del original; `fitBounds` lo reemplaza en cuanto hay sucursal. */
const CENTRO_INICIAL: [number, number] = [20.98, -89.62];

export interface MapaLeafletProps {
  readonly sucursal: { readonly nombre: string; readonly lat: number; readonly lng: number };
  /** Tooltip del cliente; sin direccion, «Dirección del cliente (simulada)». */
  readonly direccionCliente: string | null;
  readonly repartidorNombre: string;
  /** Solo en camino se anima el repartidor; en cualquier otro estado queda en la sucursal. */
  readonly enCamino: boolean;
  /** Cambia al seleccionar otro pedido (reinicia la animacion). */
  readonly pedidoId: string;
}

/** Posicion simulada del repartidor para un progreso 0..1 del ciclo (ida hasta 0.5, vuelta despues). */
export function progresoIdaYVuelta(transcurridoMs: number): number {
  const crudo = (transcurridoMs % CICLO_ANIMACION_MS) / CICLO_ANIMACION_MS;
  return crudo <= 0.5 ? crudo * 2 : 2 - crudo * 2;
}

function conTexto(texto: string): HTMLElement {
  // Nunca innerHTML con datos del cliente: bindTooltip(string) interpreta HTML.
  const el = document.createElement("span");
  el.textContent = texto;
  return el;
}

export default function MapaLeaflet({ sucursal, direccionCliente, repartidorNombre, enCamino, pedidoId }: MapaLeafletProps) {
  const contenedor = useRef<HTMLDivElement>(null);
  const lib = useRef<typeof Leaflet | null>(null);
  const mapa = useRef<Leaflet.Map | null>(null);
  const [listo, setListo] = useState(false);

  // El mapa se crea una vez.
  useEffect(() => {
    let vivo = true;
    void (async () => {
      const L = (await import("leaflet")).default;
      if (!vivo || !contenedor.current) return;
      lib.current = L;
      const m = L.map(contenedor.current, { zoomControl: true, attributionControl: true }).setView(CENTRO_INICIAL, 12);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(m);
      mapa.current = m;
      setListo(true);
    })();
    return () => {
      vivo = false;
      mapa.current?.remove();
      mapa.current = null;
      setListo(false);
    };
  }, []);

  // Marcadores y animacion: se rehacen al cambiar el pedido, la sucursal o el estado.
  useEffect(() => {
    const L = lib.current;
    const m = mapa.current;
    if (!listo || !L || !m) return;
    const origen: [number, number] = [sucursal.lat, sucursal.lng];
    const destino: [number, number] = [origen[0] + DESPLAZAMIENTO_CLIENTE_SIMULADO.dLat, origen[1] + DESPLAZAMIENTO_CLIENTE_SIMULADO.dLng];
    const pin = (clase: string, emoji: string, tam: number) => L.divIcon({ className: "", html: `<div class="pedido-pin ${clase}">${emoji}</div>`, iconSize: [tam, tam], iconAnchor: [tam / 2, tam / 2] });

    const mSucursal = L.marker(origen, { icon: pin("pedido-pin-sucursal", "🏠", 30) }).addTo(m).bindTooltip(conTexto(sucursal.nombre), { direction: "top" });
    const mCliente = L.marker(destino, { icon: pin("pedido-pin-cliente", "📍", 26) }).addTo(m).bindTooltip(conTexto(direccionCliente || "Dirección del cliente (simulada)"), { direction: "top" });
    const mRepartidor = L.marker(origen, { icon: pin("pedido-pin-repartidor", "🛵", 32) }).addTo(m).bindTooltip(conTexto(repartidorNombre), { direction: "top" });
    m.fitBounds(L.latLngBounds([origen, destino]), { padding: [40, 40] });

    let raf: number | null = null;
    if (enCamino) {
      const inicio = performance.now();
      const animar = (t: number) => {
        const p = progresoIdaYVuelta(t - inicio);
        mRepartidor.setLatLng([origen[0] + (destino[0] - origen[0]) * p, origen[1] + (destino[1] - origen[1]) * p]);
        raf = requestAnimationFrame(animar);
      };
      raf = requestAnimationFrame(animar);
    }
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      mSucursal.remove();
      mCliente.remove();
      mRepartidor.remove();
    };
  }, [listo, pedidoId, sucursal.lat, sucursal.lng, sucursal.nombre, direccionCliente, repartidorNombre, enCamino]);

  return <div ref={contenedor} role="region" aria-label="Mapa de la entrega" data-testid="mapa-entrega-leaflet" className="pedido-mapa h-[360px] overflow-hidden rounded-xl border border-border" />;
}
