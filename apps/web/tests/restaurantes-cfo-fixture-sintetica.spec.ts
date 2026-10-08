// CFO-07 · la API simulada de e2e sirve respuestas SINTÉTICAS generadas con el generador de CFO-04 y el servicio de CFO-05. Este guard regenera
// esas respuestas y falla si el JSON versionado (`e2e/mock-api/fixtures/restaurantes-cfo.datos.json`) dejó de coincidir con el contrato: si el
// servicio o el generador cambian, hay que volver a generarlo (`ACTUALIZAR_FIXTURE_CFO=1 npx vitest run apps/web/tests/restaurantes-cfo-fixture-sintetica.spec.ts`).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AVISO_SINTETICO, construirFixtureCfo, ID_T3, type FixtureCfoSintetica } from "./test-utils/cfo-fixture-sintetica.ts";

const RUTA = fileURLToPath(new URL("../e2e/mock-api/fixtures/restaurantes-cfo.datos.json", import.meta.url));

describe("fixture SINTÉTICA del CFO para e2e", () => {
  it("el JSON versionado coincide con lo que generan CFO-04 + CFO-05", async () => {
    const nueva = await construirFixtureCfo();
    // Ida y vuelta por JSON: lo que se compara es lo que realmente sirve el mock.
    const texto = JSON.stringify(nueva);
    if (process.env["ACTUALIZAR_FIXTURE_CFO"] === "1") writeFileSync(RUTA, texto);
    const guardada = readFileSync(RUTA, "utf8");
    expect(JSON.parse(guardada)).toEqual(JSON.parse(texto));
  });

  it("todas las respuestas llevan el rótulo SINTÉTICO y no hay datos personales", () => {
    const f = JSON.parse(readFileSync(RUTA, "utf8")) as FixtureCfoSintetica;
    const vistas = [f.alcance, ...Object.values(f.resumen), ...Object.values(f.ventas), ...Object.values(f.sucursales), ...Object.values(f.estadoResultados)] as Array<{ avisos: string[] }>;
    for (const v of vistas) expect(v.avisos[0]).toBe(AVISO_SINTETICO);
    const crudo = JSON.stringify(f);
    expect(crudo).not.toMatch(/"\+?\d{10,}"/); // sin teléfonos (cadenas solo de dígitos)
    for (const p of f.pedidos) expect(Object.keys(p)).not.toEqual(expect.arrayContaining(["customerName", "phone", "address"]));
  });

  it("T3 (Pensiones) no captura nómina: «captura pendiente» antes y dato después de capturarla", () => {
    type Pyl = { estadoResultados: { acumulado: { columnas: Array<{ clave: string; lineas: Array<{ id: string; faltaCaptura: boolean; cifra: { valor: number | null } }> }> } } };
    const f = JSON.parse(readFileSync(RUTA, "utf8")) as FixtureCfoSintetica;
    const nomina = (v: unknown) => (v as Pyl).estadoResultados.acumulado.columnas.find((c) => c.clave === "sucursal")!.lineas.find((l) => l.id === "nomina")!;
    const antes = nomina(f.estadoResultados["t3|2026-09-21|0"]);
    const despues = nomina(f.estadoResultados["t3|2026-09-21|1"]);
    expect(antes.faltaCaptura).toBe(true);
    expect(antes.cifra.valor).toBeNull();
    expect(despues.faltaCaptura).toBe(false);
    expect(despues.cifra.valor).not.toBeNull();
    expect(ID_T3).toMatch(/a3$/);
  });
});
