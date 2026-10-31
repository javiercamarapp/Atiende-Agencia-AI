// @vitest-environment jsdom
//
// R23: el staff atiende lo escalado desde el panel. Estado nuevo/en atencion/resuelto, alertas (sin tomar, sin respuesta humana, llamada por devolver
// con resumen y telefono, pedido por aprobar), asignar a una persona y refresco automatico. Contrato: lib/conversaciones-client.ts.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversacionesPage } from "../src/verticals/restaurantes/pages/Conversaciones.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "staff", staffFullName: "Ana", staffEmail: "ana@example.com" };
const COBERTURA = { sinCobertura: false, turnosVigentes: [], guardia: [{ userId: "u1", nombre: "Ana", turno: "Turno 1", orden: 1 }, { userId: "u2", nombre: "Beto", turno: "Turno 1", orden: 2 }] };
const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const ITEM = {
  canal: "whatsapp", conversationId: "c-1", telefono: "+5219990000001", vistaPrevia: "Quiero hablar con alguien", actividadEn: "2026-09-30T20:00:00.000Z",
  estado: "pendiente", handoffId: "h-1", motivo: "queja", solicitadaEn: "2026-09-30T20:00:00.000Z", tomadaPor: null, tomadaPorNombre: null, resultadoVoz: null, escalacion: null,
};
const esperar = async () => act(async () => { await flushMicrotasks(); await flushMicrotasks(); });

function api(extra: { alertas?: unknown; detalle?: unknown; items?: unknown[] } = {}) {
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/alertas-panel")) return json(extra.alertas ?? { disponible: true, sinRespuestaMin: 10, montoMin: 4000, total: 0, items: [] });
    if (u.endsWith("/asignar")) return json({ handoffId: "h-1", estado: "tomada", cambio: true });
    if (u.includes("/conversaciones/whatsapp/c-1") || u.includes("/conversaciones/voz/")) return json(extra.detalle ?? { canal: "whatsapp", conversationId: "c-1", transcripcionDisponible: true, mensajes: [], handoff: { handoffId: "h-1", estado: "pendiente", solicitadoPor: "agente", motivo: "queja", solicitadaEn: ITEM.solicitadaEn, tomadaPor: null, tomadaPorNombre: null }, notas: [] });
    return json({ disponible: true, total: 1, nextOffset: null, cobertura: COBERTURA, items: extra.items ?? [ITEM] });
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

describe("ConversacionesPage: flujo del staff (R23)", () => {
  it("cada fila con handoff muestra su estado de trabajo (Nuevo / En atención / Resuelto)", async () => {
    api({ items: [ITEM, { ...ITEM, conversationId: "c-2", estado: "tomada", tomadaPorNombre: "Ana" }, { ...ITEM, conversationId: "c-3", estado: "cerrada" }, { ...ITEM, conversationId: "c-4", estado: "agente", handoffId: null }] });
    rendered = renderComponent(<ConversacionesPage {...CTX} />);
    await esperar();
    const filas = Array.from(rendered.container.querySelectorAll("ul[aria-label='Conversaciones'] li")).map((l) => l.textContent ?? "");
    expect(filas[0]).toContain("Nuevo · ");
    expect(filas[1]).toContain("En atención · ");
    expect(filas[2]).toContain("Resuelto · ");
    expect(filas[3]).not.toMatch(/Nuevo ·|En atención ·|Resuelto ·/);
  });

  it("muestra las alertas con su texto, el resumen y el enlace para llamar, y el enlace a Pedidos", async () => {
    api({
      alertas: {
        disponible: true, sinRespuestaMin: 10, montoMin: 4000, total: 4,
        items: [
          { tipo: "pedido_por_aprobar", canal: null, conversationId: null, handoffId: null, orderId: "o1", referencia: "#901", minutos: 20, monto: 4500, resumen: null, telefono: null },
          { tipo: "llamada_por_devolver", canal: "voz", conversationId: "v-1", handoffId: "h-v", orderId: null, referencia: "+5219991112222", minutos: 9, monto: null, resumen: "Queja por tacos fríos", telefono: "+5219991112222" },
          { tipo: "sin_respuesta_humana", canal: "whatsapp", conversationId: "c-1", handoffId: "h-1", orderId: null, referencia: "+5219990000001", minutos: 14, monto: null, resumen: null, telefono: null },
          { tipo: "sin_tomar", canal: "whatsapp", conversationId: "c-9", handoffId: "h-9", orderId: null, referencia: "+5219990000009", minutos: 11, monto: null, resumen: null, telefono: null },
        ],
      },
    });
    rendered = renderComponent(<ConversacionesPage {...CTX} />);
    await esperar();
    const caja = rendered.container.querySelector("ul[aria-label='Alertas']");
    expect(caja).not.toBeNull();
    const t = caja!.textContent ?? "";
    expect(t).toContain("Pedido #901 por aprobar por $4,500 (hace 20 min).");
    expect(t).toContain("Devolver la llamada a +5219991112222 (hace 9 min).");
    expect(t).toContain("Resumen: Queja por tacos fríos");
    expect(t).toContain("El cliente +5219990000001 escribió y nadie le ha contestado (hace 14 min).");
    expect(t).toContain("Nadie ha tomado el chat +5219990000009 (hace 11 min).");
    expect(caja!.querySelector("a[href='tel:+5219991112222']")).not.toBeNull();
    expect(caja!.querySelector("a[href='/restaurantes/demo/pedidos']")).not.toBeNull();
  });

  it("sin alertas, o si el endpoint falla o la base no esta migrada, no aparece la tarjeta y la bandeja funciona", async () => {
    api();
    rendered = renderComponent(<ConversacionesPage {...CTX} />);
    await esperar();
    expect(rendered.container.querySelector("ul[aria-label='Alertas']")).toBeNull();
    rendered.unmount();
    api({ alertas: { disponible: false, items: [] } });
    rendered = renderComponent(<ConversacionesPage {...CTX} />);
    await esperar();
    expect(rendered.container.querySelector("ul[aria-label='Alertas']")).toBeNull();
    expect(rendered.container.querySelector("ul[aria-label='Conversaciones']")).not.toBeNull();
  });

  it("asignar: el staff elige a alguien de guardia y se manda POST .../asignar con su userId", async () => {
    api();
    rendered = renderComponent(<ConversacionesPage {...CTX} />);
    await esperar();
    click(rendered.container.querySelector("ul[aria-label='Conversaciones'] button")!);
    await esperar();
    const sel = rendered.container.querySelector("select[aria-label='Asignar a']") as HTMLSelectElement;
    expect(sel).not.toBeNull();
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual(["Asignar a…", "Ana", "Beto"]);
    const boton = Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent === "Asignar")!;
    expect((boton as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      sel.value = "u2";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    click(Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent === "Asignar")!);
    await esperar();
    const post = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/handoffs/h-1/asignar"));
    expect(post?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ userId: "u2" });
    expect(rendered.container.textContent).toContain("Conversación asignada.");
  });

  it("llamada escalada: el detalle muestra el resumen y el teléfono para devolver la llamada", async () => {
    api({
      items: [{ ...ITEM, canal: "voz", conversationId: "v-1", telefono: null }],
      detalle: { canal: "voz", conversationId: "v-1", transcripcionDisponible: false, mensajes: [], handoff: { handoffId: "h-v", estado: "pendiente", solicitadoPor: "agente", motivo: "escalada:queja", solicitadaEn: ITEM.solicitadaEn, tomadaPor: null, tomadaPorNombre: null, resumen: "Queja por tacos fríos", telefonoDevolucion: "+5219991112222" }, notas: [] },
    });
    rendered = renderComponent(<ConversacionesPage {...CTX} />);
    await esperar();
    click(rendered.container.querySelector("ul[aria-label='Conversaciones'] button")!);
    await esperar();
    const bloque = rendered.container.querySelector("[aria-label='Devolver la llamada']");
    expect(bloque?.textContent).toContain("Resumen de la llamada: Queja por tacos fríos");
    expect(bloque?.querySelector("a[href='tel:+5219991112222']")?.textContent).toBe("+5219991112222");
  });

  it("refresca la bandeja y las alertas solo cada 30 s, y no con la pestaña oculta", async () => {
    vi.useFakeTimers();
    try {
      api();
      rendered = renderComponent(<ConversacionesPage {...CTX} />);
      await esperar();
      const contar = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("/conversaciones?")).length;
      const antes = contar();
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      await esperar();
      expect(contar()).toBe(antes + 1);
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      await esperar();
      expect(contar()).toBe(antes + 1);
    } finally {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      vi.useRealTimers();
    }
  });
});
