// Puerto de resenas (seccion 8): adaptador falso, "no disponible aun" honesto y la regla de aprobacion humana <= 3 estrellas.
import { describe, expect, it } from "vitest";
import {
  FakeResenasProvider,
  ResenasNoDisponiblesError,
  RespuestaRequiereAprobacionError,
  publicarRespuestaAResena,
  redactarBorradorRespuesta,
  requiereAprobacionHumana,
  resenasProviderNoDisponible,
  type ResenaExterna,
} from "../src/resenas-provider.ts";

const resena = (calificacion: number, id = "r1"): ResenaExterna => ({ id, sucursalSlug: "pensiones", calificacion, texto: "x", creadaEn: "2026-10-01T10:00:00Z" });

describe("aprobacion humana", () => {
  it("<= 3 estrellas la exige; >= 4 no", () => {
    expect([1, 2, 3].map(requiereAprobacionHumana)).toEqual([true, true, true]);
    expect([4, 5].map(requiereAprobacionHumana)).toEqual([false, false]);
  });

  it("<= 3 estrellas sin aprobacion: lanza y NO llama al proveedor; con aprobacion publica", async () => {
    const p = new FakeResenasProvider([resena(2)]);
    await expect(publicarRespuestaAResena(p, resena(2), "Lamentamos lo ocurrido.", null)).rejects.toBeInstanceOf(RespuestaRequiereAprobacionError);
    expect(p.respuestas).toEqual([]);
    await expect(publicarRespuestaAResena(p, resena(2), "Lamentamos lo ocurrido.", "usuario-1")).resolves.toEqual({ publicada: true });
    expect(p.respuestas).toHaveLength(1);
  });

  it(">= 4 estrellas se puede responder sin aprobacion previa", async () => {
    const p = new FakeResenasProvider();
    await expect(publicarRespuestaAResena(p, resena(5), "Gracias por su reseña.", null)).resolves.toEqual({ publicada: true });
  });

  it("una respuesta que ofrece incentivos se rechaza siempre, aunque venga aprobada", async () => {
    const p = new FakeResenasProvider();
    await expect(publicarRespuestaAResena(p, resena(5), "Gracias, le damos un postre gratis si regresa", "usuario-1")).rejects.toThrow(/incentivos/);
    expect(p.respuestas).toEqual([]);
  });
});

describe("proveedores", () => {
  it("no disponible aun: lanza un error honesto, nunca devuelve resenas inventadas", async () => {
    const p = resenasProviderNoDisponible();
    expect(p.disponible).toBe(false);
    await expect(p.listarResenas({ sucursalSlug: "pensiones" })).rejects.toBeInstanceOf(ResenasNoDisponiblesError);
    await expect(p.publicarRespuesta({ resenaId: "r1", texto: "x" })).rejects.toThrow(/Business Profile API/);
  });

  it("el falso filtra por sucursal y fecha", async () => {
    const p = new FakeResenasProvider([resena(5, "a"), { ...resena(1, "b"), sucursalSlug: "playa" }, { ...resena(4, "c"), creadaEn: "2026-09-01T00:00:00Z" }]);
    expect((await p.listarResenas({ sucursalSlug: "pensiones" })).map((r) => r.id)).toEqual(["a", "c"]);
    expect((await p.listarResenas({ sucursalSlug: "pensiones", desde: "2026-10-01T00:00:00Z" })).map((r) => r.id)).toEqual(["a"]);
  });

  it("el borrador trata de usted, nombra la sucursal y no ofrece compensaciones", () => {
    const malo = redactarBorradorRespuesta(resena(1), "Pensiones");
    const bueno = redactarBorradorRespuesta(resena(5), "Pensiones");
    expect(malo).toContain("Pensiones");
    expect(malo).toMatch(/atenderle|llame/);
    expect(bueno).toContain("Gracias por su reseña");
    for (const t of [malo, bueno]) expect(t).not.toMatch(/gratis|descuento|regalo|cortesía/i);
  });
});
