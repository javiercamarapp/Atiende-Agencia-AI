// @vitest-environment jsdom
//
// Smoke tests reales de <IdentidadPage /> (H-01): metadatos sin documento, estados honestos
// (base sin migrar / sin llave), revelar con motivo (cancelar el prompt NO llama a la API),
// ocultar, pestaña de purgas solo para owner/gm y mensaje real del doble control.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock, Toaster: () => null }));

import { IdentidadPage } from "../src/verticals/hoteles/pages/Identidad.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

const CTX: HotelesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "GM Demo", staffEmail: "gm@example.com" };

const IDENT = {
  id: "ident-1", huespedId: "guest-1", reservaId: "res-1", tipoDocumento: "pasaporte", nacionalidad: "USA", ultimos4: "5678", versionLlave: 1, estado: "activo",
  retencionHasta: "2027-03-01", verificadaEn: null, verificadaPor: null, capturadaPor: "u1", creadaEn: "2026-03-01T00:00:00Z", purgadaEn: null,
};
const PURGA = { id: "purga-1", identidadId: "ident-1", solicitadaPor: "owner-1", motivo: "Cancelacion ARCO del titular", estado: "pendiente", decididaPor: null, decididaEn: null, notaDecision: null, creadaEn: "2026-03-02T00:00:00Z" };

interface Opts {
  list?: unknown;
  purgas?: unknown;
  decideStatus?: number;
}

function stubFetch(opts: Opts = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = url.replace("https://api.test", "");
    if (method === "GET" && path.startsWith("/hoteles/prop-1/identidad-purgas")) return jsonResponse(opts.purgas ?? { disponible: true, items: [PURGA] });
    if (method === "GET" && path.startsWith("/hoteles/prop-1/identidad")) return jsonResponse(opts.list ?? { disponible: true, llaveConfigurada: true, items: [IDENT] });
    if (method === "GET" && path.startsWith("/hoteles/prop-1/registro-migratorio")) return jsonResponse({ disponible: true, items: [] });
    if (method === "GET" && path.startsWith("/hoteles/prop-1/huespedes")) return jsonResponse([{ id: "guest-1", nombreCompleto: "Ana Torres", email: null, telefono: null }]);
    if (method === "GET" && path.startsWith("/hoteles/prop-1/reservas")) return jsonResponse([]);
    if (method === "POST" && path === "/hoteles/prop-1/identidad/ident-1/revelar") {
      return jsonResponse({ identidad: IDENT, documento: { nombreCompleto: "Ana Torres", numeroDocumento: "G-1234 5678", fechaNacimiento: "1990-05-17", paisEmisor: null, vigenciaHasta: null, mrz: null } });
    }
    if (method === "POST" && path === "/hoteles/prop-1/identidad-purgas/purga-1/decidir") {
      return opts.decideStatus && opts.decideStatus >= 400
        ? jsonResponse({ message: "Doble control: quien solicita la purga no puede aprobarla ni rechazarla; debe decidirla otra persona con rol owner/gm." }, opts.decideStatus)
        : jsonResponse({ resultado: "ejecutada" });
    }
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(ctx: HotelesShellContext = CTX): RenderedComponent {
  return renderComponent(
    <MemoryRouter>
      <IdentidadPage {...ctx} />
    </MemoryRouter>,
  );
}

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

function buttonByText(text: string): HTMLButtonElement {
  return [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
}

async function clickButton(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

async function openTab(label: string): Promise<void> {
  await act(async () => {
    buttonByText(label).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("IdentidadPage (hoteles)", () => {
  it("lista SOLO metadatos: tipo, ****ultimos4, nacionalidad y retencion; ningun documento en claro", async () => {
    stubFetch();
    rendered = renderPage();
    await esperar();
    const text = rendered.container.textContent!;
    expect(text).toContain("Pasaporte ****5678 · USA");
    expect(text).toContain("Retención hasta 2027-03-01");
    expect(text).toContain("Sin verificar");
    expect(text).not.toContain("G-1234");
    expect(rendered.container.querySelector('[data-testid="documento-revelado"]')).toBeNull();
  });

  it("base sin migrar (disponible:false): estado honesto 'aun no esta disponible', sin formulario de captura", async () => {
    stubFetch({ list: { disponible: false, llaveConfigurada: true, items: [] } });
    rendered = renderPage();
    await esperar();
    expect(rendered.container.textContent).toContain("aún no está disponible");
    expect(rendered.container.querySelector('form[aria-label="Capturar identidad"]')).toBeNull();
  });

  it("sin llave de cifrado: avisa y NO ofrece capturar", async () => {
    stubFetch({ list: { disponible: true, llaveConfigurada: false, items: [] } });
    rendered = renderPage();
    await esperar();
    expect(rendered.container.textContent).toContain("Falta la llave de cifrado");
    expect(rendered.container.querySelector('form[aria-label="Capturar identidad"]')).toBeNull();
  });

  it("con llave y base lista: muestra el formulario de captura cifrada", async () => {
    stubFetch({ list: { disponible: true, llaveConfigurada: true, items: [] } });
    rendered = renderPage();
    await esperar();
    expect(rendered.container.querySelector('form[aria-label="Capturar identidad"]')).not.toBeNull();
    expect(rendered.container.textContent).toContain("Todavía no hay identidades capturadas");
  });

  it("el formulario de captura muestra el plazo que aplicara y el aviso de privacidad/consentimiento", async () => {
    stubFetch({ list: { disponible: true, llaveConfigurada: true, items: [] } });
    rendered = renderPage();
    await esperar();
    const plazo = rendered.container.querySelector('[data-testid="plazo-retencion"]')!;
    expect(plazo.textContent).toContain("30 día(s)");
    const nota = rendered.container.querySelector('[role="note"]')!.textContent!;
    expect(nota).toContain("aviso de privacidad");
    expect(nota).toContain("consentimiento");
    expect(nota).toContain("365 días");
  });

  it("cancelar el prompt del motivo NUNCA llama a revelar", async () => {
    stubFetch();
    vi.spyOn(window, "prompt").mockReturnValue(null);
    rendered = renderPage();
    await esperar();
    const antes = fetchMock.mock.calls.length;
    await clickButton(buttonByText("Revelar"));
    expect(fetchMock.mock.calls.length).toBe(antes);
    expect(rendered.container.querySelector('[data-testid="documento-revelado"]')).toBeNull();
  });

  it("revelar con motivo: POST con el motivo, muestra el documento y 'Ocultar' lo descarta", async () => {
    stubFetch();
    vi.spyOn(window, "prompt").mockReturnValue("Verificacion en mostrador al hacer check-in");
    rendered = renderPage();
    await esperar();
    await clickButton(buttonByText("Revelar"));
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/identidad/ident-1/revelar"))!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ motivo: "Verificacion en mostrador al hacer check-in" });
    const box = rendered.container.querySelector('[data-testid="documento-revelado"]')!;
    expect(box.textContent).toContain("Ana Torres");
    expect(box.textContent).toContain("G-1234 5678");

    await clickButton(buttonByText("Ocultar"));
    expect(rendered.container.querySelector('[data-testid="documento-revelado"]')).toBeNull();
    expect(rendered.container.textContent).not.toContain("G-1234");
  });

  it("rol reservations: captura/lista pero NO ve Revelar, Marcar verificada, Solicitar purga ni la pestana Purgas", async () => {
    stubFetch();
    rendered = renderPage({ ...CTX, role: "reservations" });
    await esperar();
    expect(buttonByText("Revelar")).toBeUndefined();
    expect(buttonByText("Marcar verificada")).toBeUndefined();
    expect(buttonByText("Solicitar purga")).toBeUndefined();
    expect(buttonByText("Purgas")).toBeUndefined();
  });

  it("frontdesk: puede revelar y verificar, pero no solicitar purga ni ve la pestana Purgas", async () => {
    stubFetch();
    rendered = renderPage({ ...CTX, role: "frontdesk" });
    await esperar();
    expect(buttonByText("Revelar")).toBeDefined();
    expect(buttonByText("Marcar verificada")).toBeDefined();
    expect(buttonByText("Solicitar purga")).toBeUndefined();
    expect(buttonByText("Purgas")).toBeUndefined();
  });

  it("pestana Purgas (owner): lista la solicitud pendiente y aprobar la ejecuta", async () => {
    stubFetch();
    vi.spyOn(window, "prompt").mockReturnValue("");
    rendered = renderPage();
    await esperar();
    await openTab("Purgas");
    expect(rendered.container.textContent).toContain("Cancelacion ARCO del titular");
    expect(rendered.container.textContent).toContain("Doble control");
    await clickButton(buttonByText("Aprobar purga"));
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/identidad-purgas/purga-1/decidir"))!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toMatchObject({ aprobar: true });
    expect(toastMock.success).toHaveBeenCalledWith("Purga ejecutada.");
  });

  it("doble control: si el servidor rechaza al solicitante (403), se muestra el mensaje real y NO hay toast de exito", async () => {
    stubFetch({ decideStatus: 403 });
    vi.spyOn(window, "prompt").mockReturnValue("");
    rendered = renderPage();
    await esperar();
    await openTab("Purgas");
    await clickButton(buttonByText("Aprobar purga"));
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining("Doble control"));
  });
});
