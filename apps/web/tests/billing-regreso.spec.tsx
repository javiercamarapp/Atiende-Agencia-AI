// @vitest-environment jsdom
//
// Onboarding P0: las URLs de regreso de Stripe Checkout (/billing/success y /billing/cancel) caian en NotFound. Se monta el App real y se
// verifica que ambas rutas existen, explican el estado sin prometer de mas y mandan al login de la vertical (lista cerrada).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App.tsx";
import { destinoRegresoBilling } from "../src/shell/BillingRegreso.tsx";
import { esperarRutaCargada, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

let rendered: RenderedComponent | undefined;

beforeEach(() => {
  installMatchMediaStub();
  installMemoryLocalStorage();
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  window.history.pushState({}, "", "/");
});

async function renderEn(ruta: string): Promise<RenderedComponent> {
  window.history.pushState({}, "", ruta);
  const r = renderComponent(<App />);
  await esperarRutaCargada(r.container);
  return r;
}

describe("regreso de Stripe Checkout", () => {
  it("/billing/success: pago recibido o en proceso y enlace al login de la vertical; nunca muestra el session_id", async () => {
    rendered = await renderEn("/billing/success?organization_id=00000000-0000-4000-8000-000000000001&vertical=citas&session_id=cs_test_secreto");
    expect(rendered.container.querySelector("h1")?.textContent).toBe("Gracias por tu pago");
    // Con OXXO/SPEI Stripe regresa a success_url antes de cobrar: la pantalla no puede afirmar que el pago ya se confirmó.
    expect(rendered.container.textContent).toContain("Recibimos tu pago o está en proceso");
    expect(rendered.container.textContent).not.toMatch(/confirm[oó] tu pago|Pago recibido/);
    expect(rendered.container.textContent).not.toContain("No encontramos esta página");
    expect(rendered.container.textContent).not.toContain("cs_test_secreto");
    const ir = [...rendered.container.querySelectorAll("a")].find((a) => a.textContent === "Ir a mi panel");
    expect(ir?.getAttribute("href")).toBe("/citas/login");
  });

  it("/billing/cancel: sin cargo y enlace al login de la vertical", async () => {
    rendered = await renderEn("/billing/cancel?organization_id=00000000-0000-4000-8000-000000000001&vertical=restaurantes");
    expect(rendered.container.querySelector("h1")?.textContent).toBe("No se completó el pago");
    const ir = [...rendered.container.querySelectorAll("a")].find((a) => a.textContent === "Ir a mi panel");
    expect(ir?.getAttribute("href")).toBe("/restaurantes/login");
  });

  it("vertical desconocida o ausente: manda a la portada (sin redireccion abierta)", () => {
    expect(destinoRegresoBilling(null)).toBe("/");
    expect(destinoRegresoBilling("https://evil.example")).toBe("/");
    expect(destinoRegresoBilling("despachos")).toBe("/despachos/login");
  });
});
