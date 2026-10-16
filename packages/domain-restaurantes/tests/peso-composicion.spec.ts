// L2b: composicion de pesos con presentaciones reales (peso-composicion.ts). Puro: sin base ni reloj.
import { describe, expect, it } from "vitest";
import { basePesoDeProducto, componerPeso, composicionParaProducto, etiquetaDePeso, pesoPedidoEnConsulta, TOPE_COMPOSICION_G, type PresentacionPeso } from "../src/peso-composicion.ts";

const pres = (base: string, kilo: number, gramos = [250, 500, 750, 1000, 1500, 2000]): PresentacionPeso[] =>
  gramos.map((g) => ({ id: `${base}-${g}`, name: `${base} — ${etiquetaDePeso(g)}`, price: (kilo * g) / 1000, gramos: g }));
const PASTOR = pres("Pastor", 900);

const piezas = (g: number, p = PASTOR) => {
  const c = componerPeso(g, p);
  if (c.tipo !== "composicion") throw new Error(`no compuso ${g}: ${c.motivo}`);
  return c;
};

describe("componerPeso: cualquier multiplo de 250 g hasta el tope, precio exacto = suma = proporcional", () => {
  it("A42: 1.25 kg de pastor = 1 kg + 250 g = $900 + $225 = $1,125 (no se redondea a 1 ni a 1.5 kg)", () => {
    const c = piezas(1250);
    expect(c.partes.map((x) => [x.cantidad, x.gramos, x.subtotal])).toEqual([[1, 1000, 900], [1, 250, 225]]);
    expect(c.total).toBe(1125);
    expect(c.precio_proporcional).toBe(1125);
    expect(c.frase).toBe("le armo 1 kg + 250 g de Pastor, $1,125");
  });

  it.each([
    [1750, "1.5 kg + 250 g"], [2250, "2 kg + 250 g"], [2500, "2 kg + 500 g"], [2750, "2 kg + 750 g"], [3000, "2 kg + 1 kg"], [3500, "2 kg + 1.5 kg"],
    [3750, "2 kg + 1.5 kg + 250 g"], [4000, "2 × 2 kg"], [4250, "2 × 2 kg + 250 g"], [5000, "2 × 2 kg + 1 kg"], [7500, "3 × 2 kg + 1.5 kg"], [10000, "5 × 2 kg"],
  ])("%d g -> %s", (g, texto) => {
    expect(piezas(g).frase).toContain(texto);
  });

  it("propiedad: cada multiplo de 250 g de 250 a 10 kg suma exacto los gramos, el precio es la suma de las presentaciones y coincide con el proporcional", () => {
    for (const kilo of [900, 1100, 1150, 950, 1400]) {
      const p = pres("X", kilo);
      for (let g = 250; g <= TOPE_COMPOSICION_G; g += 250) {
        const c = piezas(g, p);
        expect(c.partes.reduce((a, x) => a + x.cantidad * x.gramos, 0)).toBe(g);
        expect(c.total).toBeCloseTo(c.partes.reduce((a, x) => a + x.cantidad * x.precio_unitario, 0), 6);
        expect(c.total).toBeCloseTo((kilo * g) / 1000, 6);
        expect(c.proporcional).toBe(true);
        // piezas minimas: nunca mas que un 2 kg por cada 2 kg + las presentaciones chicas necesarias
        expect(c.partes.reduce((a, x) => a + x.cantidad, 0)).toBeLessThanOrEqual(Math.floor(g / 2000) + 2);
      }
    }
  });

  it("negativo: un peso que NO es multiplo de 250 g (1.3 kg, 100 g, 1251 g) NO se inventa: pregunta con las dos opciones vecinas", () => {
    for (const g of [100, 300, 1100, 1300, 1251, 2999]) {
      const c = componerPeso(g, PASTOR);
      expect(c).toMatchObject({ tipo: "preguntar", motivo: "no_multiplo_de_250", gramos_pedidos: g });
      expect("total" in c).toBe(false);
    }
    expect((componerPeso(1300, PASTOR) as { mensaje: string }).mensaje).toContain("1.25 kg o 1.5 kg");
    expect((componerPeso(100, PASTOR) as { mensaje: string }).mensaje).toContain("250 g");
  });

  it("mas de 10 kg se pregunta (pedido grande), 10 kg exacto si se compone", () => {
    expect(componerPeso(TOPE_COMPOSICION_G + 250, PASTOR)).toMatchObject({ tipo: "preguntar", motivo: "mas_del_tope" });
    expect(componerPeso(100000, PASTOR)).toMatchObject({ tipo: "preguntar", motivo: "mas_del_tope" });
    expect(componerPeso(TOPE_COMPOSICION_G, PASTOR).tipo).toBe("composicion");
  });

  it("sin la presentacion de 250 g (o sin ninguna) no se puede armar un cuarto: pregunta, no inventa", () => {
    expect(componerPeso(1250, pres("Y", 900, [500, 1000]))).toMatchObject({ tipo: "preguntar", motivo: "sin_presentaciones" });
    expect(componerPeso(1250, [])).toMatchObject({ tipo: "preguntar", motivo: "sin_presentaciones" });
    // con 500 y 1 kg si se arma 1.5 kg
    expect(piezas(1500, pres("Y", 900, [500, 1000])).partes.map((x) => x.gramos)).toEqual([1000, 500]);
  });

  it("presentaciones basura (precio 0, NaN, gramos 0, no multiplo) se ignoran; duplicadas gana el precio menor", () => {
    const sucias: PresentacionPeso[] = [...PASTOR, { id: "a", name: "Pastor — 100 g", price: 90, gramos: 100 }, { id: "b", name: "Pastor — 250 g", price: 0, gramos: 250 }, { id: "c", name: "Pastor — 250 g", price: Number.NaN, gramos: 250 }, { id: "d", name: "x", price: 5, gramos: 0 }];
    expect(piezas(1250, sucias).total).toBe(1125);
    const dup: PresentacionPeso[] = [...PASTOR, { id: "barata", name: "Pastor — 250 g", price: 200, gramos: 250 }];
    expect(piezas(250, dup).partes[0]!.product_id).toBe("barata");
  });

  it("si el menu NO es proporcional lo dice (proporcional: false) pero cobra la suma real de las presentaciones", () => {
    const caro = PASTOR.map((p) => (p.gramos === 250 ? { ...p, price: 300 } : p));
    const c = piezas(1250, caro);
    expect(c.total).toBe(1200);
    expect(c.precio_proporcional).toBe(1125);
    expect(c.proporcional).toBe(false);
  });

  it("contrato de entrada: 0, '', null, undefined, false, [], {}, NaN, Infinity, negativos, decimales y strings dan 'preguntar' sin lanzar", () => {
    for (const malo of [0, "", null, undefined, false, true, [], {}, Number.NaN, Infinity, -250, -1, 250.5, "1250", "250"]) {
      const c = componerPeso(malo, PASTOR);
      expect(c, String(malo)).toMatchObject({ tipo: "preguntar", motivo: "peso_invalido", gramos_pedidos: null });
    }
    for (const mala of [[], [{ id: "x", name: "x", price: 1, gramos: 250 }]]) expect(() => componerPeso(250, mala)).not.toThrow();
  });
});

describe("composicionParaProducto: usa SOLO las presentaciones del mismo platillo", () => {
  const catalogo = [...pres("Pastor", 900), ...pres("Bistec de Res", 1100), ...pres("Bistec de Res Encebollado", 1150), { id: "t", name: "Taco Al Pastor (individual)", price: 25 }];
  it("Bistec de Res no mezcla con Bistec de Res Encebollado", () => {
    const c = composicionParaProducto(catalogo, "Bistec de Res — 1 kg", 1250);
    expect(c).toMatchObject({ tipo: "composicion", total: 1375 });
    if (c?.tipo === "composicion") expect(c.partes.every((x) => x.name.startsWith("Bistec de Res — "))).toBe(true);
    const e = composicionParaProducto(catalogo, "Bistec de Res Encebollado — 250 g", 1250);
    expect(e).toMatchObject({ tipo: "composicion", total: 1437.5 });
  });
  it("una presentacion exacta no necesita composicion (null); aproximado pregunta; ids reales de las partes", () => {
    expect(composicionParaProducto(catalogo, "Pastor — 1 kg", 500)).toBeNull();
    expect(composicionParaProducto(catalogo, "Pastor — 1 kg", "aproximado")).toMatchObject({ tipo: "preguntar", motivo: "cantidad_aproximada" });
    const c = composicionParaProducto(catalogo, "Pastor — 1 kg", 1250);
    expect(c?.tipo === "composicion" && c.partes.map((x) => x.product_id)).toEqual(["Pastor-1000", "Pastor-250"]);
  });
  it("precio como string del repositorio (numeric de Postgres) se convierte", () => {
    const c = composicionParaProducto(catalogo.map((p) => ({ ...p, price: String(p.price) })), "Pastor — 1 kg", 1250);
    expect(c).toMatchObject({ tipo: "composicion", total: 1125 });
  });
});

describe("pesoPedidoEnConsulta: que peso pide la consulta", () => {
  it.each([
    ["kilo y cuarto de pastor", 1250], ["1 1/4 kg de pastor", 1250], ["kilo y medio", 1500], ["casi un kilo de pastor", "aproximado"], ["kilo y pico", "aproximado"],
    ["tacos de pastor", null], ["3 de pastor", null], ["", null], ["un kilo de pastor y medio kilo de arrachera", null],
  ] as const)("%s -> %s", (q, esperado) => {
    expect(pesoPedidoEnConsulta(q)).toBe(esperado);
  });
  it("contrato: lo que el registry manda con String(input.query ?? '') (0, '', null, false, [], {}) nunca lanza ni inventa peso", () => {
    for (const v of [0, "", null, undefined, false, [], {}]) expect(pesoPedidoEnConsulta(String(v ?? ""))).toBeNull();
  });
});

describe("contrato de entrada (revision): cualquier tipo basura da un resultado seguro, nunca TypeError", () => {
  const BASURA = [0, "", null, undefined, false, true, [], {}, 12, "x"];
  it("componerPeso con presentaciones que no son arreglo, o con elementos basura", () => {
    for (const b of BASURA) expect(componerPeso(1250, b), String(b)).toMatchObject({ tipo: "preguntar", motivo: "sin_presentaciones" });
    expect(componerPeso(1250, [null, 1, "x", {}, undefined])).toMatchObject({ tipo: "preguntar", motivo: "sin_presentaciones" });
  });
  it("composicionParaProducto con catalogo/nombre/gramos invalidos", () => {
    for (const b of BASURA) {
      if (!Array.isArray(b)) expect(composicionParaProducto(b, "Pastor — 1 kg", 1250), `catalogo ${String(b)}`).toBeNull();
      if (typeof b !== "string") expect(composicionParaProducto([], b, 1250), `nombre ${String(b)}`).toBeNull();
      else expect(() => composicionParaProducto([], b, 1250)).not.toThrow();
      expect(() => composicionParaProducto(pres("Pastor", 900), "Pastor — 1 kg", b)).not.toThrow();
    }
    expect(composicionParaProducto([null, 3, {}, { name: 5 }], "Pastor — 1 kg", 1250)).toMatchObject({ tipo: "preguntar" });
  });
  it("pesoPedidoEnConsulta, basePesoDeProducto y etiquetaDePeso", () => {
    for (const b of BASURA) {
      expect(pesoPedidoEnConsulta(b as never) === null || typeof b === "string").toBe(true);
      expect(typeof basePesoDeProducto(b)).toBe("string");
    }
    expect(etiquetaDePeso(null)).toBe("");
    expect(etiquetaDePeso(undefined)).toBe("");
    expect(etiquetaDePeso(Number.NaN)).toBe("");
    expect(etiquetaDePeso("250")).toBe("");
    expect(etiquetaDePeso(250)).toBe("250 g");
    expect(etiquetaDePeso(1500)).toBe("1.5 kg");
  });
});
