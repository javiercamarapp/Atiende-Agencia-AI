// R22 decision 7: la direccion de T3 Pensiones es Calle 52 No 37 por Av. 7, Residencial Pensiones, CP 97217 (el sitio oficial y la ficha de Google coinciden);
// la anterior (Calle 11 No. 371 x Av. 32, San Damian) no aparece en ninguna fuente publica.
import { describe, expect, it } from "vitest";
import { buildPmSeedPlan, renderPmSeedPlpgsql } from "../src/seed/pm-demo.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const { data, agent } = loadSeedInputs();

describe("R22-7 direccion de T3 Pensiones", () => {
  it("el seed trae Calle 52 No 37 por Av. 7, Residencial Pensiones, CP 97217", () => {
    const t3 = data.sucursales.find((b) => b.id === "T3")!;
    expect(t3.direccion).toMatch(/^Calle 52 No 37 por Av\. 7, Residencial Pensiones, CP 97217/);
    expect(t3.direccion).not.toMatch(/Calle 11|371|San Damián/);
  });
  it("el SQL que siembra la sucursal lleva la direccion nueva y ningun rastro de la vieja", () => {
    const sql = renderPmSeedPlpgsql(buildPmSeedPlan(data, agent));
    expect(sql).toContain("Calle 52 No 37 por Av. 7, Residencial Pensiones, CP 97217");
    expect(sql).not.toContain("Calle 11 No. 371");
  });
});
