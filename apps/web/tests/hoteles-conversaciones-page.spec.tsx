// @vitest-environment jsdom
//
// H-20 -- <ConversacionesPage /> de hoteles: `fetch` global mockeado por ruta real contra apps/api/.../hoteles/conversaciones.ts.
// Cubre bandeja (estado, no leidas, filtro por huesped desde la ficha), base sin migrar (disponible:false, nunca "sin conversaciones"),
// hilo (leer al abrir, tomar, conflicto, devolver, cerrar, reasignar solo owner/gm), respuesta (solo el responsable; estado de envio
// honesto "Pendiente de envio"; sin numeros de tarjeta), notas y gating por rol.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversacionesPage } from "../src/verticals/hoteles/pages/Conversaciones.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import type { ConversacionItemWire, DetalleWire } from "../src/verticals/hoteles/lib/conversaciones-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ctx = (role: string): HotelesShellContext => ({ apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role, staffFullName: "Ana", staffEmail: "ana@example.com" });
const BASE = "https://api.test/hoteles/prop-1/conversaciones";

function item(over: Partial<ConversacionItemWire> = {}): ConversacionItemWire {
  return {
    id: "c1", telefono: "••••2222", estado: "humano", porAtender: true, responsable: null, tomadaEn: null, motivo: "agente_derivo", motivoTexto: "El agente pidió que lo atienda una persona",
    derivadaEn: "2026-12-02T17:00:00Z", noLeidos: 2, ultimoMensajeDelHuespedEn: "2026-12-02T17:00:00Z", actividadEn: "2026-12-02T17:00:00Z", vistaPrevia: "Quiero negociar un precio",
    ultimoRol: "user", huesped: { id: "g1", nombre: "Ana Torres" }, ...over,
  };
}
function detalle(over: Partial<DetalleWire> = {}): DetalleWire {
  return {
    ...item(), cerradaEn: null, derivaciones: 1, esResponsable: false, totalMensajes: 2,
    mensajes: [
      { rol: "user", origen: "huesped", texto: "Quiero negociar un precio", creadoEn: "2026-12-02T17:00:00Z", envio: null },
      { rol: "assistant", origen: "agente", texto: "Una persona le ayuda", creadoEn: null, envio: null },
    ],
    notas: [{ id: "n1", autor: "Recepción", autorId: "u2", texto: "Es cliente frecuente", creadaEn: "2026-12-02T17:05:00Z" }],
    ...over,
  };
}

interface Mock {
  items?: ConversacionItemWire[];
  disponible?: boolean;
  detalle?: DetalleWire;
  tomarFalla?: { status: number; code: string; message: string };
  sinTelefono?: boolean;
}
function stub(m: Mock = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const json = (b: unknown, status = 200) => ({ ok: status < 400, status, json: async () => b }) as unknown as Response;
    if (method === "GET" && url.startsWith(`${BASE}?`) || (method === "GET" && url === BASE)) {
      const items = m.items ?? [item()];
      return json({ disponible: m.disponible ?? true, total: items.length, siguiente: null, sinTelefono: m.sinTelefono ?? false, items: m.disponible === false ? [] : items });
    }
    if (method === "GET" && url === `${BASE}/c1`) return json(m.detalle ?? detalle());
    if (method === "POST" && url.endsWith("/c1/leer")) return json({ id: "c1", noLeidos: 0 });
    if (method === "POST" && url.endsWith("/c1/tomar")) {
      if (m.tomarFalla) return json({ code: m.tomarFalla.code, message: m.tomarFalla.message }, m.tomarFalla.status);
      return json({ id: "c1", estado: "humano", responsableId: "u1", tomadaEn: "2026-12-02T18:00:00Z" }, 201);
    }
    if (method === "POST" && url.endsWith("/c1/devolver-al-agente")) return json({ id: "c1", estado: "agente" });
    if (method === "POST" && url.endsWith("/c1/cerrar")) return json({ id: "c1", estado: "cerrada" });
    if (method === "POST" && url.endsWith("/c1/notas")) return json({ id: "n2" }, 201);
    if (method === "POST" && url.endsWith("/c1/responder")) return json({ encolado: true, outboxId: "o1", envio: "pendiente_envio" }, 201);
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function esperar() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}
function montar(role = "frontdesk", entrada = "/hoteles/demo/conversaciones") {
  rendered = renderComponent(
    <MemoryRouter initialEntries={[entrada]}>
      <ConversacionesPage {...ctx(role)} />
    </MemoryRouter>,
  );
}
const texto = () => rendered!.container.textContent ?? "";
const boton = (t: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === t || b.getAttribute("aria-label") === t) as HTMLButtonElement | undefined;
const llamadas = (metodo: string, fin: string) => fetchMock.mock.calls.filter((c) => (c[1]?.method ?? "GET") === metodo && String(c[0]).endsWith(fin));
async function abrirHilo() {
  const fila = rendered!.container.querySelector('ul[aria-label="Conversaciones"] button') as HTMLButtonElement;
  await act(async () => {
    click(fila);
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}
async function pulsar(t: string) {
  await act(async () => {
    click(boton(t)!);
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}

describe("ConversacionesPage (hoteles) -- bandeja", () => {
  it("lista las conversaciones con estado, huesped, vista previa y punto de no leidas; resume cuantas esperan", async () => {
    stub({ items: [item(), item({ id: "c2", estado: "agente", porAtender: false, noLeidos: 0, huesped: null, telefono: "••••9999", vistaPrevia: "Gracias", motivo: null, motivoTexto: null })] });
    montar();
    expect(texto()).toContain("Cargando conversaciones");
    await esperar();
    const t = texto();
    expect(t).toContain("Ana Torres");
    expect(t).toContain("Por atender");
    expect(t).toContain("Con el agente");
    expect(t).toContain("Quiero negociar un precio");
    expect(t).toContain("••••9999");
    expect(t).toContain("1 por atender · 2 en total");
    expect(rendered!.container.querySelector('[aria-label="2 sin leer"]')).not.toBeNull();
  });

  it("base sin la migracion 043: aviso honesto de 'no disponibles aun', nunca 'sin conversaciones'", async () => {
    stub({ disponible: false });
    montar();
    await esperar();
    expect(texto()).toContain("Conversaciones no disponibles aún");
    expect(texto()).not.toContain("Sin conversaciones");
  });

  it("bandeja vacia con datos reales: 'Sin conversaciones'", async () => {
    stub({ items: [] });
    montar();
    await esperar();
    expect(texto()).toContain("Sin conversaciones");
  });

  it("el filtro por estado y 'solo no leidas' viajan al servidor", async () => {
    stub();
    montar();
    await esperar();
    changeValue(rendered!.container.querySelector("select") as HTMLSelectElement, "por_atender");
    await esperar();
    expect(fetchMock.mock.calls.some((c) => String(c[0]) === `${BASE}?estado=por_atender`)).toBe(true);
    await act(async () => {
      click(rendered!.container.querySelector('input[type="checkbox"]') as HTMLInputElement);
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(fetchMock.mock.calls.some((c) => String(c[0]) === `${BASE}?estado=por_atender&noLeidas=1`)).toBe(true);
  });

  it("enlace desde la ficha: ?huesped= filtra por ese huesped y se puede quitar el filtro", async () => {
    stub();
    montar("frontdesk", "/hoteles/demo/conversaciones?huesped=g1");
    await esperar();
    expect(fetchMock.mock.calls.some((c) => String(c[0]) === `${BASE}?huespedId=g1`)).toBe(true);
    expect(texto()).toContain("Filtrando por un huésped");
    await act(async () => {
      click(boton("Quitar filtro")!);
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(texto()).not.toContain("Filtrando por un huésped");
  });

  it("huesped sin telefono: explica por que no hay conversaciones", async () => {
    stub({ items: [], sinTelefono: true });
    montar("frontdesk", "/hoteles/demo/conversaciones?huesped=g1");
    await esperar();
    expect(texto()).toContain("Este huésped no tiene teléfono");
  });

  it("housekeeping, fnb y contabilidad ven 'Sin acceso' y NO consultan la bandeja", async () => {
    for (const rol of ["housekeeping", "fnb", "accountant"]) {
      stub();
      montar(rol);
      await esperar();
      expect(texto()).toContain("Sin acceso");
      expect(fetchMock).not.toHaveBeenCalled();
      rendered!.unmount();
      rendered = undefined;
    }
  });
});

describe("ConversacionesPage (hoteles) -- hilo", () => {
  it("abrir una conversacion la marca leida, muestra mensajes por origen, notas y el aviso de que el agente calla", async () => {
    stub();
    montar();
    await esperar();
    await abrirHilo();
    expect(llamadas("POST", "/c1/leer")).toHaveLength(1);
    const t = texto();
    expect(t).toContain("Huésped");
    expect(t).toContain("Agente");
    expect(t).toContain("Quiero negociar un precio");
    expect(t).toContain("Es cliente frecuente");
    expect(t).toContain("Nadie la ha tomado");
    expect(t).toContain("El agente no responde mientras esté en atención humana");
    expect(t).toContain("Ficha del huésped");
    // sin ser responsable no hay formulario de respuesta
    expect(rendered!.container.querySelector('textarea')).toBeNull();
  });

  it("tomar: llama al servidor, avisa y recarga; un conflicto (otra persona la tomo) se muestra tal cual", async () => {
    stub();
    montar();
    await esperar();
    await abrirHilo();
    await pulsar("Tomar conversación");
    expect(llamadas("POST", "/c1/tomar")).toHaveLength(1);
    expect(texto()).toContain("La conversación es tuya");
    rendered!.unmount();
    stub({ tomarFalla: { status: 409, code: "ya_tomada", message: "Otra persona ya tomó esta conversación." } });
    montar();
    await esperar();
    await abrirHilo();
    await pulsar("Tomar conversación");
    expect(texto()).toContain("Otra persona ya tomó esta conversación.");
  });

  it("responsable: puede responder; la respuesta queda 'Pendiente de envio' con la explicacion honesta; devolver y cerrar disponibles", async () => {
    const mia = detalle({
      porAtender: false, esResponsable: true, responsable: { id: "u1", nombre: "Ana" }, tomadaEn: "2026-12-02T18:00:00Z",
      mensajes: [
        { rol: "user", origen: "huesped", texto: "Quiero negociar un precio", creadoEn: null, envio: null },
        { rol: "assistant", origen: "personal", texto: "Con gusto, le hago una oferta", creadoEn: "2026-12-02T18:01:00Z", envio: "pendiente_envio" },
      ],
    });
    stub({ detalle: mia });
    montar();
    await esperar();
    await abrirHilo();
    const t = texto();
    expect(t).toContain("Personal del hotel");
    expect(t).toContain("Pendiente de envío");
    expect(t).toContain("Hay 1 respuesta pendiente de envío");
    expect(boton("Devolver al agente")).toBeDefined();
    expect(boton("Cerrar conversación")).toBeDefined();
    expect(boton("Tomar conversación")).toBeUndefined();
    const area = rendered!.container.querySelector("textarea") as HTMLTextAreaElement;
    changeValue(area, "  Con gusto, le hago una oferta  ");
    await act(async () => {
      click(boton("Enviar respuesta")!);
      for (let i = 0; i < 6; i++) await flushMicrotasks();
    });
    const post = llamadas("POST", "/c1/responder")[0]!;
    expect(JSON.parse(post[1].body as string)).toEqual({ texto: "Con gusto, le hago una oferta" });
    expect(texto()).toContain("Respuesta guardada. Se envía por WhatsApp en cuanto el canal esté conectado.");
    await pulsar("Devolver al agente");
    expect(llamadas("POST", "/c1/devolver-al-agente")).toHaveLength(1);
    await pulsar("Cerrar conversación");
    expect(llamadas("POST", "/c1/cerrar")).toHaveLength(1);
  });

  it("minimizacion: una respuesta o nota con numero de tarjeta no se envia", async () => {
    stub({ detalle: detalle({ porAtender: false, esResponsable: true, responsable: { id: "u1", nombre: "Ana" } }) });
    montar();
    await esperar();
    await abrirHilo();
    changeValue(rendered!.container.querySelector("textarea") as HTMLTextAreaElement, "Mi tarjeta es 4111 1111 1111 1111");
    expect(texto()).toContain("No envíes números de tarjeta ni de documento por WhatsApp.");
    expect(boton("Enviar respuesta")!.disabled).toBe(true);
    changeValue(rendered!.container.querySelector('input[aria-label="Nueva nota"]') as HTMLInputElement, "tarjeta 4111111111111111");
    expect(boton("Agregar")!.disabled).toBe(true);
    expect(llamadas("POST", "/c1/responder")).toHaveLength(0);
    expect(llamadas("POST", "/c1/notas")).toHaveLength(0);
  });

  it("agrega una nota interna", async () => {
    stub();
    montar();
    await esperar();
    await abrirHilo();
    changeValue(rendered!.container.querySelector('input[aria-label="Nueva nota"]') as HTMLInputElement, "  Pidió late check-out  ");
    await pulsar("Agregar");
    expect(JSON.parse(llamadas("POST", "/c1/notas")[0]![1].body as string)).toEqual({ texto: "Pidió late check-out" });
  });

  it("tomada por otra persona: recepcion no ve tomar/reasignar/responder; owner/gm ven 'Reasignarme la conversación'", async () => {
    const ajena = detalle({ porAtender: false, esResponsable: false, responsable: { id: "u9", nombre: "Marta" }, tomadaEn: "2026-12-02T18:00:00Z" });
    stub({ detalle: ajena, items: [item({ porAtender: false, responsable: { id: "u9", nombre: "Marta" } })] });
    montar("frontdesk");
    await esperar();
    await abrirHilo();
    expect(texto()).toContain("La tiene: Marta");
    expect(boton("Tomar conversación")).toBeUndefined();
    expect(boton("Reasignarme la conversación")).toBeUndefined();
    expect(boton("Devolver al agente")).toBeUndefined();
    expect(texto()).toContain("Solo la persona que tomó la conversación puede responder.");
    rendered!.unmount();
    stub({ detalle: ajena, items: [item({ porAtender: false, responsable: { id: "u9", nombre: "Marta" } })] });
    montar("owner");
    await esperar();
    await abrirHilo();
    await pulsar("Reasignarme la conversación");
    expect(JSON.parse(llamadas("POST", "/c1/tomar")[0]![1].body as string)).toEqual({ reasignar: true });
    expect(boton("Devolver al agente")).toBeDefined();
  });

  it("conversacion cerrada: no se puede tomar y se explica que se reabre sola", async () => {
    stub({ detalle: detalle({ estado: "cerrada", porAtender: false, cerradaEn: "2026-12-02T19:00:00Z" }), items: [item({ estado: "cerrada", porAtender: false, noLeidos: 0 })] });
    montar();
    await esperar();
    await abrirHilo();
    expect(boton("Tomar conversación")).toBeUndefined();
    expect(texto()).toContain("Se reabre con el agente si el huésped vuelve a escribir.");
  });
});
