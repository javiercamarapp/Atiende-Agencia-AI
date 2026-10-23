// @vitest-environment jsdom
//
// H-29 -- <MensajeriaPage />: fetch mockeado por ruta real contra apps/api/.../hoteles/mensajeria-config.ts. Cubre el gating por rol,
// guardar el canal (valida el numero), y que el secreto de voz se muestre UNA vez y no se guarde en el navegador.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));

import { MensajeriaPage } from "../src/verticals/hoteles/pages/Mensajeria.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CTX: HotelesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Ana", staffEmail: "ana@example.com" };
const SECRETO = "a".repeat(64);
const M = "https://api.test/hoteles/prop-1/mensajeria";

function stub(estado = { whatsapp: { configurado: false, phoneNumberId: null, habilitado: false, actualizadoEn: null }, voz: { configurado: false, habilitado: false, secretoConfigurado: false, actualizadoEn: null } }) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as unknown as Response;
    if (method === "GET" && url === M) return json(estado);
    // H-P3-03: la seccion "Mensajes automaticos" (su propio spec: hoteles-mensajes-huesped-page.spec.tsx) consulta estos dos endpoints.
    if (method === "GET" && url === "https://api.test/hoteles/prop-1/mensajes-huesped") return json({ disponible: false, catalogoDisponible: false, puedeConfigurar: true, whatsapp: { canalConfigurado: false, canalHabilitado: false, credencialMeta: false, listo: false, aviso: null }, ventanaGraciaHoras: 24, horasAntesPorOmision: 48, horasAntesMin: 1, horasAntesMax: 336, horaPostEstancia: 12, estadosPlantilla: [], eventos: [] });
    if (method === "GET" && url === "https://api.test/hoteles/prop-1/mensajes-huesped/historial?limite=30") return json({ disponible: false, envios: [] });
    // La tarjeta "Probar el agente de voz" consulta el estado de la escalera (sin credenciales en estos casos).
    if (method === "GET" && url === "https://api.test/hoteles/prop-1/voz/estado") return json({ agente: { configurado: false, habilitado: false }, escalera: { operativa: false, escalones: [] }, precioMicroUsdPorMinuto: { "gemini-3.8-live": 18000, "cascada-openrouter": 14000 }, preview: { disponible: false, motivo: "requiere GEMINI_API_KEY" } });
    if (method === "PUT" && url === `${M}/whatsapp`) return json({ configurado: true, phoneNumberId: "12345678", habilitado: true, actualizadoEn: "2026-03-10T10:00:00Z" });
    if (method === "POST" && url === `${M}/voz/rotar-secreto`) return json({ configurado: true, habilitado: false, secretoConfigurado: true, actualizadoEn: "x", secreto: SECRETO, aviso: "x" });
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
async function esperar() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await flushMicrotasks();
  });
}
const botones = (r: RenderedComponent) => [...r.container.querySelectorAll("button")];

describe("MensajeriaPage (hoteles)", () => {
  it("solo owner/gm: otro rol ve el aviso y NO se llama a la API", async () => {
    stub();
    rendered = renderComponent(<MensajeriaPage {...CTX} role="frontdesk" />);
    await esperar();
    expect(rendered.container.textContent).toContain("Solo el dueño o la gerencia");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("guardar el canal exige un numero valido y llama a PUT /whatsapp con el cuerpo real", async () => {
    stub();
    rendered = renderComponent(<MensajeriaPage {...CTX} />);
    await esperar();
    const guardar = () => botones(rendered!).find((b) => b.textContent === "Guardar canal")!;
    expect(guardar().disabled).toBe(true);
    const input = rendered.container.querySelector("input[inputmode='numeric']") as HTMLInputElement;
    changeValue(input, "+52 55");
    expect(guardar().disabled).toBe(true);
    changeValue(input, "12345678");
    expect(guardar().disabled).toBe(false);
    await act(async () => {
      click(guardar());
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    const put = fetchMock.mock.calls.find((c) => c[0] === `${M}/whatsapp`)!;
    expect(JSON.parse(String(put[1].body))).toEqual({ phoneNumberId: "12345678", habilitado: false });
  });

  it("generar el secreto lo muestra una vez y no lo guarda en el navegador; la lectura nunca lo trae", async () => {
    stub();
    rendered = renderComponent(<MensajeriaPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).not.toContain(SECRETO);
    const generar = botones(rendered).find((b) => b.textContent === "Generar secreto")!;
    await act(async () => {
      click(generar);
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(rendered.container.textContent).toContain(SECRETO);
    expect(rendered.container.textContent).toContain("No se vuelve a mostrar");
    expect(JSON.stringify({ ...globalThis.localStorage })).not.toContain(SECRETO);
    expect(JSON.stringify({ ...globalThis.sessionStorage })).not.toContain(SECRETO);
  });

  it("base sin migrar o error del servidor se muestra, no se oculta", async () => {
    fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: { message: "Fallo del servidor" } }), text: async () => "" }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderComponent(<MensajeriaPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Ocurrió un problema");
  });
});
