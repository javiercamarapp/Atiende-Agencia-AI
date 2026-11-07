// C-16 -- cliente del centro de avisos: URL, metodo y cuerpo reales (la nota solo viaja cuando existe).
import { describe, expect, it, vi } from "vitest";
import { darSeguimientoEscalacion, fetchAvisosCitas } from "../src/verticals/citas/lib/avisos-client.ts";

function respuesta(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe("avisos-client (citas)", () => {
  it("fetchAvisosCitas hace GET a .../admin/avisos con el token", async () => {
    const f = vi.fn(async () => respuesta({ generadoEn: "x" }));
    await fetchAvisosCitas(f as unknown as typeof fetch, "https://api.test", "tok", "prop-1");
    expect(f).toHaveBeenCalledWith("https://api.test/v1/citas/properties/prop-1/admin/avisos", expect.objectContaining({ headers: { authorization: "Bearer tok" } }));
  });

  it("darSeguimientoEscalacion hace POST con estado y nota; sin nota no la manda", async () => {
    const f = vi.fn(async () => respuesta({ id: "e", estado: "resolved", en: "x" }));
    await darSeguimientoEscalacion(f as unknown as typeof fetch, "https://api.test", "tok", "prop-1", "e-1", "resolved", "ok");
    await darSeguimientoEscalacion(f as unknown as typeof fetch, "https://api.test", "tok", "prop-1", "e-1", "in_progress", null);
    const [[url1, init1], [, init2]] = f.mock.calls as unknown as [[string, RequestInit], [string, RequestInit]];
    expect(url1).toBe("https://api.test/v1/citas/properties/prop-1/admin/escalaciones/e-1/seguimiento");
    expect(init1.method).toBe("POST");
    expect(JSON.parse(String(init1.body))).toEqual({ estado: "resolved", nota: "ok" });
    expect(JSON.parse(String(init2.body))).toEqual({ estado: "in_progress" });
  });
});
