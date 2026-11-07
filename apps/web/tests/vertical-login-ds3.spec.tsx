// @vitest-environment jsdom
//
// ds3: inicio de sesion identico al de Rovaq AI en las 6 verticales (paleta de Atiende). Monta la PAGINA real de cada
// vertical con la bandera encendida y comprueba el orden de Rovaq, los metodos que Atiende ya tenia (Google, enlace por
// correo, ¿Olvidaste tu contraseña?), el copy por vertical en ES/EN, la espera de 60 s para reenviar y el tema claro.
import type { ReactElement } from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

vi.mock("@atiende/ui", async (importOriginal) => ({ ...(await importOriginal<typeof import("@atiende/ui")>()), DISENO_DS3: true }));

const iniciarMagicLink = vi.fn();
const verificarGoogle = vi.fn();
vi.mock("../src/lib/google-auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/google-auth.ts")>();
  return { ...actual, iniciarMagicLink: (...a: unknown[]) => iniciarMagicLink(...a), verificarGoogleConfigurado: (...a: unknown[]) => verificarGoogle(...a) };
});
// El canvas de particulas no corre en jsdom: se sustituye por su contenedor (el motor tiene sus propias pruebas en e2e).
vi.mock("../src/components/LoginArtwork.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/LoginArtwork.tsx")>();
  return { ...actual, LoginArtwork: () => <div className="login-artwork" data-shape="sphere" aria-hidden="true"><canvas /></div> };
});
vi.mock("../src/verticals/restaurantes/lib/login-telefono-client.ts", () => ({ consultarDisponibilidadLoginCelular: async () => false }));

const { CitasLoginPage } = await import("../src/verticals/citas/pages/Login.tsx");
const { DespachosLoginPage } = await import("../src/verticals/despachos/pages/Login.tsx");
const { HotelesLoginPage } = await import("../src/verticals/hoteles/pages/Login.tsx");
const { LicitacionesLoginPage } = await import("../src/verticals/licitaciones/pages/Login.tsx");
const { RentasLoginPage } = await import("../src/verticals/rentas/pages/Login.tsx");
const { RestaurantesLoginPage } = await import("../src/verticals/restaurantes/pages/Login.tsx");
const { COPIA_LOGIN_DS3 } = await import("../src/components/login-ds3-copia.ts");
const { ESPERA_REENVIO_S } = await import("../src/components/VerticalLoginDs3.tsx");

const API = "https://api.test";
const noop = () => undefined;
const PAGINAS: ReadonlyArray<readonly [string, () => ReactElement]> = [
  ["restaurantes", () => <RestaurantesLoginPage apiBaseUrl={API} onLoggedIn={noop} />],
  ["hoteles", () => <HotelesLoginPage apiBaseUrl={API} onLoggedIn={noop} />],
  ["rentas", () => <RentasLoginPage apiBaseUrl={API} onLoggedIn={noop} />],
  ["despachos", () => <DespachosLoginPage apiBaseUrl={API} onLoggedIn={noop} />],
  ["licitaciones", () => <LicitacionesLoginPage apiBaseUrl={API} onLoggedIn={noop} />],
  ["citas", () => <CitasLoginPage apiBaseUrl={API} onLoggedIn={noop} />],
];

let rendered: RenderedComponent | undefined;
let escritorio = true;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.useRealTimers();
  document.documentElement.classList.remove("dark");
  window.localStorage.clear();
});
beforeEach(() => {
  escritorio = true;
  iniciarMagicLink.mockReset();
  verificarGoogle.mockReset().mockResolvedValue(true);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (q: string) => ({ matches: q.includes("min-width: 1024px") ? escritorio : false, media: q, addEventListener: noop, removeEventListener: noop }),
  });
});

async function montar(pagina: () => ReactElement, ruta: string) {
  rendered = renderComponent(<MemoryRouter initialEntries={[ruta]}>{pagina()}</MemoryRouter>);
  await act(async () => {
    await flushMicrotasks();
  });
  return rendered.container;
}

const correo = (c: HTMLElement) => c.querySelector<HTMLInputElement>('input[type="email"]')!;
const botones = (c: HTMLElement) => [...c.querySelectorAll("button")];
const boton = (c: HTMLElement, texto: RegExp) => botones(c).find((b) => texto.test(b.textContent ?? ""))!;

describe.each(PAGINAS)("login ds3 · %s", (vertical, pagina) => {
  it("pinta la pantalla de Rovaq en su orden: marca + ES/EN, kicker, H1, bajada, Google, «o», correo, ayuda, invitacion y nota", async () => {
    const c = await montar(pagina, `/${vertical}/login`);
    const main = c.querySelector("main.login-ds3")!;
    expect(main).not.toBeNull();
    expect(main.getAttribute("data-vertical")).toBe(vertical);
    expect(c.querySelector(".login-editorial, .login-lamina")).toBeNull(); // el diseno de hoy no se mezcla
    expect(c.querySelectorAll("h1")).toHaveLength(1);
    expect(c.querySelector("h1")!.textContent).toBe(`Bienvenido a atiende ${vertical}`);
    expect(c.querySelector(".ld3-kicker")!.textContent).toBe("Acceso al panel");
    expect(c.querySelector(".ld3-idiomas")!.getAttribute("aria-label")).toBe("Idioma");

    const orden = [".ld3-marca", ".ld3-kicker", "h1", ".ld3-intro", ".ld3-divisor", ".ld3-google", ".ld3-separador", "form", ".ld3-ayuda", ".ld3-invitacion", ".ld3-nota"];
    const nodos = orden.map((s) => c.querySelector(s));
    nodos.forEach((n, i) => expect(n, orden[i]).not.toBeNull());
    for (let i = 1; i < nodos.length; i++) expect(nodos[i - 1]!.compareDocumentPosition(nodos[i]!) & Node.DOCUMENT_POSITION_FOLLOWING, `${orden[i - 1]} antes de ${orden[i]}`).toBeTruthy();

    expect(c.querySelector(".ld3-separador")!.textContent).toBe("o");
    expect(boton(c, /Continuar con Google/).className).toContain("login-btn-borde");
    const cta = c.querySelector<HTMLButtonElement>('form button[type="submit"]')!;
    expect(cta.className).toContain("login-btn-tinta");
    expect(cta.textContent).toContain("Continuar con correo");
    expect(c.querySelector(`label[for="${correo(c).id}"]`)!.textContent).toBe("Correo");
    expect(c.querySelector("details.ld3-ayuda summary")!.textContent).toBe("¿Necesitas ayuda para entrar?");
    expect(c.querySelector(".ld3-nota")!.textContent).toContain("Acceso reservado a equipos autorizados.");
    // Atiende conserva sus enlaces legales en la nota al pie.
    expect([...c.querySelectorAll(".ld3-nota a")].map((a) => a.getAttribute("href"))).toEqual(["/terminos", "/privacidad"]);
  });

  it("panel oscuro a la izquierda con el copy de la vertical y la esfera de particulas (solo en escritorio)", async () => {
    const c = await montar(pagina, `/${vertical}/login`);
    const copia = COPIA_LOGIN_DS3[vertical]!;
    const aside = c.querySelector("aside.ld3-visual")!;
    expect(aside.getAttribute("aria-label")).toBe(copia.kicker.es);
    expect(aside.querySelector(".login-story-surface")).not.toBeNull();
    expect(aside.querySelector("h2")!.textContent).toBe(copia.titulo.es);
    expect(aside.querySelector(".ld3-panel-descripcion")!.textContent).toBe(copia.descripcion.es);
    expect(aside.querySelector('.login-artwork[aria-hidden="true"] canvas')).not.toBeNull();
    // En el DOM el formulario va primero (orden de lectura y de teclado); la rejilla pone el panel en la columna 1 por CSS.
    expect(c.querySelector("section.ld3-columna")!.compareDocumentPosition(aside) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("en movil no monta el canvas de particulas", async () => {
    escritorio = false;
    const c = await montar(pagina, `/${vertical}/login`);
    expect(c.querySelector("canvas")).toBeNull();
    expect(correo(c)).not.toBeNull();
  });

  it("en ingles cambia todo el copy, incluido el del panel", async () => {
    const c = await montar(pagina, `/${vertical}/login?lang=en`);
    const copia = COPIA_LOGIN_DS3[vertical]!;
    expect(c.querySelector("main")!.getAttribute("lang")).toBe("en");
    expect(c.querySelector("h1")!.textContent).toBe(`Welcome to atiende ${copia.nombreEn}`);
    expect(c.querySelector(".ld3-intro")!.textContent).toBe(copia.introEn);
    expect(c.querySelector(".ld3-kicker")!.textContent).toBe("Workspace access");
    expect(c.querySelector("aside h2")!.textContent).toBe(copia.titulo.en);
    expect(c.querySelector(".ld3-separador")!.textContent).toBe("or");
    expect(c.querySelector(".ld3-invitacion")!.textContent).toContain("Ask your team for an invitation.");
    expect(c.querySelector('.ld3-idiomas button[aria-current="true"]')!.textContent).toBe("EN");
  });

  it("conserva «¿Olvidaste tu contraseña?» y abre el restablecer en la misma pantalla", async () => {
    const c = await montar(pagina, `/${vertical}/login`);
    click(boton(c, /¿Olvidaste tu contraseña\?/));
    expect(c.textContent).toContain("Restablece tu contraseña");
    expect(c.querySelector(".ld3-google")).toBeNull();
    click(boton(c, /Volver a iniciar sesión/));
    expect(c.querySelector(".ld3-google")).not.toBeNull();
  });
});

describe("login ds3 · comportamiento", () => {
  const citas = PAGINAS.find(([v]) => v === "citas")![1];

  it("enlace por correo: aviso en la ranura role=status y espera de 60 s antes de reenviar («Reintentar en N s»)", async () => {
    vi.useFakeTimers();
    iniciarMagicLink.mockResolvedValue({ ok: true });
    const c = await montar(citas, "/citas/login");
    changeValue(correo(c), " dueno@negocio.com ");
    await submitForm(c.querySelector("form")!);
    expect(iniciarMagicLink).toHaveBeenCalledWith(API, "dueno@negocio.com", "citas");
    const estado = c.querySelector(".ld3-estado")!;
    expect(estado.getAttribute("data-estado")).toBe("enviado");
    expect(estado.querySelector('[role="status"]')!.textContent).toContain("dueno@negocio.com");
    const cta = c.querySelector<HTMLButtonElement>('form button[type="submit"]')!;
    expect(cta.disabled).toBe(true);
    expect(cta.textContent).toContain(`Reintentar en ${ESPERA_REENVIO_S} s`);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(cta.textContent).toContain(`Reintentar en ${ESPERA_REENVIO_S - 1} s`);
    // Un segundo envio durante la espera no llama a la API.
    await submitForm(c.querySelector("form")!);
    expect(iniciarMagicLink).toHaveBeenCalledTimes(1);
    for (let i = 1; i < ESPERA_REENVIO_S; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(cta.disabled).toBe(false);
    expect(cta.textContent).toContain("Continuar con correo");
  });

  it("correo invalido: error accesible en la misma ranura, sin llamar a la API ni iniciar la espera", async () => {
    const c = await montar(citas, "/citas/login");
    changeValue(correo(c), "no-es-correo");
    await submitForm(c.querySelector("form")!);
    expect(iniciarMagicLink).not.toHaveBeenCalled();
    const alerta = c.querySelector('.ld3-estado [role="alert"]')!;
    expect(alerta.textContent).toContain("correo válido");
    expect(correo(c).getAttribute("aria-invalid")).toBe("true");
    expect(correo(c).getAttribute("aria-describedby")).toBe(alerta.id);
    expect(c.querySelector<HTMLButtonElement>('form button[type="submit"]')!.disabled).toBe(false);
  });

  it("Google sin configurar: boton deshabilitado y el aviso ocupa el lugar de la «o» (como Rovaq), ligado por aria-describedby", async () => {
    verificarGoogle.mockResolvedValue(false);
    const c = await montar(citas, "/citas/login");
    const google = boton(c, /Continuar con Google/);
    expect(google.disabled).toBe(true);
    const aviso = c.querySelector(".ld3-separador p")!;
    expect(aviso.textContent).toBe("Google no está disponible por ahora.");
    expect(google.getAttribute("aria-describedby")).toBe(aviso.id);
  });

  it("Google habilitado redirige al inicio de sesion de la vertical", async () => {
    const asignar = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...original, set href(v: string) { asignar(v); } } });
    try {
      const c = await montar(citas, "/citas/login");
      click(boton(c, /Continuar con Google/));
      expect(asignar).toHaveBeenCalledWith(`${API}/auth/google/iniciar?vertical=citas`);
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    }
  });

  it("un error que llega por la URL se muestra como alerta bajo el filete", async () => {
    const c = await montar(citas, "/citas/login?google_error=access_denied");
    const alerta = c.querySelector(".ld3-mensaje[role=alert]")!;
    expect(alerta).not.toBeNull();
    expect(alerta.textContent!.length).toBeGreaterThan(0);
  });

  it("siempre en tema claro: quita `dark` mientras vive y lo repone al salir", async () => {
    window.localStorage.setItem("atiende-tema", "oscuro");
    document.documentElement.classList.add("dark");
    await montar(citas, "/citas/login");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    rendered!.unmount();
    rendered = undefined;
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("restaurantes: el pie propio de la vertical se conserva; rentas: el alta autoservicio sigue enlazada", async () => {
    const r = await montar(PAGINAS[0]![1], "/restaurantes/login");
    expect(r.querySelector(".ld3-invitacion")!.textContent).toContain("Pídele a tu restaurante que te dé de alta.");
    rendered!.unmount();
    const rentas = await montar(PAGINAS[2]![1], "/rentas/login");
    expect(rentas.querySelector('.ld3-invitacion a[href="/rentas/registro"]')).not.toBeNull();
  });
});
