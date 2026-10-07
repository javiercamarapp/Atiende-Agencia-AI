// @vitest-environment jsdom
//
// H-P3-06: pagina "Primeros pasos" de hoteles, su cliente y el gate. El estado lo calcula el servidor; aqui se verifica que se muestre tal cual
// (con responsable y enlace a la pantalla, incluida la pestana de Configuracion), que un error no se disfrace de checklist vacio y que el gate
// solo aplique a owner/gm, se pueda omitir (con aviso a la bitacora) y nunca deje a nadie fuera si la consulta falla.
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchOnboarding, gateOmitido } from "../src/verticals/hoteles/lib/onboarding-client.ts";
import { PuertaOnboarding } from "../src/verticals/hoteles/PuertaOnboarding.tsx";
import { enlaceDePaso, PrimerosPasosPage } from "../src/verticals/hoteles/pages/PrimerosPasos.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

const CTX: HotelesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Jefa", staffEmail: "j@example.com" };

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

const CHECKLIST = {
  bloquea: false,
  obligatoriosPendientes: 0,
  operaConReservas: false,
  listoParaOperar: true,
  nochesRequeridas: 30,
  resumen: { hechos: 1, total: 4, obligatoriosPendientes: 0 },
  items: [
    { id: "tipos_habitacion", titulo: "Tipos de habitación", estado: "hecho", obligatorio: true, detalle: "2 tipo(s) de habitación creados.", responsable: "dueno", pantalla: "catalogo" },
    { id: "impuestos", titulo: "Impuestos revisados", estado: "pendiente", obligatorio: false, detalle: "Todavía no guardas tus impuestos.", responsable: "dueno", pantalla: "configuracion", pestana: "impuestos" },
    { id: "whatsapp", titulo: "WhatsApp conectado", estado: "parcial", obligatorio: false, detalle: "Hay un número registrado pero el canal está apagado.", responsable: "meta", pantalla: "mensajeria" },
    { id: "equipo", titulo: "Al menos un miembro del equipo", estado: "pendiente", obligatorio: false, detalle: "Solo tú tienes acceso.", responsable: "dueno", pantalla: "equipo" },
  ],
};
const BLOQUEA = { ...CHECKLIST, listoParaOperar: false, bloquea: true, obligatoriosPendientes: 2, resumen: { hechos: 1, total: 4, obligatoriosPendientes: 2 } };

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  window.sessionStorage.clear();
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const pagina = (ctx = CTX) =>
  renderComponent(
    <MemoryRouter>
      <PrimerosPasosPage {...ctx} />
    </MemoryRouter>,
  );

describe("fetchOnboarding", () => {
  it("GET a .../primeros-pasos con el token; una respuesta sin items se rechaza (no se disfraza de checklist vacio)", async () => {
    fetchMock.mockResolvedValueOnce(json(CHECKLIST));
    const r = await fetchOnboarding(fetchMock as unknown as typeof fetch, "https://api.test", "tok", "prop-1");
    expect(r.items).toHaveLength(4);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.test/hoteles/prop-1/primeros-pasos");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ authorization: "Bearer tok" });
    fetchMock.mockResolvedValueOnce(json({ nada: true }));
    await expect(fetchOnboarding(fetchMock as unknown as typeof fetch, "https://api.test", "tok", "prop-1")).rejects.toThrow(/checklist/);
  });
});

describe("enlaceDePaso", () => {
  it("lleva a la pestana exacta de Configuracion y a las demas pantallas sin pestana", () => {
    expect(enlaceDePaso("demo", CHECKLIST.items[1] as never)).toBe("/hoteles/demo/configuracion?tab=impuestos");
    expect(enlaceDePaso("demo", CHECKLIST.items[3] as never)).toBe("/hoteles/demo/equipo");
  });
});

describe("PrimerosPasosPage", () => {
  it("muestra el estado real con responsable y enlace; un paso hecho no ofrece enlace", async () => {
    fetchMock.mockResolvedValue(json(CHECKLIST));
    rendered = pagina();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Listo para operar");
    expect(t).toContain("1 de 4 puntos listos");
    expect(t).toContain("Lo cierra: Dueño");
    expect(t).toContain("Lo cierra: Meta (WhatsApp Business)");
    const enlaces = Array.from(rendered.container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(enlaces).toContain("/hoteles/demo/configuracion?tab=impuestos");
    expect(enlaces).toContain("/hoteles/demo/equipo");
    expect(enlaces).not.toContain("/hoteles/demo/catalogo");
  });

  it("bloqueado: avisa los obligatorios pendientes y ofrece 'Ir al panel de todos modos'", async () => {
    fetchMock.mockResolvedValue(json(BLOQUEA));
    rendered = pagina();
    await esperar();
    expect(rendered.container.textContent).toContain("Faltan puntos obligatorios");
    expect(rendered.container.textContent).toContain("2 obligatorio(s) pendiente(s)");
    expect([...rendered.container.querySelectorAll("button")].some((b) => b.textContent?.includes("Ir al panel de todos modos"))).toBe(true);
  });

  it("un hotel que ya opera con reservas no ofrece omitir y lo explica", async () => {
    fetchMock.mockResolvedValue(json({ ...BLOQUEA, bloquea: false, operaConReservas: true }));
    rendered = pagina();
    await esperar();
    expect(rendered.container.textContent).toContain("ya opera con reservas");
    expect([...rendered.container.querySelectorAll("button")].some((b) => b.textContent?.includes("todos modos"))).toBe(false);
  });

  it("error del servidor: muestra el error con reintento (nunca un checklist vacio) y Actualizar vuelve a pedir", async () => {
    fetchMock.mockResolvedValueOnce(json({ message: "boom" }, 500)).mockResolvedValue(json(CHECKLIST));
    rendered = pagina();
    await esperar();
    expect(rendered.container.textContent).not.toContain("Listo para operar");
    const actualizar = [...rendered.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Actualizar"))!;
    await act(async () => click(actualizar));
    await esperar();
    expect(rendered.container.textContent).toContain("Listo para operar");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("un rol distinto de owner/gm no consulta nada y lo explica", async () => {
    rendered = pagina({ ...CTX, role: "frontdesk" });
    await esperar();
    expect(rendered.container.textContent).toContain("propietario o el gerente general");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("gate de onboarding (puerta del shell + 'Ir al panel de todos modos')", () => {
  const montar = (role: string, ruta = "/hoteles/demo") =>
    renderComponent(
      <MemoryRouter initialEntries={[ruta]}>
        <Routes>
          <Route
            path="/hoteles/demo/*"
            element={
              <PuertaOnboarding apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" orgSlug="demo" role={role}>
                <p>PANEL-RESUMEN</p>
              </PuertaOnboarding>
            }
          />
          <Route path="/hoteles/demo/primeros-pasos" element={<p>PANTALLA-PRIMEROS-PASOS</p>} />
        </Routes>
      </MemoryRouter>,
    );

  it("owner y gm con obligatorios pendientes y sin reservas aterrizan en primeros-pasos", async () => {
    for (const rol of ["owner", "gm"]) {
      fetchMock.mockResolvedValue(json(BLOQUEA));
      rendered = montar(rol);
      await esperar();
      expect(rendered.container.textContent).toContain("PANTALLA-PRIMEROS-PASOS");
      expect(rendered.container.textContent).not.toContain("PANEL-RESUMEN");
      rendered.unmount();
      rendered = undefined;
    }
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.test/hoteles/prop-1/primeros-pasos");
  });

  it("los demas roles nunca consultan el gate ni ven el banner", async () => {
    fetchMock.mockResolvedValue(json(BLOQUEA));
    for (const rol of ["frontdesk", "accountant", "housekeeping"]) {
      rendered = montar(rol);
      await esperar();
      expect(rendered.container.textContent).toContain("PANEL-RESUMEN");
      expect(rendered.container.textContent).not.toContain("Faltan puntos obligatorios");
      rendered.unmount();
      rendered = undefined;
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("una pagina que no es el Resumen no consulta el gate", async () => {
    rendered = montar("owner", "/hoteles/demo/reservas");
    await esperar();
    expect(rendered.container.textContent).toContain("PANEL-RESUMEN");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("si la consulta falla la puerta se abre: nadie queda fuera de su panel", async () => {
    fetchMock.mockResolvedValue(json({ message: "boom" }, 500));
    rendered = montar("owner");
    await esperar();
    expect(rendered.container.textContent).toContain("PANEL-RESUMEN");
  });

  it("'Ir al panel de todos modos' avisa al servidor (bitacora), recuerda la omision y el Resumen sale con el banner de pendientes", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === "POST" ? json({ omitido: true, registrada: true }) : json(BLOQUEA)));
    rendered = renderComponent(
      <MemoryRouter initialEntries={["/hoteles/demo/primeros-pasos"]}>
        <Routes>
          <Route path="/hoteles/demo/primeros-pasos" element={<PrimerosPasosPage {...CTX} />} />
          <Route
            path="/hoteles/demo"
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
    const omitir = [...rendered.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Ir al panel de todos modos"))!;
    await act(async () => click(omitir));
    await esperar();
    await esperar();
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST");
    expect(post?.[0]).toBe("https://api.test/hoteles/prop-1/primeros-pasos/omitir");
    expect(gateOmitido("demo")).toBe(true);
    expect(rendered.container.textContent).toContain("PANEL-RESUMEN");
    expect(rendered.container.textContent).toContain("Faltan puntos obligatorios de configuración");
  });

  it("si omitir falla en el servidor NO se recuerda la omision ni se navega", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === "POST" ? json({ message: "no" }, 500) : json(BLOQUEA)));
    rendered = pagina();
    await esperar();
    const omitir = [...rendered.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Ir al panel de todos modos"))!;
    await act(async () => click(omitir));
    await esperar();
    expect(gateOmitido("demo")).toBe(false);
  });
});
