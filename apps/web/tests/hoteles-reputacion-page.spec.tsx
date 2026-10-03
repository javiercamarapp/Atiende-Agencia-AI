// @vitest-environment jsdom
//
// Pruebas reales de <ReputacionPage /> (hoteles): render de la lista y estados (carga, vacio, error), captura de una
// resena (FormDialog), detalle, responder y ejecutar/descartar una accion sugerida CON confirmacion (Cancelar y Escape
// nunca escriben) y la pestana de metricas. `fetch` mockeado por ruta real contra apps/api/.../hoteles/reputacion.ts.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock, Toaster: () => null }));

import { ReputacionPage } from "../src/verticals/hoteles/pages/Reputacion.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import type { GuestReview, GuestReviewAction, GuestReviewDetail, IndiceReputacion } from "../src/verticals/hoteles/lib/reputacion-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  toastMock.success.mockClear();
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const jsonResponse = (body: unknown, ok = true): Response => ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response;

const CTX: HotelesShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "owner",
  staffFullName: "GM Demo",
  staffEmail: "gm@example.com",
};

const RESENA: GuestReview = {
  id: "rev-1",
  guestId: null,
  folioId: null,
  source: "google",
  externalId: null,
  texto: "El aire acondicionado de la habitacion no funcionaba",
  idioma: "es",
  calificacion: 2,
  stayState: "post_estancia",
  isPublic: false,
  topics: [{ topic: "limpieza", esConocido: true }],
  sentiment: "negativo",
  sentimentScore: -0.5,
  createdBy: null,
  createdAt: "2026-09-18T10:00:00.000Z",
};

const ACCION: GuestReviewAction = {
  id: "act-1",
  reviewId: "rev-1",
  actionType: "ticket_mantenimiento",
  status: "pendiente",
  ticketId: null,
  detail: {},
  reason: "Se menciona una falla de mantenimiento",
  resolvedBy: null,
  resolvedAt: null,
  createdAt: "2026-09-18T10:00:00.000Z",
};

const DETALLE: GuestReviewDetail = { resena: RESENA, acciones: [ACCION], respuestas: [] };

const INDICE: IndiceReputacion = {
  totalResenas: 12,
  promedioSentimiento: 0.25,
  promedioCalificacion: 4.2,
  distribucionSentimiento: { muy_negativo: 1, negativo: 2, neutral: 3, positivo: 4, muy_positivo: 2 },
  distribucionSentimientoPct: { muy_negativo: 8, negativo: 17, neutral: 25, positivo: 33, muy_positivo: 17 },
  puntajeIndice: 72,
  temasFrecuentes: [],
  temasCriticos: [{ topic: "ruido", esConocido: true, resenas: 5, resenasNegativas: 4, pctNegativo: 80 }],
};

interface Handlers {
  reviews?: readonly GuestReview[];
  listOk?: boolean;
}

function stubFetch(h: Handlers = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.startsWith("https://api.test/hoteles/prop-1/reputacion/resenas?")) return jsonResponse(h.reviews ?? [RESENA], h.listOk ?? true);
    if (method === "GET" && url === "https://api.test/hoteles/prop-1/reputacion/resenas") return jsonResponse(h.reviews ?? [RESENA], h.listOk ?? true);
    if (method === "GET" && url === "https://api.test/hoteles/prop-1/reputacion/resenas/rev-1") return jsonResponse(DETALLE);
    if (method === "GET" && url === "https://api.test/hoteles/prop-1/reputacion/indice") return jsonResponse(INDICE);
    if (method === "POST" && url === "https://api.test/hoteles/prop-1/reputacion/resenas") return jsonResponse({ resena: RESENA, acciones: [ACCION] });
    if (method === "POST" && url === "https://api.test/hoteles/prop-1/reputacion/resenas/rev-1/respuestas") {
      return jsonResponse({ id: "resp-1", reviewId: "rev-1", texto: JSON.parse(init!.body as string).texto, createdBy: null, createdAt: "2026-09-19T10:00:00.000Z" });
    }
    if (method === "POST" && url === "https://api.test/hoteles/prop-1/reputacion/acciones/act-1/resolver") return jsonResponse({ ...ACCION, status: JSON.parse(init!.body as string).status });
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

const escrituras = () => fetchMock.mock.calls.filter(([, init]) => (init?.method ?? "GET") !== "GET");
const dialogo = () => document.body.querySelector('[role="dialog"]') as HTMLElement | null;
const confirmacion = () => document.body.querySelector('[role="alertdialog"]') as HTMLElement | null;
const botonEn = (raiz: ParentNode, etiqueta: string) => [...raiz.querySelectorAll("button")].find((b) => b.textContent?.trim() === etiqueta) as HTMLButtonElement;

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
async function pulsar(btn: Element): Promise<void> {
  await act(async () => {
    click(btn);
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

function renderPage(): RenderedComponent {
  return renderComponent(
    <MemoryRouter>
      <ReputacionPage {...CTX} />
    </MemoryRouter>,
  );
}

async function abrirDetalle(): Promise<void> {
  await pulsar(botonEn(rendered!.container, "Ver detalle / responder"));
  await esperar();
}

describe("ReputacionPage (hoteles)", () => {
  it("un solo h1 'Reputación', carga y pinta la resena real con fuente, calificacion y sentimiento", async () => {
    stubFetch();
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando");
    await esperar();
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
    expect(rendered.container.querySelector("h1")!.textContent).toBe("Reputación");
    const text = rendered.container.textContent!;
    expect(text).toContain("El aire acondicionado de la habitacion no funcionaba");
    expect(text).toContain("Google");
    expect(text).toContain("2/5");
    expect(text).toContain("Negativo");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.test/hoteles/prop-1/reputacion/resenas");
  });

  it("estado vacio honesto y estado de error con reintentar", async () => {
    stubFetch({ reviews: [] });
    rendered = renderPage();
    await esperar();
    expect(rendered.container.textContent).toContain("No hay reseñas en este filtro.");
    rendered.unmount();

    stubFetch({ listOk: false });
    rendered = renderPage();
    await esperar();
    expect(rendered.container.textContent).toContain("Ocurrió un problema");
    expect(botonEn(rendered.container, "Reintentar")).toBeDefined();
  });

  it("capturar resena: FormDialog con campos etiquetados; vacio no llama a la API; con texto manda POST y avisa", async () => {
    stubFetch();
    rendered = renderPage();
    await esperar();
    await pulsar(botonEn(rendered.container, "Capturar reseña"));
    expect(dialogo()!.textContent).toContain("Capturar reseña/encuesta");
    expect(dialogo()!.querySelectorAll("label").length).toBeGreaterThanOrEqual(4);

    await act(async () => {
      dialogo()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
    expect(dialogo()!.textContent).toContain("El texto de la reseña no puede estar vacío.");
    expect(escrituras()).toHaveLength(0);

    changeValue(dialogo()!.querySelector("textarea")!, "  Excelente servicio  ");
    changeValue(dialogo()!.querySelector("#resena-calificacion") as HTMLInputElement, "5");
    await act(async () => {
      dialogo()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });
    await esperar();
    const [url, init] = escrituras()[0]!;
    expect(url).toBe("https://api.test/hoteles/prop-1/reputacion/resenas");
    expect(JSON.parse(init.body as string)).toEqual({ texto: "Excelente servicio", calificacion: 5, source: "encuesta_propia", stayState: "desconocido" });
    expect(toastMock.success).toHaveBeenCalledWith("Reseña capturada: 1 acción(es) generada(s).", expect.anything());
    expect(dialogo()).toBeNull();
  });

  it("responder pide confirmacion: Volver NO escribe; Escape NO escribe; Responder manda POST con el texto", async () => {
    stubFetch();
    rendered = renderPage();
    await esperar();
    await abrirDetalle();
    expect(dialogo()!.textContent).toContain("Se menciona una falla de mantenimiento");

    changeValue(dialogo()!.querySelector("input") as HTMLInputElement, "Lamentamos lo ocurrido");
    await act(async () => {
      dialogo()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
    expect(confirmacion()).not.toBeNull();
    await pulsar(botonEn(confirmacion()!, "Volver"));
    expect(confirmacion()).toBeNull();
    expect(escrituras()).toHaveLength(0);

    await act(async () => {
      dialogo()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
    await act(async () => {
      confirmacion()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await flushMicrotasks();
    });
    expect(escrituras()).toHaveLength(0);

    await act(async () => {
      dialogo()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
    await pulsar(botonEn(confirmacion()!, "Responder"));
    await esperar();
    const [url, init] = escrituras()[0]!;
    expect(url).toBe("https://api.test/hoteles/prop-1/reputacion/resenas/rev-1/respuestas");
    expect(JSON.parse(init.body as string)).toEqual({ texto: "Lamentamos lo ocurrido" });
    expect(toastMock.success).toHaveBeenCalledWith("Respuesta registrada.", expect.anything());
  });

  it("ejecutar o descartar una accion sugerida exige confirmacion; Volver no escribe y Ejecutar manda status ejecutada", async () => {
    stubFetch();
    rendered = renderPage();
    await esperar();
    await abrirDetalle();

    await pulsar(botonEn(dialogo()!, "Descartar"));
    expect(confirmacion()!.textContent).toContain("Descartar la acción sugerida");
    await pulsar(botonEn(confirmacion()!, "Volver"));
    expect(escrituras()).toHaveLength(0);

    await pulsar(botonEn(dialogo()!, "Ejecutar"));
    expect(confirmacion()!.textContent).toContain("Ejecutar la acción sugerida");
    await pulsar(botonEn(confirmacion()!, "Ejecutar"));
    await esperar();
    const [url, init] = escrituras()[0]!;
    expect(url).toBe("https://api.test/hoteles/prop-1/reputacion/acciones/act-1/resolver");
    expect(JSON.parse(init.body as string)).toEqual({ status: "ejecutada" });
  });

  it("cerrar el detalle (Cerrar) no escribe nada", async () => {
    stubFetch();
    rendered = renderPage();
    await esperar();
    await abrirDetalle();
    await pulsar(botonEn(dialogo()!, "Cerrar"));
    expect(dialogo()).toBeNull();
    expect(escrituras()).toHaveLength(0);
  });

  it("pestana Metricas: cifras reales del indice y temas criticos", async () => {
    stubFetch();
    rendered = renderPage();
    await esperar();
    const tab = [...rendered.container.querySelectorAll("button, [role=tab]")].find((b) => b.textContent === "Métricas")!;
    await act(async () => {
      tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      await flushMicrotasks();
    });
    await esperar();
    const text = rendered.container.textContent!;
    expect(text).toContain("12");
    expect(text).toContain("72");
    expect(text).toContain("4.2");
    expect(text).toContain("ruido");
    expect(text).toContain("4/5 negativas (80%)");
  });
});
