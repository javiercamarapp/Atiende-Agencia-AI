// Trinquete de tablas crudas en despachos (UNI-C-despachos.3): las paginas de calculo/captura conservan <Table> (seccion 6.4: caption,
// primera columna fija, cifras a la derecha, scroll horizontal solo dentro de la tarjeta), pero su numero de usos NO puede subir.
// Los listados no pueden tener ninguna (regla "Table a mano en listados de despachos" en test-utils/ds-v2-guard-reglas.ts).
// Si migras una tabla de calculo a DataTable, BAJA el tope; si necesitas una nueva, justificalo: el tope solo baja.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PAGINAS_CALCULO_DESPACHOS, cargarFuentes, type Fuente } from "./test-utils/ds-v2-guard-reglas";

export const TOPE_TABLAS_CALCULO: Readonly<Record<string, number>> = {
  Bookkeeping: 7,
  DevolucionIva: 5,
  Declaraciones: 1,
  Nomina: 3,
  Reportes: 1,
  ContabilidadElectronica: 2,
  Conciliacion: 1,
};

/** Usos de `<Table` crudo (no `<TableRow`, etc.) por pagina de despachos. */
export function contarTablasCrudas(fuentes: readonly Fuente[]): Record<string, number> {
  const cuenta: Record<string, number> = {};
  for (const f of fuentes) {
    const m = /^verticals\/despachos\/pages\/(\w+)\.tsx$/.exec(f.ruta);
    if (!m) continue;
    const n = (f.codigo.match(/<Table[\s>]/g) ?? []).length;
    if (n > 0) cuenta[m[1]!] = n;
  }
  return cuenta;
}

/** Paginas que superan su tope (0 si no es de calculo). */
export function excesos(cuenta: Readonly<Record<string, number>>, topes: Readonly<Record<string, number>>): string[] {
  return Object.entries(cuenta)
    .filter(([pagina, n]) => n > (topes[pagina] ?? 0))
    .map(([pagina, n]) => `${pagina}: ${n} > ${topes[pagina] ?? 0}`);
}

const RAIZ = join(fileURLToPath(new URL(".", import.meta.url)), "../src");

describe("despachos — trinquete de tablas crudas", () => {
  const cuenta = contarTablasCrudas(cargarFuentes(RAIZ));

  it("los topes cubren exactamente las paginas de calculo del guard", () => {
    expect(Object.keys(TOPE_TABLAS_CALCULO).sort()).toEqual([...PAGINAS_CALCULO_DESPACHOS].sort());
  });

  it("ninguna pagina supera su tope (listados: 0; calculo: su tope)", () => {
    expect(excesos(cuenta, TOPE_TABLAS_CALCULO)).toEqual([]);
  });

  it("los topes son ajustados: si migras una tabla, baja el tope", () => {
    for (const [pagina, tope] of Object.entries(TOPE_TABLAS_CALCULO)) expect(cuenta[pagina] ?? 0).toBe(tope);
  });

  it("sanidad: agregar una tabla cruda en un listado o pasarse del tope en una pagina de calculo FALLA", () => {
    const base: Fuente[] = [{ ruta: "verticals/despachos/pages/Staff.tsx", codigo: "<DataTable />" }];
    expect(excesos(contarTablasCrudas(base), TOPE_TABLAS_CALCULO)).toEqual([]);
    const conTabla: Fuente[] = [{ ruta: "verticals/despachos/pages/Staff.tsx", codigo: "<Table><TableRow /></Table>" }];
    expect(excesos(contarTablasCrudas(conTabla), TOPE_TABLAS_CALCULO)).toEqual(["Staff: 1 > 0"]);
    const calculoSube: Fuente[] = [{ ruta: "verticals/despachos/pages/Declaraciones.tsx", codigo: "<Table></Table><Table></Table>" }];
    expect(excesos(contarTablasCrudas(calculoSube), TOPE_TABLAS_CALCULO)).toEqual(["Declaraciones: 2 > 1"]);
    const dentroDelTope: Fuente[] = [{ ruta: "verticals/despachos/pages/Declaraciones.tsx", codigo: "<Table></Table>" }];
    expect(excesos(contarTablasCrudas(dentroDelTope), TOPE_TABLAS_CALCULO)).toEqual([]);
  });
});
