// CFO-08 · la API simulada de e2e sirve respuestas SINTÉTICAS de clientes, platillos, patrones, operación y SoftRestaurant generadas con CFO-04 + CFO-05.
// Este guard regenera esas respuestas y falla si el JSON versionado (`e2e/mock-api/fixtures/restaurantes-cfo-b.datos.json`) dejó de coincidir:
// `ACTUALIZAR_FIXTURE_CFO=1 npx vitest run apps/web/tests/restaurantes-cfo-b-fixture-sintetica.spec.ts` lo reescribe.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { construirFixtureCfoB, type FixtureCfoB } from "./test-utils/cfo-fixture-sintetica-b.ts";
import { AVISO_SINTETICO } from "./test-utils/cfo-fixture-sintetica.ts";

const RUTA = fileURLToPath(new URL("../e2e/mock-api/fixtures/restaurantes-cfo-b.datos.json", import.meta.url));

describe("fixture SINTÉTICA del CFO B para e2e", () => {
  it("el JSON versionado coincide con lo que generan CFO-04 + CFO-05", async () => {
    const nueva = await construirFixtureCfoB();
    const texto = JSON.stringify(nueva);
    if (process.env["ACTUALIZAR_FIXTURE_CFO"] === "1") writeFileSync(RUTA, `${JSON.stringify(nueva, null, 1)}\n`);
    expect(JSON.parse(readFileSync(RUTA, "utf8"))).toEqual(JSON.parse(texto));
  });

  it("toda vista lleva el rótulo SINTÉTICO y no trae nombres, teléfonos ni direcciones", () => {
    const f = JSON.parse(readFileSync(RUTA, "utf8")) as FixtureCfoB;
    const vistas = [...Object.values(f.clientes), ...Object.values(f.productos), ...Object.values(f.patrones), ...Object.values(f.operacion), ...Object.values(f.cuadre), f.operacionApagada] as Array<{ avisos: string[] }>;
    for (const v of vistas) expect(v.avisos[0]).toBe(AVISO_SINTETICO);
    const crudo = JSON.stringify(f);
    expect(crudo).not.toMatch(/"\+?\d{10,}"/);
    expect(crudo).not.toMatch(/"(telefono|phone|direccion|address|email|customerName)"/i);
  });

  it("las colonias no bajan de k = 5 y hay un renglón «(otras)»", () => {
    const f = JSON.parse(readFileSync(RUTA, "utf8")) as FixtureCfoB;
    const col = (f.patrones["todas"] as { colonias: Array<{ colonia: string; pedidos: number }> }).colonias;
    for (const c of col) if (c.colonia !== "(otras)") expect(c.pedidos).toBeGreaterThanOrEqual(5);
    expect(col.some((c) => c.colonia === "(otras)")).toBe(true);
  });
});
