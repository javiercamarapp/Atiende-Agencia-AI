// @vitest-environment jsdom
//
// Smoke test real de <SuperAdminAccionesPage />, enfocado en el hallazgo de
// auditoría a1 (MEDIA): confirmar() leía solo el HTTP status y asumía éxito,
// pero POST .../confirmar responde 200 con { intent } también cuando
// intent.estado === 'failed' (la función SQL de 0016_superadmin_acciones.sql
// atrapa el error, guarda estado='failed' + error, y NO relanza). El fix lee
// `intent.estado` del cuerpo real de la respuesta -- estos tests cubren los
// dos resultados con esa forma exacta.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

// Se mockea "sonner" directo (no "@atiende/ui") porque packages/ui/src/components/ui/sonner.tsx
// solo reexporta `toast` de "sonner" -- mockear ahí abajo cubre la misma
// instancia de módulo que importa Acciones.tsx a través de "@atiende/ui".
vi.mock("sonner", () => ({ toast: toastMock, Toaster: () => null }));

import { SuperAdminAccionesPage } from "../src/superadmin/pages/Acciones.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

// El TabsTrigger de Radix cambia de pestaña en `onMouseDown` (no en `onClick`,
// para responder al instante sin esperar el `click` sintético) -- dispara
// ambos eventos, como haría un click real de mouse.
function clickTab(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
}

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
  toastMock.error.mockClear();
  toastMock.success.mockClear();
});

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const INTENT_PENDIENTE = {
  id: "intent-1",
  tipo: "reencolar_mensaje_muerto",
  payload: {},
  resumen: "Reencolar mensaje muerto de la organización X.",
  estado: "pending",
  creadoEn: "2026-09-19T10:00:00.000Z",
  venceEn: "2099-01-01T00:00:00.000Z",
  ejecutadoEn: null,
  resultado: null,
  error: null,
};

function stubFetch(opts: { confirmarRespuesta: unknown }) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && url.includes("/confirmar")) return jsonResponse(opts.confirmarRespuesta);
    if (url.includes("/superadmin/acciones/sugerencias")) return jsonResponse({ sugerencias: [] });
    if (url.includes("/superadmin/acciones/intents")) return jsonResponse({ intents: [INTENT_PENDIENTE] });
    if (url.includes("/superadmin/acciones/automatizaciones")) return jsonResponse({ automatizaciones: [] });
    throw new Error(`fetch inesperado en el test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  return renderComponent(<SuperAdminAccionesPage apiBaseUrl="https://api.test" token="tok-123" />);
}

async function abrirDialogoYConfirmar(): Promise<void> {
  const tabPendientes = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Pendientes de confirmar"));
  expect(tabPendientes).toBeDefined();
  clickTab(tabPendientes!);
  await esperarCarga();

  const trigger = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Confirmar");
  expect(trigger).toBeDefined();
  click(trigger!);
  await esperarCarga();

  const accion = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Sí, confirmar");
  expect(accion).toBeDefined();
  click(accion!);
  await esperarCarga();
}

describe("SuperAdminAccionesPage -- confirmar() lee el estado real del intent", () => {
  it("estado 'executed' -> toast.success, nunca toast.error", async () => {
    stubFetch({ confirmarRespuesta: { intent: { ...INTENT_PENDIENTE, estado: "executed", ejecutadoEn: "2026-09-19T10:01:00.000Z", resultado: { ok: true }, error: null } } });
    rendered = renderPage();
    await esperarCarga();

    await abrirDialogoYConfirmar();

    expect(toastMock.success).toHaveBeenCalledWith("Acción confirmada.");
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("HTTP 200 con estado 'failed' -> toast.error con el mensaje real, NUNCA 'Acción confirmada'", async () => {
    stubFetch({
      confirmarRespuesta: {
        intent: { ...INTENT_PENDIENTE, estado: "failed", ejecutadoEn: "2026-09-19T10:01:00.000Z", resultado: null, error: "organización no encontrada" },
      },
    });
    rendered = renderPage();
    await esperarCarga();

    await abrirDialogoYConfirmar();

    expect(toastMock.error).toHaveBeenCalledWith("La acción falló al ejecutarse.", { description: "organización no encontrada" });
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
