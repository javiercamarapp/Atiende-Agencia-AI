// @vitest-environment jsdom
//
// D-11 -- smoke tests reales de <ColaCobranzaPage />: estados de carga/vacio/no disponible (base sin la migracion
// 017), render de una promesa con monto desde centavos, resolver, encolar WhatsApp (sin enviar), roles de solo
// lectura y descarga del PDF de cartera. `fetch` global mockeado por ruta real.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ColaCobranzaPage } from "../src/verticals/despachos/pages/ColaCobranza.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX: DespachosShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "contador", staffFullName: "Contador", staffEmail: "c@example.com" };

const ITEM = {
  urgencia: "promesa_vencida",
  gestion: { id: "g-1", receivableId: "cta-1", tipo: "promesa_pago", estado: "pendiente", montoPromesaCentavos: 116000, fechaPromesa: "2026-09-30", fechaSeguimiento: null, nota: "Pagara el viernes", creadoEn: "2026-09-20T18:00:00.000Z" },
  cuenta: { id: "cta-1", folioFiscal: "ABCDEFGH-1234", rfcReceptor: "XAXX010101000", clienteNombre: "Cliente Demo SA", saldoCentavos: 116000, fechaVencimiento: "2026-09-15", diasVencido: 16 },
};

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function stub(over: { cola?: unknown; consentimientos?: unknown; outbox?: unknown } = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.includes("/reporte-cartera")) return { ok: true, status: 200, blob: async () => new Blob(["%PDF-1.4"]), headers: new Headers({ "content-disposition": 'attachment; filename="cartera-antiguedad-2026-10-01.pdf"' }) } as unknown as Response;
    if (method === "GET" && url.endsWith("/cola-cobranza/cola")) return ok(over.cola ?? { disponible: true, hoy: "2026-10-01", items: [ITEM] });
    if (method === "GET" && url.includes("/cobranza/cuentas")) return ok([]);
    if (method === "GET" && url.includes("/whatsapp/consentimientos")) return ok(over.consentimientos ?? { disponible: true, consentimientos: [] });
    if (method === "GET" && url.includes("/whatsapp/outbox")) return ok(over.outbox ?? { disponible: true, mensajes: [] });
    if (method === "POST" && url.endsWith("/gestiones/g-1/estado")) return ok({ id: "g-1", estado: "cumplida" });
    if (method === "POST" && url.endsWith("/cuentas/cta-1/whatsapp")) return ok({ id: "m1", etapa: "recordatorio_formal", duplicado: false, enviado: false, nota: "x" });
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function cargar(ctx: DespachosShellContext = CTX) {
  rendered = renderComponent(<ColaCobranzaPage {...ctx} />);
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

const boton = (texto: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(texto));

describe("ColaCobranzaPage (despachos)", () => {
  it("muestra el estado de carga primero", () => {
    stub();
    rendered = renderComponent(<ColaCobranzaPage {...CTX} />);
    expect(rendered.container.textContent).toContain("Cargando la cola de cobranza");
  });

  it("cola vacia: mensaje explicito, nunca un error", async () => {
    stub({ cola: { disponible: true, hoy: "2026-10-01", items: [] } });
    await cargar();
    expect(rendered!.container.textContent).toContain("No hay gestiones pendientes");
  });

  it("base sin migrar: lo dice, oculta el alta y deja el reporte PDF disponible", async () => {
    stub({ cola: { disponible: false, hoy: "2026-10-01", items: [] }, consentimientos: { disponible: false, consentimientos: [] }, outbox: { disponible: false, mensajes: [] } });
    await cargar();
    const texto = rendered!.container.textContent!;
    expect(texto).toContain("aún no está disponible");
    expect(texto).toContain("migración 017");
    expect(boton("Registrar gestión")).toBeUndefined();
    expect(boton("Reporte PDF de cartera")).toBeDefined();
  });

  it("renderiza una promesa: monto desde centavos, urgencia, cliente y saldo", async () => {
    stub();
    await cargar();
    const texto = rendered!.container.textContent!;
    expect(texto).toContain("Promesa vencida");
    expect(texto).toContain("Cliente Demo SA");
    expect(texto).toContain("XAXX010101000");
    expect(texto).toContain("$1,160.00");
    expect(texto).toContain("Pagara el viernes");
    expect(texto).toContain("16 días de atraso");
  });

  it("'Cumplida' llama POST .../gestiones/g-1/estado y recarga", async () => {
    stub();
    await cargar();
    await act(async () => {
      boton("Cumplida")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });
    const call = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/gestiones/g-1/estado") && (init as RequestInit | undefined)?.method === "POST");
    expect(call).toBeDefined();
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ estado: "cumplida", nota: null });
  });

  it("'Encolar WhatsApp' avisa que NO se envio nada", async () => {
    stub();
    await cargar();
    await act(async () => {
      boton("Encolar WhatsApp")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/cuentas/cta-1/whatsapp") && (init as RequestInit | undefined)?.method === "POST")).toBe(true);
    expect(rendered!.container.textContent).toContain("nada se envió al cliente");
  });

  it("rol de solo lectura (auditor): ve la cola pero no tiene acciones de escritura", async () => {
    stub();
    await cargar({ ...CTX, role: "auditor" });
    expect(rendered!.container.textContent).toContain("Cliente Demo SA");
    expect(boton("Cumplida")).toBeUndefined();
    expect(boton("Encolar WhatsApp")).toBeUndefined();
    expect(boton("Registrar gestión")).toBeUndefined();
    expect(boton("Reporte PDF de cartera")).toBeDefined();
  });

  it("muestra la cola de WhatsApp como 'En cola (sin enviar)'", async () => {
    stub({ outbox: { disponible: true, mensajes: [{ id: "m1", receivableId: "cta-1", rfcReceptor: "XAXX010101000", cuerpo: "Recordatorio de pago", estado: "pendiente", creadoEn: "2026-10-01T12:00:00.000Z" }] } });
    await cargar();
    expect(rendered!.container.textContent).toContain("En cola (sin enviar)");
  });

  it("descarga el PDF de cartera (GET .../reporte-cartera?formato=pdf)", async () => {
    stub();
    const crear = vi.fn(() => "blob:x");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: crear, revokeObjectURL: vi.fn() }));
    await cargar();
    await act(async () => {
      boton("Reporte PDF de cartera")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/cola-cobranza/reporte-cartera?formato=pdf"))).toBe(true);
    expect(crear).toHaveBeenCalledOnce();
  });
});
