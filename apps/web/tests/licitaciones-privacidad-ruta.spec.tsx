// @vitest-environment jsdom
//
// L-20: la privacidad de la organizacion (PL-13) se abre desde la consola de licitaciones en /licitaciones/:orgSlug/privacidad.
// owner/admin ve la pantalla real (GET /v1/privacidad/resumen con su token); cualquier otro rol ve el estado denegado SIN
// llamar a la API. Se monta el App real (BrowserRouter sobre la URL de jsdom) con la sesion guardada del vertical.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import type { BranchOption } from "../src/verticals/licitaciones/lib/admin-client.ts";
import { esperarHasta, esperarRutaCargada, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

vi.mock("../src/verticals/licitaciones/lib/admin-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/verticals/licitaciones/lib/admin-client.ts")>();
  return { ...actual, fetchBranches: async (): Promise<readonly BranchOption[]> => [{ propertyId: "prop-1", name: "Empresa Demo" }] };
});

vi.mock("../src/lib/useNotifications.ts", () => ({
  useNotifications: () => ({ items: [], unreadCount: 0, loading: false, refetch: () => {}, onMarkRead: () => {}, onMarkAllRead: () => {} }),
}));

const RESUMEN = {
  disponible: true,
  plazos: { respuestaDias: 20, ejecucionDias: 15, porVencerDias: 5 },
  arco: { total: 1, solicitudes: [{ vertical: "hoteles", id: "aaaaaaaa-1111-4111-8111-111111111111", referencia: "AAAAAAAA", derecho: "acceso", canal: "web", estado: "abierta", estadoOriginal: "recibida", abiertaEnMs: Date.UTC(2026, 8, 1), respuestaVenceEnMs: null, ejecucionVenceEnMs: null, resueltaEnMs: null, abierta: true, plazo: { estado: "en_plazo", diasRestantes: 12, venceEnMs: null } }] },
  retencion: [{ claseDato: "restaurantes_whatsapp_conversaciones", vertical: "restaurantes", descripcion: "Mensajes de WhatsApp.", ejecuta: "plataforma", defectoDias: 180, minimoDias: 30, maximoDias: 1095, diasEfectivos: 180, origen: "defecto" }],
  bloqueos: [],
  purgas: [],
  avisos: [],
};

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  installMatchMediaStub();
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  window.history.pushState({}, "", "/");
  vi.unstubAllGlobals();
});

async function abrirPrivacidad(rol: string) {
  installMemoryLocalStorage().setItem(
    "atiende.licitaciones.session",
    JSON.stringify({ token: "tok", refreshToken: "reftok", email: "u@example.com", fullName: "Usuario Demo", organizations: [{ id: "org-1", slug: "demo", nombre: "Demo", vertical: "licitaciones", rol }] }),
  );
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith("/v1/privacidad/resumen")) return { ok: true, status: 200, json: async () => RESUMEN } as unknown as Response;
    return { ok: false, status: 404, json: async () => ({ message: "sin ruta" }) } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  window.history.pushState({}, "", "/licitaciones/demo/privacidad");
  rendered = renderComponent(<App />);
  await esperarRutaCargada(rendered!.container);
  await act(async () => {
    for (let i = 0; i < 12; i++) await flushMicrotasks();
  });
  // La página de privacidad es otro chunk lazy que el shell monta recién cuando la sesión está lista.
  await esperarRutaCargada(rendered.container);
  const contenedor = rendered.container;
  await esperarHasta(() => /Privacidad de la organización|Solo el owner o un admin/.test(contenedor.textContent ?? ""), "la página de privacidad (chunk lazy)");
  await act(async () => {
    for (let i = 0; i < 12; i++) await flushMicrotasks();
  });
}

const llamadasPrivacidad = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/v1/privacidad/"));

describe("licitaciones -- ruta /privacidad (L-20)", () => {
  it.each(["owner", "admin"])("%s ve la privacidad de la organizacion (ARCO y retencion) con su token", async (rol) => {
    await abrirPrivacidad(rol);
    const texto = rendered!.container.textContent!;
    expect(texto).toContain("Privacidad de la organización");
    expect(texto).toContain("Licitaciones todavía no registra solicitudes ARCO propias");
    expect(texto).toContain("AAAAAAAA");
    expect(llamadasPrivacidad()).toHaveLength(1);
    const [, init] = llamadasPrivacidad()[0]!;
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it.each(["viewer", "analyst", "writer", "reviewer"])("%s ve el estado denegado y no llama a la API de privacidad", async (rol) => {
    await abrirPrivacidad(rol);
    expect(rendered!.container.textContent).toContain("Solo el owner o un admin de la organización puede administrar la privacidad.");
    expect(rendered!.container.textContent).not.toContain("AAAAAAAA");
    expect(llamadasPrivacidad()).toHaveLength(0);
  });
});
