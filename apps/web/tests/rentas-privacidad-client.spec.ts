import { describe, expect, it, vi } from "vitest";
import { cambiarEstadoSolicitudArco, fetchSolicitudesArco, registrarSolicitudArco } from "../src/verticals/rentas/lib/privacidad-client.ts";

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("privacidad-client (rentas)", () => {
  it("lista con filtros y paginacion en la query string", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return ok({ disponible: true, total: 0, nextOffset: null, plazos: { respuestaDias: 20, ejecucionDias: 15 }, items: [] });
    }) as unknown as typeof fetch;
    const r = await fetchSolicitudesArco(fetchImpl, "http://api.local", "tok", "p1", { estado: "recibida", derecho: "acceso", limit: 25, offset: 50 });
    expect(r.disponible).toBe(true);
    expect(urls[0]).toBe("http://api.local/rentas/p1/privacidad/solicitudes?limit=25&offset=50&estado=recibida&derecho=acceso");
  });

  it("registra con POST y cambia el estado con PATCH", async () => {
    const llamadas: { url: string; method: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      llamadas.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return init?.method === "POST" ? ok({ id: "s1", folio: "ARCO-R-00000001", creada: true }, 201) : ok({ id: "s1", estado: "resuelta" });
    }) as unknown as typeof fetch;
    const nueva = { derecho: "acceso", canal: "correo", solicitanteNombre: "Ana", solicitanteContacto: "ana@example.com", detalle: null, recibidaEn: null } as const;
    expect(await registrarSolicitudArco(fetchImpl, "http://api.local", "tok", "p1", nueva)).toEqual({ id: "s1", folio: "ARCO-R-00000001", creada: true });
    await cambiarEstadoSolicitudArco(fetchImpl, "http://api.local", "tok", "p1", "s1", "resuelta", "Listo");
    expect(llamadas).toEqual([
      { url: "http://api.local/rentas/p1/privacidad/solicitudes", method: "POST", body: nueva },
      { url: "http://api.local/rentas/p1/privacidad/solicitudes/s1/estado", method: "PATCH", body: { estado: "resuelta", nota: "Listo" } },
    ]);
  });

  it("un error del servidor llega con su mensaje real (no se inventa uno)", async () => {
    const fetchImpl = (async () => ok({ message: "Esa solicitud no puede pasar a ese estado desde su estado actual." }, 409)) as unknown as typeof fetch;
    await expect(cambiarEstadoSolicitudArco(fetchImpl, "http://api.local", "tok", "p1", "s1", "en_proceso", null)).rejects.toThrow(/no puede pasar a ese estado/);
  });
});
