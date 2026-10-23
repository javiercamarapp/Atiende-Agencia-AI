// @vitest-environment jsdom
//
// Pantalla movil de acceso del repartidor (celular -> codigo). Estados: comprobando, no disponible, celular, codigo, errores, reenvio, exito.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AccesoRepartidorPage, ESPERA_REENVIO_SEGUNDOS } from "../src/verticals/restaurantes/pages/AccesoRepartidor.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.useRealTimers();
});

interface Llamada {
  url: string;
  body: Record<string, unknown> | null;
}

function fetchSimulado(opts: { disponible?: boolean; solicitar?: () => Response; verificar?: () => Response }) {
  const llamadas: Llamada[] = [];
  const f = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    llamadas.push({ url: u, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
    if (u.endsWith("/estado")) return json({ disponible: opts.disponible !== false });
    if (u.endsWith("/solicitar")) return opts.solicitar ? opts.solicitar() : json({ ok: true, expiraEnSegundos: 300 });
    if (u.endsWith("/verificar")) return opts.verificar ? opts.verificar() : json({ message: "x" }, 401);
    return json({}, 404);
  });
  return { f: f as unknown as typeof fetch, llamadas };
}

function memoriaStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), datos: m };
}

async function montar(f: typeof fetch, onLoggedIn = vi.fn(), storage = memoriaStorage()) {
  rendered = renderComponent(
    <MemoryRouter initialEntries={["/restaurantes/acceso-repartidor"]}>
      <AccesoRepartidorPage apiBaseUrl="https://api.test" onLoggedIn={onLoggedIn} fetchImpl={f} storage={storage} />
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
  return { c: rendered.container, onLoggedIn, storage };
}

const campo = (c: HTMLElement) => c.querySelector<HTMLInputElement>("input")!;
const botonSubmit = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const texto = (c: HTMLElement) => c.textContent ?? "";

async function pedirCodigo(c: HTMLElement, celular = "999 123 0001") {
  changeValue(campo(c), celular);
  await submitForm(c.querySelector("form")!);
}

describe("AccesoRepartidorPage", () => {
  it("servidor sin la funcion encendida: estado honesto 'todavia no esta disponible' con salida al correo, sin formulario", async () => {
    const { f } = fetchSimulado({ disponible: false });
    const { c } = await montar(f);
    expect(texto(c)).toContain("Todavía no está disponible");
    expect(c.querySelector("form")).toBeNull();
    expect(c.querySelector('a[href="/restaurantes/login"]')).not.toBeNull();
  });

  it("paso 1: campo de celular accesible (etiqueta, teclado telefonico) y boton de >= 56 px", async () => {
    const { f } = fetchSimulado({});
    const { c } = await montar(f);
    const input = campo(c);
    expect(input.type).toBe("tel");
    expect(input.getAttribute("inputmode")).toBe("tel");
    expect(c.querySelector(`label[for="${input.id}"]`)?.textContent).toContain("Tu celular");
    expect(input.className).toContain("h-14");
    expect(botonSubmit(c).className).toContain("h-14");
    expect(c.querySelectorAll("h1")).toHaveLength(1);
  });

  it("celular invalido: error accesible (role=alert), no llama al servidor", async () => {
    const { f, llamadas } = fetchSimulado({});
    const { c } = await montar(f);
    await pedirCodigo(c, "123");
    expect(c.querySelector('[role="alert"]')?.textContent).toContain("10 dígitos");
    expect(campo(c).getAttribute("aria-invalid")).toBe("true");
    expect(llamadas.some((l) => l.url.endsWith("/solicitar"))).toBe(false);
  });

  it("celular valido: manda 10 digitos y pasa al codigo con aviso condicional (no confirma que exista la cuenta)", async () => {
    const { f, llamadas } = fetchSimulado({});
    const { c } = await montar(f);
    await pedirCodigo(c, "+52 (999) 123-0001");
    expect(llamadas.find((l) => l.url.endsWith("/solicitar"))?.body).toEqual({ telefono: "9991230001" });
    expect(texto(c)).toContain("Escribe tu código");
    expect(texto(c)).toContain("Si el 999 123 0001 está registrado");
    const input = campo(c);
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
    expect(input.getAttribute("inputmode")).toBe("numeric");
  });

  it("429 al pedir el codigo: muestra el mensaje y se queda en el paso del celular", async () => {
    const { f } = fetchSimulado({ solicitar: () => json({ message: "Pediste demasiados códigos. Espera unos minutos e inténtalo de nuevo." }, 429) });
    const { c } = await montar(f);
    await pedirCodigo(c);
    expect(c.querySelector('[role="alert"]')?.textContent).toContain("demasiados códigos");
    expect(texto(c)).toContain("Entrar con tu celular");
  });

  it("503 al pedir el codigo: pasa al estado 'no disponible'", async () => {
    const { f } = fetchSimulado({ solicitar: () => json({ message: "x" }, 503) });
    const { c } = await montar(f);
    await pedirCodigo(c);
    expect(texto(c)).toContain("Todavía no está disponible");
  });

  it("codigo incorrecto: mensaje fijo, limpia el campo y deja reintentar; formato invalido no llama al servidor", async () => {
    const { f, llamadas } = fetchSimulado({});
    const { c } = await montar(f);
    await pedirCodigo(c);
    changeValue(campo(c), "12");
    await submitForm(c.querySelector("form")!);
    expect(c.querySelector('[role="alert"]')?.textContent).toContain("6 dígitos");
    expect(llamadas.some((l) => l.url.endsWith("/verificar"))).toBe(false);
    changeValue(campo(c), "123456");
    await submitForm(c.querySelector("form")!);
    expect(llamadas.find((l) => l.url.endsWith("/verificar"))?.body).toEqual({ telefono: "9991230001", codigo: "123456" });
    expect(c.querySelector('[role="alert"]')?.textContent).toContain("Código incorrecto o vencido");
    expect(campo(c).value).toBe("");
  });

  it("codigo correcto: guarda la sesion y navega al panel del repartidor", async () => {
    const sesion = { token: "t", refreshToken: "r", email: "c@x.test", fullName: "Chofer", organizations: [{ id: "o", slug: "los-taquitos", nombre: "PM", vertical: "restaurantes", rol: "repartidor" }] };
    const { f } = fetchSimulado({ verificar: () => json(sesion) });
    const { c, onLoggedIn, storage } = await montar(f);
    await pedirCodigo(c);
    changeValue(campo(c), "123456");
    await submitForm(c.querySelector("form")!);
    expect(onLoggedIn).toHaveBeenCalledTimes(1);
    expect(onLoggedIn.mock.calls[0]![1]).toBe("/restaurantes/los-taquitos/repartidor");
    expect(storage.datos.size).toBe(1);
  });

  it("reenvio: bloqueado durante la espera y activo despues; el boton y 'Cambiar mi numero' miden >= 56 px", async () => {
    vi.useFakeTimers();
    const { f, llamadas } = fetchSimulado({});
    const { c } = await montar(f);
    await pedirCodigo(c);
    const reenviar = () => Array.from(c.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("otro código"))!;
    expect(reenviar().disabled).toBe(true);
    expect(reenviar().textContent).toContain(`${ESPERA_REENVIO_SEGUNDOS} s`);
    expect(reenviar().className).toContain("h-14");
    for (let i = 0; i < ESPERA_REENVIO_SEGUNDOS; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    expect(reenviar().disabled).toBe(false);
    click(reenviar());
    await act(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(llamadas.filter((l) => l.url.endsWith("/solicitar"))).toHaveLength(2);
    expect(texto(c)).toContain("El anterior ya no sirve");
    const cambiar = Array.from(c.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("Cambiar mi número"))!;
    expect(cambiar.className).toContain("min-h-14");
    click(cambiar);
    expect(texto(c)).toContain("Entrar con tu celular");
  });
});
