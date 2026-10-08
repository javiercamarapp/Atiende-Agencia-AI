// @vitest-environment jsdom
//
// «Entrega en curso» (UNI-R1): MapaEntrega + MapaLeaflet con Leaflet SIMULADO (vi.mock): sin red ni tiles. Se afirma lo que el original promete:
// insignia «Simulado», placeholder sin pedido, marcador REAL de la sucursal + cliente y repartidor simulados con sus tooltips, encuadre, animacion solo
// en camino, estado vacio sin coordenadas y que los textos del cliente nunca entran como HTML.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapaEntrega } from "../src/verticals/restaurantes/components/pedidos/MapaEntrega.tsx";
import { CICLO_ANIMACION_MS, DESPLAZAMIENTO_CLIENTE_SIMULADO, progresoIdaYVuelta } from "../src/verticals/restaurantes/components/pedidos/MapaLeaflet.tsx";
import type { OrderSummary } from "../src/verticals/restaurantes/lib/orders-client.ts";
import { esperarHasta, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

interface Marcador {
  readonly latlng: [number, number];
  readonly clase: string;
  tooltip: HTMLElement | string | null;
  removido: boolean;
  setLatLng: ReturnType<typeof vi.fn>;
}
const marcadores: Marcador[] = [];
const fitBounds = vi.fn();
const mapaRemove = vi.fn();
const tileLayer = vi.fn();

vi.mock("leaflet", () => {
  const L = {
    map: () => {
      const m = { setView: () => m, fitBounds: (...a: unknown[]) => fitBounds(...a), remove: () => mapaRemove() };
      return m;
    },
    tileLayer: (url: string, opts: unknown) => {
      tileLayer(url, opts);
      return { addTo: () => undefined };
    },
    divIcon: (o: { html: string }) => ({ html: o.html }),
    latLngBounds: (pts: unknown) => ({ pts }),
    marker: (latlng: [number, number], o: { icon: { html: string } }) => {
      const mk: Marcador & { addTo: () => unknown; bindTooltip: (t: HTMLElement | string) => unknown; remove: () => void } = {
        latlng,
        clase: o.icon.html,
        tooltip: null,
        removido: false,
        setLatLng: vi.fn(),
        addTo: () => mk,
        bindTooltip: (t) => {
          mk.tooltip = t;
          return mk;
        },
        remove: () => {
          mk.removido = true;
        },
      };
      marcadores.push(mk);
      return mk;
    },
  };
  return { default: L };
});

let rendered: RenderedComponent | undefined;
let rafCallbacks: Array<(t: number) => void> = [];

beforeEach(() => {
  marcadores.length = 0;
  fitBounds.mockClear();
  mapaRemove.mockClear();
  tileLayer.mockClear();
  rafCallbacks = [];
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const PEDIDO: OrderSummary = {
  id: "ord-1",
  propertyId: "prop-1",
  branch: "Centro",
  customerId: null,
  customerName: "Marisol Pech",
  customerPhone: "5511112222",
  customerAddress: "Calle 60 #412, Centro",
  total: 286,
  status: "pending",
  items: [],
  source: "whatsapp",
  notes: null,
  paymentMethod: null,
  createdAt: "2026-10-08T19:30:00.000Z",
  assignedRepartidorId: null,
  estimatedDeliveryAt: null,
  incidentNote: null,
};
const SUCURSAL = { nombre: "Sucursal Centro", lat: 20.9671, lng: -89.6237 };
const textoDe = (m: Marcador) => (typeof m.tooltip === "string" ? m.tooltip : m.tooltip?.textContent);

async function montar(order: OrderSummary | null, sucursal: typeof SUCURSAL | null = SUCURSAL, repartidor: string | null = null) {
  rendered = renderComponent(<MapaEntrega order={order} sucursal={sucursal} repartidorNombre={repartidor} />);
  if (order && sucursal && sucursal.lat !== null) await esperarHasta(() => marcadores.length === 3, "el mapa pinta sucursal, cliente y repartidor");
}

describe("MapaEntrega", () => {
  it("cabecera «Entrega en curso» con la insignia «Simulado» (nunca se quita)", async () => {
    await montar(null);
    const t = rendered!.container.textContent!;
    expect(t).toContain("Entrega en curso");
    expect(t).toContain("Simulado");
  });

  it("sin pedido: placeholder con el texto del original y ningun mapa (Leaflet ni se pide)", async () => {
    await montar(null);
    expect(rendered!.container.textContent).toContain("Selecciona un pedido de la lista para ver su entrega en el mapa");
    expect(rendered!.container.querySelector('[data-testid="mapa-entrega-leaflet"]')).toBeNull();
    expect(marcadores).toHaveLength(0);
  });

  it("con pedido: marcador REAL de la sucursal y cliente/repartidor simulados a ~900 m, con sus tooltips", async () => {
    await montar(PEDIDO, SUCURSAL, "Pedro Chan");
    const [sucursal, cliente, repartidor] = marcadores as [Marcador, Marcador, Marcador];
    expect(sucursal.latlng).toEqual([20.9671, -89.6237]);
    expect(sucursal.clase).toContain("pedido-pin-sucursal");
    expect(textoDe(sucursal)).toBe("Sucursal Centro");
    expect(cliente.latlng[0]).toBeCloseTo(20.9671 + DESPLAZAMIENTO_CLIENTE_SIMULADO.dLat, 6);
    expect(cliente.latlng[1]).toBeCloseTo(-89.6237 + DESPLAZAMIENTO_CLIENTE_SIMULADO.dLng, 6);
    expect(textoDe(cliente)).toBe("Calle 60 #412, Centro");
    expect(repartidor.latlng).toEqual([20.9671, -89.6237]);
    expect(textoDe(repartidor)).toBe("Pedro Chan");
    expect(fitBounds).toHaveBeenCalledTimes(1);
    // Tiles de OpenStreetMap, sin llave.
    expect(tileLayer.mock.calls[0]![0]).toBe("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
  });

  it("sin direccion del cliente el tooltip dice «Dirección del cliente (simulada)»; sin repartidor, «Repartidor»", async () => {
    await montar({ ...PEDIDO, customerAddress: null });
    expect(textoDe(marcadores[1]!)).toBe("Dirección del cliente (simulada)");
    expect(textoDe(marcadores[2]!)).toBe("Repartidor");
  });

  it("un texto con HTML del cliente se muestra como texto, nunca como marcado (tooltip por textContent)", async () => {
    await montar({ ...PEDIDO, customerAddress: '<img src=x onerror="alert(1)">' });
    const tip = marcadores[1]!.tooltip as HTMLElement;
    expect(tip.querySelector("img")).toBeNull();
    expect(tip.textContent).toBe('<img src=x onerror="alert(1)">');
  });

  it("pie sin enviar: «Aún no sale a reparto» y el repartidor NO se anima", async () => {
    await montar(PEDIDO);
    const t = rendered!.container.textContent!;
    expect(t).toContain("Marisol Pech");
    expect(t).toContain("Aún no sale a reparto — el repartidor se muestra en la sucursal");
    expect(t).toContain("La ubicación de la sucursal es real. La posición del repartidor y del cliente son simuladas — la integración con GPS en vivo se conecta más adelante.");
    expect(rafCallbacks).toHaveLength(0);
  });

  it("en camino: pie «posición simulada en tránsito» y el repartidor va y vuelve entre sucursal y cliente", async () => {
    await montar({ ...PEDIDO, status: "en_camino" }, SUCURSAL, "Pedro Chan");
    expect(rendered!.container.textContent).toContain("Pedro Chan — posición simulada en tránsito");
    expect(rafCallbacks.length).toBeGreaterThan(0);
    const repartidor = marcadores[2]!;
    const inicio = performance.now();
    await act(async () => {
      rafCallbacks[0]!(inicio + CICLO_ANIMACION_MS / 2); // a medio ciclo llego al cliente
    });
    const [lat, lng] = repartidor.setLatLng.mock.calls.at(-1)![0] as [number, number];
    expect(lat).toBeCloseTo(20.9671 + DESPLAZAMIENTO_CLIENTE_SIMULADO.dLat, 4);
    expect(lng).toBeCloseTo(-89.6237 + DESPLAZAMIENTO_CLIENTE_SIMULADO.dLng, 4);
  });

  it("sin lat/lng de la sucursal: estado vacio elegante con el aviso, sin Leaflet ni marcadores", async () => {
    await montar(PEDIDO, { nombre: "Sucursal Centro", lat: null as unknown as number, lng: null as unknown as number });
    const vacio = rendered!.container.querySelector('[data-testid="mapa-sin-ubicacion"]')!;
    expect(vacio.textContent).toContain("Esta sucursal aún no tiene ubicación en el mapa");
    expect(marcadores).toHaveLength(0);
    expect(rendered!.container.textContent).toContain("Simulado");
  });

  it("al cambiar de pedido se rehacen los marcadores (los anteriores se quitan) sin recrear el mapa", async () => {
    await montar(PEDIDO);
    rendered!.rerender(<MapaEntrega order={{ ...PEDIDO, id: "ord-2", customerAddress: "Calle 45 #210" }} sucursal={SUCURSAL} repartidorNombre={null} />);
    await esperarHasta(() => marcadores.length === 6, "se pintan los marcadores del segundo pedido");
    expect(marcadores.slice(0, 3).every((m) => m.removido)).toBe(true);
    expect(textoDe(marcadores[4]!)).toBe("Calle 45 #210");
    expect(mapaRemove).not.toHaveBeenCalled();
  });

  it("al desmontar se destruye el mapa", async () => {
    await montar(PEDIDO);
    rendered!.unmount();
    rendered = undefined;
    expect(mapaRemove).toHaveBeenCalled();
  });
});

describe("progresoIdaYVuelta", () => {
  it("ida en la primera mitad del ciclo y vuelta en la segunda, sin detenerse", () => {
    expect(progresoIdaYVuelta(0)).toBe(0);
    expect(progresoIdaYVuelta(CICLO_ANIMACION_MS / 4)).toBeCloseTo(0.5, 5);
    expect(progresoIdaYVuelta(CICLO_ANIMACION_MS / 2)).toBeCloseTo(1, 5);
    expect(progresoIdaYVuelta((CICLO_ANIMACION_MS * 3) / 4)).toBeCloseTo(0.5, 5);
    expect(progresoIdaYVuelta(CICLO_ANIMACION_MS * 2.25)).toBeCloseTo(0.5, 5);
  });
});
