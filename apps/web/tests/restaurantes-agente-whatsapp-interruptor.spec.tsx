// @vitest-environment jsdom
//
// Interruptor DURO del agente de WhatsApp por sucursal (migracion 053) dentro de las reglas de la sucursal: lee el estado real, pide
// confirmacion antes de APAGAR (Volver no cambia nada), manda PUT {activo} y muestra el resultado; con la base sin migrar lo dice (no finge).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { SucursalesPage } from "../src/verticals/restaurantes/pages/Sucursales.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Gaby", staffEmail: "g@example.com" };
const BRANCH = { propertyId: "prop-1", name: "Altabrisa", slug: "altabrisa", status: "active", phone: null, address: null, lat: null, lng: null };
const BASE = "https://api.test/v1/restaurantes/prop-1/admin";

interface Llamada {
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
}

function stub(llamadas: Llamada[], interruptor: { status?: number; body?: unknown; put?: (activo: boolean) => Response } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      llamadas.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url === `${BASE}/sucursales`) return json({ branches: [BRANCH] });
      if (url === `${BASE}/config/sucursales/prop-1/agente-whatsapp`) {
        if (method === "PUT") return interruptor.put ? interruptor.put(JSON.parse(init!.body as string).activo) : json({ disponible: true, agenteActivo: JSON.parse(init!.body as string).activo });
        return json(interruptor.body ?? { disponible: true, agenteActivo: true }, interruptor.status ?? 200);
      }
      if (url === `${BASE}/config/sucursales/prop-1/politica`) return json({ horario: null, pedidoMinimoDomicilio: null, pedidoMinimoRecoger: null, propinaPolitica: null });
      if (url === `${BASE}/config/sucursales/prop-1/zonas-reparto`) return json({ zoneIds: [] });
      if (url === `${BASE}/config/sucursales/prop-1/whatsapp`) return json({ phoneNumberId: null });
      if (url === `${BASE}/config/zonas`) return json({ zonas: [] });
      if (url === `${BASE}/config/puentes`) return json({ puentes: [] });
      throw new Error(`fetch inesperado en el test: ${method} ${url}`);
    }),
  );
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}

async function abrir() {
  rendered = renderComponent(
    <MemoryRouter>
      <SucursalesPage {...CTX} />
    </MemoryRouter>,
  );
  await settle();
  click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Reglas de pedido"))!);
  await settle();
}

const interruptor = () => rendered!.container.querySelector('[data-testid="agente-whatsapp-prop-1"]')!;
const casilla = () => interruptor().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const enDialogo = async (etiqueta: string) => {
  const boton = [...document.body.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent === etiqueta)!;
  await act(async () => {
    click(boton);
    for (let i = 0; i < 4; i++) await flushMicrotasks();
  });
};

describe("interruptor del agente de WhatsApp de la sucursal (UI)", () => {
  it("lee el estado real: encendido por omision", async () => {
    stub([]);
    await abrir();
    expect(interruptor().textContent).toContain("El agente contesta los mensajes de WhatsApp de esta sucursal");
    expect(casilla().checked).toBe(true);
  });

  it("apagar pide confirmacion: Volver no manda nada; Apagar agente manda PUT {activo:false} y avisa que los mensajes llegan a Conversaciones", async () => {
    const llamadas: Llamada[] = [];
    stub(llamadas);
    await abrir();
    await act(async () => {
      click(casilla());
      await flushMicrotasks();
    });
    expect(document.body.querySelector('[role="alertdialog"]')!.textContent).toContain("Apagar el agente de WhatsApp de esta sucursal");
    await enDialogo("Volver");
    expect(llamadas.some((c) => c.method === "PUT" && c.url.endsWith("/agente-whatsapp"))).toBe(false);
    expect(casilla().checked).toBe(true);

    await act(async () => {
      click(casilla());
      await flushMicrotasks();
    });
    await enDialogo("Apagar agente");
    expect(llamadas.find((c) => c.method === "PUT" && c.url.endsWith("/agente-whatsapp"))!.body).toEqual({ activo: false });
    expect(casilla().checked).toBe(false);
    expect(rendered!.container.textContent).toContain("Agente de WhatsApp apagado");
    expect(interruptor().textContent).toContain("debe atenderla una persona del equipo");
  });

  it("encender no pide confirmacion y manda PUT {activo:true}", async () => {
    const llamadas: Llamada[] = [];
    stub(llamadas, { body: { disponible: true, agenteActivo: false } });
    await abrir();
    expect(casilla().checked).toBe(false);
    await act(async () => {
      click(casilla());
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(llamadas.find((c) => c.method === "PUT" && c.url.endsWith("/agente-whatsapp"))!.body).toEqual({ activo: true });
    expect(casilla().checked).toBe(true);
  });

  it("un fallo del servidor (503) se muestra junto al control y deja el estado anterior", async () => {
    stub([], { put: () => json({ message: "Esta configuración todavía no se puede editar en esta base de datos." }, 503) });
    await abrir();
    await act(async () => {
      click(casilla());
      await flushMicrotasks();
    });
    await enDialogo("Apagar agente");
    expect(interruptor().textContent).toContain("todavía no se puede editar");
    expect(casilla().checked).toBe(true);
  });

  it("base sin migrar (disponible:false): dice 'No disponible aún' y no ofrece el control", async () => {
    stub([], { body: { disponible: false, agenteActivo: true } });
    await abrir();
    expect(interruptor().textContent).toContain("No disponible aún");
    expect(interruptor().textContent).toContain("migración 053");
    expect(interruptor().querySelector('input[type="checkbox"]')).toBeNull();
  });
});
