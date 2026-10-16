// R-42 + REGLA DURA de compatibilidad con la base SIN migrar: el repositorio de cierres corre en la transaccion unica del request.
// Contra la base vieja (42883/42P01) cae a "no disponible" SIN abortar la transaccion (AbortAwareFakeSession reproduce el 25P02).
import { describe, expect, it } from "vitest";
import { PostgresCierreRepository } from "../src/cierres/index.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000c1";
const PROP = "00000000-0000-4000-8000-0000000000c2";
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const FILA = {
  creado: true, id: "r1", tipo: "dia", fecha_inicio: "2026-03-10", fecha_fin: "2026-03-10", zona_horaria: "America/Mexico_City",
  datos: { pedidos: 3, ventas_centavos: 1000 }, generado_por: "staff", generado_at: new Date("2026-03-11T12:00:00Z"),
};

describe("PostgresCierreRepository", () => {
  it("generar: base migrada devuelve el cierre creado", async () => {
    const s = new AbortAwareFakeSession([{ match: /generar_cierre/, respond: () => [FILA] }]);
    const r = await new PostgresCierreRepository(s).generar(ORG, PROP, "dia", "2026-03-10");
    expect(r.estado).toBe("creado");
    if (r.estado === "creado") {
      expect(r.reporte.datos.pedidos).toBe(3);
      expect(r.reporte.generadoAt).toBe("2026-03-11T12:00:00.000Z");
    }
  });

  it("generar: creado=false => existente (idempotente)", async () => {
    const s = new AbortAwareFakeSession([{ match: /generar_cierre/, respond: () => [{ ...FILA, creado: false }] }]);
    expect((await new PostgresCierreRepository(s).generar(ORG, PROP, "dia", "2026-03-10")).estado).toBe("existente");
  });

  it("generar: id nulo (barrido sin actividad) => sin_actividad", async () => {
    const s = new AbortAwareFakeSession([{ match: /generar_cierre/, respond: () => [{ ...FILA, creado: false, id: null }] }]);
    expect((await new PostgresCierreRepository(s).generar(ORG, PROP, "dia", "2026-03-10", { omitirSinActividad: true })).estado).toBe("sin_actividad");
  });

  it("generar: el dia de negocio aun abierto (22023 'aun no termina') => periodo_abierto con la sesion viva (QA R2 automatizacion-08)", async () => {
    const s = new AbortAwareFakeSession([{ match: /generar_cierre/, respond: () => pgError("22023", "generar_cierre: el periodo aun no termina en la zona de la sucursal") }, SIGUIENTE]);
    const r = await new PostgresCierreRepository(s).generar(ORG, PROP, "dia", "2026-03-10");
    expect(r.estado).toBe("periodo_abierto");
    await expect(s.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(s.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("generar: cualquier OTRO 22023 (fecha invalida) sigue propagandose", async () => {
    const s = new AbortAwareFakeSession([{ match: /generar_cierre/, respond: () => pgError("22023", "generar_cierre: tipo o fecha invalidos") }]);
    await expect(new PostgresCierreRepository(s).generar(ORG, PROP, "dia", "2026-03-10")).rejects.toThrow(/invalidos/);
  });

  it.each(["42883", "42P01", "42703"])("generar: base SIN migrar (%s) => no_disponible y la sesion sigue viva", async (code) => {
    const s = new AbortAwareFakeSession([{ match: /generar_cierre/, respond: () => pgError(code, "does not exist") }, SIGUIENTE]);
    const r = await new PostgresCierreRepository(s).generar(ORG, PROP, "dia", "2026-03-10");
    expect(r.estado).toBe("no_disponible");
    await expect(s.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(s.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("listar: base SIN migrar => disponible=false, lista vacia y sesion viva", async () => {
    const s = new AbortAwareFakeSession([{ match: /from restaurantes\.cierre_reporte/, respond: () => pgError("42P01", "relation does not exist") }, SIGUIENTE]);
    const r = await new PostgresCierreRepository(s).listar(ORG, PROP, "dia", 10);
    expect(r).toEqual({ disponible: false, valor: [] });
    await expect(s.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("listar: mapea filas y filtra por organizacion Y sucursal", async () => {
    const s = new AbortAwareFakeSession([{ match: /from restaurantes\.cierre_reporte/, respond: () => [{ ...FILA }] }]);
    const r = await new PostgresCierreRepository(s).listar(ORG, PROP, "dia", 10);
    expect(r.disponible).toBe(true);
    expect(r.valor).toHaveLength(1);
    expect(r.valor[0]!.fechaInicio).toBe("2026-03-10");
  });

  it("sucursalesParaBarrido: base SIN migrar => no disponible", async () => {
    const s = new AbortAwareFakeSession([{ match: /cierre_sucursales_sistema/, respond: () => pgError("42883", "function does not exist") }, SIGUIENTE]);
    expect(await new PostgresCierreRepository(s).sucursalesParaBarrido()).toEqual({ disponible: false, valor: [] });
  });

  it("un error que NO es de compatibilidad (22023 periodo sin terminar, 42501) se repropaga", async () => {
    for (const code of ["22023", "42501", "57P01"]) {
      const s = new AbortAwareFakeSession([{ match: /generar_cierre/, respond: () => pgError(code, "x") }, SIGUIENTE]);
      await expect(new PostgresCierreRepository(s).generar(ORG, PROP, "dia", "2026-03-10")).rejects.toMatchObject({ code });
    }
  });
});
