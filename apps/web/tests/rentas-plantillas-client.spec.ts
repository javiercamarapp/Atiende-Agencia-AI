// Rn-24 / Rn-25 -- cliente de plantillas y automatizaciones: URLs, cuerpos, vista previa y estado visible.
import { describe, expect, it, vi } from "vitest";
import { actualizarPlantilla, crearPlantilla, estadoPlantilla, fetchAutomatizaciones, fetchPlantillas, guardarAutomatizacion, vistaPrevia } from "../src/verticals/rentas/lib/plantillas-client.ts";

const json = (body: unknown, ok = true, status = 200): Response => ({ ok, status, json: async () => body }) as unknown as Response;
const VARIABLES = [
  { nombre: "huesped", descripcion: "Nombre", ejemplo: "Ana" },
  { nombre: "propiedad", descripcion: "Propiedad", ejemplo: "Casa Mar" },
];

describe("plantillas-client", () => {
  it("lista plantillas y automatizaciones con el token", async () => {
    const fn = vi.fn(async (url: string, _init?: RequestInit) => (url.endsWith("/plantillas") ? json({ plantillas: [{ id: "p1" }] }) : json({ disponible: true, eventos: [], variables: [] })));
    expect(await fetchPlantillas(fn as unknown as typeof fetch, "http://api.local", "tok", "prop-1")).toEqual([{ id: "p1" }]);
    expect((await fetchAutomatizaciones(fn as unknown as typeof fetch, "http://api.local", "tok", "prop-1")).disponible).toBe(true);
    expect(fn.mock.calls.map((c) => c[0])).toEqual(["http://api.local/rentas/prop-1/plantillas", "http://api.local/rentas/prop-1/mensajes-automaticos"]);
    expect((fn.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("crear (POST), editar/aprobar (PATCH) y programar un evento (PUT) mandan el cuerpo esperado", async () => {
    const fn = vi.fn(async () => json({ ok: true }));
    const f = fn as unknown as typeof fetch;
    await crearPlantilla(f, "http://api.local", "tok", "prop-1", { evento: "check_in", idioma: "es", canal: null, cuerpo: "Hola" });
    await actualizarPlantilla(f, "http://api.local", "tok", "prop-1", "p1", { aprobadaPorTenant: true });
    await guardarAutomatizacion(f, "http://api.local", "tok", "prop-1", "check_out", { activo: true, offsetHoras: 8, plantillaId: "p2" });
    const llamadas = fn.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(llamadas.map(([u, i]) => [i.method, u])).toEqual([
      ["POST", "http://api.local/rentas/prop-1/plantillas"],
      ["PATCH", "http://api.local/rentas/prop-1/plantillas/p1"],
      ["PUT", "http://api.local/rentas/prop-1/mensajes-automaticos/check_out"],
    ]);
    expect(JSON.parse(String(llamadas[1]![1].body))).toEqual({ aprobadaPorTenant: true });
    expect(JSON.parse(String(llamadas[2]![1].body))).toEqual({ activo: true, offsetHoras: 8, plantillaId: "p2" });
  });

  it("un error del servidor sube con su mensaje", async () => {
    const fn = vi.fn(async () => json({ message: "La plantilla debe estar aprobada" }, false, 409));
    await expect(guardarAutomatizacion(fn as unknown as typeof fetch, "http://api.local", "tok", "prop-1", "check_in", { activo: true, offsetHoras: 1, plantillaId: "x" })).rejects.toThrow();
  });

  it("vistaPrevia usa los ejemplos y reporta las variables desconocidas sin inventarlas", () => {
    expect(vistaPrevia("Hola {{huesped}}, {{ propiedad }} y {{codigo_wifi}}", VARIABLES)).toEqual({ texto: "Hola Ana, Casa Mar y {{codigo_wifi}}", desconocidas: ["codigo_wifi"] });
  });

  it("estadoPlantilla distingue aprobada, pendiente e inactiva", () => {
    expect(estadoPlantilla({ aprobadaPorTenant: true, activa: true })).toEqual({ etiqueta: "Aprobada", tono: "success" });
    expect(estadoPlantilla({ aprobadaPorTenant: false, activa: true })).toEqual({ etiqueta: "Pendiente de aprobación", tono: "warning" });
    expect(estadoPlantilla({ aprobadaPorTenant: true, activa: false })).toEqual({ etiqueta: "Inactiva", tono: "neutral" });
  });
});
