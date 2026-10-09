// @vitest-environment jsdom
//
// QA R1 (restaurantes) en Historial: botones-06 (fila de otro filtro tras un error), botones-07 (carrera de filtros) y viaje-11
// (cerrar un pedido entregado / registrar incidencia con nota).
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, beforeAll } from "vitest";
import { HistorialPage } from "../src/verticals/restaurantes/pages/Historial.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { elegirValor, valorDe, prepararJsdomParaRadix } from "./test-utils/seleccionar.tsx";

beforeAll(prepararJsdomParaRadix);

let rendered: RenderedComponent | undefined;
const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Sam", staffEmail: "s@example.com" };

function orden(id: string, nombre: string, status: string) {
  return { id, propertyId: "prop-1", branch: "Centro", customerId: null, customerName: nombre, customerPhone: "9990000000", customerAddress: null, total: 100, status, items: [], source: "web", notes: null, paymentMethod: null, createdAt: "2026-10-03T19:00:00.000Z", assignedRepartidorId: null, estimatedDeliveryAt: null, incidentNote: null };
}
const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const sinPromesa = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

async function esperar() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}
const estadoSelect = () => rendered!.container.querySelector("#restaurantes-historial-estado") as HTMLElement;
const texto = () => (rendered!.container.textContent ?? "") + (document.body.textContent ?? "");
const boton = (t: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(t))!;

beforeEach(() => undefined);
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

describe("Historial: filtros", () => {
  it("botones-06: si falla la carga de un filtro nuevo no quedan filas del filtro anterior", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url.includes("status=cancelado") ? json({ message: "Servicio no disponible" }, 503) : json({ orders: [orden("o1", "Marisol Pech", "pending")], nextCursor: null }))),
    );
    rendered = renderComponent(<HistorialPage {...CTX} />);
    await esperar();
    expect(texto()).toContain("Marisol Pech");
    elegirValor(estadoSelect(), "cancelado");
    await esperar();
    expect(texto()).toContain("Servicio no disponible");
    expect(texto()).not.toContain("Marisol Pech");
  });

  it("botones-07: la respuesta lenta de un filtro anterior no pisa el filtro actual", async () => {
    const lenta = sinPromesa<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("status=completado")) return lenta.promise;
        if (url.includes("status=preparando")) return Promise.resolve(json({ orders: [orden("o2", "Jorge Canul", "preparando")], nextCursor: null }));
        return Promise.resolve(json({ orders: [orden("o1", "Marisol Pech", "pending")], nextCursor: null }));
      }),
    );
    rendered = renderComponent(<HistorialPage {...CTX} />);
    await esperar();
    elegirValor(estadoSelect(), "completado");
    elegirValor(estadoSelect(), "preparando");
    await esperar();
    expect(texto()).toContain("Jorge Canul");
    lenta.resolve(json({ orders: [orden("o3", "Ana Vieja", "completado")], nextCursor: null }));
    await esperar();
    expect(valorDe(estadoSelect())).toBe("preparando");
    expect(texto()).toContain("Jorge Canul");
    expect(texto()).not.toContain("Ana Vieja");
  });
});

describe("Historial: pedidos entregados", () => {
  function stub(patches: Array<{ url: string; body: unknown }>) {
    let entregado = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          patches.push({ url, body: JSON.parse(init.body as string) });
          entregado = false;
          return json({ order: orden("o1", "Marisol Pech", "completado") });
        }
        return json({ orders: [orden("o1", "Marisol Pech", entregado ? "entregado" : "completado"), orden("o2", "Jorge Canul", "cancelado")], nextCursor: null });
      }),
    );
  }

  it("viaje-11: solo los entregados ofrecen acciones y 'Cerrar (completado)' hace PATCH status completado", async () => {
    const patches: Array<{ url: string; body: unknown }> = [];
    stub(patches);
    rendered = renderComponent(<HistorialPage {...CTX} />);
    await esperar();
    expect([...rendered.container.querySelectorAll("button")].filter((b) => b.textContent?.includes("Cerrar (completado)"))).toHaveLength(1);
    await act(async () => {
      click(boton("Cerrar (completado)"));
      for (let i = 0; i < 6; i++) await flushMicrotasks();
    });
    expect(patches).toHaveLength(1);
    expect(patches[0]!.url).toBe("https://api.test/v1/restaurantes/prop-1/admin/orders/o1/status");
    expect(patches[0]!.body).toEqual({ status: "completado" });
    expect(texto()).not.toContain("Cerrar (completado)");
  });

  it("viaje-11: 'Registrar incidencia' pide la nota (Volver no escribe) y manda status problema con incidentNote", async () => {
    const patches: Array<{ url: string; body: unknown }> = [];
    stub(patches);
    rendered = renderComponent(<HistorialPage {...CTX} />);
    await esperar();
    await act(async () => {
      click(boton("Registrar incidencia"));
      await flushMicrotasks();
    });
    const dialogo = document.body.querySelector('[role="alertdialog"]')!;
    const volver = [...dialogo.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Volver")!;
    await act(async () => {
      volver.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      for (let i = 0; i < 6; i++) await flushMicrotasks();
    });
    expect(patches).toHaveLength(0);

    await act(async () => {
      click(boton("Registrar incidencia"));
      await flushMicrotasks();
    });
    const d2 = document.body.querySelector('[role="alertdialog"]')!;
    changeValue(d2.querySelector("textarea")!, "Faltó un refresco");
    const registrar = [...d2.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Registrar incidencia")!;
    await act(async () => {
      registrar.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({ status: "problema", incidentNote: "Faltó un refresco" });
  });
});
