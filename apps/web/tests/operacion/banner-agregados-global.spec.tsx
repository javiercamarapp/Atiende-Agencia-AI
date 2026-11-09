// @vitest-environment jsdom
//
// Banner global «agregados por validar» (auditoria R2 #8): aviso de 1 px teñido con la accion como primario suave de 32 px y radio de
// control, no una pildora solida de 48 px con borde de 2 px. Fuera de un shell se pinta en su lugar (AvisoPagina).
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BannerAgregados } from "../../src/verticals/restaurantes/components/operacion/BannerAgregados.tsx";
import { renderComponent, type RenderedComponent } from "../test-utils/render.tsx";

const json = (status: number, cuerpo: unknown) => new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });

let rendered: RenderedComponent | undefined;
beforeEach(() => window.localStorage.clear());
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

describe("BannerAgregados", () => {
  it("con pendientes: aviso teñido de 1 px y «Validar ahora» como primario suave de 32 px", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { disponible: true, agregados: [], pendientes: 2, ahora: new Date().toISOString() })));
    await act(async () => {
      rendered = renderComponent(
        <MemoryRouter initialEntries={["/restaurantes/demo/pedidos"]}>
          <BannerAgregados apiBaseUrl="https://api.test" token="t" propertyId="prop-1" orgSlug="demo" activo />
        </MemoryRouter>,
      );
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const banner = document.querySelector<HTMLElement>('[data-testid="banner-agregados-global"]')!;
    expect(banner.textContent).toContain("2 agregados por validar");
    expect(banner.className).toContain("border border-primary/30 bg-primary-soft");
    expect(banner.className).toContain("rounded-control");
    expect(banner.className).not.toContain("border-2");
    const enlace = [...banner.querySelectorAll("a")].find((a) => a.textContent === "Validar ahora")!;
    expect(enlace.getAttribute("href")).toBe("/restaurantes/demo/operacion/agregados");
    expect(enlace.className).toContain("h-8");
    expect(enlace.className).toContain("rounded-control");
    expect(enlace.className).toContain("text-primary-ink");
    expect(enlace.className).not.toMatch(/(^|\s)(bg-primary|rounded-full|h-12)(\s|$)/);
  });
});
