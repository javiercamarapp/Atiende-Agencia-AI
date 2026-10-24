// «Análisis de clientes»: la API simulada de e2e sirve respuestas SINTÉTICAS generadas con el servicio real de CFO-05. Este guard regenera esas respuestas y
// falla si el JSON versionado (`e2e/mock-api/fixtures/restaurantes-cfo-analisis.datos.json`) dejó de coincidir:
// `ACTUALIZAR_FIXTURE_CFO=1 npx vitest run apps/web/tests/restaurantes-cfo-analisis-fixture-sintetica.spec.ts` lo reescribe.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { construirFixtureAnalisis, type FixtureAnalisis } from "./test-utils/cfo-fixture-analisis.ts";
import { AVISO_SINTETICO } from "./test-utils/cfo-fixture-sintetica.ts";

const RUTA = fileURLToPath(new URL("../e2e/mock-api/fixtures/restaurantes-cfo-analisis.datos.json", import.meta.url));

describe("fixture SINTÉTICA del análisis de clientes para e2e", () => {
  it("el JSON versionado coincide con lo que genera el servicio real", async () => {
    const nueva = await construirFixtureAnalisis();
    if (process.env["ACTUALIZAR_FIXTURE_CFO"] === "1") writeFileSync(RUTA, `${JSON.stringify(nueva, null, 1)}\n`);
    expect(JSON.parse(readFileSync(RUTA, "utf8"))).toEqual(JSON.parse(JSON.stringify(nueva)));
  });

  it("toda vista lleva el rótulo SINTÉTICO y no trae nombres, teléfonos, direcciones ni correos", () => {
    const f = JSON.parse(readFileSync(RUTA, "utf8")) as FixtureAnalisis;
    for (const v of Object.values(f)) expect(v.avisos[0]).toBe(AVISO_SINTETICO);
    const crudo = JSON.stringify(f);
    expect(crudo).not.toMatch(/"\+?\d{10,}"/);
    expect(crudo).not.toMatch(/"(telefono|phone|direccion|address|email|customerName|customerId)"/i);
  });

  it("los clientes de la reactivación solo traen alias de 8 caracteres hexadecimales", () => {
    const f = JSON.parse(readFileSync(RUTA, "utf8")) as FixtureAnalisis;
    for (const fila of f.normal.secciones.reactivacion.datos!.filas) expect(fila.alias).toMatch(/^[0-9a-f]{8}$/);
  });
});
