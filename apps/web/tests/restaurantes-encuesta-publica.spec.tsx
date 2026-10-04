// @vitest-environment jsdom
//
// R-41: pagina publica de la encuesta post-entrega (/encuesta/:orgSlug/:token) renderizada por la App real, con la red simulada.
// Cubre: formulario con estrellas, envio con calificacion y comentario, liga a resenas solo cuando el servidor la manda, token invalido,
// encuesta ya respondida, base sin migrar, reintento ante error y validacion de la calificacion.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}
function esperar(): Promise<void> {
  return act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
function renderEn(ruta: string): RenderedComponent {
  window.history.pushState({}, "", ruta);
  return renderComponent(<App />);
}
const q = <T extends Element>(sel: string): T | null => rendered!.container.querySelector<T>(sel);
const texto = () => rendered!.container.textContent ?? "";
const boton = (t: string) => Array.from(rendered!.container.querySelectorAll("button")).find((b) => b.textContent?.includes(t)) as HTMLButtonElement | undefined;
const estrella = (n: number) => q<HTMLButtonElement>(`button[role=radio][aria-label^="${n} "]`)!;
const RUTA = "/encuesta/los-taquitos/e1.cuerpo.firma";
const URL_API = /\/v1\/restaurantes\/los-taquitos\/encuesta\/e1\.cuerpo\.firma$/;
const LISTA = { disponible: true, encuesta: { sucursal: "Centro", respondida: false, calificacion: null, resenasUrl: null } };

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  globalThis.sessionStorage.clear();
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

describe("pagina publica de la encuesta", () => {
  it("muestra la sucursal, 5 estrellas y un comentario opcional; no muestra nada personal", async () => {
    fetchMock.mockResolvedValueOnce(json(LISTA));
    rendered = renderEn(RUTA);
    await esperar();
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(URL_API);
    expect(texto()).toContain("¿Cómo estuvo tu pedido?");
    expect(texto()).toContain("Centro");
    expect(rendered.container.querySelectorAll("button[role=radio]")).toHaveLength(5);
    expect(q("textarea#encuesta-comentario")).not.toBeNull();
    expect(texto()).not.toMatch(/\+52|tel[eé]fono/i);
  });

  it("enviar sin calificar: avisa y NO llama a la API", async () => {
    fetchMock.mockResolvedValueOnce(json(LISTA));
    rendered = renderEn(RUTA);
    await esperar();
    click(boton("Enviar")!);
    await esperar();
    expect(texto()).toContain("Elige de 1 a 5 estrellas.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("califica con 5 estrellas y comentario: manda ambos y, si el servidor da la liga, ofrece la reseña", async () => {
    fetchMock.mockResolvedValueOnce(json(LISTA)).mockResolvedValueOnce(json({ disponible: true, estado: "registrada", calificacion: 5, resenasUrl: "https://g.page/r/ejemplo/review" }, 201));
    rendered = renderEn(RUTA);
    await esperar();
    click(estrella(5));
    changeValue(q<HTMLTextAreaElement>("textarea#encuesta-comentario")!, "  Todo muy rico  ");
    click(boton("Enviar")!);
    await esperar();
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toMatch(URL_API);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ calificacion: 5, comentario: "  Todo muy rico  " });
    expect(q("[data-testid=encuesta-gracias]")).not.toBeNull();
    const liga = q<HTMLAnchorElement>("[data-testid=encuesta-gracias] a")!;
    expect(liga.getAttribute("href")).toBe("https://g.page/r/ejemplo/review");
    expect(liga.getAttribute("rel")).toContain("noopener");
    expect(liga.getAttribute("target")).toBe("_blank");
  });

  it("calificacion baja sin liga: agradece con empatia y no ofrece reseña", async () => {
    fetchMock.mockResolvedValueOnce(json(LISTA)).mockResolvedValueOnce(json({ disponible: true, estado: "registrada", calificacion: 2, resenasUrl: null }, 201));
    rendered = renderEn(RUTA);
    await esperar();
    click(estrella(2));
    click(boton("Enviar")!);
    await esperar();
    expect(texto()).toContain("Lamentamos");
    expect(q("[data-testid=encuesta-gracias] a")).toBeNull();
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body))).toEqual({ calificacion: 2 });
  });

  it("encuesta ya respondida: no muestra el formulario, solo el agradecimiento", async () => {
    fetchMock.mockResolvedValueOnce(json({ disponible: true, encuesta: { sucursal: "Centro", respondida: true, calificacion: 5, resenasUrl: null } }));
    rendered = renderEn(RUTA);
    await esperar();
    expect(q("[data-testid=encuesta-formulario]")).toBeNull();
    expect(q("[data-testid=encuesta-gracias]")).not.toBeNull();
  });

  it("token invalido o vencido (404): mensaje uniforme", async () => {
    fetchMock.mockResolvedValueOnce(json({ message: "No encontramos esa encuesta." }, 404));
    rendered = renderEn(RUTA);
    await esperar();
    expect(texto()).toContain("No encontramos esa encuesta");
    expect(q("[data-testid=encuesta-formulario]")).toBeNull();
  });

  it("base sin migrar: estado honesto, sin formulario", async () => {
    fetchMock.mockResolvedValueOnce(json({ disponible: false, mensaje: "La encuesta todavía no está disponible. ¡Gracias por tu pedido!" }));
    rendered = renderEn(RUTA);
    await esperar();
    expect(texto()).toContain("Encuesta no disponible por ahora");
    expect(q("[data-testid=encuesta-formulario]")).toBeNull();
  });

  it("un error al guardar muestra el mensaje del servidor y deja reintentar sin perder lo escrito", async () => {
    fetchMock.mockResolvedValueOnce(json(LISTA)).mockResolvedValueOnce(json({ message: "Demasiadas solicitudes." }, 429)).mockResolvedValueOnce(json({ disponible: true, estado: "registrada", calificacion: 4, resenasUrl: null }, 201));
    rendered = renderEn(RUTA);
    await esperar();
    click(estrella(4));
    changeValue(q<HTMLTextAreaElement>("textarea#encuesta-comentario")!, "Bien");
    click(boton("Enviar")!);
    await esperar();
    expect(texto()).toContain("Demasiadas solicitudes.");
    expect(q<HTMLTextAreaElement>("textarea#encuesta-comentario")!.value).toBe("Bien");
    click(boton("Enviar")!);
    await esperar();
    expect(q("[data-testid=encuesta-gracias]")).not.toBeNull();
  });

  it("un fallo de red al cargar ofrece reintentar", async () => {
    fetchMock.mockRejectedValueOnce(new Error("sin red")).mockResolvedValueOnce(json(LISTA));
    rendered = renderEn(RUTA);
    await esperar();
    expect(texto()).toContain("sin red");
    click(boton("Reintentar")!);
    await esperar();
    expect(q("[data-testid=encuesta-formulario]")).not.toBeNull();
  });
});
