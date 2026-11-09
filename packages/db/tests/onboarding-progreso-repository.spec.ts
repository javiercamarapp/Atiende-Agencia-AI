// ds3 «Guía»: PostgresOnboardingProgresoRepository contra una sesion que aborta como Postgres real (SAVEPOINT obligatorio).
// Base sin la migracion 0075 -> disponible:false con la sesion utilizable; 42501/22023 de la funcion -> errores de dominio.
import { describe, expect, it } from "vitest";
import {
  OnboardingProgresoInvalidoError,
  OnboardingProgresoProhibidoError,
  PostgresOnboardingProgresoRepository,
  validarProgresoGuia,
} from "../src/onboarding-progreso-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const err = (code: string, message = `sqlstate ${code}`) => Object.assign(new Error(message), { code });
const DATOS = { modo: "corto" as const, paso: "pedidos.que", visto: true, omitido: false, descartado: false, activo: true, terminado: false };

describe("PostgresOnboardingProgresoRepository", () => {
  it("lee la fila propia y normaliza fechas y banderas", async () => {
    const s = new AbortAwareFakeSession([
      { match: /from core\.onboarding_progreso/, respond: () => [{ modo: "corto", paso: "pedidos.que", visto: true, omitido: false, descartado: false, activo: true, terminado: true, actualizado: new Date("2026-11-06T10:00:00Z") }] },
    ]);
    const r = await new PostgresOnboardingProgresoRepository(s).leer("u1", "taqueria", "restaurantes.owner");
    expect(r).toEqual({ disponible: true, progreso: { modo: "corto", paso: "pedidos.que", visto: true, omitido: false, descartado: false, activo: true, terminado: true, actualizado: "2026-11-06T10:00:00.000Z" } });
  });

  it("sin fila: progreso null", async () => {
    const s = new AbortAwareFakeSession([{ match: /from core\.onboarding_progreso/, respond: () => [] }]);
    expect(await new PostgresOnboardingProgresoRepository(s).leer("u1", null, "superadmin")).toEqual({ disponible: true, progreso: null });
  });

  it("base sin migrar (42P01 al leer, 42883 al guardar): disponible:false y la sesion sigue utilizable", async () => {
    const s = new AbortAwareFakeSession([
      { match: /from core\.onboarding_progreso/, respond: () => err("42P01") },
      { match: /guardar_onboarding_progreso/, respond: () => err("42883", "function core.guardar_onboarding_progreso(unknown, unknown) does not exist") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresOnboardingProgresoRepository(s);
    expect(await repo.leer("u1", "taqueria", "restaurantes.owner")).toEqual({ disponible: false, progreso: null });
    expect(await repo.guardar("u1", "taqueria", "restaurantes.owner", DATOS)).toEqual({ disponible: false, actualizado: null });
    expect(await s.query("select 1")).toEqual({ rows: [{ ok: 1 }] });
    expect(s.calls.filter((c) => c.startsWith("rollback to savepoint"))).toHaveLength(2);
  });

  it("guarda por la funcion y devuelve la hora de escritura", async () => {
    const s = new AbortAwareFakeSession([{ match: /guardar_onboarding_progreso/, respond: () => [{ actualizado: "2026-11-06T10:00:00Z" }] }]);
    expect(await new PostgresOnboardingProgresoRepository(s).guardar("u1", "taqueria", "restaurantes.owner", DATOS)).toEqual({ disponible: true, actualizado: "2026-11-06T10:00:00.000Z" });
  });

  it("42501 -> prohibido; 22023 -> invalido; otro error se repropaga", async () => {
    const con = (code: string) => new PostgresOnboardingProgresoRepository(new AbortAwareFakeSession([{ match: /guardar_onboarding_progreso/, respond: () => err(code) }]));
    await expect(con("42501").guardar("u1", "x", "restaurantes.owner", DATOS)).rejects.toBeInstanceOf(OnboardingProgresoProhibidoError);
    await expect(con("22023").guardar("u1", "x", "restaurantes.owner", DATOS)).rejects.toBeInstanceOf(OnboardingProgresoInvalidoError);
    await expect(con("57014").guardar("u1", "x", "restaurantes.owner", DATOS)).rejects.toMatchObject({ code: "57014" });
  });
});

describe("validarProgresoGuia", () => {
  it("acepta las pistas de vertical y la de plataforma", () => {
    expect(validarProgresoGuia("taqueria", "restaurantes.owner", DATOS)).toBeNull();
    expect(validarProgresoGuia(null, "superadmin")).toBeNull();
  });
  it("rechaza formato fuera de la lista cerrada", () => {
    expect(validarProgresoGuia("taqueria", "superadmin")).not.toBeNull();
    expect(validarProgresoGuia(null, "restaurantes.owner")).not.toBeNull();
    expect(validarProgresoGuia("Org Mal", "restaurantes.owner")).not.toBeNull();
    expect(validarProgresoGuia("taqueria", "restaurantes.owner", { ...DATOS, paso: "a b" })).not.toBeNull();
    expect(validarProgresoGuia("taqueria", "restaurantes.owner", { ...DATOS, modo: "x" as never })).not.toBeNull();
  });
});
