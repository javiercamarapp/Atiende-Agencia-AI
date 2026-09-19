// @vitest-environment jsdom
//
// Smoke tests de <SuperAdminIntegracionesPage /> — mismo patrón exacto que
// superadmin-gasto-api-page.spec.tsx (render/EstadoCargando/EstadoError, fetch
// global mockeado, sin cliente HTTP separado). Además del render con datos y el
// estado de error, esta suite verifica lo único que de verdad importa para esta
// pantalla: que JAMÁS aparezca nada que parezca un VALOR de secreto -- solo
// nombres de variable, nunca un valor con pinta de API key/token/contraseña.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminIntegracionesPage } from "../src/superadmin/pages/Integraciones.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

const INTEGRACIONES_EJEMPLO = [
  {
    id: "database",
    nombre: "Base de datos (Supabase Postgres)",
    configurada: true,
    faltantes: [],
    habilita: "El motor Postgres completo (todas las rutas de negocio de las 6 verticales).",
  },
  {
    id: "stripe",
    nombre: "Stripe (suscripción SaaS de Atiende + cobro a huésped en hoteles)",
    configurada: false,
    faltantes: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
    habilita: "Checkout/webhook de la suscripción SaaS y cobro con tarjeta al huésped de un folio de hoteles.",
  },
  {
    id: "resend-correo",
    nombre: "Resend (correo transaccional)",
    configurada: false,
    faltantes: ["RESEND_API_KEY"],
    habilita: "Envío real de correo transaccional.",
  },
];

function stubFetch(body: unknown, ok = true) {
  fetchMock = vi.fn(async () => jsonResponse(body, ok));
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  return renderComponent(<SuperAdminIntegracionesPage apiBaseUrl="https://api.test" token="tok-123" />);
}

describe("SuperAdminIntegracionesPage", () => {
  it("muestra el estado de carga primero, y después el resumen y las tarjetas agrupadas", async () => {
    stubFetch({ integraciones: INTEGRACIONES_EJEMPLO });
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando estado de integraciones");

    await esperarCarga();
    expect(rendered.container.textContent).toContain("Integraciones");
    expect(rendered.container.textContent).toContain("1 de 3");
    expect(rendered.container.textContent).toContain("Base de datos (Supabase Postgres)");
    expect(rendered.container.textContent).toContain("Stripe");
    expect(rendered.container.textContent).toContain("STRIPE_SECRET_KEY");
    expect(rendered.container.textContent).toContain("STRIPE_WEBHOOK_SECRET");
    expect(rendered.container.textContent).toContain("docs/CREDENCIALES.md");
  });

  it("estado vacío real en 'Listas' cuando ninguna integración está configurada todavía", async () => {
    stubFetch({
      integraciones: [{ id: "stripe", nombre: "Stripe", configurada: false, faltantes: ["STRIPE_SECRET_KEY"], habilita: "Cobro." }],
    });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("Todavía ninguna integración está completamente configurada");
  });

  it("estado vacío real en 'Falta pegar credenciales' cuando todo está configurado", async () => {
    stubFetch({
      integraciones: [{ id: "database", nombre: "Base de datos", configurada: true, faltantes: [], habilita: "Motor Postgres." }],
    });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("Todas las integraciones de este inventario están completas");
  });

  it("estado de error cuando el fetch falla -- nunca se queda atorado en 'Cargando'", async () => {
    fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("network down");
  });

  it("nunca muestra nada que parezca un VALOR de secreto -- solo nombres de variable y booleanos", async () => {
    const valorFalso = "sk-live-esto-jamas-deberia-aparecer-1234567890";
    stubFetch({
      integraciones: [
        { id: "stripe", nombre: "Stripe", configurada: false, faltantes: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"], habilita: "Cobro con tarjeta." },
      ],
    });
    rendered = renderPage();
    await esperarCarga();

    // El backend ya garantiza (apps/api/tests/superadmin-integraciones.spec.ts)
    // que nunca manda un valor -- esta prueba blinda que el FRONTEND tampoco lo
    // inventa ni lo filtra desde ningún otro lado (p.ej. `token`, que si se
    // imprimiera por accidente en la UI sería un secreto real de esta sesión).
    expect(rendered.container.textContent).not.toContain(valorFalso);
    expect(rendered.container.textContent).not.toContain("tok-123");
    expect(rendered.container.textContent).toContain("STRIPE_SECRET_KEY");
    expect(rendered.container.textContent).toContain("STRIPE_WEBHOOK_SECRET");
  });
});
