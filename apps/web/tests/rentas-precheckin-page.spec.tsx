// @vitest-environment jsdom
//
// Rn-P3-08 -- <PreCheckinPage />: formulario publico accesible (cada campo con su etiqueta), flujo verificar -> capturar -> listo, errores sin revelar
// si la reserva existe, reglamento obligatorio, bloqueo (429) y base sin migrar. Sin sesion: ninguna llamada lleva Authorization.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreCheckinPage } from "../src/verticals/rentas/pages/PreCheckin.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}
const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const INFO = (reglamento: string | null = null) => ({ propiedad: "Casa del Mar", organizacion: "Gestora Sol", reglamento, aviso: { version: "2026-10-v1", titulo: "Aviso de privacidad del pre-check-in", parrafos: ["Gestora Sol es responsable de los datos que captures aqui."] } });
const OK = { estado: "ok", token: "T".repeat(43), propiedad: "Casa del Mar", unidad: "Depa 1", check_in: "2027-03-10", check_out: "2027-03-12", ya_capturado: false };

interface Red {
  info?: () => Response;
  verificar?: () => Response;
  capturar?: () => Response;
}
function red(o: Red = {}) {
  const llamadas: { url: string; method: string; headers: Record<string, string>; body?: Record<string, unknown> }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    llamadas.push({ url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });
    if (url.endsWith("/verificar")) return (o.verificar ?? (() => json(OK)))();
    if (url.endsWith("/capturar")) return (o.capturar ?? (() => json({ estado: "ok", mensaje: "Listo. Te enviaremos las instrucciones de acceso por correo antes de tu llegada." })))();
    return (o.info ?? (() => json(INFO())))();
  });
  return { fn, llamadas };
}
const montar = () => renderComponent(<PreCheckinPage apiBaseUrl="http://api.local" propertyId="prop-1" />);
const campo = (etiqueta: string) => {
  const label = [...document.body.querySelectorAll("label")].find((l) => l.textContent?.includes(etiqueta));
  return label?.querySelector("input,textarea") as HTMLInputElement;
};
const boton = (texto: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement | undefined;

async function verificarConDatos(codigo = "HMAB12CD34", tel = "0123") {
  changeValue(campo("Código de confirmación"), codigo);
  changeValue(campo("Últimos 4 dígitos"), tel);
  await submitForm(campo("Código de confirmación").closest("form")!);
  await esperar();
}

describe("PreCheckinPage", () => {
  it("carga el nombre de la propiedad y cada campo tiene su etiqueta (accesible); sin sesion ni Authorization", async () => {
    const { fn, llamadas } = red();
    vi.stubGlobal("fetch", fn);
    rendered = montar();
    await esperar();
    expect(document.body.textContent).toContain("Pre-check-in");
    expect(document.body.textContent).toContain("Casa del Mar");
    expect(campo("Código de confirmación")).toBeTruthy();
    expect(campo("Últimos 4 dígitos de tu teléfono").getAttribute("inputmode")).toBe("numeric");
    expect(boton("Continuar")!.disabled).toBe(true);
    for (const l of llamadas) expect(Object.keys(l.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
  });

  it("flujo completo: verifica, muestra la estancia, captura correo y WhatsApp con el aviso aceptado y muestra la confirmacion", async () => {
    const { fn, llamadas } = red();
    vi.stubGlobal("fetch", fn);
    rendered = montar();
    await esperar();
    await verificarConDatos();
    expect(llamadas.find((l) => l.url.endsWith("/verificar"))!.body).toEqual({ codigo: "HMAB12CD34", ultimos4: "0123" });
    expect(document.body.textContent).toContain("Depa 1");
    expect(document.body.textContent).toContain("10 de marzo de 2027");
    expect(boton("Enviar")!.disabled).toBe(true);
    changeValue(campo("Correo electrónico"), "ana@example.com");
    changeValue(campo("WhatsApp"), "998 123 4567");
    expect(boton("Enviar")!.disabled).toBe(true); // falta aceptar el aviso
    click(campo("Acepto el aviso de privacidad") ?? ([...document.body.querySelectorAll("input[type=checkbox]")][0] as HTMLInputElement));
    await esperar();
    expect(boton("Enviar")!.disabled).toBe(false);
    await submitForm(campo("Correo electrónico").closest("form")!);
    await esperar();
    const cap = llamadas.find((l) => l.url.endsWith("/capturar"))!;
    expect(cap.body).toMatchObject({ token: "T".repeat(43), correo: "ana@example.com", whatsapp: "998 123 4567", aceptaPrivacidad: true, aceptaReglamento: false });
    expect(document.body.textContent).toContain("Listo");
    expect(document.body.textContent).toContain("instrucciones de acceso por correo");
  });

  it("datos que no coinciden: mensaje generico (role alert), se queda en el primer paso y no revela nada de la reserva", async () => {
    vi.stubGlobal("fetch", red({ verificar: () => json({ estado: "invalido", mensaje: "No pudimos validar tus datos. Revisa el código de confirmación y los últimos 4 dígitos de tu teléfono." }) }).fn);
    rendered = montar();
    await esperar();
    await verificarConDatos("HMNOEXISTE1", "9999");
    expect(document.body.querySelector('[role="alert"]')!.textContent).toContain("No pudimos validar tus datos");
    expect(campo("Código de confirmación")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Depa 1");
  });

  it("bloqueo tras demasiados intentos (429): muestra el mensaje real del servidor", async () => {
    vi.stubGlobal("fetch", red({ verificar: () => json({ message: "Demasiados intentos con ese código. Intenta de nuevo en una hora o escribe a tu anfitrión." }, 429) }).fn);
    rendered = montar();
    await esperar();
    await verificarConDatos();
    expect(document.body.querySelector('[role="alert"]')!.textContent).toContain("Demasiados intentos");
  });

  it("si la property tiene reglamento, lo muestra y exige aceptarlo antes de poder enviar", async () => {
    const { fn, llamadas } = red({ info: () => json(INFO("No fiestas ni mascotas.")) });
    vi.stubGlobal("fetch", fn);
    rendered = montar();
    await esperar();
    await verificarConDatos();
    expect(document.body.textContent).toContain("No fiestas ni mascotas.");
    changeValue(campo("Correo electrónico"), "ana@example.com");
    const [privacidad, reglamento] = [...document.body.querySelectorAll("input[type=checkbox]")] as HTMLInputElement[];
    click(privacidad!);
    await esperar();
    expect(boton("Enviar")!.disabled).toBe(true);
    click(reglamento!);
    await esperar();
    expect(boton("Enviar")!.disabled).toBe(false);
    await submitForm(campo("Correo electrónico").closest("form")!);
    await esperar();
    expect(llamadas.find((l) => l.url.endsWith("/capturar"))!.body).toMatchObject({ aceptaReglamento: true });
  });

  it("una reserva que ya capturo sus datos lo dice sin pedirlos de nuevo", async () => {
    vi.stubGlobal("fetch", red({ verificar: () => json({ ...OK, ya_capturado: true }) }).fn);
    rendered = montar();
    await esperar();
    await verificarConDatos();
    expect(document.body.textContent).toContain("Ya recibimos tus datos");
    expect(campo("Correo electrónico")).toBeFalsy();
  });

  it("un token vencido al enviar regresa al primer paso con el mensaje del servidor", async () => {
    vi.stubGlobal("fetch", red({ capturar: () => json({ message: "La verificación expiró o ya se usó. Vuelve a empezar." }, 400) }).fn);
    rendered = montar();
    await esperar();
    await verificarConDatos();
    changeValue(campo("Correo electrónico"), "ana@example.com");
    click([...document.body.querySelectorAll("input[type=checkbox]")][0]!);
    await esperar();
    await submitForm(campo("Correo electrónico").closest("form")!);
    await esperar();
    expect(document.body.textContent).toContain("La verificación expiró");
    expect(campo("Código de confirmación")).toBeTruthy();
  });

  it("enlace desconocido (404) y base sin la migracion (503) se dicen honestamente", async () => {
    vi.stubGlobal("fetch", red({ info: () => json({ message: "Este enlace de pre-check-in no es válido." }, 404) }).fn);
    rendered = montar();
    await esperar();
    expect(document.body.textContent).toContain("Enlace no válido");
    rendered.unmount();
    vi.stubGlobal("fetch", red({ info: () => json({ message: "El pre-check-in aún no está disponible para esta propiedad." }, 503) }).fn);
    rendered = montar();
    await esperar();
    expect(document.body.textContent).toContain("Aún no disponible");
    expect(campo("Código de confirmación")).toBeFalsy();
  });
});
