// Pin de sucursal: geocodificacion del lado del servidor. Rutas (rol, validacion, 503 sin proveedor, proveedor caido) y adaptadores
// Nominatim / Google con `fetch` inyectado (sesgo a Mexico/Yucatan, contacto de la politica de OSM, la llave nunca en la respuesta).
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { GeocodificacionFallidaError, crearGeocodificador, leerConfigGeocodificacion } from "../src/geocodificacion.ts";
import type { Geocodificador } from "../src/geocodificacion.ts";
import { authedGet, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

function falso(over: Partial<Geocodificador> = {}): Geocodificador {
  return {
    proveedor: "nominatim",
    buscar: vi.fn(async () => [{ etiqueta: "Calle 60, Centro, Mérida, Yucatán", lat: 20.9671, lng: -89.6237 }]),
    inverso: vi.fn(async () => "Calle 60 491, Centro, Mérida"),
    ...over,
  };
}

async function montar(geocodificador: Geocodificador | null) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const app = buildApp({ ...ctx.deps, geocodificador });
  return { ctx, app, url: `/v1/restaurantes/${ctx.propertyIdA}/admin/geocodificar` };
}

describe("GET .../admin/geocodificar", () => {
  it("owner busca y recibe resultados del proveedor (texto normalizado)", async () => {
    const geo = falso();
    const { ctx, app, url } = await montar(geo);
    const res = await app.request(`${url}?q=${encodeURIComponent("  calle 60   centro ")}`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ proveedor: "nominatim", resultados: [{ etiqueta: "Calle 60, Centro, Mérida, Yucatán", lat: 20.9671, lng: -89.6237 }] });
    expect(geo.buscar).toHaveBeenCalledWith("calle 60 centro");
  });

  it("sin proveedor configurado -> 503 honesto que nombra la variable", async () => {
    const { ctx, app, url } = await montar(null);
    const res = await app.request(`${url}?q=centro`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toContain("GEOCODING_PROVIDER");
  });

  it("staff y repartidor -> 403 (es la misma accion que editar la sucursal); sin token -> 401", async () => {
    const geo = falso();
    const { ctx, app, url } = await montar(geo);
    for (const quien of [ctx.staff.staffSucursalA, ctx.staff.repartidor]) {
      expect((await app.request(`${url}?q=centro`, authedGet(quien.token))).status).toBe(403);
    }
    expect((await app.request(`${url}?q=centro`)).status).toBe(401);
    expect(geo.buscar).not.toHaveBeenCalled();
  });

  it("q demasiado corto o largo -> 400 sin llamar al proveedor", async () => {
    const geo = falso();
    const { ctx, app, url } = await montar(geo);
    expect((await app.request(`${url}?q=ab`, authedGet(ctx.staff.owner.token))).status).toBe(400);
    expect((await app.request(`${url}?q=${"x".repeat(201)}`, authedGet(ctx.staff.owner.token))).status).toBe(400);
    expect(geo.buscar).not.toHaveBeenCalled();
  });

  it("proveedor caido -> 503 con salida (pegar coordenadas), nunca 500", async () => {
    const { ctx, app, url } = await montar(falso({ buscar: async () => Promise.reject(new GeocodificacionFallidaError("caido")) }));
    const res = await app.request(`${url}?q=centro`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toContain("pega las coordenadas");
  });
});

describe("GET .../admin/geocodificar/inverso", () => {
  it("devuelve la direccion del punto (coordenadas redondeadas a 6 decimales)", async () => {
    const geo = falso();
    const { ctx, app, url } = await montar(geo);
    const res = await app.request(`${url}/inverso?lat=20.96712345&lng=-89.6237`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ proveedor: "nominatim", etiqueta: "Calle 60 491, Centro, Mérida" });
    expect(geo.inverso).toHaveBeenCalledWith(20.967123, -89.6237);
  });

  it("coordenadas invalidas -> 400", async () => {
    const { ctx, app, url } = await montar(falso());
    for (const q of ["lat=91&lng=-89", "lat=21&lng=-181", "lat=abc&lng=-89", "lng=-89"]) {
      expect((await app.request(`${url}/inverso?${q}`, authedGet(ctx.staff.owner.token))).status).toBe(400);
    }
  });
});

describe("configuracion y adaptadores", () => {
  it("leerConfigGeocodificacion: apagada por omision; nominatim exige un correo de contacto; google exige llave", () => {
    expect(leerConfigGeocodificacion({})).toBeNull();
    expect(leerConfigGeocodificacion({ GEOCODING_PROVIDER: "nominatim" })).toBeNull();
    expect(leerConfigGeocodificacion({ GEOCODING_PROVIDER: "nominatim", GEOCODING_CONTACT_EMAIL: "ops@example.com" })).toEqual({ proveedor: "nominatim", contacto: "ops@example.com", urlBase: "https://nominatim.openstreetmap.org" });
    expect(leerConfigGeocodificacion({ GEOCODING_PROVIDER: "nominatim", GEOCODING_CONTACT_EMAIL: "ops@example.com", GEOCODING_BASE_URL: "http://inseguro" })).toMatchObject({ urlBase: "https://nominatim.openstreetmap.org" });
    expect(leerConfigGeocodificacion({ GEOCODING_PROVIDER: "google" })).toBeNull();
    expect(leerConfigGeocodificacion({ GEOCODING_PROVIDER: "google", GEOCODING_API_KEY: "k" })).toEqual({ proveedor: "google", llave: "k" });
    expect(leerConfigGeocodificacion({ GEOCODING_PROVIDER: "otro", GEOCODING_API_KEY: "k" })).toBeNull();
  });

  it("nominatim: sesgo a Mexico/Yucatan, contacto y User-Agent; descarta resultados sin coordenadas validas", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify([{ display_name: "Centro, Mérida", lat: "20.97", lon: "-89.62" }, { display_name: "Roto", lat: "x", lon: "1" }]), { status: 200 }),
    );
    const geo = crearGeocodificador({ proveedor: "nominatim", contacto: "ops@example.com", urlBase: "https://nominatim.openstreetmap.org" }, fetchImpl as unknown as typeof fetch)!;
    expect(await geo.buscar("centro merida")).toEqual([{ etiqueta: "Centro, Mérida", lat: 20.97, lng: -89.62 }]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain("countrycodes=mx");
    expect(url).toContain("viewbox=-90.4,21.7,-86.7,17.8");
    expect(url).toContain("email=ops%40example.com");
    expect(url).toContain("q=centro%20merida");
    expect((init!.headers as Record<string, string>)["User-Agent"]).toMatch(/^Atiende/);
  });

  it("google: llave solo en la URL del servidor, ZERO_RESULTS = vacio, otro status = error del proveedor", async () => {
    const respuestas = [
      { status: "OK", results: [{ formatted_address: "C. 60, Centro, Mérida, Yuc.", geometry: { location: { lat: 20.97, lng: -89.62 } } }] },
      { status: "ZERO_RESULTS", results: [] },
      { status: "REQUEST_DENIED" },
    ];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(respuestas.shift()), { status: 200 }));
    const geo = crearGeocodificador({ proveedor: "google", llave: "llave-secreta" }, fetchImpl as unknown as typeof fetch)!;
    expect(await geo.buscar("centro")).toEqual([{ etiqueta: "C. 60, Centro, Mérida, Yuc.", lat: 20.97, lng: -89.62 }]);
    expect(String(fetchImpl.mock.calls[0]![0 as never])).toContain("components=country:MX");
    expect(await geo.buscar("nada")).toEqual([]);
    await expect(geo.buscar("x")).rejects.toBeInstanceOf(GeocodificacionFallidaError);
  });

  it("HTTP de error o red caida -> GeocodificacionFallidaError", async () => {
    const http = crearGeocodificador({ proveedor: "google", llave: "k" }, (async () => new Response("no", { status: 500 })) as unknown as typeof fetch)!;
    await expect(http.inverso(20, -89)).rejects.toBeInstanceOf(GeocodificacionFallidaError);
    const red = crearGeocodificador({ proveedor: "nominatim", contacto: "a@b.co", urlBase: "https://n.example" }, (async () => Promise.reject(new TypeError("red"))) as unknown as typeof fetch)!;
    await expect(red.buscar("centro")).rejects.toBeInstanceOf(GeocodificacionFallidaError);
  });
});
