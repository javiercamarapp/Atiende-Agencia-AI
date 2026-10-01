// D-04: job de ingesta mensual de la lista 69-B con adaptador/fixture (sin llamadas al SAT).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Efos69bFormatoError, InMemoryDespachosRepository } from "@atiende/domain-despachos";
import { FixtureEfos69bSource, runEfos69bIngestion } from "../src/index.ts";

const CSV = readFileSync(fileURLToPath(new URL("../../../packages/domain-despachos/tests/fixtures/efos-69b-muestra.csv", import.meta.url)), "utf8");

describe("runEfos69bIngestion", () => {
  it("ingiere la edicion desde el adaptador, reporta descartadas y es idempotente por periodo", async () => {
    const repo = new InMemoryDespachosRepository();
    const withRepo = <T>(fn: (r: InMemoryDespachosRepository) => Promise<T>) => fn(repo);
    const source = new FixtureEfos69bSource({ "2026-07": CSV });
    const a = await runEfos69bIngestion(withRepo, source, "2026-07");
    expect(a).toMatchObject({ periodo: "2026-07", resultado: "insertada", filas: 4 });
    expect(a.descartadas.map((d) => d.motivo)).toEqual(["rfc_invalido", "situacion_desconocida", "rfc_duplicado"]);
    expect((await runEfos69bIngestion(withRepo, source, "2026-07")).resultado).toBe("sin_cambios");
    expect((await repo.consultarEfos(["AAA010101AA1"])).coincidencias[0]!.situacion).toBe("definitivo");
  });

  it("una edicion corregida del mismo periodo reemplaza a la anterior", async () => {
    const repo = new InMemoryDespachosRepository();
    const withRepo = <T>(fn: (r: InMemoryDespachosRepository) => Promise<T>) => fn(repo);
    await runEfos69bIngestion(withRepo, new FixtureEfos69bSource({ "2026-07": CSV }), "2026-07");
    const corregido = CSV.replace("Definitivo", "Desvirtuado");
    expect((await runEfos69bIngestion(withRepo, new FixtureEfos69bSource({ "2026-07": corregido }), "2026-07")).resultado).toBe("reemplazada");
    expect((await repo.consultarEfos(["AAA010101AA1"])).coincidencias[0]!.situacion).toBe("desvirtuado");
  });

  it("archivo invalido o periodo mal formado: falla entero y NO escribe nada", async () => {
    const repo = new InMemoryDespachosRepository();
    const withRepo = <T>(fn: (r: InMemoryDespachosRepository) => Promise<T>) => fn(repo);
    await expect(runEfos69bIngestion(withRepo, new FixtureEfos69bSource({ "2026-07": "basura" }), "2026-07")).rejects.toBeInstanceOf(Efos69bFormatoError);
    await expect(runEfos69bIngestion(withRepo, new FixtureEfos69bSource({}), "2026-7")).rejects.toBeInstanceOf(Efos69bFormatoError);
    expect((await repo.estadoEfos()).estado).toBe("no_disponible");
  });
});
