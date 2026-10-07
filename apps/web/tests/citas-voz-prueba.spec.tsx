// @vitest-environment jsdom
//
// <PruebaAgenteVoz /> de citas (dentro del Agente de WhatsApp): fetch mockeado por ruta real contra apps/api/.../citas/voice-tools.ts. Cubre el estado HONESTO de
// la escalera (nunca una llave), que sin credenciales no hay boton ni simulacion, y que con credenciales se abre la llamada de prueba.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));

import { PruebaAgenteVoz } from "../src/verticals/citas/voz/PruebaAgenteVoz.tsx";
import { formatoUsdPorMinuto } from "../src/verticals/citas/lib/voz-client.ts";
import type { EstadoVozCitas } from "../src/verticals/citas/lib/voz-client.ts";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const V = "https://api.test/v1/citas/properties/prop-1/admin/voz";
const PRECIOS = { "gemini-3.8-live": 18_000, "cascada-openrouter": 14_000 } as const;

const SIN_CREDENCIALES: EstadoVozCitas = {
  escalera: {
    operativa: false,
    escalones: [
      { escalon: "gemini-3.8-live", configurado: false, detalle: "Falta GEMINI_API_KEY." },
      { escalon: "cascada-openrouter", configurado: false, detalle: "Falta OPENROUTER_API_KEY." },
    ],
  },
  precioMicroUsdPorMinuto: PRECIOS,
  preview: { disponible: false, motivo: "Voz no configurada: no hay proveedor de voz en este despliegue (requiere GEMINI_API_KEY)." },
};

const OPERATIVA: EstadoVozCitas = {
  escalera: {
    operativa: true,
    escalones: [
      { escalon: "gemini-3.8-live", configurado: true, detalle: "Credencial presente (no se probó la red)." },
      { escalon: "cascada-openrouter", configurado: false, detalle: "Falta OPENROUTER_API_KEY." },
    ],
  },
  precioMicroUsdPorMinuto: PRECIOS,
  preview: { disponible: true, motivo: null },
};

function stub(respuesta: EstadoVozCitas | "error") {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === `${V}/estado`) {
      if (respuesta === "error") return { ok: false, status: 500, json: async () => ({ message: "boom" }), text: async () => "boom" } as unknown as Response;
      return { ok: true, status: 200, json: async () => respuesta } as unknown as Response;
    }
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function esperar() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await flushMicrotasks();
  });
}

const montar = () => renderComponent(<PruebaAgenteVoz apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" />);
const boton = (r: RenderedComponent, texto: string) => [...r.container.querySelectorAll("button")].find((b) => b.textContent?.includes(texto));

describe("PruebaAgenteVoz (citas)", () => {
  it("sin credenciales: dice que requiere credenciales, lista lo que falta y NO ofrece la llamada de prueba (nada simulado)", async () => {
    stub(SIN_CREDENCIALES);
    rendered = montar();
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Requiere credenciales");
    expect(texto).toContain("Falta GEMINI_API_KEY.");
    expect(texto).toContain("Falta OPENROUTER_API_KEY.");
    expect(rendered.container.querySelector("[data-testid='preview-no-disponible']")?.textContent).toContain("No disponible aún");
    expect(boton(rendered, "Hacer llamada de prueba")).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("con credenciales: muestra el escalon configurado con su precio estimado por minuto y ofrece la llamada; al pulsarla abre la vista previa con el orbe", async () => {
    stub(OPERATIVA);
    rendered = montar();
    await esperar();
    expect(rendered.container.textContent).toContain("Voz operativa");
    expect(rendered.container.textContent).toContain(`${formatoUsdPorMinuto(18_000)} por minuto (estimado)`);
    expect(rendered.container.querySelector("[data-testid='llamada-de-prueba']")).toBeNull();
    const b = boton(rendered, "Hacer llamada de prueba")!;
    expect(b).toBeDefined();
    await act(async () => {
      click(b);
      await flushMicrotasks();
    });
    expect(rendered.container.querySelector("[data-testid='llamada-de-prueba']")).not.toBeNull();
    expect(rendered.container.querySelector("[data-testid='chip-estado']")?.textContent).toContain("Vista previa");
  });

  it("QA-citas-R1-botones-22: la llamada de prueba es un dialogo: role=dialog, el foco entra, Escape la cierra y el foco vuelve al boton", async () => {
    stub(OPERATIVA);
    rendered = montar();
    await esperar();
    const b = boton(rendered, "Hacer llamada de prueba")!;
    b.focus();
    await act(async () => {
      click(b);
      await flushMicrotasks();
    });
    const llamada = rendered.container.querySelector("[data-testid='llamada-de-prueba']")!;
    const dialogo = llamada.querySelector("[role='dialog']") as HTMLElement | null;
    expect(dialogo).not.toBeNull();
    expect(dialogo!.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(dialogo);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await flushMicrotasks();
    });
    expect(rendered.container.querySelector("[data-testid='llamada-de-prueba']")).toBeNull();
    expect(document.activeElement).toBe(boton(rendered, "Hacer llamada de prueba"));
  });

  it("si el estado no se puede leer: aviso honesto, sin boton", async () => {
    stub("error");
    rendered = montar();
    await esperar();
    expect(rendered.container.textContent).toContain("No se pudo comprobar el servicio de voz");
    expect(boton(rendered, "Hacer llamada de prueba")).toBeUndefined();
  });

  it("formato del precio: micro-USD enteros a dolares con 3 decimales, sin Intl", () => {
    expect(formatoUsdPorMinuto(18_000)).toBe("US$0.018");
    expect(formatoUsdPorMinuto(14_000)).toBe("US$0.014");
    expect(formatoUsdPorMinuto(0)).toBe("US$0.000");
  });
});
