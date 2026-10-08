// @vitest-environment jsdom
// <BannerSoporte />: banner permanente de la sesión de soporte. Reloj fijo (`ahora`), sin recargar la página, sin TZ.
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BannerSoporte } from "../src/components/BannerSoporte.tsx";
import { guardarNombreOrganizacion } from "../src/lib/soporte.ts";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { instalarLocalStorageEnMemoria, tokenSinSoporte, tokenSoporteFalso } from "./test-utils/token-soporte.ts";

const T0 = Date.parse("2030-03-04T10:00:00.000Z");
const MIN = 60_000;
let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
let recargar: ReturnType<typeof vi.fn>;
const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body }) as unknown as Response;

async function esperar() {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
function Ubicacion() {
  return <p data-testid="ubicacion">{useLocation().pathname}</p>;
}
function render(token: string, ahora = () => T0) {
  rendered = renderComponent(
    <MemoryRouter initialEntries={["/restaurantes/los-taquitos-de-pm"]}>
      <Routes>
        <Route path="/restaurantes/:slug" element={<BannerSoporte apiBaseUrl="https://api.test" token={token} ahora={ahora} recargar={recargar} fetchImpl={fetchMock as never} />} />
        <Route path="*" element={<Ubicacion />} />
      </Routes>
    </MemoryRouter>,
  );
}
const boton = (texto: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto) as HTMLButtonElement | undefined;
const dialogo = () => document.body.querySelector('[role="alertdialog"]');
const llamadas = (sufijo: string) => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith(sufijo));

beforeEach(() => {
  const st = instalarLocalStorageEnMemoria();
  st.setItem("atiende.restaurantes.session", JSON.stringify({ token: "viejo", refreshToken: "", email: "javier@atiende.ai", organizations: [] }));
  guardarNombreOrganizacion(st, "s1", "Los Taquitos de PM");
  recargar = vi.fn();
  fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/soporte/estado")) return json({ active: true, elevated: false });
    if (url.endsWith("/soporte/salir")) return json({ ok: true });
    if (url.endsWith("/soporte/elevar")) return json({ token: tokenSoporteFalso({ expMs: T0 + 42 * MIN, ro: false }) });
    throw new Error(`fetch inesperado: ${url}`);
  });
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.useRealTimers();
});

describe("BannerSoporte", () => {
  it("un login normal (sin claim de soporte) no pinta NADA ni hace ninguna petición", async () => {
    render(tokenSinSoporte());
    await esperar();
    expect(rendered!.container.textContent).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pinta el banner permanente con la organización, el tiempo que queda (hh:mm) y los botones", async () => {
    render(tokenSoporteFalso({ expMs: T0 + 42 * MIN }));
    await esperar();
    const banner = rendered!.container.querySelector('[data-testid="banner-soporte"]')!;
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain("Estás viendo como Los Taquitos de PM — sesión de soporte, caduca en 00:42");
    expect(banner.textContent).toContain("Solo lectura");
    expect(boton("Permitir edición")).toBeDefined();
    expect(boton("Salir")).toBeDefined();
  });

  it("con la edición ya habilitada no ofrece «Permitir edición» y lo dice", async () => {
    render(tokenSoporteFalso({ expMs: T0 + 42 * MIN, ro: false }));
    await esperar();
    expect(rendered!.container.textContent).toContain("Edición habilitada");
    expect(boton("Permitir edición")).toBeUndefined();
  });

  it("Salir: avisa a la API, borra la sesión del cliente (no la del superadmin) y vuelve a la consola", async () => {
    window.localStorage.setItem("atiende.superadmin.session", "intacta");
    render(tokenSoporteFalso({ expMs: T0 + 42 * MIN }));
    await esperar();
    click(boton("Salir")!);
    await esperar();
    expect(llamadas("/soporte/salir")).toHaveLength(1);
    expect((llamadas("/soporte/salir")[0]![1] as RequestInit).method).toBe("POST");
    expect(window.localStorage.getItem("atiende.restaurantes.session")).toBeNull();
    expect(window.localStorage.getItem("atiende.superadmin.session")).toBe("intacta");
    expect(rendered!.container.querySelector('[data-testid="ubicacion"]')?.textContent).toBe("/superadmin/organizaciones");
  });

  it("Permitir edición exige motivo: vacío, corto o solo espacios dejan el botón bloqueado y no sale nada al servidor", async () => {
    render(tokenSoporteFalso({ expMs: T0 + 42 * MIN }));
    await esperar();
    click(boton("Permitir edición")!);
    await esperar();
    expect(dialogo()).not.toBeNull();
    const confirmar = () => [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.includes("Permitir edición")) as HTMLButtonElement;
    expect(confirmar().disabled).toBe(true);
    for (const v of ["", "   ", "corto"]) {
      changeValue(dialogo()!.querySelector("textarea")!, v);
      expect(confirmar().disabled, JSON.stringify(v)).toBe(true);
    }
    click(confirmar());
    await esperar();
    expect(llamadas("/soporte/elevar")).toHaveLength(0);
  });

  it("Permitir edición con motivo: llama a /soporte/elevar, guarda el token nuevo (ro:false) y recarga", async () => {
    render(tokenSoporteFalso({ expMs: T0 + 42 * MIN }));
    await esperar();
    click(boton("Permitir edición")!);
    await esperar();
    changeValue(dialogo()!.querySelector("textarea")!, "Corregir el precio mal capturado");
    click([...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.includes("Permitir edición")) as HTMLButtonElement);
    await esperar();
    expect(llamadas("/soporte/elevar")).toHaveLength(1);
    expect(JSON.parse(String((llamadas("/soporte/elevar")[0]![1] as RequestInit).body))).toEqual({ reason: "Corregir el precio mal capturado" });
    const guardada = JSON.parse(window.localStorage.getItem("atiende.restaurantes.session")!);
    expect(guardada.token).not.toBe("viejo");
    expect(guardada.email).toBe("javier@atiende.ai");
    expect(recargar).toHaveBeenCalledTimes(1);
  });

  it("si la sesión ya venció según el reloj, cierra la sesión local y vuelve a la consola", async () => {
    render(tokenSoporteFalso({ expMs: T0 - MIN }));
    await esperar();
    expect(window.localStorage.getItem("atiende.restaurantes.session")).toBeNull();
    expect(rendered!.container.querySelector('[data-testid="ubicacion"]')?.textContent).toBe("/superadmin/organizaciones");
  });

  it("si el servidor dice que la sesión terminó (sondeo cada 30 s), cierra la sesión local", async () => {
    vi.useFakeTimers();
    fetchMock = vi.fn(async (url: string) => (url.endsWith("/soporte/estado") ? json({ active: false, elevated: false }) : json({})));
    render(tokenSoporteFalso({ expMs: T0 + 42 * MIN }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(llamadas("/soporte/estado").length).toBeGreaterThanOrEqual(1);
    expect(window.localStorage.getItem("atiende.restaurantes.session")).toBeNull();
  });
});
