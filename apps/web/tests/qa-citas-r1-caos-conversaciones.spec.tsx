// @vitest-environment jsdom
//
// QA-citas-R1-caos-12: un 503 momentaneo al refrescar la bandeja (boton Actualizar o sondeo de 30 s) desmontaba el hilo abierto y borraba la nota o la
// respuesta que el humano escribia, justo en los handoffs de crisis. Ahora el error se muestra arriba y el hilo y su borrador siguen ahi.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversacionesPage } from "../src/verticals/citas/pages/Conversaciones.tsx";
import type { CitasShellContext } from "../src/verticals/citas/CitasShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const ctx = { apiBaseUrl: "https://api.test", token: "tok-1", propertyId: "prop-1", orgSlug: "demo", orgId: "org-1", role: "staff", staffFullName: "Sam", staffEmail: "sam@example.com" } as CitasShellContext;
const BASE = "https://api.test/v1/citas/properties/prop-1/admin";

const jsonResponse = (body: unknown, status = 200): Response => ({ ok: status < 300, status, json: async () => body }) as unknown as Response;

async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i++) await flushMicrotasks();
  });
}

const ITEM = {
  conversationId: "c-1", telefono: "***4567", vistaPrevia: "Ya no quiero seguir", actividadEn: "2026-10-01T10:00:00.000Z", estado: "tomada", handoffId: "h-1", motivo: "crisis", crisis: true,
  solicitadaEn: null, ultimoClienteEn: null, tomadaPor: "u-1", tomadaPorNombre: "Sam", tomadaEn: null, esMia: true, cita: null,
};
const BANDEJA = { disponible: true, total: 1, nextOffset: null, puedeGestionar: false, items: [ITEM] };
const DETALLE = {
  conversationId: "c-1", telefono: "***4567", citaId: null, puedeGestionar: false, mensajes: [{ rol: "cliente", texto: "Ya no quiero seguir" }], notas: [],
  handoff: { handoffId: "h-1", estado: "tomada", solicitadoPor: "agente", motivo: "crisis", crisis: true, solicitadaEn: "2026-10-01T10:00:00.000Z", ultimoClienteEn: null, tomadaPor: "u-1", tomadaPorNombre: "Sam", tomadaEn: "2026-10-01T10:01:00.000Z", esMia: true },
};

describe("QA-citas-R1-caos-12: el error al refrescar la bandeja no desmonta el hilo", () => {
  it("con la nota escrita, un 503 al pulsar Actualizar deja el hilo y la nota; al volver el servidor, Reintentar tampoco la pierde", async () => {
    let bandejaFalla = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const metodo = init?.method ?? "GET";
        if (metodo === "GET" && url.startsWith(`${BASE}/conversaciones?`)) return bandejaFalla ? jsonResponse({ message: "Falla inyectada 503" }, 503) : jsonResponse(BANDEJA);
        if (metodo === "GET" && url === `${BASE}/conversaciones/c-1`) return jsonResponse(DETALLE);
        throw new Error(`fetch no esperado: ${metodo} ${url}`);
      }),
    );
    rendered = renderComponent(
      <MemoryRouter>
        <ConversacionesPage {...ctx} />
      </MemoryRouter>,
    );
    await esperar();
    click(rendered.container.querySelector("[data-conversation-id='c-1']")!);
    await esperar();
    const campo = () => rendered!.container.querySelector("input[aria-label='Nueva nota']") as HTMLInputElement;
    changeValue(campo(), "Llamar a su familiar de confianza");
    expect(campo().value).toBe("Llamar a su familiar de confianza");

    bandejaFalla = true;
    click(rendered.container.querySelector("button[aria-label='Actualizar']")!);
    await esperar();
    expect(rendered.container.textContent).toContain("Falla inyectada 503");
    expect(campo()).not.toBeNull();
    expect(campo().value).toBe("Llamar a su familiar de confianza");
    expect(rendered.container.querySelector("[data-conversation-id='c-1']")).not.toBeNull();

    bandejaFalla = false;
    const reintentar = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Reintentar"))!;
    click(reintentar);
    await esperar();
    expect(rendered.container.textContent).not.toContain("Falla inyectada 503");
    expect(campo().value).toBe("Llamar a su familiar de confianza");
  });
});
