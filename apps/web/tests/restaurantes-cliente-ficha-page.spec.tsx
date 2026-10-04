// @vitest-environment jsdom
//
// Cliente 360: ficha del cliente del panel. Cada control llama a su endpoint real; contra una base sin la migracion 049 la
// ficha completa dice "no disponible aun" y muestra la ficha basica de siempre (nunca datos inventados).
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ClienteFichaPage } from "../src/verticals/restaurantes/pages/ClienteFicha.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

const OWNER: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Jefa", staffEmail: "j@example.com" };
const STAFF: RestaurantesShellContext = { ...OWNER, role: "staff" };

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

const FICHA = {
  customer: { id: "c1", name: "Ana Torres", phone: "9991112222", orderCount: 3, lastOrderAt: "2026-10-01T18:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", fechaNacimientoDia: null, fechaNacimientoMes: null, staffNotes: null },
  addresses: [
    { id: "a1", address: "Calle 1 #2, Col. Centro", label: "casa", isDefault: true, accessNotes: "portón verde", mapsUrl: "https://maps.example.com/x", colonia: "Centro", branchSlug: "centro", lastUsedAt: "2026-10-01T18:00:00.000Z", timesUsed: 3 },
    { id: "a2", address: "Av. Dos 20", label: "oficina", isDefault: false, accessNotes: null, mapsUrl: null, colonia: null, branchSlug: null, lastUsedAt: null, timesUsed: 1 },
  ],
  preferences: [{ id: "g1", kind: "tortilla", value: "harina", source: "pedido", timesSeen: 3, firstSeenAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-10-01T18:00:00.000Z", status: "activa" }],
  reliability: { noRecogidos90d: 2, pedidosFalsos: 0, umbral: 2, ventanaDias: 90 },
  tier: "GOLD",
  orders: [{ id: "o1", orderNumber: 41, createdAt: "2026-10-01T18:00:00.000Z", status: "entregado", total: 150, items: [{ name: "Tacos", quantity: 2 }], branch: "Centro", source: "whatsapp", paymentMethod: "efectivo", pedidoFalso: false }],
  whatsapp: { conversaciones: 1, ultimaActividad: "2026-10-01T18:00:00.000Z", mensajes: 6 },
  llamadas: [{ id: "l1", startedAt: "2026-09-20T18:00:00.000Z", durationS: 130, resultado: "pedido_creado" }],
};

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
const botones = () => Array.from(rendered!.container.querySelectorAll("button"));
const boton = (texto: string) => botones().find((b) => b.textContent === texto);

function montar(ctx: RestaurantesShellContext) {
  rendered = renderComponent(
    <MemoryRouter>
      <ClienteFichaPage {...ctx} customerId="c1" />
    </MemoryRouter>,
  );
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

describe("ClienteFichaPage (restaurantes)", () => {
  it("muestra datos, domicilios con etiqueta y referencias, gustos, pedidos, conversaciones y la reincidencia", async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).endsWith("/policy") ? json({ policy: { umbralNoRecogidos: 2, ventanaDias: 90 } }) : json({ ficha: FICHA })));
    montar(OWNER);
    await esperar();
    const t = rendered!.container.textContent ?? "";
    expect(t).toContain("Ana Torres");
    expect(t).toContain("casa");
    expect(t).toContain("Referencias: portón verde");
    expect(t).toContain("oficina");
    expect(t).toContain("harina");
    expect(t).toContain("Pedido 41");
    expect(t).toContain("6 mensajes guardados");
    expect(t).toContain("pedido_creado");
    expect(rendered!.container.querySelector('[data-testid="no-recogidos"]')?.textContent).toBe("2");
    // Con 2 no recogidos y umbral 2: el aviso de que el siguiente pedido lo confirma la sucursal.
    expect(t).toContain("El siguiente pedido lo confirma la sucursal");
    const mapa = rendered!.container.querySelector('a[href="https://maps.example.com/x"]');
    expect(mapa?.getAttribute("rel")).toContain("noopener");
  });

  it("marcar como falso llama al endpoint real del pedido y recarga la ficha", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/policy")) return json({ policy: { umbralNoRecogidos: 2, ventanaDias: 90 } });
      if (u.endsWith("/orders/o1/falso")) return json({ falso: true });
      return json({ ficha: FICHA });
    });
    montar(OWNER);
    await esperar();
    click(boton("Marcar como falso")!);
    await esperar();
    const llamada = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/customers/c1/orders/o1/falso"));
    expect(llamada).toBeTruthy();
    expect(JSON.parse(String((llamada![1] as RequestInit).body))).toEqual({ falso: true });
    expect(rendered!.container.textContent).toContain("Pedido marcado como falso.");
  });

  it("guardar un gusto nuevo manda tipo y valor al endpoint de gustos", async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).endsWith("/policy") ? json({ policy: { umbralNoRecogidos: 2, ventanaDias: 90 } }) : json({ ficha: FICHA, id: "g9" })));
    montar(STAFF);
    await esperar();
    const valor = Array.from(rendered!.container.querySelectorAll("input")).find((i) => i.closest("label, div")?.textContent?.includes("Valor") && i.maxLength === 120)!;
    changeValue(valor, "sin cebolla");
    click(boton("Agregar")!);
    await esperar();
    const llamada = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/customers/c1/preferences"));
    expect(JSON.parse(String((llamada![1] as RequestInit).body))).toEqual({ accion: "agregar", kind: "tortilla", value: "sin cebolla" });
  });

  it("el rol staff no ve ARCO ni puede editar la politica; owner si", async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).endsWith("/policy") ? json({ policy: { umbralNoRecogidos: 2, ventanaDias: 90 } }) : json({ ficha: FICHA })));
    montar(STAFF);
    await esperar();
    expect(rendered!.container.textContent).not.toContain("Privacidad (ARCO)");
    expect(boton("Guardar")).toBeUndefined();
    rendered!.unmount();
    montar(OWNER);
    await esperar();
    expect(rendered!.container.textContent).toContain("Privacidad (ARCO)");
    expect(boton("Guardar")).toBeTruthy();
  });

  it("base sin la migracion 049: 'no disponible aun' y la ficha basica de siempre, sin controles que no funcionan", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/ficha")) return json({ message: "No disponible aún: la ficha del cliente requiere aplicar la migración 049 de restaurantes." }, 503);
      return json({ customer: { isNew: false, name: "Ana Torres", orderCount: 3, addresses: [{ address: "Calle 1 #2", label: null, isDefault: true }], lastOrderItems: null, frequentItems: [{ name: "Tacos", quantity: 5 }], tier: "GOLD", agentNotes: [] } });
    });
    montar(OWNER);
    await esperar();
    const t = rendered!.container.textContent ?? "";
    expect(t).toContain("Ficha completa no disponible aún");
    expect(t).toContain("Calle 1 #2");
    expect(t).toContain("5× Tacos");
    expect(boton("Marcar como falso")).toBeUndefined();
    expect(boton("Agregar domicilio")).toBeUndefined();
  });

  it("un error real se muestra tal cual (no se disfraza de 'no disponible')", async () => {
    fetchMock.mockImplementation(async () => json({ message: "Cliente no encontrado." }, 404));
    montar(OWNER);
    await esperar();
    expect(rendered!.container.textContent).toContain("Cliente no encontrado.");
    expect(rendered!.container.textContent).not.toContain("no disponible aún");
  });
});
