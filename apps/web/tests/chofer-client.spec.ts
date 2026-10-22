// Cliente HTTP del chofer (rutas nuevas del panel): URL, cabecera de idempotencia, validacion contra el contrato y clasificacion de errores.
import { describe, expect, it, vi } from "vitest";
import {
  RepartidorClientError,
  deshacerEntregaChofer,
  entregarPedidoChofer,
  esErrorDeRed,
  esFuncionNoDisponible,
  fetchEntregasChofer,
  fetchHoyChofer,
  nuevaLlaveIdempotencia,
  pedirTelefonoCliente,
  reportarProblemaChofer,
} from "../src/verticals/restaurantes/lib/repartidor-client.ts";

const API = "http://api.local";
const BASE = `${API}/v1/restaurantes/prop-1/repartidor`;
const ID = "00000000-0000-4000-8000-000000000001";
const json = (status: number, cuerpo: unknown) => new Response(JSON.stringify(cuerpo), { status });

describe("fetchEntregasChofer", () => {
  it("pega a repartidor/entregas y devuelve el cuerpo validado", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(`${BASE}/entregas`);
      return json(200, { entregas: [], actualizadoEn: "2026-10-21T20:00:00.000Z" });
    }) as unknown as typeof fetch;
    expect((await fetchEntregasChofer(fetchImpl, API, "tok", "prop-1")).entregas).toEqual([]);
  });

  it("un cuerpo que no cumple el contrato es un error honesto, no datos a medias", async () => {
    const fetchImpl = vi.fn(async () => json(200, { entregas: [{ id: "x" }], actualizadoEn: "ya" })) as unknown as typeof fetch;
    await expect(fetchEntregasChofer(fetchImpl, API, "tok", "prop-1")).rejects.toMatchObject({ code: "respuesta_invalida" });
  });

  it("501 no_implementado se reconoce como funcion aun no disponible", async () => {
    const fetchImpl = vi.fn(async () => json(501, { code: "no_implementado", message: "No disponible aún" })) as unknown as typeof fetch;
    const err = await fetchEntregasChofer(fetchImpl, API, "tok", "prop-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepartidorClientError);
    expect(esFuncionNoDisponible(err)).toBe(true);
    expect(esErrorDeRed(err)).toBe(false);
  });

  it("un 404 cuenta como funcion no disponible solo si se pide (lectura de lista en una API anterior a estas rutas)", async () => {
    const fetchImpl = vi.fn(async () => json(404, { code: "not_found", message: "Ruta no encontrada" })) as unknown as typeof fetch;
    const err = await fetchEntregasChofer(fetchImpl, API, "tok", "prop-1").catch((e: unknown) => e);
    expect(esFuncionNoDisponible(err)).toBe(false);
    expect(esFuncionNoDisponible(err, { rutaAusente: true })).toBe(true);
  });

  it("sin red (fetch lanza) se marca como error de red y no como funcion no disponible", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const err = await fetchEntregasChofer(fetchImpl, API, "tok", "prop-1").catch((e: unknown) => e);
    expect(esErrorDeRed(err)).toBe(true);
    expect(esFuncionNoDisponible(err)).toBe(false);
  });
});

describe("acciones del chofer", () => {
  it("entregar: POST con Idempotency-Key, desdeEstado y cobradoMonto", async () => {
    const llave = nuevaLlaveIdempotencia();
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${BASE}/orders/${ID}/entregar`);
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>)["Idempotency-Key"]).toBe(llave);
      expect(JSON.parse(init!.body as string)).toEqual({ desdeEstado: "en_camino", cobradoMonto: 708 });
      return json(200, { resultado: "entregado", entregadoAt: "2026-10-21T20:00:00.000Z", puedeDeshacerHasta: "2026-10-21T20:01:00.000Z" });
    }) as unknown as typeof fetch;
    const r = await entregarPedidoChofer(fetchImpl, API, "tok", "prop-1", ID, { cobradoMonto: 708 }, llave);
    expect(r.resultado).toBe("entregado");
  });

  it("deshacer: POST a deshacer-entrega; fuera de ventana llega como error con su codigo", async () => {
    const fetchImpl = vi.fn(async () => json(409, { code: "fuera_de_ventana", message: "Ya pasó el tiempo" })) as unknown as typeof fetch;
    await expect(deshacerEntregaChofer(fetchImpl, API, "tok", "prop-1", ID, nuevaLlaveIdempotencia())).rejects.toMatchObject({ status: 409, code: "fuera_de_ventana" });
  });

  it("problema: manda el motivo cerrado", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${BASE}/orders/${ID}/problema`);
      expect(JSON.parse(init!.body as string)).toEqual({ motivo: "no_contesto" });
      return json(200, { resultado: "problema", estado: "problema" });
    }) as unknown as typeof fetch;
    expect((await reportarProblemaChofer(fetchImpl, API, "tok", "prop-1", ID, { motivo: "no_contesto" }, nuevaLlaveIdempotencia())).estado).toBe("problema");
  });

  it("llamar: devuelve el telefono solo si es un E.164 valido", async () => {
    const bien = vi.fn(async () => json(200, { telefono: "+529991234567" })) as unknown as typeof fetch;
    expect((await pedirTelefonoCliente(bien, API, "tok", "prop-1", ID, nuevaLlaveIdempotencia())).telefono).toBe("+529991234567");
    const mal = vi.fn(async () => json(200, { telefono: "javascript:alert(1)" })) as unknown as typeof fetch;
    await expect(pedirTelefonoCliente(mal, API, "tok", "prop-1", ID, nuevaLlaveIdempotencia())).rejects.toMatchObject({ code: "respuesta_invalida" });
  });

  it("hoy: acepta efectivoPorEntregar null (base sin migrar)", async () => {
    const fetchImpl = vi.fn(async () => json(200, { entregasHoy: 6, enCamino: 1, efectivoPorEntregar: null })) as unknown as typeof fetch;
    expect((await fetchHoyChofer(fetchImpl, API, "tok", "prop-1")).efectivoPorEntregar).toBeNull();
  });
});
