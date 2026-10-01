// Catálogo estático de voces de Gemini Live (sin clonación) y cliente HTTP de voz:
// 404/503 -> VozNoDisponibleError (estado honesto), errores reales con su mensaje.
import { describe, expect, it, vi } from "vitest";
import { buscarVoz, CATALOGO_VOCES, filtrarVoces, urlMuestraVoz } from "../src/verticals/restaurantes/lib/voz-catalogo.ts";
import { crearSesionPreviewVoz, fetchConversacionesVoz, fetchConversacionVoz, fetchVozConfig, updateVozConfig, VozNoDisponibleError } from "../src/verticals/restaurantes/lib/voz-client.ts";
import { RestaurantesAdminError } from "../src/verticals/restaurantes/lib/admin-client.ts";

const JSON_RESP = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("catálogo de voces", () => {
  it("tiene las 30 voces predefinidas de Gemini Live, sin repetidas", () => {
    expect(CATALOGO_VOCES).toHaveLength(30);
    expect(new Set(CATALOGO_VOCES.map((v) => v.id)).size).toBe(30);
    for (const nombre of ["Zephyr", "Kore", "Puck", "Charon", "Sulafat", "Vindemiatrix"]) expect(buscarVoz(nombre)?.nombre).toBe(nombre);
  });

  it("no ofrece clonación ni voces propias: ninguna entrada es clonada/propia", () => {
    const serializado = JSON.stringify(CATALOGO_VOCES).toLowerCase();
    expect(serializado).not.toMatch(/clon|mis voces|dise[ñn]o/);
    for (const v of CATALOGO_VOCES) expect(Object.keys(v).sort()).toEqual(["id", "nombre", "tono"]);
  });

  it("filtra por nombre o tono sin distinguir mayúsculas ni acentos", () => {
    expect(filtrarVoces(CATALOGO_VOCES, "  kore ").map((v) => v.id)).toEqual(["Kore"]);
    expect(filtrarVoces(CATALOGO_VOCES, "calido").map((v) => v.id)).toEqual(["Sulafat"]);
    expect(filtrarVoces(CATALOGO_VOCES, "firme").map((v) => v.id)).toEqual(["Kore", "Orus", "Alnilam"]);
    expect(filtrarVoces(CATALOGO_VOCES, "")).toHaveLength(30);
    expect(filtrarVoces(CATALOGO_VOCES, "zzz")).toHaveLength(0);
  });

  it("resuelve la ruta de la muestra con o sin barra final y busca por id inexistente", () => {
    expect(urlMuestraVoz("/", "Kore")).toBe("/media/voces/kore.mp3");
    expect(urlMuestraVoz("/app", "Kore")).toBe("/app/media/voces/kore.mp3");
    expect(buscarVoz("NoExiste")).toBeUndefined();
    expect(buscarVoz(null)).toBeUndefined();
  });
});

const WIRE_CONFIG = { disponible: true, configurada: true, habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "p", mensajeInicial: "m" };
const ENTRADA = { vozId: "Puck", promptSistema: "Habla en español de México", mensajeInicial: "Hola, asistente virtual", habilitado: true } as const;

describe("voz-client (contrato real de apps/api voz-admin.ts)", () => {
  it("GET config: mapea el formato de la API; null si la sucursal aún no tiene", async () => {
    const f1 = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/voz/config");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
      return JSON_RESP(WIRE_CONFIG);
    }) as unknown as typeof fetch;
    await expect(fetchVozConfig(f1, "http://api.local", "tok", "prop-1")).resolves.toEqual({ vozId: "Kore", promptSistema: "p", mensajeInicial: "m", habilitado: true });
    const f2 = vi.fn(async () => JSON_RESP({ ...WIRE_CONFIG, configurada: false, habilitado: false, voiceId: "" })) as unknown as typeof fetch;
    await expect(fetchVozConfig(f2, "http://api.local", "tok", "prop-1")).resolves.toBeNull();
  });

  it("base sin migrar (disponible: false) -> VozNoDisponibleError en config y en conversaciones", async () => {
    const f1 = vi.fn(async () => JSON_RESP({ ...WIRE_CONFIG, disponible: false, configurada: false })) as unknown as typeof fetch;
    await expect(fetchVozConfig(f1, "http://api.local", "tok", "prop-1")).rejects.toBeInstanceOf(VozNoDisponibleError);
    const f2 = vi.fn(async () => JSON_RESP({ disponible: false, total: 0, nextOffset: null, items: [] })) as unknown as typeof fetch;
    await expect(fetchConversacionesVoz(f2, "http://api.local", "tok", "prop-1")).rejects.toBeInstanceOf(VozNoDisponibleError);
  });

  it("404 y 503 en cualquier endpoint -> VozNoDisponibleError con el status", async () => {
    for (const status of [404, 503]) {
      const f = vi.fn(async () => JSON_RESP({ message: "x" }, status)) as unknown as typeof fetch;
      const llamadas = [
        fetchVozConfig(f, "http://api.local", "tok", "prop-1"),
        updateVozConfig(f, "http://api.local", "tok", "prop-1", ENTRADA),
        crearSesionPreviewVoz(f, "http://api.local", "tok", "prop-1"),
        fetchConversacionesVoz(f, "http://api.local", "tok", "prop-1"),
        fetchConversacionVoz(f, "http://api.local", "tok", "prop-1", "c1"),
      ];
      for (const l of llamadas) {
        await expect(l).rejects.toBeInstanceOf(VozNoDisponibleError);
        await expect(l).rejects.toMatchObject({ status });
      }
    }
  });

  it("PUT config manda la config COMPLETA con los nombres de la API (proveedor gemini, voiceId, comportamiento)", async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/voz/config");
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(init!.body as string)).toEqual({ habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Puck", comportamiento: "Habla en español de México", mensajeInicial: "Hola, asistente virtual" });
      return JSON_RESP({ ...WIRE_CONFIG, voiceId: "Puck", comportamiento: ENTRADA.promptSistema, mensajeInicial: ENTRADA.mensajeInicial });
    }) as unknown as typeof fetch;
    const r = await updateVozConfig(f, "http://api.local", "tok", "prop-1", ENTRADA);
    expect(r).toEqual({ vozId: "Puck", promptSistema: ENTRADA.promptSistema, mensajeInicial: ENTRADA.mensajeInicial, habilitado: true });
  });

  it("PUT sin voz elegida no llama a la red (la API exige voiceId)", async () => {
    const f = vi.fn() as unknown as typeof fetch;
    await expect(updateVozConfig(f, "http://api.local", "tok", "prop-1", { ...ENTRADA, vozId: null })).rejects.toBeInstanceOf(RestaurantesAdminError);
    expect(f).not.toHaveBeenCalled();
  });

  it("un error real del servidor conserva su mensaje (no se confunde con 'no disponible')", async () => {
    const f = vi.fn(async () => JSON_RESP({ message: "No tienes permiso para realizar esta acción." }, 403)) as unknown as typeof fetch;
    const p = updateVozConfig(f, "http://api.local", "tok", "prop-1", ENTRADA);
    await expect(p).rejects.toBeInstanceOf(RestaurantesAdminError);
    await expect(p).rejects.not.toBeInstanceOf(VozNoDisponibleError);
  });

  it("POST preview/sesion devuelve los tokens efímeros con el formato de la API", async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/voz/preview/sesion");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ voiceId: "Kore" });
      return JSON_RESP({ sesionId: "s1", proveedor: "gemini-3.8-live", modelo: "m", voiceId: "Kore", websocketUrl: "wss://x", tokenProveedor: "tp", tokenPreview: "tv", expiraEn: "2026-09-30T00:01:00Z" }, 201);
    }) as unknown as typeof fetch;
    await expect(crearSesionPreviewVoz(f, "http://api.local", "tok", "prop-1", { voiceId: "Kore" })).resolves.toMatchObject({ sesionId: "s1", tokenPreview: "tv", tokenProveedor: "tp" });
  });

  it("conversaciones: lee `items`, convierte micro-USD a USD y respeta el límite; el detalle trae la transcripción", async () => {
    const f = vi.fn(async (url: string) => {
      if (url.endsWith("/conversaciones/c1")) {
        return JSON_RESP({ id: "c1", iniciadaEn: "2026-09-30T00:00:00Z", duracionS: 61, costoEstimadoMicroUsd: 50000, resultado: "escalado", turnos: [{ seq: 0, rol: "agente", texto: "Hola", creadoEn: "2026-09-30T00:00:01Z" }, { seq: 1, rol: "cliente", texto: "Quiero tacos", creadoEn: "2026-09-30T00:00:02Z" }] });
      }
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/voz/conversaciones?limit=10");
      return JSON_RESP({ disponible: true, total: 1, nextOffset: null, items: [{ id: "c1", iniciadaEn: "2026-09-30T00:00:00Z", duracionS: 61, costoEstimadoMicroUsd: 50000, resultado: "pedido_creado" }] });
    }) as unknown as typeof fetch;
    const lista = await fetchConversacionesVoz(f, "http://api.local", "tok", "prop-1", 10);
    expect(lista).toEqual([{ id: "c1", iniciadaEn: "2026-09-30T00:00:00Z", duracionSegundos: 61, costoUsd: 0.05, resultado: "pedido_creado" }]);
    const d = await fetchConversacionVoz(f, "http://api.local", "tok", "prop-1", "c1");
    expect(d.resultado).toBe("escalado");
    expect(d.transcripcion?.map((l) => [l.rol, l.texto])).toEqual([["agente", "Hola"], ["usuario", "Quiero tacos"]]);
  });
});
