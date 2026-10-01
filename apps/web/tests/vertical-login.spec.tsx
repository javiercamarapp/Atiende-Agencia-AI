// @vitest-environment jsdom
//
// PR-4 del plan de diseno-ux: <VerticalLogin> unico (Google + magic link) que
// sustituye al Login.tsx de cada vertical; primer cliente: citas.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { VerticalLogin, esCorreoValido, type VerticalLoginProps } from "../src/components/VerticalLogin.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

const notifyError = vi.fn();
vi.mock("@atiende/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@atiende/ui")>();
  return { ...actual, notify: { ...actual.notify, error: (...a: unknown[]) => notifyError(...a) } };
});

const iniciarMagicLink = vi.fn();
const verificarGoogle = vi.fn();
vi.mock("../src/lib/google-auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/google-auth.ts")>();
  return { ...actual, iniciarMagicLink: (...a: unknown[]) => iniciarMagicLink(...a), verificarGoogleConfigurado: (...a: unknown[]) => verificarGoogle(...a) };
});

const BASE: VerticalLoginProps = {
  apiBaseUrl: "https://api.test",
  vertical: "citas",
  nombre: "citas",
  descripcion: "El panel de operación de tu negocio de citas.",
  hero: { imagen: "images/login-hero-citas.jpg", alt: "Sala vacía", kicker: "Citas y turnos por WhatsApp", texto: "El agente agenda." },
};

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});
beforeEach(() => {
  iniciarMagicLink.mockReset();
  verificarGoogle.mockReset().mockResolvedValue(true);
  notifyError.mockReset();
});

async function montar(props: Partial<VerticalLoginProps> = {}, ruta = "/citas/login") {
  rendered = renderComponent(
    <MemoryRouter initialEntries={[ruta]}>
      <VerticalLogin {...BASE} {...props} />
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
  });
  return rendered.container;
}

const correo = (c: HTMLElement) => c.querySelector<HTMLInputElement>('input[type="email"]')!;

describe("esCorreoValido", () => {
  it("acepta correos normales y rechaza vacíos o sin dominio", () => {
    expect(esCorreoValido("a@b.co")).toBe(true);
    expect(esCorreoValido(" a@b.co ")).toBe(true);
    for (const malo of ["", "a", "a@b", "a b@c.com", "@x.com"]) expect(esCorreoValido(malo)).toBe(false);
  });
});

describe("VerticalLogin", () => {
  it("pinta el titulo de la vertical, un solo h1, landmark main y el campo de correo etiquetado", async () => {
    const c = await montar();
    expect(c.querySelectorAll("h1")).toHaveLength(1);
    expect(c.querySelector("h1")!.textContent).toContain("atiende citas");
    expect(c.querySelectorAll("main")).toHaveLength(1);
    const input = correo(c);
    expect(c.querySelector(`label[for="${input.id}"]`)!.textContent).toContain("Tu correo");
    expect(c.querySelector("img")!.getAttribute("alt")).toBe("Sala vacía");
  });

  it("Google queda deshabilitado con aviso honesto si el entorno no lo tiene configurado", async () => {
    verificarGoogle.mockResolvedValue(false);
    const c = await montar();
    const google = [...c.querySelectorAll("button")].find((b) => b.textContent?.includes("Continuar con Google"))!;
    expect(google.disabled).toBe(true);
    expect(c.textContent).toContain("Google: pendiente de configurar en este entorno.");
  });

  it("Google habilitado redirige al inicio de sesion de la vertical", async () => {
    const asignar = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...original, set href(v: string) { asignar(v); } } });
    const c = await montar();
    const google = [...c.querySelectorAll("button")].find((b) => b.textContent?.includes("Continuar con Google"))!;
    expect(google.disabled).toBe(false);
    click(google);
    expect(asignar).toHaveBeenCalledWith("https://api.test/auth/google/iniciar?vertical=citas");
    Object.defineProperty(window, "location", { configurable: true, value: original });
  });

  it("un correo invalido muestra el error inline accesible y NO llama a la API", async () => {
    const c = await montar();
    changeValue(correo(c), "no-es-correo");
    await submitForm(c.querySelector("form")!);
    expect(iniciarMagicLink).not.toHaveBeenCalled();
    const alerta = c.querySelector('p[role="alert"]')!;
    expect(alerta.textContent).toContain("correo válido");
    expect(correo(c).getAttribute("aria-invalid")).toBe("true");
    expect(correo(c).getAttribute("aria-describedby")).toBe(alerta.id);
  });

  it("magic link exitoso: confirma el correo y 'Usar otro correo' regresa al formulario", async () => {
    iniciarMagicLink.mockResolvedValue({ ok: true });
    const c = await montar();
    changeValue(correo(c), " dueno@negocio.com ");
    await submitForm(c.querySelector("form")!);
    expect(iniciarMagicLink).toHaveBeenCalledWith("https://api.test", "dueno@negocio.com", "citas");
    expect(c.querySelector('[role="status"]')!.textContent).toContain("dueno@negocio.com");
    click([...c.querySelectorAll("button")].find((b) => b.textContent === "Usar otro correo")!);
    expect(c.querySelector("form")).not.toBeNull();
  });

  it("magic link rechazado por el servidor avisa con notify.error y deja el formulario", async () => {
    iniciarMagicLink.mockResolvedValue({ ok: false, error: "Demasiados intentos" });
    const c = await montar();
    changeValue(correo(c), "a@b.com");
    await submitForm(c.querySelector("form")!);
    expect(notifyError).toHaveBeenCalledWith("No se pudo enviar el enlace", { description: "Demasiados intentos" });
    expect(c.querySelector("form")).not.toBeNull();
  });

  it("muestra el mensaje humano de ?google_error= y de ?magic_link_error= (nunca el codigo crudo)", async () => {
    let c = await montar({}, "/citas/login?google_error=state_expirado");
    expect(c.querySelector('[role="alert"]')!.textContent).toContain("venció");
    expect(c.textContent).not.toContain("state_expirado");
    rendered!.unmount();
    c = await montar({}, "/citas/login?magic_link_error=cualquiera");
    expect(c.querySelector('div[role="alert"]')).not.toBeNull();
  });

  it("los metodos son props: sin Google ni su aviso, sin separador y sin consultar al servidor", async () => {
    const c = await montar({ metodos: { google: false } });
    expect(c.textContent).not.toContain("Continuar con Google");
    expect(verificarGoogle).not.toHaveBeenCalled();
    expect(c.querySelector("form")).not.toBeNull();
  });

  it("sin magic link solo queda Google", async () => {
    const c = await montar({ metodos: { magicLink: false } });
    expect(c.querySelector("form")).toBeNull();
    expect(c.textContent).toContain("Continuar con Google");
  });
});
