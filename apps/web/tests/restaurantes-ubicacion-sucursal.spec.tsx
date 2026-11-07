// @vitest-environment jsdom
//
// Pin de sucursal: busqueda «dirección o colonia» por la API propia (nunca al proveedor desde el navegador), elegir un resultado mueve
// el pin, mover el pin sugiere la direccion del punto, 503 = aviso honesto (el mapa sigue), «mi ubicación» y su error.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UbicacionSucursal } from "../src/verticals/restaurantes/components/UbicacionSucursal.tsx";
import type { UbicacionSucursalProps } from "../src/verticals/restaurantes/components/UbicacionSucursal.tsx";
import { buscarDireccion, direccionDePunto, GeocodificacionNoDisponibleError } from "../src/verticals/restaurantes/lib/geocodificar-client.ts";
import { changeValue, click, flushMicrotasks, keydown, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}
async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await flushMicrotasks();
  });
}

const API = "https://api.test";
const BASE = `${API}/v1/restaurantes/prop-1/admin/geocodificar`;
const RESULTADO = { etiqueta: "Calle 60, Centro, Mérida, Yucatán", lat: 20.9671234567, lng: -89.6237 };

/** Mapa de prueba: muestra la posicion y un boton que simula arrastrar el pin. */
function MapaFalso({ lat, lng, onMover, etiqueta }: { lat: number | null; lng: number | null; onMover: (a: number, b: number) => void; etiqueta: string }) {
  return (
    <div role="region" aria-label={etiqueta} data-testid="mapa-falso">
      <span data-testid="pos">{lat === null ? "sin" : `${lat},${lng}`}</span>
      <button type="button" data-testid="arrastrar" onClick={() => onMover(21.01, -89.6)}>
        arrastrar
      </button>
    </div>
  );
}

function montar(fetchImpl: ReturnType<typeof vi.fn>, extra: Partial<UbicacionSucursalProps> = {}) {
  const onUbicar = vi.fn();
  const onUsarDireccion = vi.fn();
  rendered = renderComponent(
    <UbicacionSucursal
      apiBaseUrl={API}
      token="tok"
      propertyId="prop-1"
      idBase="b1"
      lat={null}
      lng={null}
      onUbicar={onUbicar}
      direccion=""
      onUsarDireccion={onUsarDireccion}
      fetchImpl={fetchImpl as unknown as typeof fetch}
      mapa={MapaFalso}
      {...extra}
    />,
  );
  return { onUbicar, onUsarDireccion, raiz: rendered.container };
}

describe("UbicacionSucursal", () => {
  it("busca por la API propia, lista resultados y al elegir uno ubica el pin (6 decimales) y ofrece usar la direccion", async () => {
    const fetchImpl = vi.fn(async () => json({ proveedor: "nominatim", resultados: [RESULTADO] }));
    const { onUbicar, onUsarDireccion, raiz } = montar(fetchImpl);
    const input = raiz.querySelector<HTMLInputElement>("#sucursal-buscar-b1")!;
    expect(input.placeholder).toBe("Buscar dirección o colonia…");
    changeValue(input, "calle 60 centro");
    keydown(input, "Enter");
    await esperar();
    expect(String(fetchImpl.mock.calls[0]![0 as never])).toBe(`${BASE}?q=calle%2060%20centro`);
    const boton = raiz.querySelector<HTMLButtonElement>("[data-testid='geocodificar-resultados'] button")!;
    expect(boton.textContent).toBe(RESULTADO.etiqueta);
    click(boton);
    await esperar();
    expect(onUbicar).toHaveBeenCalledWith(20.967123, -89.6237);
    expect(raiz.querySelector("[data-testid='geocodificar-resultados']")).toBeNull();
    click([...raiz.querySelectorAll("[data-testid='sugerencia-direccion'] button")][0]!);
    expect(onUsarDireccion).toHaveBeenCalledWith(RESULTADO.etiqueta);
  });

  it("texto corto: no llama a la API; sin resultados: lo dice", async () => {
    const fetchImpl = vi.fn(async () => json({ proveedor: "nominatim", resultados: [] }));
    const { raiz } = montar(fetchImpl);
    const input = raiz.querySelector<HTMLInputElement>("#sucursal-buscar-b1")!;
    changeValue(input, "ab");
    keydown(input, "Enter");
    await esperar();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(raiz.textContent).toContain("Escribe al menos 3 letras.");
    changeValue(input, "lugar que no existe");
    keydown(input, "Enter");
    await esperar();
    expect(raiz.textContent).toContain("No encontramos esa ubicación");
  });

  it("503 (sin configurar): aviso honesto con el texto del servidor; el buscador se oculta y el mapa sigue moviendo el pin sin pedir direccion", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "service_unavailable", message: "La búsqueda de direcciones no está disponible aún: requiere configurar GEOCODING_PROVIDER en la API." }, 503));
    const { onUbicar, raiz } = montar(fetchImpl);
    changeValue(raiz.querySelector<HTMLInputElement>("#sucursal-buscar-b1")!, "centro");
    keydown(raiz.querySelector<HTMLInputElement>("#sucursal-buscar-b1")!, "Enter");
    await esperar();
    expect(raiz.querySelector("[data-testid='geocodificacion-no-disponible']")!.textContent).toContain("GEOCODING_PROVIDER");
    expect(raiz.querySelector("#sucursal-buscar-b1")).toBeNull();
    click(raiz.querySelector("[data-testid='arrastrar']")!);
    await esperar();
    expect(onUbicar).toHaveBeenCalledWith(21.01, -89.6);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("arrastrar el pin pide la direccion del punto y la ofrece si es distinta a la escrita", async () => {
    const fetchImpl = vi.fn(async () => json({ proveedor: "google", etiqueta: "C. 62 500, Centro" }));
    const { onUbicar, raiz } = montar(fetchImpl, { direccion: "Otra" });
    click(raiz.querySelector("[data-testid='arrastrar']")!);
    await esperar();
    expect(onUbicar).toHaveBeenCalledWith(21.01, -89.6);
    expect(String(fetchImpl.mock.calls[0]![0 as never])).toBe(`${BASE}/inverso?lat=21.01&lng=-89.6`);
    expect(raiz.querySelector("[data-testid='sugerencia-direccion']")!.textContent).toContain("Dirección de ese punto: C. 62 500, Centro");
  });

  it("«Usar mi ubicación actual» mueve el pin; si el navegador niega el permiso lo dice", async () => {
    const fetchImpl = vi.fn(async () => json({ proveedor: "nominatim", etiqueta: null }));
    const ok: Geolocation = { getCurrentPosition: (exito: PositionCallback) => exito({ coords: { latitude: 20.5, longitude: -89.1 } } as GeolocationPosition) } as unknown as Geolocation;
    const { onUbicar, raiz } = montar(fetchImpl, { geolocalizacion: ok });
    const boton = [...raiz.querySelectorAll("button")].find((b) => b.textContent?.includes("Usar mi ubicación actual"))!;
    click(boton);
    await esperar();
    expect(onUbicar).toHaveBeenCalledWith(20.5, -89.1);
    rendered!.unmount();
    const negado: Geolocation = { getCurrentPosition: (_e: PositionCallback, fallo?: PositionErrorCallback | null) => fallo?.({} as GeolocationPositionError) } as unknown as Geolocation;
    const otro = montar(fetchImpl, { geolocalizacion: negado });
    click([...otro.raiz.querySelectorAll("button")].find((b) => b.textContent?.includes("Usar mi ubicación actual"))!);
    await esperar();
    expect(otro.raiz.textContent).toContain("revisa el permiso del navegador");
  });
});

describe("geocodificar-client", () => {
  it("filtra resultados malformados, 503 -> GeocodificacionNoDisponibleError, inverso vacio -> null", async () => {
    const ok = vi.fn(async () => json({ resultados: [RESULTADO, { etiqueta: 1, lat: 2, lng: 3 }, { etiqueta: "x", lat: "a", lng: 1 }] }));
    expect(await buscarDireccion(ok as unknown as typeof fetch, API, "tok", "prop-1", " centro ")).toEqual([RESULTADO]);
    const caido = vi.fn(async () => json({ error: { message: "no" } }, 503));
    await expect(buscarDireccion(caido as unknown as typeof fetch, API, "tok", "prop-1", "centro")).rejects.toBeInstanceOf(GeocodificacionNoDisponibleError);
    const vacio = vi.fn(async () => json({ etiqueta: "  " }));
    expect(await direccionDePunto(vacio as unknown as typeof fetch, API, "tok", "prop-1", 20, -89)).toBeNull();
  });
});
