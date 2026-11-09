// @vitest-environment jsdom
//
// «Tu restaurante listo en 30 minutos»: pinta los pasos del servidor con minutos restantes; «Confirmo» llama al endpoint real y recarga;
// «Activar sucursal» va a la activacion de la 0071 y queda deshabilitado mientras falten menu, horario o zonas.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { RestaurantesPrimerValorPage } from "../src/verticals/restaurantes/pages/PrimerValor.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { click, esperarHasta, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Jefa", staffEmail: "j@example.com" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const paso = (id: string, estado: string, pantalla: string | null = null) => ({ id, titulo: `Paso ${id}`, detalle: "d", estado, minutos: 5, pantalla });
const PV = (puedeActivar: boolean, pago = "pendiente") => ({
  sucursal: { propertyId: "prop-1", nombre: "Centro", status: "inactive" },
  pasos: [paso("menu", "hecho", "productos"), paso("horario", puedeActivar ? "hecho" : "pendiente", "sucursales"), paso("zonas", "hecho", "sucursales"), paso("metodos_pago", pago), paso("probar_agente", "pendiente", "agente-whatsapp"), paso("activar", "pendiente")],
  hechos: 2,
  minutosRestantes: 16,
  puedeActivar,
  listo: false,
});

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const montar = () =>
  renderComponent(
    <MemoryRouter>
      <RestaurantesPrimerValorPage {...CTX} />
    </MemoryRouter>,
  );
const boton = (texto: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement | undefined;

describe("RestaurantesPrimerValorPage", () => {
  it("muestra avance y minutos; activar deshabilitado mientras falta horario; enlaces a la pantalla de cada paso", async () => {
    fetchMock.mockResolvedValue(json(PV(false)));
    rendered = montar();
    await esperarHasta(() => rendered!.container.textContent!.includes("16 minutos"), "avance");
    expect(rendered.container.textContent).toContain("Centro: 2 de 6 pasos");
    expect(boton("Activar sucursal")!.disabled).toBe(true);
    const hrefs = [...rendered.container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(expect.arrayContaining(["/restaurantes/demo/sucursales", "/restaurantes/demo/agente-whatsapp", "/restaurantes/demo/primeros-pasos"]));
  });

  it("Confirmo metodos de pago llama al endpoint y recarga; Activar llama a la activacion de la 0071", async () => {
    fetchMock.mockResolvedValueOnce(json(PV(true)));
    rendered = montar();
    await esperarHasta(() => boton("Confirmo") !== undefined, "boton confirmar");
    fetchMock.mockResolvedValueOnce(json({ ok: true })).mockResolvedValueOnce(json(PV(true, "hecho")));
    click(boton("Confirmo")!);
    await esperarHasta(() => boton("Confirmo") === undefined, "recarga");
    expect(fetchMock.mock.calls[1]![0]).toBe("https://api.test/v1/restaurantes/prop-1/admin/primer-valor/metodos-pago");
    fetchMock.mockResolvedValueOnce(json({ status: "active" })).mockResolvedValueOnce(json(PV(true, "hecho")));
    click(boton("Activar sucursal")!);
    await esperarHasta(() => fetchMock.mock.calls.length >= 5, "activar");
    expect(fetchMock.mock.calls[3]![0]).toBe("https://api.test/v1/restaurantes/demo/admin/alta-sucursal/prop-1/activar");
  });
});
