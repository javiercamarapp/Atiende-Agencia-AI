// Defecto A (13-oct, prod): el agente escribia `**$126**` y WhatsApp (que usa UN asterisco para negrita) lo mostraba literal. Corpus positivo (se convierte)
// y negativo (no se toca: precios, URLs, asteriscos aislados, negritas ya correctas), mas idempotencia y el contrato de entradas invalidas.
import { describe, expect, it } from "vitest";
import { normalizarFormatoWhatsApp as n } from "../src/whatsapp/formato-whatsapp.ts";

describe("normalizarFormatoWhatsApp: lo que SI se convierte", () => {
  it.each([
    ["Son **$126**, ¿confirma?", "Son *$126*, ¿confirma?"],
    ["**Total:** $126 en efectivo", "*Total:* $126 en efectivo"],
    ["**3 tacos** y **1 agua**", "*3 tacos* y *1 agua*"],
    ["***Importante***: cierra a las 11", "*_Importante_*: cierra a las 11"],
    ["~~Agotado~~ disponible", "~Agotado~ disponible"],
    ["# Resumen del pedido", "*Resumen del pedido*"],
    ["### **Menú** del día ###", "*Menú del día*"],
    ["* 3 tacos al pastor\n* 1 agua", "- 3 tacos al pastor\n- 1 agua"],
    ["# Precio 2*3", "*Precio 2*3*"],
    ["## **Total** $126", "*Total $126*"],
    ["Menú:\n\n---\n\n1. Tacos", "Menú:\n\n1. Tacos"],
    ["Vea el [menú](https://ejemplo.mx/menu_2026)", "Vea el menú: https://ejemplo.mx/menu_2026"],
    ["**Pedido**\n* 3 × Taco **$126**", "*Pedido*\n- 3 × Taco *$126*"],
    ["  * con sangria", "  - con sangria"],
  ])("%j -> %j", (entrada, esperado) => {
    expect(n(entrada)).toBe(esperado);
  });
});

describe("normalizarFormatoWhatsApp: lo que NO se toca", () => {
  it.each([
    "Son $126.00 en total",
    "El total es *$126* (ya en formato WhatsApp)",
    "_cursiva_ y ~tachado~ ya correctos",
    "5 * 3 = 15",
    "2**3 es 8",
    "Costo*: no incluye propina",
    "*Nota",
    "Una * sola al final *",
    "https://ejemplo.mx/__archivo__/a_b_c?x=**1**",
    "https://ejemplo.mx/menu_del_dia_final",
    "mi_variable_con_guiones y snake__case__nombre",
    "`**codigo**` en linea",
    "```\n**bloque**\n# no titulo\n* no lista\n```",
    "#1 en ventas",
    "Pedido #4521 listo",
    "Tel. 999-123-4567, colonia Centro #100",
    "- guion ya es lista en WhatsApp",
    "1. Tacos\n2. Agua",
    "** sin cerrar",
    "**con espacio al final **",
    "texto normal sin formato",
    "+ 52 999 123 4567 es la lada",
    "__init__ y __main__",
    "__Gracias__ por su pedido",
    "www.ejemplo.mx/__archivo__/a",
    "+ salsa verde",
  ])("%j queda igual", (entrada) => {
    expect(n(entrada)).toBe(entrada);
  });

  it("no cruza lineas: ** abierto en una linea y cerrado en otra no se empareja", () => {
    expect(n("**uno\ndos**")).toBe("**uno\ndos**");
  });

  it("un precio dentro de negrita conserva cifra, signo y decimales", () => {
    expect(n("**$1,500.50 MXN**")).toBe("*$1,500.50 MXN*");
    expect(n("Total: **$126**. Propina: **$12.60**")).toBe("Total: *$126*. Propina: *$12.60*");
  });
});

describe("normalizarFormatoWhatsApp: entradas hostiles (tiempo acotado)", () => {
  it.each([
    ["corchetes sin cerrar", "[".repeat(50_000)],
    ["enlaces a medias", "[a](".repeat(12_000)],
    ["dobles asteriscos sin cerrar", "**a ".repeat(15_000)],
    ["tildes sin cerrar", "~~a ".repeat(15_000)],
    ["encabezado enorme", "# " + "*".repeat(50_000)],
  ])("%s se normaliza en menos de 500 ms", (_n, entrada) => {
    const t0 = Date.now();
    n(entrada);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("normalizarFormatoWhatsApp: propiedades", () => {
  const corpus = ["~~~", "~~~x~~~", "a~~~b", "~~~~", "*", "**", "***", "Son **$126**", "# Titulo\n* a\n* b", "---", "[a](https://x.mx/a_b)", "_ya_ *bien*", "***x***", "", "\n\n\n"];
  it("es idempotente", () => {
    for (const t of corpus) expect(n(n(t)), t).toBe(n(t));
  });
  it("no deja dobles asteriscos de negrita ni encabezados en texto convertido", () => {
    const out = n("# A\n**b** y **c**\n## D");
    expect(out).not.toMatch(/\*\*/);
    expect(out).not.toMatch(/^#/m);
  });
  it("las cifras de dinero del texto de entrada sobreviven intactas", () => {
    const entrada = "**3 × Taco al pastor** — $42.00 c/u\n**Total: $126.00**";
    const dinero = (s: string) => s.match(/\$\d[\d,]*(?:\.\d+)?/g);
    expect(dinero(n(entrada))).toEqual(dinero(entrada));
  });
  it.each([0, null, undefined, false, true, [], {}, 123, ["a"], { a: 1 }])("entrada no textual %j -> cadena vacia", (entrada) => {
    expect(n(entrada)).toBe("");
  });
  it("cadena vacia -> cadena vacia", () => {
    expect(n("")).toBe("");
  });
});
