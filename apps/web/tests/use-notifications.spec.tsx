// @vitest-environment jsdom
// Sondeo ligero del contador de la campana: base 30 s, pausa con la pestana oculta, backoff tras fallos,
// 401 detiene el sondeo y la pagina puede apagar el punto al instante con el evento de cambio.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTIFICACIONES_CAMBIO_EVENTO, SONDEO_BASE_MS, SONDEO_MAX_MS, anunciarCambioNotificaciones, esperaSondeo, useNotifications } from "../src/lib/useNotifications.ts";
import type { UseNotificationsResult } from "../src/lib/useNotifications.ts";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | null = null;
let ultimo: UseNotificationsResult;
const llamadas: string[] = [];
let respuestas: Array<() => Response | Promise<Response>> = [];

function Sonda({ token }: { token: string }) {
  ultimo = useNotifications("https://api.test", token);
  return <span data-hay={ultimo.hayNoLeidas ? "1" : "0"}>{ultimo.unreadCount}</span>;
}

function json(unreadCount: number, status = 200): Response {
  return new Response(JSON.stringify({ unreadCount }), { status, headers: { "content-type": "application/json" } });
}

function ocultar(oculta: boolean) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (oculta ? "hidden" : "visible") });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

async function avanzar(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  llamadas.length = 0;
  respuestas = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      llamadas.push(url);
      const siguiente = respuestas.shift();
      return siguiente ? siguiente() : json(0);
    }),
  );
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});
afterEach(() => {
  rendered?.unmount();
  rendered = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("esperaSondeo", () => {
  it("30 s tras un exito y el doble por cada fallo seguido, con tope de 5 min", () => {
    expect(esperaSondeo(0)).toBe(SONDEO_BASE_MS);
    expect(esperaSondeo(1)).toBe(60_000);
    expect(esperaSondeo(2)).toBe(120_000);
    expect(esperaSondeo(3)).toBe(240_000);
    expect(esperaSondeo(4)).toBe(SONDEO_MAX_MS);
    expect(esperaSondeo(20)).toBe(SONDEO_MAX_MS);
  });
});

describe("useNotifications", () => {
  it("lee el contador al montar y prende el punto solo si hay sin leer", async () => {
    respuestas = [() => json(2)];
    rendered = renderComponent(<Sonda token="tok" />);
    await avanzar(0);
    expect(llamadas).toEqual(["https://api.test/notifications/unread-count"]);
    expect(ultimo.unreadCount).toBe(2);
    expect(ultimo.hayNoLeidas).toBe(true);
  });

  it("sin token no sondea", async () => {
    rendered = renderComponent(<Sonda token="" />);
    await avanzar(SONDEO_BASE_MS * 3);
    expect(llamadas).toHaveLength(0);
    expect(ultimo.hayNoLeidas).toBe(false);
  });

  it("sondea cada 30 s: cuando llega una nueva el punto se enciende, sin recargar nada", async () => {
    respuestas = [() => json(0), () => json(0), () => json(1)];
    rendered = renderComponent(<Sonda token="tok" />);
    await avanzar(0);
    expect(ultimo.hayNoLeidas).toBe(false);
    await avanzar(SONDEO_BASE_MS);
    expect(ultimo.hayNoLeidas).toBe(false);
    await avanzar(SONDEO_BASE_MS);
    expect(llamadas).toHaveLength(3);
    expect(ultimo.hayNoLeidas).toBe(true);
  });

  it("anuncia 'sondeo' solo cuando el contador SUBE (la primera lectura no cuenta)", async () => {
    const eventos: Array<{ origen: string; unreadCount?: number }> = [];
    const escucha = (e: Event) => eventos.push((e as CustomEvent).detail);
    window.addEventListener(NOTIFICACIONES_CAMBIO_EVENTO, escucha);
    respuestas = [() => json(3), () => json(3), () => json(4)];
    rendered = renderComponent(<Sonda token="tok" />);
    await avanzar(0);
    await avanzar(SONDEO_BASE_MS);
    expect(eventos).toEqual([]);
    await avanzar(SONDEO_BASE_MS);
    expect(eventos).toEqual([{ origen: "sondeo", unreadCount: 4 }]);
    window.removeEventListener(NOTIFICACIONES_CAMBIO_EVENTO, escucha);
  });

  it("se PAUSA con la pestana oculta y refresca al instante al volver", async () => {
    respuestas = [() => json(0), () => json(5)];
    rendered = renderComponent(<Sonda token="tok" />);
    await avanzar(0);
    expect(llamadas).toHaveLength(1);
    ocultar(true);
    await avanzar(SONDEO_BASE_MS * 10);
    expect(llamadas).toHaveLength(1);
    ocultar(false);
    await avanzar(0);
    expect(llamadas).toHaveLength(2);
    expect(ultimo.hayNoLeidas).toBe(true);
  });

  it("backoff: tras un fallo espera 60 s, y conserva el ultimo estado conocido (nunca rompe la campana)", async () => {
    respuestas = [() => json(1), () => new Response("boom", { status: 503 }), () => json(1)];
    rendered = renderComponent(<Sonda token="tok" />);
    await avanzar(0);
    await avanzar(SONDEO_BASE_MS);
    expect(llamadas).toHaveLength(2);
    expect(ultimo.hayNoLeidas).toBe(true);
    await avanzar(SONDEO_BASE_MS);
    expect(llamadas).toHaveLength(2);
    await avanzar(SONDEO_BASE_MS);
    expect(llamadas).toHaveLength(3);
  });

  it("un error de red tambien aleja el sondeo sin lanzar", async () => {
    respuestas = [() => Promise.reject(new TypeError("offline")), () => json(0)];
    rendered = renderComponent(<Sonda token="tok" />);
    await avanzar(0);
    expect(llamadas).toHaveLength(1);
    await avanzar(SONDEO_BASE_MS);
    expect(llamadas).toHaveLength(1);
    await avanzar(SONDEO_BASE_MS);
    expect(llamadas).toHaveLength(2);
  });

  it("un 401 detiene el sondeo (el flujo de sesion expirada lo atiende la siguiente accion real)", async () => {
    respuestas = [() => new Response("no", { status: 401 })];
    rendered = renderComponent(<Sonda token="tok" />);
    await avanzar(0);
    await avanzar(SONDEO_MAX_MS * 2);
    expect(llamadas).toHaveLength(1);
  });

  it("una respuesta con forma invalida se trata como fallo, no como cero", async () => {
    respuestas = [() => json(2), () => new Response(JSON.stringify({ unreadCount: "mucho" }), { status: 200 })];
    rendered = renderComponent(<Sonda token="tok" />);
    await avanzar(0);
    await avanzar(SONDEO_BASE_MS);
    expect(ultimo.unreadCount).toBe(2);
  });

  it("la pagina apaga el punto al instante al anunciar el contador (se apaga al leer)", async () => {
    respuestas = [() => json(2)];
    rendered = renderComponent(<Sonda token="tok" />);
    await avanzar(0);
    expect(ultimo.hayNoLeidas).toBe(true);
    act(() => anunciarCambioNotificaciones({ unreadCount: 0, origen: "pagina" }));
    expect(ultimo.hayNoLeidas).toBe(false);
    expect(llamadas).toHaveLength(1);
  });

  it("al desmontar deja de sondear", async () => {
    rendered = renderComponent(<Sonda token="tok" />);
    await avanzar(0);
    rendered.unmount();
    rendered = null;
    await avanzar(SONDEO_BASE_MS * 5);
    expect(llamadas).toHaveLength(1);
  });
});
