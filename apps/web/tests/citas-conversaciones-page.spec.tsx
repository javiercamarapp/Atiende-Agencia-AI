// @vitest-environment jsdom
//
// C-11 -- <ConversacionesPage /> (citas): bandeja real del servidor (telefono enmascarado, marca de crisis, cita vinculada), estado "no disponible
// aun" distinto del vacio, y acciones que llaman al endpoint REAL: tomar, responder (FormDialog), nota, devolver y cerrar (useConfirm: "Cancelar"
// NO ejecuta nada). Los botones dependen del estado de la toma y de los booleanos que declara el servidor.
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

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

const ITEM = (over: Record<string, unknown> = {}) => ({
  conversationId: "c-1", telefono: "***4567", vistaPrevia: "Quiero mover mi cita", actividadEn: "2026-10-01T10:00:00.000Z", estado: "agente", handoffId: null, motivo: null, crisis: false,
  solicitadaEn: null, ultimoClienteEn: null, tomadaPor: null, tomadaPorNombre: null, tomadaEn: null, esMia: false, cita: { id: "a-1", iniciaEn: "2026-10-03T16:00:00.000Z", estado: "confirmed" }, ...over,
});
const BANDEJA = (items: unknown[], over: Record<string, unknown> = {}) => ({ disponible: true, total: items.length, nextOffset: null, puedeGestionar: false, items, ...over });
const HANDOFF = (over: Record<string, unknown> = {}) => ({
  handoffId: "h-1", estado: "tomada", solicitadoPor: "staff", motivo: null, crisis: false, solicitadaEn: "2026-10-01T10:00:00.000Z", ultimoClienteEn: null, tomadaPor: "u-1", tomadaPorNombre: "Sam", tomadaEn: "2026-10-01T10:01:00.000Z", esMia: true, ...over,
});
const DETALLE = (over: Record<string, unknown> = {}) => ({
  conversationId: "c-1", telefono: "***4567", citaId: "a-1", puedeGestionar: false, mensajes: [{ rol: "cliente", texto: "Quiero mover mi cita" }, { rol: "agente", texto: "Claro, ¿para cuándo?" }], handoff: null, notas: [], ...over,
});

interface Estado { bandeja: unknown; detalle: unknown }
function stub(estado: Estado, onPost?: (url: string, body: unknown) => Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const metodo = init?.method ?? "GET";
    if (metodo === "GET" && url.startsWith(`${BASE}/conversaciones?`)) return jsonResponse(estado.bandeja);
    if (metodo === "GET" && url === `${BASE}/conversaciones/c-1`) return jsonResponse(estado.detalle);
    if (metodo === "POST") return onPost ? onPost(url, JSON.parse(String(init!.body))) : jsonResponse({});
    throw new Error(`fetch no esperado: ${metodo} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const montar = () => renderComponent(<MemoryRouter><ConversacionesPage {...ctx} /></MemoryRouter>);
const botones = () => Array.from(rendered!.container.querySelectorAll("button"));
const boton = (texto: string) => botones().find((b) => b.textContent?.includes(texto));
const dialogoAbierto = (rol: "dialog" | "alertdialog") => document.body.querySelector(`[role="${rol}"]`) as HTMLElement | null;

async function abrirConversacion(): Promise<void> {
  click(rendered!.container.querySelector("[data-conversation-id='c-1']")!);
  await esperar();
}

describe("ConversacionesPage (citas)", () => {
  it("lista la bandeja real: telefono enmascarado, marca de crisis y cita vinculada", async () => {
    stub({ bandeja: BANDEJA([ITEM({ crisis: true, estado: "pendiente" })]), detalle: DETALLE() });
    rendered = montar();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("***4567");
    expect(t).toContain("Crisis");
    expect(t).toContain("Pide una persona");
    expect(t).toContain("Quiero mover mi cita");
    expect(t).toContain("Confirmada");
    expect(t).toContain("1 por atender · 1 en total");
  });

  it("base sin la migracion: 'no disponible aun' (distinto de 'sin conversaciones') y sin tabla", async () => {
    stub({ bandeja: BANDEJA([], { disponible: false }), detalle: DETALLE() });
    rendered = montar();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Conversaciones no disponibles aún");
    expect(t).not.toContain("Sin conversaciones");
    expect(rendered.container.querySelector("[data-conversation-id]")).toBeNull();
  });

  it("vacio real: 'Sin conversaciones'", async () => {
    stub({ bandeja: BANDEJA([]), detalle: DETALLE() });
    rendered = montar();
    await esperar();
    expect(rendered.container.textContent).toContain("Sin conversaciones");
  });

  it("error de carga: muestra el error con reintento, no una bandeja vacia", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "boom" }, false, 500)));
    rendered = montar();
    await esperar();
    expect(rendered.container.textContent).toContain("Ocurrió un problema");
    expect(rendered.container.textContent).not.toContain("Sin conversaciones");
  });

  it("el filtro por estado vuelve a pedir la bandeja con ?estado=", async () => {
    const f = stub({ bandeja: BANDEJA([ITEM()]), detalle: DETALLE() });
    rendered = montar();
    await esperar();
    changeValue(rendered.container.querySelector("select[aria-label='Estado']") as HTMLSelectElement, "tomada");
    await esperar();
    expect(f.mock.calls.some((c) => String(c[0]).includes("estado=tomada"))).toBe(true);
  });

  it("'Tomar conversacion' manda POST real a .../tomar y recarga; sin toma no hay Responder ni Devolver", async () => {
    const posts: string[] = [];
    const estado: Estado = { bandeja: BANDEJA([ITEM()]), detalle: DETALLE() };
    stub(estado, (url) => {
      posts.push(url);
      estado.detalle = DETALLE({ handoff: HANDOFF() });
      return jsonResponse({ handoffId: "h-1", estado: "tomada" }, true, 201);
    });
    rendered = montar();
    await esperar();
    await abrirConversacion();
    expect(boton("Responder")).toBeUndefined();
    expect(boton("Devolver al agente")).toBeUndefined();
    expect(rendered.container.textContent).toContain("Toma la conversación para dejar notas internas.");
    click(boton("Tomar conversación")!);
    await esperar();
    expect(posts).toEqual([`${BASE}/conversaciones/c-1/tomar`]);
    expect(rendered.container.textContent).toContain("La conversación es tuya: el agente ya no responde.");
    expect(boton("Responder")).toBeDefined();
    expect(boton("Devolver al agente")).toBeDefined();
    expect(boton("Tomar conversación")).toBeUndefined();
  });

  it("si la tiene otra persona: no hay Tomar ni Responder; staff no puede devolver ni cerrar; un gestor (owner/admin) si", async () => {
    const otra = HANDOFF({ esMia: false, tomadaPor: "u-9", tomadaPorNombre: "Lupita" });
    stub({ bandeja: BANDEJA([ITEM({ estado: "tomada", handoffId: "h-1", tomadaPorNombre: "Lupita" })]), detalle: DETALLE({ handoff: otra }) });
    rendered = montar();
    await esperar();
    await abrirConversacion();
    expect(rendered.container.textContent).toContain("La tiene Lupita");
    expect(boton("Tomar conversación")).toBeUndefined();
    expect(boton("Responder")).toBeUndefined();
    expect(boton("Devolver al agente")).toBeUndefined();
    expect(boton("Cerrar conversación")).toBeUndefined();
    rendered.unmount();

    stub({ bandeja: BANDEJA([ITEM({ estado: "tomada", handoffId: "h-1" })], { puedeGestionar: true }), detalle: DETALLE({ puedeGestionar: true, handoff: otra }) });
    rendered = montar();
    await esperar();
    await abrirConversacion();
    expect(boton("Devolver al agente")).toBeDefined();
    expect(boton("Cerrar conversación")).toBeDefined();
    expect(boton("Responder")).toBeUndefined();
  });

  it("'Responder' abre el FormDialog, manda POST real con el texto recortado y avisa que quedo en cola", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    stub({ bandeja: BANDEJA([ITEM({ estado: "tomada", handoffId: "h-1", esMia: true })]), detalle: DETALLE({ handoff: HANDOFF() }) }, (url, body) => {
      posts.push({ url, body });
      return jsonResponse({ encolado: true, outboxId: "o-1" }, true, 201);
    });
    rendered = montar();
    await esperar();
    await abrirConversacion();
    click(boton("Responder")!);
    await esperar();
    const dlg = dialogoAbierto("dialog")!;
    expect(dlg.textContent).toContain("Responder por WhatsApp");
    changeValue(dlg.querySelector("textarea") as HTMLTextAreaElement, "  Con gusto le ayudo  ");
    const enviar = [...dlg.querySelectorAll("button")].find((b) => b.textContent?.includes("Enviar respuesta"))!;
    await act(async () => {
      enviar.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(posts).toEqual([{ url: `${BASE}/handoffs/h-1/responder`, body: { texto: "Con gusto le ayudo" } }]);
    expect(rendered.container.textContent).toContain("Respuesta en cola");
  });

  it("un error del servidor al responder (p. ej. sin numero de WhatsApp) se muestra y NO se pierde el texto", async () => {
    stub({ bandeja: BANDEJA([ITEM({ estado: "tomada", handoffId: "h-1", esMia: true })]), detalle: DETALLE({ handoff: HANDOFF() }) }, () => jsonResponse({ message: "El negocio no tiene un número de WhatsApp activo para responder." }, false, 409));
    rendered = montar();
    await esperar();
    await abrirConversacion();
    click(boton("Responder")!);
    await esperar();
    const dlg = dialogoAbierto("dialog")!;
    changeValue(dlg.querySelector("textarea") as HTMLTextAreaElement, "Hola");
    const enviar = [...dlg.querySelectorAll("button")].find((b) => b.textContent?.includes("Enviar respuesta"))!;
    await act(async () => {
      enviar.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(rendered.container.querySelector("[role='alert']")?.textContent).toContain("número de WhatsApp");
    expect((dialogoAbierto("dialog")!.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Hola");
  });

  it("nota interna: POST real con el texto y aparece en la lista tras recargar", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const estado: Estado = { bandeja: BANDEJA([ITEM({ estado: "tomada", handoffId: "h-1", esMia: true })]), detalle: DETALLE({ handoff: HANDOFF() }) };
    stub(estado, (url, body) => {
      posts.push({ url, body });
      estado.detalle = DETALLE({ handoff: HANDOFF(), notas: [{ id: "n-1", autor: "Sam", autorId: "u-1", texto: "Pidio factura", creadoEn: "2026-10-01T10:05:00.000Z" }] });
      return jsonResponse({ id: "n-1" }, true, 201);
    });
    rendered = montar();
    await esperar();
    await abrirConversacion();
    changeValue(rendered.container.querySelector("input[aria-label='Nueva nota']") as HTMLInputElement, " Pidio factura ");
    click(boton("Agregar")!);
    await esperar();
    expect(posts).toEqual([{ url: `${BASE}/handoffs/h-1/notas`, body: { texto: "Pidio factura" } }]);
    expect(rendered.container.textContent).toContain("Pidio factura");
  });

  it("'Devolver al agente' manda POST real a .../devolver", async () => {
    const posts: string[] = [];
    stub({ bandeja: BANDEJA([ITEM({ estado: "tomada", handoffId: "h-1", esMia: true })]), detalle: DETALLE({ handoff: HANDOFF() }) }, (url) => {
      posts.push(url);
      return jsonResponse({ handoffId: "h-1", estado: "devuelta", cambio: true });
    });
    rendered = montar();
    await esperar();
    await abrirConversacion();
    click(boton("Devolver al agente")!);
    await esperar();
    expect(posts).toEqual([`${BASE}/handoffs/h-1/devolver`]);
    expect(rendered.container.textContent).toContain("Devuelta al agente: vuelve a responder.");
  });

  it("'Cerrar conversacion' pide confirmacion (useConfirm, nunca window.confirm): 'Cancelar' NO ejecuta; 'Cerrar conversacion' si", async () => {
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmSpy);
    const posts: string[] = [];
    const fetchMock = stub({ bandeja: BANDEJA([ITEM({ estado: "tomada", handoffId: "h-1", esMia: true })]), detalle: DETALLE({ handoff: HANDOFF() }) }, (url) => {
      posts.push(url);
      return jsonResponse({ handoffId: "h-1", estado: "cerrada", cambio: true });
    });
    vi.stubGlobal("confirm", confirmSpy);
    void fetchMock;
    rendered = montar();
    await esperar();
    await abrirConversacion();

    click(boton("Cerrar conversación")!);
    await esperar();
    const dlg = dialogoAbierto("alertdialog")!;
    expect(dlg.textContent).toContain("Cerrar la conversación");
    const cancelar = [...dlg.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cancelar")!;
    await act(async () => {
      cancelar.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(posts).toEqual([]); // Cancelar NO ejecuta nada
    expect(dialogoAbierto("alertdialog")).toBeNull();

    click(boton("Cerrar conversación")!);
    await esperar();
    const ok = [...dialogoAbierto("alertdialog")!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cerrar conversación")!;
    await act(async () => {
      ok.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(posts).toEqual([`${BASE}/handoffs/h-1/cerrar`]);
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
