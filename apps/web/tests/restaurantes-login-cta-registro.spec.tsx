// @vitest-environment jsdom
//
// CTA de alta autoservicio en el login de restaurantes: enlace a /restaurantes/registro (sin quitar la indicacion para el personal).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { RestaurantesLoginPage } from "../src/verticals/restaurantes/pages/Login.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

let rendered: RenderedComponent | undefined;
beforeEach(() => {
  installMatchMediaStub();
  installMemoryLocalStorage();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ configured: false, disponible: false }), { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

describe("login de restaurantes", () => {
  it("ofrece «Crea tu cuenta» hacia /restaurantes/registro y conserva la indicacion para el personal", async () => {
    rendered = renderComponent(
      <MemoryRouter initialEntries={["/restaurantes/login"]}>
        <RestaurantesLoginPage apiBaseUrl="https://api.test" onLoggedIn={() => {}} />
      </MemoryRouter>,
    );
    await flushMicrotasks();
    const cta = [...rendered.container.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/restaurantes/registro");
    expect(cta?.textContent).toBe("Crea tu cuenta");
    expect(rendered.container.textContent).toContain("Pídele a tu restaurante que te dé de alta.");
  });
});
