import { describe, expect, it, vi } from "vitest";
import { conectarFeed, construirUrlFeedExportacion, desconectarFeed, fetchFeedsUnidad } from "../src/verticals/rentas/lib/ical-sync-client.ts";

const FEED_WIRE = {
  id: "feed-1",
  canal: "airbnb",
  url_importacion: "https://www.airbnb.com/calendar/ical/12345.ics?s=abc",
  activo: true,
  ultima_sincronizacion_exitosa_en: "2026-09-10T12:00:00.000Z",
  en_cuarentena_desde: null,
  intentos_fallidos_consecutivos: 0,
  motivo_cuarentena: null,
  drift_ultima_reconciliacion_completa: 0,
  ultimo_resumen: { eventosImportados: 3 },
};

describe("fetchFeedsUnidad", () => {
  it("pide GET .../unidades/:unidadId/ical-sync y mapea el wire snake_case a camelCase", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades/unidad-1/ical-sync");
      return new Response(JSON.stringify({ feeds: [FEED_WIRE] }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fetchFeedsUnidad(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1");

    expect(result).toEqual([
      {
        id: "feed-1",
        canal: "airbnb",
        urlImportacion: "https://www.airbnb.com/calendar/ical/12345.ics?s=abc",
        activo: true,
        ultimaSincronizacionExitosaEn: "2026-09-10T12:00:00.000Z",
        enCuarentenaDesde: null,
        intentosFallidosConsecutivos: 0,
        motivoCuarentena: null,
        driftUltimaReconciliacionCompleta: 0,
        ultimoResumen: { eventosImportados: 3 },
      },
    ]);
  });

  it("unidad sin membership -> error real (404 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Unidad no encontrada en esta property." }), { status: 404 })) as unknown as typeof fetch;
    await expect(fetchFeedsUnidad(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1")).rejects.toThrow(/Unidad no encontrada/);
  });
});

describe("conectarFeed", () => {
  it("hace POST real a .../canales/:canalCodigo/ical-sync con { url }", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades/unidad-1/canales/airbnb/ical-sync");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ url: "https://www.airbnb.com/calendar/ical/12345.ics" });
      return new Response(JSON.stringify({ id: "feed-1", canal: "airbnb", conectado: true }), { status: 201 });
    }) as unknown as typeof fetch;

    const result = await conectarFeed(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", "airbnb", "https://www.airbnb.com/calendar/ical/12345.ics");
    expect(result).toEqual({ id: "feed-1", canal: "airbnb", conectado: true });
  });

  it("URL de feed inválida -> error real (400 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "url: no es una URL válida." }), { status: 400 })) as unknown as typeof fetch;
    await expect(conectarFeed(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", "airbnb", "no-es-url")).rejects.toThrow(/no es una URL válida/);
  });

  it("sin rol de escritura de calendario -> error real (403 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No tienes el rol requerido para esta acción." }), { status: 403 })) as unknown as typeof fetch;
    await expect(conectarFeed(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", "airbnb", "https://x.com/a.ics")).rejects.toThrow(/rol requerido/);
  });
});

describe("desconectarFeed", () => {
  it("hace DELETE real a .../canales/:canalCodigo/ical-sync", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades/unidad-1/canales/airbnb/ical-sync");
      expect(init?.method).toBe("DELETE");
      return new Response(JSON.stringify({ canal: "airbnb", conectado: false }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await desconectarFeed(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", "airbnb");
    expect(result).toEqual({ canal: "airbnb", conectado: false });
  });

  it("ningún feed conectado para esta unidad/canal -> error real (404 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No hay un feed conectado para esta unidad/canal." }), { status: 404 })) as unknown as typeof fetch;
    await expect(desconectarFeed(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", "airbnb")).rejects.toThrow(/No hay un feed conectado/);
  });
});

describe("construirUrlFeedExportacion", () => {
  it("arma la URL pública .../canales/:canalCodigo/feed.ics sin hacer ninguna llamada de red", () => {
    const url = construirUrlFeedExportacion("http://api.local", "prop-1", "unidad-1", "airbnb");
    expect(url).toBe("http://api.local/rentas/prop-1/unidades/unidad-1/canales/airbnb/feed.ics");
  });
});
