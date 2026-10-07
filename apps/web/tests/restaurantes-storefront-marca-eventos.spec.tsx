// @vitest-environment jsdom
//
// R-38 / R-43: portada de marca, promociones, boton flotante de WhatsApp, redes y Open Graph del storefront; formulario publico de
// eventos (validacion, honeypot, exito, error del servidor) y seccion "Sitio publico" del panel (cargar, editar, guardar, errores,
// base sin migrar). La App real renderiza las rutas /pedir/...; la red es simulada.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { SitioPublicoSeccion } from "../src/verticals/restaurantes/pages/SitioPublicoSeccion.tsx";
import { EVENTO_VACIO, validarEvento } from "../src/verticals/restaurantes/storefront/EventosPage.tsx";
import { condicionesDe, textoDias } from "../src/verticals/restaurantes/storefront/PromocionesSeccion.tsx";
import { enlaceWhatsappSeguro } from "../src/verticals/restaurantes/storefront/BotonWhatsapp.tsx";
import { imagenOgValida } from "../src/verticals/restaurantes/storefront/meta-publica.ts";
import { hayCambios, formDesdeMarca, marcaDesdeForm } from "../src/verticals/restaurantes/lib/sitio-publico-client.ts";
import { textoMotivoCallback } from "../src/verticals/restaurantes/lib/conversaciones-client.ts";
import { changeValue, click, esperarRutaCargada, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
let respuestaEvento: ((init?: RequestInit) => Response) | undefined;

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}
async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await flushMicrotasks();
  });
  // R-37: las pantallas de la App son chunks lazy; espera a que termine el estado de carga de pantalla.
  await esperarRutaCargada(document.body);
}
async function renderEn(ruta: string): Promise<RenderedComponent> {
  window.history.pushState({}, "", ruta);
  const r = renderComponent(<App />);
  await esperarRutaCargada(r.container);
  return r;
}
const texto = () => rendered!.container.textContent ?? "";
const meta = (clave: string, atributo = "property") => document.head.querySelector(`meta[${atributo}="${clave}"]`)?.getAttribute("content") ?? null;
const campo = (etiqueta: string) => {
  const label = Array.from(rendered!.container.querySelectorAll("label")).find((l) => (l.textContent ?? "").startsWith(etiqueta));
  return rendered!.container.querySelector(`#${label?.getAttribute("for")}`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
};

const WA = "https://wa.me/529991234567?text=Hola%2C%20quiero%20informaci%C3%B3n%20de%20Centro.";
const CENTRO = { slug: "centro", name: "Centro", address: "Calle 1 #100", phone: "999 123 4567", whatsappUrl: WA, abiertoAhora: true, cierraA: "01:00", proximaApertura: null, pedidoMinimoDomicilio: 200, pedidoMinimoRecoger: null, propinaPolitica: null, zonasReparto: [] };
const NORTE = { ...CENTRO, slug: "norte", name: "Norte", whatsappUrl: "https://wa.me/529997654321?text=Hola" };
const MARCA = { titular: "Tacos con historia", eslogan: "Desde 1980", about: "Somos de Mérida", portadaUrl: "https://cdn.example.com/portada.jpg", logoUrl: "https://cdn.example.com/logo.png", instagramUrl: "https://instagram.com/lostaquitos", facebookUrl: null, tiktokUrl: null };
const MARCA_VACIA = { titular: null, eslogan: null, about: null, portadaUrl: null, logoUrl: null, instagramUrl: null, facebookUrl: null, tiktokUrl: null };
const PROMO = { id: "p1", nombre: "Lunes 2x1", descripcion: "En tacos al pastor", beneficio: "2x1", canal: "recoger", pedidoMinimo: null, dias: [1], horaInicio: null, horaFin: null, vigenteHasta: "2026-12-31T23:59:00Z", sucursales: ["centro"] };

function restaurante(over: Record<string, unknown> = {}) {
  return { restaurante: { slug: "demo", nombre: "Los Taquitos de PM" }, sucursales: [CENTRO], marca: MARCA, promociones: [PROMO], ...over };
}

beforeEach(() => {
  fetchMock = vi.fn();
  respuestaEvento = undefined;
  vi.stubGlobal("fetch", fetchMock);
  globalThis.sessionStorage.clear();
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
  for (const m of Array.from(document.head.querySelectorAll("meta"))) m.remove();
});

describe("pagina del restaurante: portada de marca, promociones, WhatsApp y OG", () => {
  it("muestra titular, eslogan, descripcion, imagen de portada con tamano y carga prioritaria, logo diferido y redes con rel seguro", async () => {
    fetchMock.mockResolvedValue(json(restaurante()));
    rendered = await renderEn("/pedir/demo");
    await esperar();
    expect(texto()).toContain("Tacos con historia");
    expect(texto()).toContain("Desde 1980");
    expect(texto()).toContain("Somos de Mérida");
    const portada = rendered.container.querySelector<HTMLImageElement>('img[src="https://cdn.example.com/portada.jpg"]')!;
    expect(portada.getAttribute("width")).toBe("1200");
    expect(portada.getAttribute("fetchpriority")).toBe("high");
    expect(portada.getAttribute("loading")).toBeNull();
    const logo = rendered.container.querySelector<HTMLImageElement>('main img[src="https://cdn.example.com/logo.png"]')!;
    expect(logo.getAttribute("loading")).toBe("lazy");
    const ig = Array.from(rendered.container.querySelectorAll("a")).find((a) => a.getAttribute("href") === "https://instagram.com/lostaquitos")!;
    expect(ig.getAttribute("rel")).toBe("noopener noreferrer");
    expect(ig.getAttribute("target")).toBe("_blank");
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain("http://localhost:8787/v1/restaurantes/demo/storefront");
  });

  it("lista las promociones con sus condiciones reales (solo recoger, dia, vigencia, sucursal) y la sucursal sigue disponible", async () => {
    fetchMock.mockResolvedValue(json(restaurante()));
    rendered = await renderEn("/pedir/demo");
    await esperar();
    const t = texto();
    expect(t).toContain("Promociones");
    expect(t).toContain("2x1");
    expect(t).toContain("En tacos al pastor");
    expect(t).toContain("Solo al recoger en la sucursal");
    expect(t).toContain("Solo el lunes");
    expect(t).toContain("hasta el 31/12/2026");
    expect(t).toContain("en Centro");
    expect(t).toContain("Ver menú y pedir en Centro");
  });

  it("sin promociones no aparece la seccion; sin marca la portada es generica con el nombre (nada inventado) y sin imagenes", async () => {
    fetchMock.mockResolvedValue(json(restaurante({ marca: MARCA_VACIA, promociones: [] })));
    rendered = await renderEn("/pedir/demo");
    await esperar();
    expect(texto()).not.toContain("Promociones");
    expect(texto()).toContain("Pide en Los Taquitos de PM");
    expect(rendered.container.querySelectorAll("main img")).toHaveLength(0);
  });

  it("un servidor anterior a R-38 (sin marca ni promociones) sigue mostrando las sucursales", async () => {
    fetchMock.mockResolvedValue(json({ restaurante: { slug: "demo", nombre: "Los Taquitos de PM" }, sucursales: [CENTRO] }));
    rendered = await renderEn("/pedir/demo");
    await esperar();
    expect(texto()).toContain("Ver menú y pedir en Centro");
    expect(texto()).toContain("Pide en Los Taquitos de PM");
  });

  it("con UNA sucursal con numero: boton flotante a wa.me de esa sucursal; sin numero valido no hay boton", async () => {
    fetchMock.mockResolvedValue(json(restaurante()));
    rendered = await renderEn("/pedir/demo");
    await esperar();
    const wa = rendered.container.querySelector<HTMLAnchorElement>('[data-testid="boton-whatsapp"]')!;
    expect(wa.getAttribute("href")).toBe(WA);
    expect(wa.getAttribute("rel")).toBe("noopener noreferrer");
    rendered.unmount();
    fetchMock.mockResolvedValue(json(restaurante({ sucursales: [{ ...CENTRO, whatsappUrl: null }] })));
    rendered = await renderEn("/pedir/demo");
    await esperar();
    expect(rendered.container.querySelector('[data-testid="boton-whatsapp"]')).toBeNull();
  });

  it("con VARIAS sucursales no hay flotante ambiguo: cada tarjeta trae su enlace de WhatsApp", async () => {
    fetchMock.mockResolvedValue(json(restaurante({ sucursales: [CENTRO, NORTE] })));
    rendered = await renderEn("/pedir/demo");
    await esperar();
    expect(rendered.container.querySelector('[data-testid="boton-whatsapp"]')).toBeNull();
    const enlaces = Array.from(rendered.container.querySelectorAll("a")).filter((a) => (a.textContent ?? "").startsWith("Escribir por WhatsApp"));
    expect(enlaces.map((a) => a.getAttribute("href"))).toEqual([WA, "https://wa.me/529997654321?text=Hola"]);
  });

  it("publica Open Graph (titulo, descripcion, tipo e imagen https) y lo retira al salir", async () => {
    fetchMock.mockResolvedValue(json(restaurante()));
    rendered = await renderEn("/pedir/demo");
    await esperar();
    expect(meta("og:title")).toBe("Tacos con historia · Los Taquitos de PM");
    expect(meta("og:description")).toBe("Somos de Mérida");
    expect(meta("og:type")).toBe("website");
    expect(meta("og:image")).toBe("https://cdn.example.com/portada.jpg");
    expect(meta("robots", "name")).toBe("index,follow");
    rendered.unmount();
    rendered = undefined;
    expect(meta("og:title")).toBeNull();
  });

  it("la pagina de la sucursal muestra el boton flotante de ESA sucursal y el pie enlaza eventos y redes", async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).endsWith("/menu") ? json({ sucursal: CENTRO, categorias: [], marca: MARCA }) : json({}, 404)));
    rendered = await renderEn("/pedir/demo/centro");
    await esperar();
    expect(rendered.container.querySelector('[data-testid="boton-whatsapp"]')!.getAttribute("href")).toBe(WA);
    expect(Array.from(rendered.container.querySelectorAll("footer a")).map((a) => a.getAttribute("href"))).toEqual(["/pedir/demo/sucursales", "/pedir/demo/eventos", "/pedir/demo/privacidad", "https://instagram.com/lostaquitos"]);
    expect(meta("og:image")).toBe("https://cdn.example.com/portada.jpg");
  });

  it("rastreo y checkout siguen noindex (la meta de la pagina de rastreo no cambia)", async () => {
    fetchMock.mockResolvedValue(json({ disponible: true, pedido: { status: "pending", branch: "Centro", total: 10, paymentMethod: "efectivo", canal: "recoger", createdAt: "2026-10-03T10:00:00Z", items: [] } }));
    rendered = await renderEn("/pedir/demo/pedido/tok");
    await esperar();
    expect(meta("robots", "name")).toBe("noindex,nofollow");
  });
});

describe("ayudas puras", () => {
  it("enlaceWhatsappSeguro solo deja pasar wa.me con numero; imagenOgValida solo https", () => {
    expect(enlaceWhatsappSeguro(WA)).toBe(WA);
    for (const mala of ["http://wa.me/529991234567", "https://evil.example.com/529991234567", "javascript:alert(1)", "https://wa.me/12", null, undefined]) expect(enlaceWhatsappSeguro(mala as string | null)).toBeNull();
    expect(imagenOgValida("https://a.example/x.jpg")).toBe("https://a.example/x.jpg");
    for (const mala of ["http://a.example/x.jpg", "data:image/png;base64,AA", "//a.example/x.jpg", null]) expect(imagenOgValida(mala)).toBeNull();
  });
  it("textoDias y condicionesDe describen la regla tal cual la evalua el motor", () => {
    expect(textoDias(null)).toBeNull();
    expect(textoDias([0, 1, 2, 3, 4, 5, 6])).toBeNull();
    expect(textoDias([1, 3])).toBe("lunes y miércoles");
    expect(textoDias([1, 3, 5])).toBe("lunes, miércoles y viernes");
    const c = condicionesDe({ ...PROMO, dias: null, vigenteHasta: null, sucursales: null, horaInicio: "12:00:00", horaFin: "18:00:00", pedidoMinimo: 150 } as never, [CENTRO]);
    expect(c).toEqual(["Solo al recoger en la sucursal", "de 12:00 a 18:00", "pedido mínimo $150"]);
  });
  it("el motivo 'evento' se muestra legible en la bandeja de contactos", () => {
    expect(textoMotivoCallback("evento")).toBe("Evento o catering");
    expect(textoMotivoCallback("escalada:queja")).toBe("Escalada: queja");
  });
});

describe("formulario publico de eventos (R-43)", () => {
  const HOY = "2026-10-03";
  const ok = { ...EVENTO_VACIO, nombre: "Ana", telefono: "999 123 4567", fechaEvento: "2026-11-15", personas: "40", sucursal: "centro", acepta: true };

  it("validarEvento: acepta un formulario completo y senala cada campo faltante", () => {
    expect(validarEvento(ok, HOY)).toEqual({});
    expect(Object.keys(validarEvento(EVENTO_VACIO, HOY)).sort()).toEqual(["acepta", "fechaEvento", "nombre", "personas", "sucursal", "telefono"]);
    expect(validarEvento({ ...ok, fechaEvento: "2026-10-02" }, HOY).fechaEvento).toMatch(/ya pasó/);
    expect(validarEvento({ ...ok, personas: "0" }, HOY).personas).toBeDefined();
    expect(validarEvento({ ...ok, personas: "2001" }, HOY).personas).toBeDefined();
    expect(validarEvento({ ...ok, personas: "4.5" }, HOY).personas).toBeDefined();
    expect(validarEvento({ ...ok, telefono: "+52 1 999 123 4567" }, HOY)).toEqual({});
  });

  async function abrir() {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/storefront/eventos")) return respuestaEvento?.(init) ?? json({ recibido: true });
      return json(restaurante({ sucursales: [CENTRO, NORTE] }));
    });
    rendered = await renderEn("/pedir/demo/eventos");
    await esperar();
  }
  const llenar = () => {
    changeValue(campo("Nombre"), "Ana Pérez");
    changeValue(campo("Teléfono"), "999 123 4567");
    changeValue(campo("Fecha del evento"), "2099-11-15");
    changeValue(campo("Personas"), "40");
    changeValue(campo("Sucursal"), "centro");
    changeValue(campo("Comentario"), "Boda, mesa de tacos");
    click(rendered!.container.querySelector('input[type="checkbox"]')!);
  };
  const formulario = () => rendered!.container.querySelector("form")!;
  const peticionesEvento = () => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/storefront/eventos"));

  it("la ruta /pedir/:org/eventos no se confunde con una sucursal; sin llenar nada muestra errores y NO envia", async () => {
    await abrir();
    expect(texto()).toContain("Eventos y catering");
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain("http://localhost:8787/v1/restaurantes/demo/storefront");
    await submitForm(formulario());
    expect(texto()).toContain("Escribe tu nombre.");
    expect(texto()).toContain("Elige la sucursal.");
    expect(texto()).toContain("Debes aceptar el aviso de privacidad.");
    expect(peticionesEvento()).toHaveLength(0);
  });

  it("envio completo: POST con los campos exactos, honeypot vacio, exito honesto y el formulario se retira", async () => {
    await abrir();
    llenar();
    await submitForm(formulario());
    const [llamada] = peticionesEvento();
    expect(llamada![1]!.method).toBe("POST");
    expect(JSON.parse(String(llamada![1]!.body))).toEqual({ nombre: "Ana Pérez", telefono: "999 123 4567", fechaEvento: "2099-11-15", personas: 40, sucursal: "centro", comentario: "Boda, mesa de tacos", aceptaAviso: true, sitio_web: "" });
    expect(texto()).toContain("Recibimos tu solicitud");
    expect(rendered!.container.querySelector("form")).toBeNull();
  });

  it("el campo trampa es invisible para quien usa la pagina (fuera de pantalla, sin foco, oculto a lectores) y viaja tal cual si un bot lo llena", async () => {
    await abrir();
    const trampa = rendered!.container.querySelector<HTMLInputElement>('input[name="sitio_web"]')!;
    expect(trampa.tabIndex).toBe(-1);
    expect(trampa.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(trampa.closest(".sr-only")).not.toBeNull();
    llenar();
    changeValue(trampa, "http://spam.example.com");
    await submitForm(formulario());
    expect(JSON.parse(String(peticionesEvento()[0]![1]!.body)).sitio_web).toBe("http://spam.example.com");
  });

  it("error del servidor (400/429): se muestra el mensaje real, el formulario y lo escrito se conservan para reintentar", async () => {
    await abrir();
    respuestaEvento = () => json({ code: "validation_error", message: "La fecha del evento ya pasó." }, 400);
    llenar();
    await submitForm(formulario());
    expect(rendered!.container.querySelector('[role="alert"]')!.textContent).toContain("La fecha del evento ya pasó.");
    expect(campo("Nombre").value).toBe("Ana Pérez");
    respuestaEvento = () => json({}, 429);
    await submitForm(formulario());
    expect(rendered!.container.querySelector('[role="alert"]')!.textContent).toContain("Demasiados intentos");
  });

  it("restaurante sin sucursales: estado vacio honesto, sin formulario", async () => {
    fetchMock.mockResolvedValue(json(restaurante({ sucursales: [] })));
    rendered = await renderEn("/pedir/demo/eventos");
    await esperar();
    expect(texto()).toContain("Sin sucursales disponibles");
    expect(rendered.container.querySelector("form")).toBeNull();
  });

  it("falla de red al cargar: error con reintento", async () => {
    fetchMock.mockRejectedValue(new Error("sin red"));
    rendered = await renderEn("/pedir/demo/eventos");
    await esperar();
    expect(texto()).toContain("No pudimos conectar con el restaurante");
    expect(texto()).toContain("Reintentar");
  });
});

describe("Configuracion > Sitio publico (R-38)", () => {
  const WIRE = { marca: { ...MARCA, updatedAt: "2026-10-03T10:00:00Z" }, guardada: true };
  function montar(escritura?: (init: RequestInit) => Response, lectura: unknown = WIRE) {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.test/v1/restaurantes/prop-1/admin/config/sitio-publico");
      if (init?.method === "PUT") return escritura ? escritura(init) : json(WIRE);
      return json(lectura);
    });
    rendered = renderComponent(<SitioPublicoSeccion apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" nombreRestaurante="Los Taquitos de PM" />);
  }
  const guardar = () => Array.from(rendered!.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Guardar sitio público")) as HTMLButtonElement;

  it("carga lo vigente, lo pinta en el formulario y en la vista previa (el mismo componente de la pagina publica); guardar apagado sin cambios", async () => {
    montar();
    await esperar();
    expect(campo("Titular").value).toBe("Tacos con historia");
    expect(campo("Instagram").value).toBe("https://instagram.com/lostaquitos");
    expect(texto()).toContain("Publicado");
    expect(rendered!.container.querySelector('[data-testid="portada-marca"]')!.textContent).toContain("Desde 1980");
    expect(guardar().disabled).toBe(true);
    // Dentro del panel la vista previa no es el titulo de la pagina: el panel ya tiene su <h1> (un solo <h1> por pantalla).
    expect(rendered!.container.querySelectorAll("h1")).toHaveLength(0);
    expect(rendered!.container.querySelector('[data-testid="portada-marca"] h2')!.textContent).toBe("Tacos con historia");
  });

  it("la vista previa del panel no agrega un <h1> (la pagina de Configuracion ya tiene el suyo): el titular es <h2>", async () => {
    montar();
    await esperar();
    const portada = rendered!.container.querySelector('[data-testid="portada-marca"]')!;
    expect(portada.querySelector("h1")).toBeNull();
    expect(portada.querySelector("h2")!.textContent).toBe("Tacos con historia");
  });

  it("editar actualiza la vista previa en vivo y guarda por PUT con vacios como null; luego muestra 'Guardado'", async () => {
    montar();
    await esperar();
    changeValue(campo("Titular"), "Nuevo titular");
    changeValue(campo("Instagram"), "");
    expect(rendered!.container.querySelector('[data-testid="portada-marca"]')!.textContent).toContain("Nuevo titular");
    expect(guardar().disabled).toBe(false);
    await submitForm(rendered!.container.querySelector("form")!);
    const put = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "PUT")!;
    expect(JSON.parse(String((put[1] as RequestInit).body))).toEqual({ ...MARCA, titular: "Nuevo titular", instagramUrl: null });
    expect(texto()).toContain("Guardado");
  });

  it("error de validacion del servidor (400): se muestra el mensaje real y lo escrito se conserva", async () => {
    montar(() => json({ code: "validation_error", message: "imagen de portada: escribe un enlace https válido a la imagen." }, 400));
    await esperar();
    changeValue(campo("Imagen de portada"), "http://inseguro.example.com/a.jpg");
    await submitForm(rendered!.container.querySelector("form")!);
    expect(texto()).toContain("escribe un enlace https válido");
    expect(campo("Imagen de portada").value).toBe("http://inseguro.example.com/a.jpg");
    expect(texto()).not.toContain("Guardado");
  });

  it("base sin migrar: sin marca guardada se ofrece el formulario vacio; guardar con 503 muestra el motivo, no un fallo mudo", async () => {
    montar(() => json({ code: "service_unavailable", message: "El sitio público todavía no se puede editar: falta aplicar una actualización de la base de datos." }, 503), { marca: MARCA_VACIA, guardada: false });
    await esperar();
    expect(texto()).toContain("Sin personalizar");
    changeValue(campo("Titular"), "X");
    await submitForm(rendered!.container.querySelector("form")!);
    expect(texto()).toContain("falta aplicar una actualización");
  });

  it("falla al cargar: error con reintento", async () => {
    fetchMock.mockResolvedValue(json({ message: "boom" }, 500));
    rendered = renderComponent(<SitioPublicoSeccion apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" />);
    await esperar();
    expect(rendered.container.textContent).toMatch(/boom|No se pudo cargar|No pudimos/);
  });

  it("formDesdeMarca/marcaDesdeForm/hayCambios: ida y vuelta sin perder ni inventar campos", () => {
    const f = formDesdeMarca({ ...MARCA, updatedAt: "x" });
    expect(marcaDesdeForm(f)).toEqual(MARCA);
    expect(hayCambios(f, f)).toBe(false);
    expect(hayCambios(f, { ...f, eslogan: "  otro " })).toBe(true);
    expect(hayCambios(f, { ...f, eslogan: `${f.eslogan}  ` })).toBe(false);
  });
});
