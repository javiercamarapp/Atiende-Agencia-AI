// @vitest-environment jsdom
//
// R-21: pantalla de Conversaciones. Tres estados honestos (base sin migrar != bandeja vacia), la toma por una persona
// y la escalacion visible. Contrato: lib/conversaciones-client.ts.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversacionesPage } from "../src/verticals/restaurantes/pages/Conversaciones.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "staff", staffFullName: "Ana", staffEmail: "ana@example.com" };
const COBERTURA = { sinCobertura: false, turnosVigentes: [], guardia: [{ userId: "u1", nombre: "Ana", turno: "Turno 1", orden: 1 }] };

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

const ITEM = {
  canal: "whatsapp", conversationId: "c-1", telefono: "+5219990000001", vistaPrevia: "Quiero hablar con alguien", actividadEn: "2026-09-30T20:00:00.000Z",
  estado: "pendiente", handoffId: "h-1", motivo: "queja", solicitadaEn: "2026-09-30T20:00:00.000Z", tomadaPor: null, tomadaPorNombre: null, resultadoVoz: null,
  escalacion: { nivel: 1, minutosEspera: 6, sinCobertura: false, avisarAdministracion: false, destinatarios: [] },
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

describe("ConversacionesPage (restaurantes)", () => {
  it("base sin migrar (disponible:false) muestra el estado honesto, no una bandeja vacia", async () => {
    fetchMock.mockResolvedValue(json({ disponible: false, total: 0, nextOffset: null, cobertura: COBERTURA, items: [] }));
    rendered = renderComponent(<ConversacionesPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Conversaciones no disponibles aún");
    expect(rendered.container.textContent).not.toContain("Sin conversaciones");
  });

  it("lista una toma pendiente con su aviso de escalacion y quien esta de guardia", async () => {
    fetchMock.mockResolvedValue(json({ disponible: true, total: 1, nextOffset: null, cobertura: COBERTURA, items: [ITEM] }));
    rendered = renderComponent(<ConversacionesPage {...CTX} />);
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Esperando a una persona");
    expect(texto).toContain("6 min sin respuesta: avisar al respaldo");
    expect(texto).toContain("Ana — Turno 1 (principal)");
  });

  it("al elegir la conversacion y tomarla manda POST .../tomar y recarga la bandeja", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/tomar")) return json({ handoffId: "h-1", estado: "tomada" }, 201);
      if (String(url).includes("/conversaciones/whatsapp/c-1")) {
        return json({ canal: "whatsapp", conversationId: "c-1", transcripcionDisponible: true, mensajes: [{ rol: "cliente", texto: "Quiero hablar con alguien", creadoEn: null }], handoff: { handoffId: "h-1", estado: "pendiente", solicitadoPor: "agente", motivo: "queja", solicitadaEn: ITEM.solicitadaEn, tomadaPor: null, tomadaPorNombre: null }, notas: [] });
      }
      void init;
      return json({ disponible: true, total: 1, nextOffset: null, cobertura: COBERTURA, items: [ITEM] });
    });
    rendered = renderComponent(<ConversacionesPage {...CTX} />);
    await esperar();
    const fila = rendered.container.querySelector("ul[aria-label='Conversaciones'] button");
    expect(fila).not.toBeNull();
    click(fila!);
    await esperar();
    const tomar = Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent === "Tomar conversación");
    expect(tomar).toBeDefined();
    click(tomar!);
    await esperar();
    const post = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/conversaciones/whatsapp/c-1/tomar"));
    expect(post?.[1]).toMatchObject({ method: "POST" });
    expect(rendered.container.textContent).toContain("La conversación es tuya: el agente ya no responde.");
  });

  it("un 409 al tomar se muestra como aviso y no rompe la pantalla", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/tomar")) return json({ message: "Esta conversación ya la tiene otra persona." }, 409);
      if (String(url).includes("/conversaciones/whatsapp/c-1")) {
        return json({ canal: "whatsapp", conversationId: "c-1", transcripcionDisponible: true, mensajes: [], handoff: null, notas: [] });
      }
      return json({ disponible: true, total: 1, nextOffset: null, cobertura: COBERTURA, items: [{ ...ITEM, estado: "agente", handoffId: null, escalacion: null }] });
    });
    rendered = renderComponent(<ConversacionesPage {...CTX} />);
    await esperar();
    click(rendered.container.querySelector("ul[aria-label='Conversaciones'] button")!);
    await esperar();
    click(Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent === "Tomar conversación")!);
    await esperar();
    expect(rendered.container.textContent).toContain("ya la tiene otra persona");
  });
});
