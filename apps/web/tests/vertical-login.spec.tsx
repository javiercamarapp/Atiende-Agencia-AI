// @vitest-environment jsdom
//
// PR-4 del plan de diseno-ux: <VerticalLogin> unico (Google + magic link) que
// sustituye al Login.tsx de cada vertical; primer cliente: citas.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { VerticalLogin, esCorreoValido, type VerticalLoginProps } from "../src/components/VerticalLogin.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

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
    expect(c.querySelector("aside")!.getAttribute("aria-label")).toBe("Atiende citas");
    expect(c.querySelector("canvas")!.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it("el arte decorativo conserva la identidad sin controles ni efectos en el formulario", async () => {
    const c = await montar();
    const campo = correo(c);
    changeValue(campo, "dueno@negocio.com");
    expect(c.querySelector(".login-artwork")!.getAttribute("data-shape")).toBe("sphere");
    expect([...c.querySelectorAll("button")].some(b => /animación/.test(b.textContent ?? ""))).toBe(false);
    expect(correo(c)).toBe(campo);
    expect(campo.value).toBe("dueno@negocio.com");
    expect(iniciarMagicLink).not.toHaveBeenCalled();
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

  it("magic link exitoso: el aviso va en la ranura de altura fija DEBAJO del boton (sin empujar el formulario) y el formulario sigue disponible", async () => {
    iniciarMagicLink.mockResolvedValue({ ok: true });
    const c = await montar();
    changeValue(correo(c), " dueno@negocio.com ");
    await submitForm(c.querySelector("form")!);
    expect(iniciarMagicLink).toHaveBeenCalledWith("https://api.test", "dueno@negocio.com", "citas");
    expect(c.querySelector('[role="status"]')!.textContent).toContain("dueno@negocio.com");
    expect(c.querySelector('[role="status"]')!.textContent).toContain("Te mandamos un enlace a tu correo.");
    // Un dedazo en el correo no deja sin salida: el campo sigue ahi para volver a escribirlo.
    expect(c.querySelector("form")).not.toBeNull();
    expect(correo(c)).not.toBeNull();
    // Sin saltos de layout: el aviso vive DENTRO de la ranura `.login-estado` (altura fija), que sigue al formulario.
    const aviso = c.querySelector('[role="status"]')!;
    const ranura = c.querySelector(".login-estado")!;
    expect(ranura.contains(aviso)).toBe(true);
    expect(ranura.getAttribute("data-estado")).toBe("enviado");
    expect(c.querySelector("form")!.compareDocumentPosition(ranura) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("idle, error de correo, error del servidor y enviado reusan LA MISMA ranura: nunca hay mas de un mensaje ni nodos fuera de ella", async () => {
    iniciarMagicLink.mockResolvedValueOnce({ ok: false, error: "Demasiados intentos" }).mockResolvedValueOnce({ ok: true });
    const c = await montar();
    const ranura = c.querySelector(".login-estado")!;
    expect(ranura.getAttribute("data-estado")).toBe("reposo");
    await submitForm(c.querySelector("form")!);
    expect(ranura.getAttribute("data-estado")).toBe("error");
    expect(ranura.querySelector('[role="alert"]')).not.toBeNull();
    changeValue(correo(c), "a@b.com");
    await submitForm(c.querySelector("form")!);
    expect(ranura.querySelector('[role="alert"]')!.textContent).toBe("Demasiados intentos");
    await submitForm(c.querySelector("form")!);
    expect(ranura.getAttribute("data-estado")).toBe("enviado");
    expect(ranura.querySelector('[role="alert"]')).toBeNull();
    // Todo mensaje (status/alert) vive en la ranura: el resto de la pantalla no inserta bloques.
    expect(c.querySelectorAll('[role="status"], [role="alert"]').length).toBe(1);
    expect(c.querySelector(".login-aviso-google")).toBeNull();
  });

  it("enviado y luego un correo invalido: el error reemplaza al aviso de enviado y es el unico mensaje de la ranura", async () => {
    iniciarMagicLink.mockResolvedValue({ ok: true });
    const c = await montar();
    const ranura = c.querySelector(".login-estado")!;
    changeValue(correo(c), "a@b.com");
    await submitForm(c.querySelector("form")!);
    expect(ranura.getAttribute("data-estado")).toBe("enviado");
    changeValue(correo(c), "mal-escrito");
    await submitForm(c.querySelector("form")!);
    expect(ranura.getAttribute("data-estado")).toBe("error");
    expect(ranura.querySelector('[role="status"]')).toBeNull();
    expect(ranura.querySelectorAll('[role="alert"]').length).toBe(1);
    expect(c.querySelectorAll('[role="status"], [role="alert"]').length).toBe(1);
  });

  it("la etiqueta del boton no cambia de caja al enviar: 'Enviando…' ya existe apilada y solo cambia cual es invisible", async () => {
    let terminar: (v: { ok: boolean }) => void = () => undefined;
    iniciarMagicLink.mockReturnValue(new Promise((r) => (terminar = r)));
    const c = await montar();
    const boton = [...c.querySelectorAll("button")].find((b) => b.getAttribute("type") === "submit")!;
    const textos = () => [...boton.querySelectorAll(".login-etiqueta > span")].map((n) => [n.textContent, n.classList.contains("invisible")]);
    expect(textos()).toEqual([["Continuar con correo", false], ["Enviando…", true]]);
    changeValue(correo(c), "a@b.com");
    await submitForm(c.querySelector("form")!);
    expect(boton.getAttribute("aria-busy")).toBe("true");
    expect(textos()).toEqual([["Continuar con correo", true], ["Enviando…", false]]);
    terminar({ ok: true });
    await act(async () => {
      await flushMicrotasks();
    });
  });

  it("el aviso de Google no se inserta en el flujo: va absoluto sobre el separador", async () => {
    verificarGoogle.mockResolvedValue(false);
    const c = await montar();
    expect(c.querySelector(".login-aviso-google")!.className).toContain("absolute");
  });

  it("magic link rechazado por el servidor muestra el mensaje inline (role=alert) y deja el formulario", async () => {
    iniciarMagicLink.mockResolvedValue({ ok: false, error: "Demasiados intentos" });
    const c = await montar();
    changeValue(correo(c), "a@b.com");
    await submitForm(c.querySelector("form")!);
    expect(c.querySelector('p[role="alert"]')!.textContent).toBe("Demasiados intentos");
    expect(c.querySelector('[role="status"]')).toBeNull();
    expect(c.querySelector("form")).not.toBeNull();
  });

  it("muestra el mensaje humano de ?google_error= y de ?magic_link_error= (nunca el codigo crudo)", async () => {
    let c = await montar({}, "/citas/login?google_error=state_expirado");
    expect(c.querySelector('[role="alert"]')!.textContent).toContain("venció");
    expect(c.textContent).not.toContain("state_expirado");
    rendered!.unmount();
    c = await montar({}, "/citas/login?magic_link_error=cualquiera");
    expect(c.querySelector('p[role="alert"]')).not.toBeNull();
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

describe("VerticalLogin — ¿Olvidaste tu contraseña? (PL-21)", () => {
  const solicitar = vi.fn();
  beforeEach(() => {
    solicitar.mockReset();
    vi.stubGlobal("fetch", solicitar);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const enlaceOlvido = (c: HTMLElement) => [...c.querySelectorAll("button")].find((b) => b.textContent === "¿Olvidaste tu contraseña?");
  const res = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

  it("el enlace existe en el login, abre el formulario de restablecer y 'Volver' regresa al acceso", async () => {
    verificarGoogle.mockResolvedValue(false);
    const c = await montar();
    click(enlaceOlvido(c)!);
    expect(c.textContent).toContain("Restablece tu contraseña");
    expect([...c.querySelectorAll("button")].some((b) => b.textContent?.includes("Continuar con correo"))).toBe(false);
    click([...c.querySelectorAll("button")].find((b) => b.textContent === "Volver a iniciar sesión")!);
    expect([...c.querySelectorAll("button")].some((b) => b.textContent?.includes("Continuar con correo"))).toBe(true);
  });

  it("respuesta uniforme: manda el correo y la vertical, y el aviso NO confirma que la cuenta exista", async () => {
    solicitar.mockResolvedValue(res({ ok: true }));
    const c = await montar();
    changeValue(correo(c), "dueno@negocio.com");
    click(enlaceOlvido(c)!);
    expect(correo(c).value).toBe("dueno@negocio.com"); // no se pide el correo dos veces
    await submitForm(c.querySelector("form")!);
    await act(async () => {
      await flushMicrotasks();
    });
    const [url, init] = solicitar.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.test/auth/password-reset/solicitar");
    expect(JSON.parse(init.body as string)).toEqual({ email: "dueno@negocio.com", vertical: "citas" });
    const aviso = c.querySelector('[role="status"]')!.textContent!;
    expect(aviso).toContain("Si dueno@negocio.com tiene una cuenta");
    expect(aviso).not.toMatch(/no existe|no encontr/i);
  });

  it("un correo invalido no llama al servidor; un error del servidor (429) se muestra", async () => {
    const c = await montar();
    click(enlaceOlvido(c)!);
    changeValue(correo(c), "no-es-correo");
    await submitForm(c.querySelector("form")!);
    expect(solicitar).not.toHaveBeenCalled();
    expect(c.querySelector('p[role="alert"]')!.textContent).toContain("correo válido");
    solicitar.mockResolvedValue(res({ message: "Demasiados intentos. Intenta de nuevo en unos minutos." }, 429));
    changeValue(correo(c), "a@b.com");
    await submitForm(c.querySelector("form")!);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(c.querySelector('p[role="alert"]')!.textContent).toContain("Demasiados intentos");
    expect(c.querySelector('[role="status"]')).toBeNull();
  });

  it("se puede apagar por vertical y no aparece si la vertical no es una de las 6", async () => {
    let c = await montar({ metodos: { olvidoContrasena: false } });
    expect(enlaceOlvido(c)).toBeUndefined();
    rendered!.unmount();
    c = await montar({ vertical: "otra" });
    expect(enlaceOlvido(c)).toBeUndefined();
  });
});
