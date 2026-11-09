// @vitest-environment jsdom
//
// R-33: pagina "Primeros pasos" y su cliente. El estado lo calcula el servidor; aqui se verifica que se muestre tal cual (con
// responsable y enlace), que un error no se disfrace de checklist vacio y que el nav la ofrezca solo a owner/admin.
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchOnboarding } from "../src/verticals/restaurantes/lib/onboarding-client.ts";
import { gateOmitido } from "../src/verticals/restaurantes/lib/onboarding-client.ts";
import { PuertaOnboarding } from "../src/verticals/restaurantes/PuertaOnboarding.tsx";
import { RestaurantesPrimerosPasosPage } from "../src/verticals/restaurantes/pages/PrimerosPasos.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Jefa", staffEmail: "j@example.com" };

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

const CHECKLIST = {
  items: [
    { id: "menu", titulo: "Menú por sucursal", estado: "hecho", obligatorio: true, detalle: "Todas las sucursales activas tienen menú con precios.", faltantes: [], responsable: "plataforma", pantalla: "productos" },
    { id: "coordenadas", titulo: "Coordenadas de cada sucursal", estado: "parcial", obligatorio: false, detalle: "Sin coordenadas: Pensiones.", faltantes: ["Pensiones"], responsable: "dueno", pantalla: "sucursales" },
    { id: "whatsapp", titulo: "Número de WhatsApp por sucursal", estado: "pendiente", obligatorio: false, detalle: "Ningún número conectado.", faltantes: ["Altabrisa"], responsable: "meta", pantalla: "configuracion" },
    { id: "catalogo_pos", titulo: "Catálogo de SoftRestaurant (códigos de producto)", estado: "externo", obligatorio: false, detalle: "Depende del distribuidor del POS.", faltantes: [], responsable: "distribuidor_pos", pantalla: "configuracion" },
  ],
  resumen: { hechos: 1, total: 4, obligatoriosPendientes: 0 },
  listoParaOperar: true,
  gate: { bloquea: false, obligatoriosPendientes: 0, operaConPedidos: false },
};

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

describe("fetchOnboarding", () => {
  it("GET a .../admin/onboarding con el token; una respuesta sin items se rechaza (no se disfraza de checklist vacio)", async () => {
    fetchMock.mockResolvedValueOnce(json(CHECKLIST));
    const r = await fetchOnboarding(fetchMock as unknown as typeof fetch, "https://api.test", "tok", "prop-1");
    expect(r.items).toHaveLength(4);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.test/v1/restaurantes/prop-1/admin/onboarding");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ authorization: "Bearer tok" });
    fetchMock.mockResolvedValueOnce(json({ nada: true }));
    await expect(fetchOnboarding(fetchMock as unknown as typeof fetch, "https://api.test", "tok", "prop-1")).rejects.toThrow(/checklist/);
  });
});

describe("RestaurantesPrimerosPasosPage", () => {
  // QA-restaurantes-R1-viaje-13: un punto en "Listo" no muestra "Falta en: <sucursales inactivas>".
  it("un punto 'hecho' con faltantes (sucursales inactivas) no pinta 'Falta en:'", async () => {
    const checklist = { ...CHECKLIST, items: [{ ...CHECKLIST.items[0]!, id: "sucursales", titulo: "Sucursales activas", detalle: "1 sucursal(es) activa(s) de 2 registrada(s) (inactivas: Vieja).", faltantes: ["Vieja"] }] };
    fetchMock.mockResolvedValue(json(checklist));
    rendered = renderComponent(
      <MemoryRouter>
        <RestaurantesPrimerosPasosPage {...CTX} />
      </MemoryRouter>,
    );
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("inactivas: Vieja");
    expect(t).not.toContain("Falta en:");
  });

  it("muestra el estado real: listo/parcial/pendiente/tercero, faltantes, responsable y enlace a la pantalla", async () => {
    fetchMock.mockResolvedValue(json(CHECKLIST));
    rendered = renderComponent(
      <MemoryRouter>
        <RestaurantesPrimerosPasosPage {...CTX} />
      </MemoryRouter>,
    );
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Primeros pasos");
    expect(t).toContain("Listo para operar");
    expect(t).toContain("1 de 4 puntos listos");
    expect(t).toContain("Falta en: Pensiones");
    expect(t).toContain("Lo cierra: Dueño");
    expect(t).toContain("Lo cierra: Meta (WhatsApp Business)");
    expect(t).toContain("Depende de un tercero");
    const enlaces = Array.from(rendered.container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(enlaces).toContain("/restaurantes/demo/sucursales");
    expect(enlaces).toContain("/restaurantes/demo/configuracion");
    // Un punto ya hecho no ofrece enlace ni "Lo cierra".
    expect(enlaces).not.toContain("/restaurantes/demo/productos");
  });

  it("bloqueado: avisa los obligatorios pendientes", async () => {
    fetchMock.mockResolvedValue(json({ ...CHECKLIST, listoParaOperar: false, resumen: { hechos: 1, total: 4, obligatoriosPendientes: 2 } }));
    rendered = renderComponent(
      <MemoryRouter>
        <RestaurantesPrimerosPasosPage {...CTX} />
      </MemoryRouter>,
    );
    await esperar();
    expect(rendered.container.textContent).toContain("Faltan puntos obligatorios");
    expect(rendered.container.textContent).toContain("2 obligatorio(s) pendiente(s)");
  });

  it("error del servidor: muestra el error con reintento (nunca un checklist vacio) y Actualizar vuelve a pedir", async () => {
    fetchMock.mockResolvedValueOnce(json({ message: "boom" }, 500)).mockResolvedValue(json(CHECKLIST));
    rendered = renderComponent(
      <MemoryRouter>
        <RestaurantesPrimerosPasosPage {...CTX} />
      </MemoryRouter>,
    );
    await esperar();
    expect(rendered.container.textContent).not.toContain("Listo para operar");
    const boton = Array.from(rendered.container.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("Actualizar"))!;
    await act(async () => click(boton));
    await esperar();
    expect(rendered.container.textContent).toContain("Listo para operar");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("R-33: gate de onboarding (puerta del shell + 'Ir al panel de todos modos')", () => {
  const GATE_BLOQUEA = { bloquea: true, obligatoriosPendientes: 2, operaConPedidos: false, listoParaOperar: false };
  const montar = (role: string, ruta = "/restaurantes/demo") =>
    renderComponent(
      <MemoryRouter initialEntries={[ruta]}>
        <Routes>
          <Route
            path="/restaurantes/demo/*"
            element={
              <PuertaOnboarding apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" orgSlug="demo" role={role}>
                <p>PANEL-RESUMEN</p>
              </PuertaOnboarding>
            }
          />
          <Route path="/restaurantes/demo/primeros-pasos" element={<p>PANTALLA-PRIMEROS-PASOS</p>} />
        </Routes>
      </MemoryRouter>,
    );

  beforeEach(() => window.sessionStorage.clear());

  it("owner con obligatorios pendientes y sin pedidos: aterriza en primeros-pasos", async () => {
    fetchMock.mockResolvedValue(json(GATE_BLOQUEA));
    rendered = montar("owner");
    await esperar();
    expect(rendered.container.textContent).toContain("PANTALLA-PRIMEROS-PASOS");
    expect(rendered.container.textContent).not.toContain("PANEL-RESUMEN");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.test/v1/restaurantes/prop-1/admin/onboarding/gate");
  });

  it("admin tambien; staff y repartidor NO aterrizan en primeros-pasos ni consultan el gate", async () => {
    fetchMock.mockResolvedValue(json(GATE_BLOQUEA));
    rendered = montar("admin");
    await esperar();
    expect(rendered.container.textContent).toContain("PANTALLA-PRIMEROS-PASOS");
    rendered.unmount();
    fetchMock.mockClear();
    for (const rol of ["staff", "repartidor"]) {
      rendered = montar(rol);
      await esperar();
      expect(rendered.container.textContent).toContain("PANEL-RESUMEN");
      expect(rendered.container.textContent).not.toContain("Faltan puntos obligatorios");
      rendered.unmount();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("'Ir al panel de todos modos' dura solo la sesion: tras omitir, el Resumen se muestra con el banner de pendientes", async () => {
    fetchMock.mockResolvedValue(json({ ...CHECKLIST, listoParaOperar: false, resumen: { hechos: 1, total: 4, obligatoriosPendientes: 2 }, gate: { bloquea: true, obligatoriosPendientes: 2, operaConPedidos: false } }));
    rendered = renderComponent(
      <MemoryRouter initialEntries={["/restaurantes/demo/primeros-pasos"]}>
        <Routes>
          <Route path="/restaurantes/demo/primeros-pasos" element={<RestaurantesPrimerosPasosPage {...CTX} />} />
          <Route
            path="/restaurantes/demo"
            element={
              <PuertaOnboarding apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" orgSlug="demo" role="owner">
                <p>PANEL-RESUMEN</p>
              </PuertaOnboarding>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    await esperar();
    expect(gateOmitido("demo")).toBe(false);
    const boton = Array.from(rendered.container.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("Ir al panel de todos modos"))!;
    fetchMock.mockResolvedValue(json(GATE_BLOQUEA));
    await act(async () => click(boton));
    await esperar();
    expect(gateOmitido("demo")).toBe(true);
    expect(rendered.container.textContent).toContain("PANEL-RESUMEN");
    expect(rendered.container.textContent).toContain("Faltan puntos obligatorios de configuración");
    expect(rendered.container.textContent).toContain("2 punto(s) obligatorio(s) pendiente(s)");
    expect(Array.from(rendered.container.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toContain("/restaurantes/demo/primeros-pasos");
  });

  it("sin bloqueo (org con pedidos) y con pendientes: no redirige, solo banner; sin pendientes: ni banner", async () => {
    fetchMock.mockResolvedValue(json({ bloquea: false, obligatoriosPendientes: 1, operaConPedidos: true, listoParaOperar: false }));
    rendered = montar("owner");
    await esperar();
    expect(rendered.container.textContent).toContain("PANEL-RESUMEN");
    expect(rendered.container.textContent).toContain("1 punto(s) obligatorio(s) pendiente(s)");
    rendered.unmount();
    fetchMock.mockResolvedValue(json({ bloquea: false, obligatoriosPendientes: 0, operaConPedidos: false, listoParaOperar: true }));
    rendered = montar("owner");
    await esperar();
    expect(rendered.container.textContent).toContain("PANEL-RESUMEN");
    expect(rendered.container.textContent).not.toContain("Faltan puntos obligatorios");
  });

  it("si la consulta del gate falla, la puerta se abre (nadie queda fuera de su panel)", async () => {
    fetchMock.mockResolvedValue(json({ message: "boom" }, 500));
    rendered = montar("owner");
    await esperar();
    expect(rendered.container.textContent).toContain("PANEL-RESUMEN");
    expect(rendered.container.textContent).not.toContain("PANTALLA-PRIMEROS-PASOS");
  });

  it("solo actua en el Resumen: otra pantalla del panel no consulta el gate", async () => {
    rendered = montar("owner", "/restaurantes/demo/pedidos");
    await esperar();
    expect(rendered.container.textContent).toContain("PANEL-RESUMEN");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
