// Catálogo estático de voces de Gemini Live (sin clonación) y cliente HTTP de voz:
// 404/503 -> VozNoDisponibleError (estado honesto), errores reales con su mensaje.
import { describe, expect, it, vi } from "vitest";
import { buscarVoz, CATALOGO_VOCES, filtrarVoces, urlMuestraVoz } from "../src/verticals/restaurantes/lib/voz-catalogo.ts";
import { crearSesionPreviewVoz, fetchConversacionesVoz, fetchVozConfig, updateVozConfig, VozNoDisponibleError } from "../src/verticals/restaurantes/lib/voz-client.ts";
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

describe("voz-client", () => {
  it("GET config: devuelve la config; null si la sucursal aún no tiene", async () => {
    const config = { vozId: "Kore", promptSistema: "p", mensajeInicial: "m", conocimiento: "c", actualizadoEn: "2026-09-30T00:00:00Z" };
    const f1 = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/voz/config");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
      return JSON_RESP({ config });
    }) as unknown as typeof fetch;
    await expect(fetchVozConfig(f1, "http://api.local", "tok", "prop-1")).resolves.toEqual(config);
    const f2 = vi.fn(async () => JSON_RESP({ config: null })) as unknown as typeof fetch;
    await expect(fetchVozConfig(f2, "http://api.local", "tok", "prop-1")).resolves.toBeNull();
  });

  it("404 y 503 en cualquier endpoint -> VozNoDisponibleError con el status", async () => {
    for (const status of [404, 503]) {
      const f = vi.fn(async () => JSON_RESP({ message: "x" }, status)) as unknown as typeof fetch;
      const llamadas = [
        fetchVozConfig(f, "http://api.local", "tok", "prop-1"),
        updateVozConfig(f, "http://api.local", "tok", "prop-1", { vozId: null, promptSistema: "", mensajeInicial: "", conocimiento: "" }),
        crearSesionPreviewVoz(f, "http://api.local", "tok", "prop-1"),
        fetchConversacionesVoz(f, "http://api.local", "tok", "prop-1"),
      ];
      for (const l of llamadas) {
        await expect(l).rejects.toBeInstanceOf(VozNoDisponibleError);
        await expect(l).rejects.toMatchObject({ status });
      }
    }
  });

  it("PUT config manda el cuerpo exacto y devuelve la config guardada", async () => {
    const input = { vozId: "Puck", promptSistema: "Habla en español de México", mensajeInicial: "Hola, asistente virtual", conocimiento: "Abrimos de 9 a 21" };
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/voz/config");
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(init!.body as string)).toEqual(input);
      return JSON_RESP({ config: { ...input, actualizadoEn: "2026-09-30T00:00:00Z" } });
    }) as unknown as typeof fetch;
    const r = await updateVozConfig(f, "http://api.local", "tok", "prop-1", input);
    expect(r.vozId).toBe("Puck");
    expect(r.actualizadoEn).toBe("2026-09-30T00:00:00Z");
  });

  it("un error real del servidor conserva su mensaje (no se confunde con 'no disponible')", async () => {
    const f = vi.fn(async () => JSON_RESP({ message: "No tienes permiso para realizar esta acción." }, 403)) as unknown as typeof fetch;
    const p = updateVozConfig(f, "http://api.local", "tok", "prop-1", { vozId: null, promptSistema: "", mensajeInicial: "", conocimiento: "" });
    await expect(p).rejects.toBeInstanceOf(RestaurantesAdminError);
    await expect(p).rejects.not.toBeInstanceOf(VozNoDisponibleError);
  });

  it("POST sesión de preview devuelve el token efímero; conversaciones respeta el límite", async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/admin/voz/sesion")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(init!.body as string)).toEqual({ vozId: "Kore" });
        return JSON_RESP({ sessionId: "s1", token: "efimero", expiraEn: "2026-09-30T00:01:00Z" });
      }
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/voz/conversaciones?limit=10");
      return JSON_RESP({ conversaciones: [{ id: "c1", iniciadaEn: "2026-09-30T00:00:00Z", duracionSegundos: 61, costoUsd: 0.05, resultado: "pedido" }] });
    }) as unknown as typeof fetch;
    await expect(crearSesionPreviewVoz(f, "http://api.local", "tok", "prop-1", { vozId: "Kore" })).resolves.toMatchObject({ sessionId: "s1", token: "efimero" });
    const lista = await fetchConversacionesVoz(f, "http://api.local", "tok", "prop-1", 10);
    expect(lista).toHaveLength(1);
    expect(lista[0]?.resultado).toBe("pedido");
  });
});
