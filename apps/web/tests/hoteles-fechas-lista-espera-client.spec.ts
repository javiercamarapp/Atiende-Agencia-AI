// H-28 / H-12 -- clientes web de cambio de fechas y lista de espera: URL, metodo, cuerpo y cabecera Idempotency-Key exactos.
import { describe, expect, it, vi } from "vitest";
import { cambiarFechas, previsualizarFechas, ESTADOS_CON_CAMBIO_DE_FECHAS, FECHAS_ROLES } from "../src/verticals/hoteles/lib/fechas-client.ts";
import { aceptarEntrada, agregarAListaEspera, cancelarEntrada, fetchListaEspera, ofrecerEntrada, LISTA_ESPERA_ROLES } from "../src/verticals/hoteles/lib/lista-espera-client.ts";

const API = "https://api.test";
function fetchOk(body: unknown) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response);
}
const call = (f: ReturnType<typeof vi.fn>) => {
  const [url, init] = f.mock.calls[0] as [string, RequestInit];
  return { url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined };
};

describe("fechas-client", () => {
  it("previsualizar: POST con las dos fechas, sin Idempotency-Key", async () => {
    const f = fetchOk({ puedeCambiar: true });
    await previsualizarFechas(f as unknown as typeof fetch, API, "tok", "p1", "r1", "2026-12-03", "2026-12-06");
    const c = call(f);
    expect(c).toMatchObject({ url: `${API}/hoteles/p1/reservas/r1/fechas/previsualizar`, method: "POST", body: { checkInDate: "2026-12-03", checkOutDate: "2026-12-06" } });
    expect(c.headers["idempotency-key"]).toBeUndefined();
    expect(c.headers.authorization).toBe("Bearer tok");
  });

  it("cambiar: PATCH con totalEsperado e Idempotency-Key", async () => {
    const f = fetchOk({});
    await cambiarFechas(f as unknown as typeof fetch, API, "tok", "p1", "r1", { checkInDate: "2026-12-03", checkOutDate: "2026-12-06", totalEsperado: 3570, motivo: "Extiende" }, "llave-1");
    const c = call(f);
    expect(c).toMatchObject({ url: `${API}/hoteles/p1/reservas/r1/fechas`, method: "PATCH", body: { checkInDate: "2026-12-03", checkOutDate: "2026-12-06", totalEsperado: 3570, motivo: "Extiende" } });
    expect(c.headers["idempotency-key"]).toBe("llave-1");
  });

  it("espejo cosmetico de estados y roles", () => {
    expect([...ESTADOS_CON_CAMBIO_DE_FECHAS].sort()).toEqual(["check_in", "confirmada", "en_estancia"]);
    expect([...FECHAS_ROLES].sort()).toEqual(["frontdesk", "gm", "owner", "reservations"]);
    expect([...LISTA_ESPERA_ROLES].sort()).toEqual(["frontdesk", "gm", "owner", "reservations"]);
  });
});

describe("lista-espera-client", () => {
  it("listar, agregar, cancelar, ofrecer y aceptar usan las rutas reales", async () => {
    const f1 = fetchOk({ disponible: true, entradas: [] });
    await fetchListaEspera(f1 as unknown as typeof fetch, API, "tok", "p1");
    expect(call(f1)).toMatchObject({ url: `${API}/hoteles/p1/lista-espera`, method: "GET" });
    const f2 = fetchOk({});
    await agregarAListaEspera(f2 as unknown as typeof fetch, API, "tok", "p1", { roomTypeId: "t1", checkInDate: "2026-12-03", checkOutDate: "2026-12-05", huespedes: 2, nombre: "Ana", telefono: "5511112222" });
    expect(call(f2)).toMatchObject({ url: `${API}/hoteles/p1/lista-espera`, method: "POST", body: { roomTypeId: "t1", huespedes: 2, nombre: "Ana", telefono: "5511112222" } });
    const f3 = fetchOk({});
    await cancelarEntrada(f3 as unknown as typeof fetch, API, "tok", "p1", "e1");
    expect(call(f3)).toMatchObject({ url: `${API}/hoteles/p1/lista-espera/e1/cancelar`, method: "POST" });
    const f4 = fetchOk({});
    await ofrecerEntrada(f4 as unknown as typeof fetch, API, "tok", "p1", "e1", 12);
    expect(call(f4)).toMatchObject({ url: `${API}/hoteles/p1/lista-espera/e1/ofrecer`, method: "POST", body: { horas: 12 } });
    const f5 = fetchOk({});
    await aceptarEntrada(f5 as unknown as typeof fetch, API, "tok", "p1", "e1", 2380, "llave-2");
    const c5 = call(f5);
    expect(c5).toMatchObject({ url: `${API}/hoteles/p1/lista-espera/e1/aceptar`, method: "POST", body: { totalEsperado: 2380 } });
    expect(c5.headers["idempotency-key"]).toBe("llave-2");
  });

  it("un error del servidor se propaga con su mensaje", async () => {
    const f = vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ code: "precio_cambio", message: "El total cambio." }) }) as unknown as Response);
    await expect(aceptarEntrada(f as unknown as typeof fetch, API, "tok", "p1", "e1", 1, "k")).rejects.toThrow("El total cambio.");
  });
});
