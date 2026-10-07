// @vitest-environment jsdom
//
// import-orig-13 — captura de coordenadas de sucursal en el panel: interpretación de lo pegado desde Google Maps,
// rechazo de puntos fuera de Yucatán, aviso de sucursal activa sin coordenadas y el PATCH real con lat/lng.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { SucursalesPage } from "../src/verticals/restaurantes/pages/Sucursales.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import type { BranchDetail } from "../src/verticals/restaurantes/lib/branches-client.ts";
import { esEnlaceCortoDeMaps, fueraDeYucatan, interpretarCoordenadasPegadas, leerCoordenada, urlVerEnMapa, validarPar } from "../src/verticals/restaurantes/lib/coordenadas.ts";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status: ok ? 200 : status, json: async () => body } as unknown as Response;
}

const CTX: RestaurantesShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "owner",
  staffFullName: "Gaby Demo",
  staffEmail: "gaby@example.com",
};

const SIN_COORDS: BranchDetail = { propertyId: "prop-1", name: "Sucursal Sin Pin", slug: "sin-pin", status: "active", phone: "9990000000", address: "Calle 1", lat: null, lng: null };
const CON_COORDS: BranchDetail = { propertyId: "prop-2", name: "Sucursal Con Pin", slug: "con-pin", status: "active", phone: null, address: null, lat: 21.0, lng: -89.6 };
const INACTIVA_SIN: BranchDetail = { propertyId: "prop-3", name: "Sucursal Cerrada", slug: "cerrada", status: "inactive", phone: null, address: null, lat: null, lng: null };

function stubFetch(branches: readonly BranchDetail[], opts: { patchError?: string; zona?: string | null } = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "https://api.test/v1/restaurantes/prop-1/admin/sucursales") return jsonResponse({ branches });
    if (method === "GET" && url === "https://api.test/v1/restaurantes/prop-1/admin/config/zona-horaria") return jsonResponse({ zonaHoraria: opts.zona ?? null });
    if (method === "PATCH" && url === "https://api.test/v1/restaurantes/prop-1/admin/sucursales/prop-1") {
      if (opts.patchError) return jsonResponse({ message: opts.patchError }, false, 400);
      const patch = JSON.parse(init!.body as string) as Partial<BranchDetail>;
      return jsonResponse({ branch: { ...SIN_COORDS, ...patch } });
    }
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(role = "owner"): RenderedComponent {
  return renderComponent(
    <MemoryRouter>
      <SucursalesPage {...CTX} role={role as RestaurantesShellContext["role"]} />
    </MemoryRouter>,
  );
}

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

const boton = (texto: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(texto));
const campo = (id: string) => rendered!.container.querySelector(`#${id}`) as HTMLInputElement;

async function abrirEdicion() {
  await act(async () => {
    click(boton("Editar")!);
  });
}

describe("interpretarCoordenadasPegadas", () => {
  it("lee '21.0280, -89.6100' con o sin espacio y entre paréntesis", () => {
    expect(interpretarCoordenadasPegadas("21.0280, -89.6100")).toEqual({ lat: 21.028, lng: -89.61 });
    expect(interpretarCoordenadasPegadas("  21.0280,-89.6100 ")).toEqual({ lat: 21.028, lng: -89.61 });
    expect(interpretarCoordenadasPegadas("(20.98, -89.63)")).toEqual({ lat: 20.98, lng: -89.63 });
  });

  it("lee una URL de Google Maps con @lat,lng", () => {
    expect(interpretarCoordenadasPegadas("https://www.google.com/maps/place/Taqueria/@21.0123,-89.6234,17z/data=!3m1")).toEqual({ lat: 21.0123, lng: -89.6234 });
  });

  it("prefiere el pin (!3d!4d) sobre el centro del mapa (@)", () => {
    const url = "https://www.google.com/maps/place/X/@21.0000,-89.6000,15z/data=!4m5!3m4!1s0x0:0x0!8m2!3d21.0456!4d-89.6789";
    expect(interpretarCoordenadasPegadas(url)).toEqual({ lat: 21.0456, lng: -89.6789 });
  });

  it("lee ?q=lat,lng y devuelve null con basura o vacío", () => {
    expect(interpretarCoordenadasPegadas("https://maps.google.com/?q=21.01,-89.62")).toEqual({ lat: 21.01, lng: -89.62 });
    expect(interpretarCoordenadasPegadas("Calle 60 x 55")).toBeNull();
    expect(interpretarCoordenadasPegadas("")).toBeNull();
    expect(interpretarCoordenadasPegadas("21.0280 -89.6100")).toBeNull();
  });
});

describe("validación de rango y formato", () => {
  it("acepta puntos de Yucatán y deja vacío como vacío", () => {
    expect(validarPar("21.0280", "-89.6100")).toEqual({ lat: 21.028, lng: -89.61, errorLat: null, errorLng: null });
    expect(validarPar("", "")).toEqual({ lat: null, lng: null, errorLat: null, errorLng: null });
  });

  it("rechaza lo que no es México: (0,0), ejes invertidos, signo perdido, otros países", () => {
    expect(validarPar("0", "0").errorLat).toContain("entre 14.5 y 32.8");
    expect(validarPar("0", "0").errorLng).toContain("entre -118.5 y -86.5");
    expect(validarPar("-89.61", "21.03").errorLat).not.toBeNull(); // invertidos
    expect(validarPar("21.03", "89.61").errorLng).toContain("signo menos");
    expect(validarPar("40.4", "-3.7").errorLat).not.toBeNull(); // Madrid
  });

  it("acepta puntos de otros estados de México (Cancún, Tijuana, Hermosillo)", () => {
    for (const [lat = "", lng = ""] of [["21.1619", "-86.8515"], ["32.5149", "-117.0382"], ["29.0729", "-110.9559"]]) {
      expect(validarPar(lat, lng)).toMatchObject({ errorLat: null, errorLng: null });
    }
  });

  it("fueraDeYucatan distingue Mérida de Cancún y Tijuana", () => {
    expect(fueraDeYucatan(21.0, -89.6)).toBe(false);
    expect(fueraDeYucatan(21.1619, -86.8515)).toBe(true);
    expect(fueraDeYucatan(32.5, -117.0)).toBe(true);
  });

  it("reconoce enlaces cortos de Google Maps", () => {
    expect(esEnlaceCortoDeMaps("https://maps.app.goo.gl/AbC123")).toBe(true);
    expect(esEnlaceCortoDeMaps("https://www.google.com/maps/@21,-89,17z")).toBe(false);
  });

  it("rechaza texto no numérico y coma decimal", () => {
    expect(leerCoordenada("21,03", "lat").error).toContain("punto decimal");
    expect(leerCoordenada("abc", "lng").error).toContain("punto decimal");
    expect(leerCoordenada("1e1", "lat").error).not.toBeNull();
  });

  it("exige latitud y longitud juntas", () => {
    expect(validarPar("21.03", "").errorLng).toContain("Falta la longitud");
    expect(validarPar("", "-89.6").errorLat).toContain("Falta la latitud");
  });

  it("el enlace al mapa solo existe con las dos coordenadas", () => {
    expect(urlVerEnMapa(21.03, -89.6)).toBe("https://www.google.com/maps?q=21.03,-89.6");
    expect(urlVerEnMapa(null, -89.6)).toBeNull();
  });
});

describe("SucursalesPage — coordenadas", () => {
  it("la zona horaria solo se pide al abrir la edición (no al cargar) y para ESA sucursal", async () => {
    stubFetch([SIN_COORDS]);
    rendered = renderPage();
    await esperar();
    const urls = () => fetchMock.mock.calls.map(([u]) => u as string);
    expect(urls().some((u) => u.includes("zona-horaria"))).toBe(false);
    await abrirEdicion();
    await esperar();
    expect(urls().filter((u) => u.includes("zona-horaria"))).toEqual(["https://api.test/v1/restaurantes/prop-1/admin/config/zona-horaria"]);
  });

  it("avisa de las sucursales ACTIVAS sin coordenadas (no de las inactivas ni de las que ya tienen)", async () => {
    stubFetch([SIN_COORDS, CON_COORDS, INACTIVA_SIN]);
    rendered = renderPage();
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Sucursal activa sin coordenadas");
    const aviso = texto.match(/Sucursal activa sin coordenadas[^]*?por distancia/)?.[0] ?? "";
    expect(aviso).toContain("Sucursal Sin Pin");
    expect(aviso).not.toContain("Sucursal Con Pin");
    expect(aviso).not.toContain("Sucursal Cerrada");
    expect(texto).toContain("Sin coordenadas"); // insignia en la ficha
  });

  it("sin sucursales activas sin pin no aparece el aviso y se muestra el enlace al mapa", async () => {
    stubFetch([CON_COORDS, INACTIVA_SIN]);
    rendered = renderPage();
    await esperar();
    expect(rendered.container.textContent).not.toContain("Sucursal activa sin coordenadas");
    expect(rendered.container.textContent).toContain("21, -89.6");
    const a = rendered.container.querySelector("a[href^='https://www.google.com/maps']") as HTMLAnchorElement;
    expect(a.href).toBe("https://www.google.com/maps?q=21,-89.6");
    expect(a.rel).toContain("noopener");
  });

  it("pegar '21.0280, -89.6100' llena los campos, muestra 'Ver en el mapa' y guarda lat/lng en el PATCH", async () => {
    stubFetch([SIN_COORDS]);
    rendered = renderPage();
    await esperar();
    await abrirEdicion();

    await act(async () => changeValue(campo("sucursal-pegar-prop-1"), "21.0280, -89.6100"));
    await act(async () => {
      click(boton("Pegar de Google Maps")!);
      await flushMicrotasks();
    });
    expect(campo("sucursal-lat-prop-1").value).toBe("21.028");
    expect(campo("sucursal-lng-prop-1").value).toBe("-89.61");
    expect(rendered.container.querySelector("fieldset a[href='https://www.google.com/maps?q=21.028,-89.61']")).not.toBeNull();

    await act(async () => {
      click(boton("Guardar")!);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(call[1].body as string)).toEqual({ phone: "9990000000", address: "Calle 1", lat: 21.028, lng: -89.61 });
  });

  it("pegar una URL de Google Maps con @lat,lng llena los campos", async () => {
    stubFetch([SIN_COORDS]);
    rendered = renderPage();
    await esperar();
    await abrirEdicion();
    await act(async () => changeValue(campo("sucursal-pegar-prop-1"), "https://www.google.com/maps/@21.0123,-89.6234,17z"));
    await act(async () => {
      click(boton("Pegar de Google Maps")!);
      await flushMicrotasks();
    });
    expect(campo("sucursal-lat-prop-1").value).toBe("21.0123");
    expect(campo("sucursal-lng-prop-1").value).toBe("-89.6234");
  });

  it("texto que no es un punto: error visible y los campos no cambian", async () => {
    stubFetch([SIN_COORDS]);
    rendered = renderPage();
    await esperar();
    await abrirEdicion();
    await act(async () => changeValue(campo("sucursal-pegar-prop-1"), "Calle 60 x 55"));
    await act(async () => {
      click(boton("Pegar de Google Maps")!);
      await flushMicrotasks();
    });
    expect(rendered.container.textContent).toContain("No reconocí coordenadas");
    expect(campo("sucursal-lat-prop-1").value).toBe("");
  });

  it("portapapeles bloqueado: mensaje honesto, sin romper", async () => {
    stubFetch([SIN_COORDS]);
    vi.stubGlobal("navigator", { clipboard: { readText: async () => { throw new Error("denegado"); } } });
    rendered = renderPage();
    await esperar();
    await abrirEdicion();
    await act(async () => {
      click(boton("Pegar de Google Maps")!);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(rendered.container.textContent).toContain("no dejó leer el portapapeles");
  });

  it("un punto fuera de México se rechaza: error ligado al campo por aria-describedby, Guardar no manda PATCH", async () => {
    stubFetch([SIN_COORDS]);
    rendered = renderPage();
    await esperar();
    await abrirEdicion();
    await act(async () => {
      changeValue(campo("sucursal-lat-prop-1"), "0");
      changeValue(campo("sucursal-lng-prop-1"), "0");
    });
    await act(async () => click(boton("Guardar")!));
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("La latitud debe estar entre 14.5 y 32.8");
    expect(texto).toContain("La longitud debe estar entre -118.5 y -86.5");
    const lat = campo("sucursal-lat-prop-1");
    expect(lat.getAttribute("aria-invalid")).toBe("true");
    const err = rendered.container.querySelector(`#${lat.getAttribute("aria-describedby")!.split(" ").pop()}`)!;
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.textContent).toContain("La latitud");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("no anuncia el error mientras se escribe: aparece al salir del campo", async () => {
    stubFetch([SIN_COORDS]);
    rendered = renderPage();
    await esperar();
    await abrirEdicion();
    await act(async () => changeValue(campo("sucursal-lat-prop-1"), "2"));
    expect(rendered.container.querySelector("[role='alert']")).toBeNull();
    await act(async () => {
      campo("sucursal-lat-prop-1").dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(rendered.container.textContent).toContain("La latitud debe estar entre");
  });

  it("Cancún se acepta y se guarda; con zona America/Merida solo hay un aviso no bloqueante", async () => {
    stubFetch([SIN_COORDS], { zona: "America/Merida" });
    rendered = renderPage();
    await esperar();
    await abrirEdicion();
    await act(async () => {
      changeValue(campo("sucursal-lat-prop-1"), "21.1619");
      changeValue(campo("sucursal-lng-prop-1"), "-86.8515");
    });
    expect(rendered.container.textContent).toContain("Este punto queda fuera de Yucatán: confirma que es el pin correcto.");
    await act(async () => {
      click(boton("Guardar")!);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(call[1].body as string)).toMatchObject({ lat: 21.1619, lng: -86.8515 });
  });

  it("con otra zona horaria (Tijuana) no hay aviso de Yucatán", async () => {
    stubFetch([SIN_COORDS], { zona: "America/Tijuana" });
    rendered = renderPage();
    await esperar();
    await abrirEdicion();
    await act(async () => {
      changeValue(campo("sucursal-lat-prop-1"), "32.5149");
      changeValue(campo("sucursal-lng-prop-1"), "-117.0382");
    });
    expect(rendered.container.textContent).not.toContain("fuera de Yucatán");
  });

  it("enlace corto maps.app.goo.gl: mensaje claro sin intentar resolverlo", async () => {
    stubFetch([SIN_COORDS]);
    rendered = renderPage();
    await esperar();
    await abrirEdicion();
    await act(async () => changeValue(campo("sucursal-pegar-prop-1"), "https://maps.app.goo.gl/AbC123"));
    await act(async () => {
      click(boton("Pegar de Google Maps")!);
      await flushMicrotasks();
    });
    expect(rendered.container.textContent).toContain("enlace corto de Google Maps");
    expect(campo("sucursal-lat-prop-1").value).toBe("");
  });

  it("solo un eje capturado: error y sin PATCH", async () => {
    stubFetch([SIN_COORDS]);
    rendered = renderPage();
    await esperar();
    await abrirEdicion();
    await act(async () => changeValue(campo("sucursal-lat-prop-1"), "21.03"));
    expect(rendered.container.textContent).not.toContain("Falta la longitud"); // aún no llega al campo
    await act(async () => click(boton("Guardar")!));
    expect(rendered.container.textContent).toContain("Falta la longitud");
    expect(document.activeElement).toBe(campo("sucursal-lng-prop-1"));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("guardar sin tocar las coordenadas NO manda lat/lng (compatibilidad con la ficha anterior)", async () => {
    stubFetch([CON_COORDS], {});
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return jsonResponse({ branches: [{ ...CON_COORDS, propertyId: "prop-1" }] });
      return jsonResponse({ branch: { ...CON_COORDS, propertyId: "prop-1" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await esperar();
    await abrirEdicion();
    expect(campo("sucursal-lat-prop-1").value).toBe("21");
    await act(async () => {
      click(boton("Guardar")!);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(call[1].body as string)).toEqual({ phone: null, address: null });
  });

  it("vaciar los dos campos de una sucursal con pin manda lat/lng null", async () => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return jsonResponse({ branches: [{ ...CON_COORDS, propertyId: "prop-1" }] });
      return jsonResponse({ branch: { ...CON_COORDS, propertyId: "prop-1", lat: null, lng: null } });
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await esperar();
    await abrirEdicion();
    await act(async () => {
      changeValue(campo("sucursal-lat-prop-1"), "");
      changeValue(campo("sucursal-lng-prop-1"), "");
    });
    await act(async () => {
      click(boton("Guardar")!);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(call[1].body as string)).toMatchObject({ lat: null, lng: null });
  });

  it("una sucursal con un punto viejo fuera de rango sigue pudiendo editar teléfono sin tocar las coordenadas", async () => {
    const vieja: BranchDetail = { ...SIN_COORDS, lat: 19.43, lng: -99.13 };
    stubFetch([vieja]);
    rendered = renderPage();
    await esperar();
    await abrirEdicion();
    expect(rendered.container.textContent).not.toContain("La latitud debe estar entre");
    await act(async () => changeValue(campo("sucursal-telefono-prop-1"), "9991112222"));
    await act(async () => {
      click(boton("Guardar")!);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(call[1].body as string)).toEqual({ phone: "9991112222", address: "Calle 1" });
  });

  it("si la API rechaza el guardado, el error se muestra y la edición sigue abierta", async () => {
    stubFetch([SIN_COORDS], { patchError: "lat: se esperaba una coordenada" });
    rendered = renderPage();
    await esperar();
    await abrirEdicion();
    await act(async () => {
      changeValue(campo("sucursal-lat-prop-1"), "21.03");
      changeValue(campo("sucursal-lng-prop-1"), "-89.6");
    });
    await act(async () => {
      click(boton("Guardar")!);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(rendered.container.textContent).toContain("lat:");
    expect(campo("sucursal-lat-prop-1")).not.toBeNull();
  });

  it("permisos: un rol sin 'sucursal.editar' ve el aviso y las coordenadas pero NO el botón Editar", async () => {
    stubFetch([SIN_COORDS]);
    rendered = renderPage("staff");
    await esperar();
    expect(boton("Editar")).toBeUndefined();
    expect(rendered.container.textContent).toContain("Sucursal activa sin coordenadas");
    expect(rendered.container.textContent).toContain("Pídele al dueño");
  });
});
