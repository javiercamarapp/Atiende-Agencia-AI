// @vitest-environment jsdom
//
// UX restaurantes: (1) la barra superior del shell ("Chatea con tus datos", campana y fecha) esta en TODAS las rutas del panel,
// no solo en el Resumen: la monta el `VerticalShell` una sola vez, ninguna pagina decide su barra; (2) el Copiloto lleva su
// nombre ("Pregunta a tus datos") en la barra como las demas paginas; (3) las categorias del Copiloto de restaurantes salen en
// el orden VENTAS, OPERACION, CLIENTES, CFO. Reloj fijo (solo `Date`); no se lee `process.env.TZ`.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { COPILOTO_RESTAURANTES } from "../src/lib/copiloto/config/restaurantes.ts";
import { esperarRutaCargada, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const SESSION = {
  token: "tok",
  refreshToken: "ref",
  email: "owner@example.com",
  fullName: "Owner",
  organizations: [{ id: "org-1", slug: "demo", nombre: "Demo", vertical: "restaurantes", rol: "owner" }],
};

// Todas las rutas con shell de `App.tsx` (sin /repartidor, que es otro panel a proposito, ni el login).
const RUTAS = [
  "",
  "/productos",
  "/sucursales",
  "/pedidos",
  "/comandas-pos",
  "/historial",
  "/clientes",
  "/clientes/cli-1",
  "/staff",
  "/promociones",
  "/auditoria",
  "/configuracion",
  "/agente-voz",
  "/agente-ajustes",
  "/agente-whatsapp",
  "/cierres",
  "/campanas",
  "/privacidad",
  "/privacidad-organizacion",
  "/conversaciones",
  "/turnos",
  "/avisos",
  "/copiloto",
  "/cfo",
  "/primeros-pasos",
  "/notificaciones",
  "/plan",
  "/seguridad",
  "/ruta-que-no-existe",
];

let rendered: RenderedComponent | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T15:00:00.000Z"));
  installMatchMediaStub();
  installMemoryLocalStorage().setItem("atiende.restaurantes.session", JSON.stringify(SESSION));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const cuerpo = String(url).includes("/admin/branches") ? { branches: [{ propertyId: "p1", name: "Centro" }] } : { items: [], unreadCount: 0 };
      return new Response(JSON.stringify(cuerpo), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.pushState({}, "", "/");
});

async function renderEn(ruta: string): Promise<HTMLElement> {
  window.history.pushState({}, "", `/restaurantes/demo${ruta}`);
  rendered = renderComponent(<App />);
  await esperarRutaCargada(rendered.container);
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
  return rendered.container;
}

describe("restaurantes: la barra superior esta en cada ruta del panel", () => {
  it.each(RUTAS)("/restaurantes/demo%s lleva la barra con Chatea con tus datos, campana y fecha", async (ruta) => {
    const c = await renderEn(ruta);
    const barras = c.querySelectorAll('[data-testid="barra-pagina"]');
    expect(barras, "una sola barra por pantalla").toHaveLength(1);
    const barra = barras[0] as HTMLElement;
    expect(barra.textContent).toContain("Chatea con tus datos");
    expect(barra.querySelector('a[href$="/notificaciones"]'), "campana").not.toBeNull();
    expect(barra.querySelector('[data-testid="barra-pagina-fecha"]')?.textContent?.trim()).toBe("8 oct 2026");
    expect((barra.querySelector('[data-testid="barra-pagina-titulo"]')?.textContent ?? "").trim().length).toBeGreaterThan(0);
    // Mismo lugar y estilo siempre: es el primer hijo de la columna de contenido (la barra no vive dentro de la pagina).
    expect(barra.closest("main"), "la barra va fuera del <main> de la pagina").toBeNull();
  });
});

describe("restaurantes: Copiloto con encabezado y tarjetas en orden", () => {
  it("la barra lleva el nombre del Copiloto igual que las demas paginas", async () => {
    const c = await renderEn("/copiloto");
    expect(c.querySelector('[data-testid="barra-pagina-titulo"]')?.textContent).toBe("Pregunta a tus datos");
    expect(c.querySelector('[data-testid="barra-pagina"] svg'), "icono de la pagina").not.toBeNull();
  });

  it("las categorias de la config salen como VENTAS, OPERACION, CLIENTES, CFO", () => {
    expect(COPILOTO_RESTAURANTES.categorias.map((k) => k.titulo)).toEqual(["Ventas", "Operación", "Clientes", "CFO"]);
  });
});
