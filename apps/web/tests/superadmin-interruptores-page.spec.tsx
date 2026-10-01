// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminInterruptoresPage } from "../src/superadmin/pages/Interruptores.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

const CATALOGO = { globales: ["llm", "crons"], agentes: ["restaurantes:whatsapp_agent"], crons: ["/internal/whatsapp/dispatch"] };

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as unknown as Response;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function stub(get: unknown, put?: (body: unknown) => void) {
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      put?.(JSON.parse(String(init.body)));
      return json({ interruptor: {} });
    }
    return json(get);
  });
  vi.stubGlobal("fetch", fetchMock);
}

describe("SuperAdminInterruptoresPage", () => {
  it("lista globales, agentes y crons con su estado", async () => {
    stub({
      disponible: true,
      catalogo: CATALOGO,
      interruptores: [{ scope: "agente", target: "restaurantes:whatsapp_agent", bloqueado: true, motivo: "Incidente de proveedor verificado en produccion.", actualizadoPor: "u", actualizadoEnMs: 1 }],
    });
    rendered = renderComponent(<SuperAdminInterruptoresPage apiBaseUrl="https://api.test" token="tok" />);
    expect(rendered.container.textContent).toContain("Cargando interruptores");
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Todo el LLM");
    expect(t).toContain("restaurantes:whatsapp_agent");
    expect(t).toContain("/internal/whatsapp/dispatch");
    expect(t).toContain("Detenido");
    expect(t).toContain("Reactivar");
  });

  it("base sin migrar: aviso honesto y ninguna tabla de acciones", async () => {
    stub({ disponible: false, catalogo: CATALOGO, interruptores: [] });
    rendered = renderComponent(<SuperAdminInterruptoresPage apiBaseUrl="https://api.test" token="tok" />);
    await esperar();
    expect(rendered.container.textContent).toContain("todavía no están disponibles en esta base");
    expect(rendered.container.textContent).not.toContain("restaurantes:whatsapp_agent");
  });

  it("error de red: estado de error, no se queda en 'Cargando'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    rendered = renderComponent(<SuperAdminInterruptoresPage apiBaseUrl="https://api.test" token="tok" />);
    await esperar();
    expect(rendered.container.textContent).toContain("No se pudieron cargar los interruptores");
  });

  it("detener con motivo corto NO llama al backend; con motivo valido arma el PUT correcto", async () => {
    let enviado: unknown = null;
    stub({ disponible: true, catalogo: CATALOGO, interruptores: [] }, (b) => { enviado = b; });
    rendered = renderComponent(<SuperAdminInterruptoresPage apiBaseUrl="https://api.test" token="tok" />);
    await esperar();

    const botones = [...rendered.container.querySelectorAll("button")].filter((b) => b.textContent?.includes("Detener"));
    expect(botones.length).toBe(4); // 2 globales + 1 agente + 1 cron
    click(botones[2]!); // el agente
    const motivo = document.body.querySelector("#interruptor-motivo") as HTMLTextAreaElement;
    const form = document.body.querySelector("#form-interruptor") as HTMLFormElement;
    changeValue(motivo, "corto");
    await submitForm(form);
    expect(document.body.textContent).toContain("al menos 20 caracteres");
    expect(fetchMock.mock.calls.every((c: unknown[]) => (c[1] as RequestInit | undefined)?.method !== "PUT")).toBe(true);

    changeValue(motivo, "El proveedor reporta una caida confirmada del servicio.");
    await submitForm(form);
    await esperar();
    expect(enviado).toEqual({ scope: "agente", target: "restaurantes:whatsapp_agent", bloqueado: true, motivo: "El proveedor reporta una caida confirmada del servicio." });
  });
});
