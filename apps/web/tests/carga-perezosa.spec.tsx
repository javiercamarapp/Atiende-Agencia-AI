// @vitest-environment jsdom
//
// R-37: un chunk perezoso que no baja (despliegue a mitad de sesión, red móvil) no puede dejar la app en blanco.
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cargaPerezosa, ErrorBoundaryRaiz, importarConRecuperacion, recargarUnaVez, VENTANA_RECARGA_MS } from "../src/lib/carga-perezosa.tsx";
import { esperarHasta, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub } from "./test-utils/memory-storage.ts";

let rendered: RenderedComponent | undefined;

beforeEach(() => {
  installMatchMediaStub();
  window.sessionStorage.clear();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.restoreAllMocks();
});

describe("recargarUnaVez", () => {
  it("recarga la primera vez y no la segunda dentro de la ventana", () => {
    const recargar = vi.fn();
    expect(recargarUnaVez(1000, recargar)).toBe(true);
    expect(recargarUnaVez(1000 + VENTANA_RECARGA_MS - 1, recargar)).toBe(false);
    expect(recargar).toHaveBeenCalledTimes(1);
    expect(recargarUnaVez(1000 + VENTANA_RECARGA_MS + 1, recargar)).toBe(true);
  });
});

describe("importarConRecuperacion", () => {
  it("reintenta una vez ante un fallo transitorio y devuelve el módulo", async () => {
    const cargar = vi.fn().mockRejectedValueOnce(new Error("red")).mockResolvedValueOnce({ ok: 1 });
    await expect(importarConRecuperacion(cargar, { esperaMs: 0 })).resolves.toEqual({ ok: 1 });
    expect(cargar).toHaveBeenCalledTimes(2);
  });

  it("si persiste, dispara UNA recarga y no resuelve (la página se está recargando)", async () => {
    const recargar = vi.fn();
    const cargar = vi.fn().mockRejectedValue(new Error("chunk viejo"));
    const resultado = importarConRecuperacion(cargar, { esperaMs: 0, recargar });
    const gano = await Promise.race([resultado.then(() => "resolvio", () => "rechazo"), new Promise((r) => setTimeout(() => r("pendiente"), 50))]);
    expect(gano).toBe("pendiente");
    expect(recargar).toHaveBeenCalledTimes(1);
  });

  it("si ya se recargó hace poco, relanza el error en vez de entrar en bucle", async () => {
    window.sessionStorage.setItem("atiende:recarga-por-chunk", String(Date.now()));
    const recargar = vi.fn();
    await expect(importarConRecuperacion(() => Promise.reject(new Error("chunk viejo")), { esperaMs: 0, recargar })).rejects.toThrow("chunk viejo");
    expect(recargar).not.toHaveBeenCalled();
  });
});

describe("ErrorBoundaryRaiz + cargaPerezosa", () => {
  it("un import que rechaza muestra el estado de error con Reintentar y no deja el árbol vacío", async () => {
    window.sessionStorage.setItem("atiende:recarga-por-chunk", String(Date.now()));
    const Rota = cargaPerezosa(() => Promise.reject(new Error("Failed to fetch dynamically imported module")) as Promise<{ X: () => null }>, "X");
    rendered = renderComponent(
      <ErrorBoundaryRaiz>
        <Suspense fallback={<div data-atiende-carga-ruta />}>
          <Rota />
        </Suspense>
      </ErrorBoundaryRaiz>,
    );
    await esperarHasta(() => rendered!.container.querySelector("[data-atiende-error-raiz]") !== null, "aparece el estado de error", 5000);
    expect(rendered.container.textContent).toContain("No pudimos cargar esta pantalla");
    expect([...rendered.container.querySelectorAll("button")].some((b) => /reintentar/i.test(b.textContent ?? ""))).toBe(true);
  });

  it("un import que sí resuelve pinta la pantalla", async () => {
    const Buena = cargaPerezosa(() => Promise.resolve({ Buena: () => <p>hola</p> }), "Buena");
    rendered = renderComponent(
      <ErrorBoundaryRaiz>
        <Suspense fallback={<div data-atiende-carga-ruta />}>
          <Buena />
        </Suspense>
      </ErrorBoundaryRaiz>,
    );
    await esperarHasta(() => rendered!.container.textContent === "hola", "pinta la pantalla", 5000);
  });
});
