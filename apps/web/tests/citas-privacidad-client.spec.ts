import { describe, expect, it, vi } from "vitest";
import { actualizarEstadoSolicitudArco, fetchSolicitudesArco } from "../src/verticals/citas/lib/privacidad-client.ts";

describe("privacidad-client (citas, solicitudes ARCO)", () => {
  it("GET sin filtros pega a .../admin/privacidad/solicitudes", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/citas/properties/p1/admin/privacidad/solicitudes");
      return new Response(JSON.stringify({ disponible: true, total: 0, nextOffset: null, plazos: { respuestaDias: 20, ejecucionDias: 15 }, items: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await fetchSolicitudesArco(fetchImpl, "http://api.local", "tok", "p1");
    expect(res.plazos).toEqual({ respuestaDias: 20, ejecucionDias: 15 });
  });

  it("arma el query con estado/derecho/limit/offset", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const q = new URL(url).searchParams;
      expect(q.get("estado")).toBe("recibida");
      expect(q.get("derecho")).toBe("cancelacion");
      expect(q.get("limit")).toBe("25");
      expect(q.get("offset")).toBe("50");
      return new Response(JSON.stringify({ disponible: true, total: 0, nextOffset: null, plazos: { respuestaDias: 20, ejecucionDias: 15 }, items: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchSolicitudesArco(fetchImpl, "http://api.local", "tok", "p1", { estado: "recibida", derecho: "cancelacion", limit: 25, offset: 50 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("disponible:false se propaga (base sin migrar, nunca una lista vacía real)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ disponible: false, total: 0, nextOffset: null, plazos: { respuestaDias: 20, ejecucionDias: 15 }, items: [] }), { status: 200 })) as unknown as typeof fetch;
    expect((await fetchSolicitudesArco(fetchImpl, "http://api.local", "tok", "p1")).disponible).toBe(false);
  });

  it("PATCH manda estado y nota (solo si hay nota)", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/citas/properties/p1/admin/privacidad/solicitudes/req-1/estado");
      expect(init?.method).toBe("PATCH");
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "req-1", estado: "resuelta" }), { status: 200 });
    }) as unknown as typeof fetch;
    await actualizarEstadoSolicitudArco(fetchImpl, "http://api.local", "tok", "p1", "req-1", "resuelta", "entregado");
    await actualizarEstadoSolicitudArco(fetchImpl, "http://api.local", "tok", "p1", "req-1", "en_proceso", null);
    expect(bodies).toEqual([{ estado: "resuelta", nota: "entregado" }, { estado: "en_proceso" }]);
  });

  it("un 409 del servidor se propaga como error con su mensaje", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Esa solicitud no puede pasar a ese estado desde su estado actual." }), { status: 409 })) as unknown as typeof fetch;
    await expect(actualizarEstadoSolicitudArco(fetchImpl, "http://api.local", "tok", "p1", "req-1", "resuelta", null)).rejects.toThrow(/no puede pasar/);
  });
});
