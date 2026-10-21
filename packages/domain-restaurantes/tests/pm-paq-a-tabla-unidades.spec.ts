// PAQUETE A (PM): tabla de unidades por orden y desambiguación orden / kilo / pieza. Sintético, determinista.
import { describe, expect, it } from "vitest";
import { analizarPiezasPedidas, avisoUnidadPorTabla, clasificarMedida, clasificarMedidas, familiaUnidadPm, piezasDeOrdenes } from "../src/unidades-pm.ts";

describe("familias de unidad", () => {
  it.each([
    ["Tacos de Bistec de Res (orden de 3)", "tacos-3", 3],
    ["Tacos de Chuleta de Cerdo (orden de 3)", "tacos-3", 3],
    ["Tacos de Arrachera (orden de 3)", "tacos-3", 3],
    ["Tacos de Pechuga de Pollo (orden de 3)", "tacos-3", 3],
    ["Tacos de Chorizo (orden de 3)", "tacos-3", 3],
    ["Tacos de Bistec Encebollado (orden de 3)", "tacos-3", 3],
    ["Tacos de Poc-Chuc (orden de 3)", "tacos-3", 3],
    ["Tacos de Costilla de Res (orden de 3)", "tacos-3", 3],
    ["Taco Al Pastor (individual)", "taco-individual", 1],
    ["Taco de Rajas (individual)", "taco-individual", 1],
    ["Taco de Champiñones (individual)", "taco-individual", 1],
    ["Alambre de Pastor", "alambre", 5],
    ["Alambre Suizo de Bistec", "alambre", 5],
    ["Suizo de Pastor", "suizo", 5],
    ["Tacos Suizos de Chile Poblano y Bistec", "suizo", 5],
    ["Papadzules (orden de 5)", "papadzules", 5],
    ["Codzitos (orden de 4)", "codzitos", 4],
    ["Tacos de Cochinita (orden de 4)", "tacos-cochinita", 4],
    ["Gringa de Pastor", "gringa", 2],
    ["Mestiza de Bistec", "mestiza", 2],
    ["Flauta de Arrachera", "flauta", 1],
    ["Quesobich de Pastor", "quesobich", 1],
    ["Alitas de Pollo", "alitas", 7],
    ["Crujientes de Pechuga de Pollo", "crujientes", 12],
  ])("%s", (nombre, familia, piezas) => {
    const f = familiaUnidadPm(nombre);
    expect(f?.familia).toBe(familia);
    expect(f?.piezasPorOrden).toBe(piezas);
  });
  it("gringa de pastor NO cae en taco de pastor ni flauta de pastor en tacos", () => {
    expect(familiaUnidadPm("Gringa de Pastor")?.familia).toBe("gringa");
    expect(familiaUnidadPm("Flauta de Pastor")?.familia).toBe("flauta");
    expect(familiaUnidadPm("Refresco")).toBeNull();
  });
  it("lo que no está confirmado ni se confunde: quesadillas sin dato, Francés Suizo y Ceiba Mestiza fuera", () => {
    expect(familiaUnidadPm("Quesadilla de Rajas")).toBeNull();
    expect(familiaUnidadPm("Francés Suizo de Pastor")).toBeNull();
    expect(familiaUnidadPm("Ceiba Mestiza")).toBeNull();
    expect(familiaUnidadPm("Bistec de Res Encebollado — 1 kg")).toBeNull();
  });
  it("crujientes es aproximado", () => {
    expect(familiaUnidadPm("Crujientes de Pechuga de Pollo")?.aproximado).toBe(true);
    expect(familiaUnidadPm("Alitas de Pollo")?.aproximado).toBe(false);
  });
});

describe("analizarPiezasPedidas (S01, S02)", () => {
  it("4 tacos de bistec: no es múltiplo de 3, ofrece 1 orden (3) o 2 órdenes (6)", () => {
    const r = analizarPiezasPedidas("Tacos de Bistec de Res (orden de 3)", 4);
    expect(r).toMatchObject({ tipo: "no_multiplo", piezasPorOrden: 3, opciones: [3, 6] });
  });
  it("6 tacos de bistec = 2 órdenes", () => {
    expect(analizarPiezasPedidas("Tacos de Bistec de Res (orden de 3)", 6)).toMatchObject({ tipo: "ok", ordenes: 2 });
  });
  it("pastor es individual: 4 tacos son 4 piezas", () => {
    expect(analizarPiezasPedidas("Taco Al Pastor (individual)", 4)).toMatchObject({ tipo: "ok", ordenes: 4 });
  });
  it("3 gringas: opciones 2 o 4", () => {
    expect(analizarPiezasPedidas("Gringa de Pastor", 3)).toMatchObject({ tipo: "no_multiplo", opciones: [2, 4] });
  });
  it("1 pieza de algo de orden de 3 sube a la orden mínima", () => {
    expect(analizarPiezasPedidas("Tacos de Arrachera (orden de 3)", 1)).toMatchObject({ tipo: "no_multiplo", opciones: [3] });
  });
  it("alitas: 14 piezas = 2 órdenes; 10 no es múltiplo", () => {
    expect(analizarPiezasPedidas("Alitas de Pollo", 14)).toMatchObject({ tipo: "ok", ordenes: 2 });
    expect(analizarPiezasPedidas("Alitas de Pollo", 10)).toMatchObject({ tipo: "no_multiplo", opciones: [7, 14] });
  });
  it("crujientes (~12): jamás convierte piezas a órdenes, pregunta cuántas órdenes", () => {
    expect(analizarPiezasPedidas("Crujientes de Pechuga de Pollo", 24)).toMatchObject({ tipo: "aproximado" });
  });
  it("producto fuera de la tabla: sin_dato (el agente no inventa)", () => {
    expect(analizarPiezasPedidas("Agua de Horchata", 2)).toMatchObject({ tipo: "sin_dato" });
  });
  it("cantidad inválida", () => {
    expect(analizarPiezasPedidas("Gringa de Pastor", 0)).toMatchObject({ tipo: "invalida" });
    expect(analizarPiezasPedidas("Gringa de Pastor", 1.5)).toMatchObject({ tipo: "invalida" });
  });
});

describe("piezasDeOrdenes (T7-012: 3 órdenes de gringas = 6)", () => {
  it("gringas, tacos de bistec, flauta, pastor", () => {
    expect(piezasDeOrdenes("Gringa de Pastor", 3)).toBe(6);
    expect(piezasDeOrdenes("Tacos de Bistec de Res (orden de 3)", 2)).toBe(6);
    expect(piezasDeOrdenes("Flauta de Pastor", 3)).toBe(3);
    expect(piezasDeOrdenes("Taco Al Pastor (individual)", 5)).toBe(5);
    expect(piezasDeOrdenes("Crujientes de Pechuga de Pollo", 2)).toBeNull();
    expect(piezasDeOrdenes("Refresco", 2)).toBeNull();
  });
});

describe("clasificarMedida: orden vs kilo vs pieza (S03)", () => {
  it("medio de pastor = medio kilo (no 1 kg)", () => {
    expect(clasificarMedida("medio de pastor")).toMatchObject({ medida: "kilo", kg: 0.5 });
    expect(clasificarMedida("1/2 de bistec")).toMatchObject({ medida: "kilo", kg: 0.5 });
    expect(clasificarMedida("un cuarto de arrachera")).toMatchObject({ medida: "kilo", kg: 0.25 });
    expect(clasificarMedida("kilo y medio de pastor")).toMatchObject({ medida: "kilo", kg: 1.5 });
    expect(clasificarMedida("2 kilos de bistec")).toMatchObject({ medida: "kilo", kg: 2 });
  });
  it("orden explícita", () => {
    expect(clasificarMedida("2 órdenes de gringas")).toMatchObject({ medida: "orden", cantidad: 2 });
    expect(clasificarMedida("una orden de alitas")).toMatchObject({ medida: "orden", cantidad: 1 });
  });
  it("piezas explícitas", () => {
    expect(clasificarMedida("4 tacos de bistec")).toMatchObject({ medida: "pieza", cantidad: 4 });
    expect(clasificarMedida("3 gringas")).toMatchObject({ medida: "pieza", cantidad: 3 });
  });
  it("«una orden de pastor» es ambigua: pregunta cuántos tacos", () => {
    const r = clasificarMedida("una orden de pastor");
    expect(r.medida).toBe("ambigua");
    expect(r.pregunta).toMatch(/cuántos tacos/i);
  });
  it("«media orden» es ambigua entre media orden de nachos/frijoles y medio kilo", () => {
    const r = clasificarMedida("media orden de bistec");
    expect(r.medida).toBe("ambigua");
    expect(r.pregunta).toMatch(/medio kilo/i);
  });
  it("«3 de pastor» pide aclarar la unidad (pieza, orden o peso), no queda mudo", () => {
    const r = clasificarMedida("3 de pastor");
    expect(r.medida).toBe("ambigua");
    expect(r.pregunta).toMatch(/piezas|tacos/i);
    expect(r.pregunta).toMatch(/órdenes/i);
    expect(r.pregunta).toMatch(/peso|kilos/i);
  });
  it("sin medida", () => {
    expect(clasificarMedida("unas alitas").medida).toBe("sin_medida");
  });
});

describe("clasificarMedidas: varias medidas en un mensaje", () => {
  it("«2 tacos y medio kilo de pastor» no pierde los tacos", () => {
    const r = clasificarMedidas("2 tacos y medio kilo de pastor");
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ medida: "pieza", cantidad: 2 });
    expect(r[1]).toMatchObject({ medida: "kilo", kg: 0.5 });
  });
  it("kilo y medio sigue siendo una sola medida; tacos + gringas + órdenes", () => {
    expect(clasificarMedidas("kilo y medio de pastor")).toEqual([expect.objectContaining({ medida: "kilo", kg: 1.5 })]);
    const r = clasificarMedidas("4 tacos de bistec, 2 ordenes de gringas y 3 de pastor");
    expect(r.map((x) => x.medida)).toEqual(["pieza", "orden", "ambigua"]);
  });
  it("sin ninguna medida devuelve sin_medida", () => {
    expect(clasificarMedidas("unas alitas")).toEqual([{ medida: "sin_medida" }]);
  });
});

describe("avisoUnidadPorTabla (se usa desde buscar_producto)", () => {
  it("solo con pack_size nulo y orden de 2 o más; no para alitas/crujientes ni con pack_size explícito", () => {
    expect(avisoUnidadPorTabla({ name: "Mestiza de Bistec", packSize: null })).toMatch(/2 piezas/);
    expect(avisoUnidadPorTabla({ name: "Alambre de Pastor", packSize: null })).toMatch(/5 piezas/);
    expect(avisoUnidadPorTabla({ name: "Mestiza de Bistec", packSize: 2 })).toBeNull();
    expect(avisoUnidadPorTabla({ name: "Crujientes de Pechuga de Pollo", packSize: null })).toBeNull();
    expect(avisoUnidadPorTabla({ name: "Taco Al Pastor (individual)", packSize: null })).toBeNull();
  });
});
