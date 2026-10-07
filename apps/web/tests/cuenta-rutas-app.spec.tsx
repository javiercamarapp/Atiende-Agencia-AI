// @vitest-environment jsdom
//
// PL-21: las rutas publicas del correo (`/<vertical>/restablecer-contrasena`, `/<vertical>/verificar-correo`) estan
// montadas en las 6 verticales -- son las que arma la API (`apps/api/src/routes/auth-account.ts`, `enlace()`) -- y el
// login de cada una ofrece "¿Olvidaste tu contraseña?". Se monta el App real (BrowserRouter sobre la URL de jsdom).
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { VERTICALES_CUENTA } from "../src/shell/cuenta/cuenta-client.ts";
import { esperarRutaCargada, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

let rendered: RenderedComponent | undefined;

beforeEach(() => {
  installMatchMediaStub();
  installMemoryLocalStorage();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ configured: false, ok: true }) }) as unknown as Response));
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

async function renderEn(ruta: string): Promise<RenderedComponent> {
  window.history.pushState({}, "", ruta);
  const r = renderComponent(<App />);
  await esperarRutaCargada(r.container);
  await act(async () => {
    await flushMicrotasks();
  });
  return r;
}

describe("App — rutas de cuenta en las 6 verticales", () => {
  it.each(VERTICALES_CUENTA)("restablecer-contrasena monta el formulario (no el 404 ni el dashboard de una org)", async (v) => {
    rendered = await renderEn(`/${v}/restablecer-contrasena?token=abc`);
    expect(rendered.container.querySelector("h1")?.textContent).toBe("Elige una contraseña nueva");
    expect(rendered.container.querySelector("#restablecer-nueva")).not.toBeNull();
    // El token sale de la barra de direcciones al montar.
    expect(window.location.search).toBe("");
  });

  it.each(VERTICALES_CUENTA)("verificar-correo monta la verificacion y vuelve al login de la vertical", async (v) => {
    rendered = await renderEn(`/${v}/verificar-correo?token=abc`);
    expect(rendered.container.querySelector("h1")?.textContent).toBe("Verificación de correo");
    const enlace = [...rendered.container.querySelectorAll("a")].find((a) => a.textContent === "Ir a iniciar sesión");
    expect(enlace?.getAttribute("href")).toBe(`/${v}/login`);
  });

  it.each(VERTICALES_CUENTA)("login ofrece '¿Olvidaste tu contraseña?'", async (v) => {
    rendered = await renderEn(`/${v}/login`);
    expect([...rendered.container.querySelectorAll("button")].some((b) => b.textContent === "¿Olvidaste tu contraseña?")).toBe(true);
  });

  it.each(VERTICALES_CUENTA)("seguridad sin sesion vuelve al login de la vertical (nunca renderiza la pagina sin sesion)", async (v) => {
    rendered = await renderEn(`/${v}/demo/seguridad`);
    expect(window.location.pathname).toBe(`/${v}/login`);
  });
});
