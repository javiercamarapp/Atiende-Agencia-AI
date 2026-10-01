// @vitest-environment jsdom
// Pagina de notificaciones con un servidor falso con estado: lista, filtros, marcar leida / todas, enlaces,
// estados vacio / carga / error, revertir ante fallo y sincronia con la campana por el evento de cambio.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { NOTIFICACIONES_CAMBIO_EVENTO, anunciarCambioNotificaciones } from "../src/lib/useNotifications.ts";
import type { CambioNotificaciones } from "../src/lib/useNotifications.ts";
import { NotificacionesPagina } from "../src/components/NotificacionesPagina.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

interface Fila {
  id: string;
  titulo: string;
  cuerpo: string | null;
  enlace: string | null;
  categoria: string | null;
  severidad: "info" | "atencion" | "critica";
  createdAt: string;
  readAt: string | null;
}

let rendered: RenderedComponent | null = null;
let filas: Fila[] = [];
let llamadas: Array<{ metodo: string; url: string }> = [];
let fallarLectura: number | null = null;
let fallarMarca = false;
const eventos: CambioNotificaciones[] = [];
const escucha = (e: Event) => eventos.push((e as CustomEvent<CambioNotificaciones>).detail);

const fila = (id: string, extra: Partial<Fila> = {}): Fila => ({
  id,
  titulo: `Aviso ${id}`,
  cuerpo: null,
  enlace: null,
  categoria: "operacion",
  severidad: "info",
  createdAt: "2026-10-01T10:00:00.000Z",
  readAt: null,
  ...extra,
});

function json(cuerpo: unknown, status = 200) {
  return new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });
}

function servidor(url: string, init?: RequestInit): Response {
  const metodo = init?.method ?? "GET";
  llamadas.push({ metodo, url });
  const u = new URL(url);
  const noLeidas = () => filas.filter((f) => f.readAt === null).length;
  if (metodo === "GET" && u.pathname === "/notifications") {
    if (fallarLectura !== null) return json({}, fallarLectura);
    let lista = [...filas].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (u.searchParams.get("unread") === "1") lista = lista.filter((f) => f.readAt === null);
    const cat = u.searchParams.get("categoria");
    if (cat) lista = lista.filter((f) => f.categoria === cat);
    const before = u.searchParams.get("before");
    if (before) lista = lista.filter((f) => f.createdAt < before);
    const limit = Number(u.searchParams.get("limit") ?? 50);
    return json({ notifications: lista.slice(0, limit), unreadCount: noLeidas() });
  }
  if (metodo === "POST" && u.pathname === "/notifications/read-all") {
    const n = noLeidas();
    for (const f of filas) f.readAt = f.readAt ?? "2026-10-01T12:00:00.000Z";
    return json({ ok: true, markedCount: n, unreadCount: 0 });
  }
  const m = /^\/notifications\/(.+)\/read$/.exec(u.pathname);
  if (metodo === "POST" && m) {
    if (fallarMarca) return json({}, 500);
    const f = filas.find((x) => x.id === decodeURIComponent(m[1]!));
    if (!f) return json({ error: "no" }, 404);
    f.readAt = f.readAt ?? "2026-10-01T12:00:00.000Z";
    return json({ ok: true, unreadCount: noLeidas() });
  }
  return json({}, 404);
}

async function montar(token = "tok") {
  rendered = renderComponent(
    <MemoryRouter>
      <NotificacionesPagina apiBaseUrl="https://api.test" token={token} />
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

async function esperar() {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

const q = <T extends Element = HTMLElement>(sel: string) => rendered!.container.querySelector<T>(sel);
const tarjetas = () => [...rendered!.container.querySelectorAll<HTMLElement>('[data-testid="notificacion"]')];
const boton = (texto: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto);

beforeEach(() => {
  filas = [];
  llamadas = [];
  fallarLectura = null;
  fallarMarca = false;
  eventos.length = 0;
  window.addEventListener(NOTIFICACIONES_CAMBIO_EVENTO, escucha);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => servidor(url, init)));
});
afterEach(() => {
  window.removeEventListener(NOTIFICACIONES_CAMBIO_EVENTO, escucha);
  rendered?.unmount();
  rendered = null;
  vi.unstubAllGlobals();
});

describe("NotificacionesPagina", () => {
  it("vacio honesto: 'Sin novedades.' y sin boton de marcar todas", async () => {
    await montar();
    expect(rendered!.container.textContent).toContain("Sin novedades.");
    expect(boton("Marcar todas")).toBeUndefined();
    expect(tarjetas()).toHaveLength(0);
  });

  it("pinta una tarjeta por aviso con su severidad, categoria y la mas reciente primero", async () => {
    filas = [
      fila("a", { titulo: "Pedido nuevo", severidad: "atencion", createdAt: "2026-10-01T10:00:00.000Z" }),
      fila("b", { titulo: "Falla un proveedor", severidad: "critica", categoria: "salud", createdAt: "2026-10-01T11:00:00.000Z", cuerpo: "Proveedor: voz." }),
    ];
    await montar();
    const t = tarjetas();
    expect(t.map((x) => x.querySelector("p.text-ui")?.textContent)).toEqual(["Falla un proveedor", "Pedido nuevo"]);
    expect(t[0]!.dataset.severidad).toBe("critica");
    expect(t[0]!.textContent).toContain("Crítica");
    expect(t[0]!.textContent).toContain("Salud");
    expect(t[0]!.textContent).toContain("Proveedor: voz.");
    expect(t[1]!.textContent).toContain("Requiere atención");
  });

  it("'Resolver' solo existe si hay enlace interno y apunta a la pantalla origen", async () => {
    filas = [fila("a", { enlace: "/hoteles/mi-hotel/tickets", createdAt: "2026-10-01T11:00:00.000Z" }), fila("b", { enlace: null })];
    await montar();
    const [conEnlace, sinEnlace] = tarjetas();
    expect(conEnlace!.querySelector("a")?.getAttribute("href")).toBe("/hoteles/mi-hotel/tickets");
    expect(conEnlace!.querySelector("a")?.textContent).toContain("Resolver");
    expect(sinEnlace!.querySelector("a")).toBeNull();
  });

  it("marcar leida: la tarjeta sale de 'Sin leer', el servidor guarda y la campana recibe el contador", async () => {
    filas = [fila("a", { createdAt: "2026-10-01T11:00:00.000Z" }), fila("b")];
    await montar();
    expect(tarjetas()).toHaveLength(2);
    eventos.length = 0;
    click([...tarjetas()[0]!.querySelectorAll("button")].find((b) => b.textContent === "Marcar leído")!);
    await esperar();
    expect(tarjetas()).toHaveLength(1);
    expect(filas.find((f) => f.id === "a")!.readAt).not.toBeNull();
    expect(llamadas.some((l) => l.metodo === "POST" && l.url.endsWith("/notifications/a/read"))).toBe(true);
    expect(eventos.at(-1)).toEqual({ unreadCount: 1, origen: "pagina" });
  });

  it("marcar todas apaga todo: lista vacia, contador 0 para la campana", async () => {
    filas = [fila("a"), fila("b"), fila("c")];
    await montar();
    click(boton("Marcar todas")!);
    await esperar();
    expect(filas.every((f) => f.readAt !== null)).toBe(true);
    expect(tarjetas()).toHaveLength(0);
    expect(rendered!.container.textContent).toContain("Sin novedades.");
    expect(eventos.some((e) => e.unreadCount === 0 && e.origen === "pagina")).toBe(true);
    expect(boton("Marcar todas")).toBeUndefined();
  });

  it("'Todas' muestra tambien las leidas, atenuadas y sin boton de marcar leido", async () => {
    filas = [fila("a", { readAt: "2026-10-01T10:30:00.000Z", createdAt: "2026-10-01T11:00:00.000Z" }), fila("b")];
    await montar();
    expect(tarjetas()).toHaveLength(1);
    click(boton("Todas")!);
    await esperar();
    const t = tarjetas();
    expect(t).toHaveLength(2);
    expect(t[0]!.dataset.sinLeer).toBe("false");
    expect([...t[0]!.querySelectorAll("button")].some((b) => b.textContent === "Marcar leído")).toBe(false);
    expect(t[1]!.dataset.sinLeer).toBe("true");
    expect(rendered!.container.textContent).toContain("1 aviso ya leído");
  });

  it("filtra por categoria en el servidor y avisa cuando no hay resultados", async () => {
    filas = [fila("a", { categoria: "operacion" }), fila("b", { categoria: "salud", createdAt: "2026-10-01T11:00:00.000Z" })];
    await montar();
    click(boton("Salud")!);
    await esperar();
    expect(tarjetas()).toHaveLength(1);
    expect(llamadas.at(-1)!.url).toContain("categoria=salud");
    click(boton("Fiscal")!);
    await esperar();
    expect(tarjetas()).toHaveLength(0);
    expect(rendered!.container.textContent).toContain("Sin resultados.");
  });

  it("pagina con 'Cargar más' usando la fecha del ultimo aviso", async () => {
    filas = Array.from({ length: 35 }, (_, i) => fila(`n${i}`, { createdAt: new Date(Date.parse("2026-10-01T10:00:00.000Z") - i * 60_000).toISOString() }));
    await montar();
    expect(tarjetas()).toHaveLength(30);
    click(boton("Cargar más")!);
    await esperar();
    expect(tarjetas()).toHaveLength(35);
    expect(llamadas.at(-1)!.url).toContain("before=");
    expect(boton("Cargar más")).toBeUndefined();
  });

  it("error de lectura: estado de error con Reintentar que recupera", async () => {
    filas = [fila("a")];
    fallarLectura = 500;
    await montar();
    expect(q('[role="alert"]')!.textContent).toContain("No se pudieron cargar las notificaciones");
    fallarLectura = null;
    click(boton("Reintentar")!);
    await esperar();
    expect(tarjetas()).toHaveLength(1);
  });

  it("si el servidor rechaza marcar leida, revierte la tarjeta y el contador de la campana y lo dice inline", async () => {
    filas = [fila("a"), fila("b")];
    await montar();
    fallarMarca = true;
    eventos.length = 0;
    click([...tarjetas()[0]!.querySelectorAll("button")].find((b) => b.textContent === "Marcar leído")!);
    await esperar();
    expect(tarjetas()).toHaveLength(2);
    expect(rendered!.container.textContent).toContain("El servidor no pudo atender la solicitud");
    expect(eventos.at(-1)).toEqual({ unreadCount: 2, origen: "pagina" });
  });

  it("al detectar el sondeo una notificacion nueva recarga la lista sin parpadeo", async () => {
    filas = [fila("a", { createdAt: "2026-10-01T10:00:00.000Z" })];
    await montar();
    expect(tarjetas()).toHaveLength(1);
    filas.push(fila("nueva", { titulo: "Llego algo", createdAt: "2026-10-01T12:00:00.000Z" }));
    await act(async () => {
      anunciarCambioNotificaciones({ unreadCount: 2, origen: "sondeo" });
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(tarjetas().map((t) => t.querySelector("p.text-ui")?.textContent)).toEqual(["Llego algo", "Aviso a"]);
  });

  it("ir a 'Resolver' cuenta como atenderlo: marca la notificacion como leida en el servidor", async () => {
    filas = [fila("a", { enlace: "/hoteles/mi-hotel/tickets" })];
    await montar();
    click(tarjetas()[0]!.querySelector("a")!);
    await esperar();
    expect(filas[0]!.readAt).not.toBeNull();
    expect(llamadas.some((l) => l.metodo === "POST" && l.url.endsWith("/notifications/a/read"))).toBe(true);
  });

  it("sin token no pide nada", async () => {
    await montar("");
    expect(llamadas).toHaveLength(0);
  });
});
