// Mapa Leaflet + OpenStreetMap con UN pin arrastrable para ubicar la sucursal (portado del repo suelto: MapaSucursalEditable en
// SucursalesSection.tsx). Se carga con React.lazy desde UbicacionSucursal.tsx: Leaflet y su CSS viajan en un chunk aparte, nunca en la
// entrada. Arrastrar el pin o tocar el mapa avisa la nueva posicion; un cambio que llega de fuera (resultado de busqueda, coordenadas
// pegadas) mueve el pin y centra el mapa. Las teselas de OSM no llevan llave.
import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import type * as Leaflet from "leaflet";
import "./pedidos/mapa-entrega.css";
import { CENTRO_MERIDA, redondearCoordenada } from "../lib/geocodificar-client.ts";

export interface MapaPinSucursalProps {
  readonly lat: number | null;
  readonly lng: number | null;
  readonly onMover: (lat: number, lng: number) => void;
  /** Nombre accesible de la region del mapa (viene traducido). */
  readonly etiqueta: string;
}

export default function MapaPinSucursal({ lat, lng, onMover, etiqueta }: MapaPinSucursalProps) {
  const contenedor = useRef<HTMLDivElement>(null);
  const mapa = useRef<Leaflet.Map | null>(null);
  const marcador = useRef<Leaflet.Marker | null>(null);
  const onMoverRef = useRef(onMover);
  onMoverRef.current = onMover;
  // El ultimo punto que puso el propio mapa (arrastre/clic): al volver por props no se re-centra, para no interrumpir el gesto.
  const propio = useRef<string | null>(null);
  const [listo, setListo] = useState(false);
  const inicial = useRef({ lat, lng });

  useEffect(() => {
    let vivo = true;
    void (async () => {
      const L = (await import("leaflet")).default;
      if (!vivo || !contenedor.current) return;
      const { lat: la, lng: ln } = inicial.current;
      const centro: [number, number] = la !== null && ln !== null ? [la, ln] : [CENTRO_MERIDA.lat, CENTRO_MERIDA.lng];
      const m = L.map(contenedor.current, { zoomControl: true, attributionControl: true }).setView(centro, la !== null ? 16 : 12);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(m);
      const icono = L.divIcon({ className: "", html: '<div class="pedido-pin pedido-pin-sucursal">📍</div>', iconSize: [30, 30], iconAnchor: [15, 15] });
      const pin = L.marker(centro, { icon: icono, draggable: true, keyboard: true }).addTo(m);
      const avisar = (p: Leaflet.LatLng) => {
        const la = redondearCoordenada(p.lat);
        const ln = redondearCoordenada(p.lng);
        propio.current = `${la},${ln}`;
        onMoverRef.current(la, ln);
      };
      pin.on("dragend", () => avisar(pin.getLatLng()));
      m.on("click", (e: Leaflet.LeafletMouseEvent) => {
        pin.setLatLng(e.latlng);
        avisar(e.latlng);
      });
      mapa.current = m;
      marcador.current = pin;
      setListo(true);
    })();
    return () => {
      vivo = false;
      mapa.current?.stop();
      mapa.current?.remove();
      mapa.current = null;
      marcador.current = null;
    };
  }, []);

  useEffect(() => {
    const m = mapa.current;
    const pin = marcador.current;
    if (!listo || !m || !pin || lat === null || lng === null) return;
    if (propio.current === `${lat},${lng}`) return;
    pin.setLatLng([lat, lng]);
    m.setView([lat, lng], Math.max(m.getZoom(), 16), { animate: false });
  }, [listo, lat, lng]);

  return <div ref={contenedor} role="region" aria-label={etiqueta} data-testid="mapa-pin-sucursal" className="pedido-mapa h-56 overflow-hidden rounded-xl border border-border" />;
}
