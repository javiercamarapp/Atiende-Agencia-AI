// L2b (14-oct, decision del dueno): el agente identifica las formas COLOQUIALES de decir el peso ("kilo y medio", "kilo y cuarto", "kilo 250", "1 kg 250 g",
// "mil doscientos cincuenta gramos"...) y arma lo que no es una presentacion con presentaciones reales al precio proporcional (1.25 kg de pastor = 1 kg + 250 g = $1,125).
// Corpus de 295 frases (fixtures/consultas-de-peso-coloquiales.json) contra el parser real, la busqueda real y buscar_producto sobre el menu de PM (sucursal T7 = garcia-lavin).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { pesoDeProductoEnGramos, tokenizeForProductSearch } from "../src/product-search.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

interface Fila {
  readonly q: string;
  /** gramos esperados; "c" = aproximado (peso:cualquiera); null = NO es peso. */
  readonly g: number | "c" | null;
  readonly nota?: string;
}
const corpus = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/consultas-de-peso-coloquiales.json"), "utf8")) as Fila[];
const { data, agent } = loadSeedInputs();
/** Frases con peso que HOY no devuelven nada, a proposito: la consulta trae texto ajeno al producto que ningun platillo contiene (el agente lo lee como "no lo encuentro" y pregunta). */
const SIN_RESULTADO_PERMITIDO = new Set<string>(["¿Me das un kilo y cuarto de pastor?", "Medio kilo de Pastor por favor", "un kilo 250 pesos de pastor"]);
const PRESENTACIONES = [250, 500, 750, 1000, 1500, 2000];
/** Precio del kilo de cada platillo en garcia-lavin (el menu vende las fracciones al precio proporcional exacto). */
const KILO: Readonly<Record<string, number>> = { Pastor: 900, "Bistec de Res": 1100, "Bistec de Res Encebollado": 1150, "Chuleta de Cerdo": 950, "Pechuga de Pollo": 950, "Poc-Chuc": 950, Arrachera: 1400, "Costilla de Res": 950 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-07T12:30:00-06:00"));
});
afterEach(() => vi.useRealTimers());

const gramosDetectados = (q: string): string[] => tokenizeForProductSearch(q).filter((t) => t.startsWith("peso:")).map((t) => t.slice(5));

interface Resultado {
  readonly name: string;
  readonly ambiguo?: boolean;
  readonly composicion_peso?: { tipo: string; gramos_pedidos: number | null; motivo?: string; total?: number; precio_proporcional?: number | null; proporcional?: boolean; frase?: string; partes?: Array<{ cantidad: number; gramos: number; subtotal: number; precio_unitario: number }> };
}
async function buscar(q: string, channel: "whatsapp" | "voz" = "whatsapp"): Promise<Resultado[]> {
  const w = await mundo;
  const ctx = { organizationId: w.organizationId, channel, phone: "9991234567", flow: { key: `k:${channel}`, turn: "1", now: () => Date.now() } };
  return (await invokeAgentTool(w.repo, ctx, "buscar_producto", { branch_slug: "garcia-lavin", query: q })).result as Resultado[];
}
const mundo = buildInMemoryPmWorld(buildPmSeedPlan(data, agent));

describe("corpus coloquial de pesos: gramos detectados por el parser real", () => {
  it("el corpus es amplio y cubre peso exacto, aproximado y NO-peso", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(120);
    expect(corpus.filter((f) => typeof f.g === "number").length).toBeGreaterThan(100);
    expect(corpus.filter((f) => f.g === "c").length).toBeGreaterThanOrEqual(8);
    expect(corpus.filter((f) => f.g === null).length).toBeGreaterThanOrEqual(25);
    expect(new Set(corpus.map((f) => f.q)).size).toBe(corpus.length);
  });

  it.each(corpus.map((f) => [f.q, f.g] as const))("%s -> %s", (q, g) => {
    const det = gramosDetectados(q);
    if (g === null) expect(det, `no es peso: ${tokenizeForProductSearch(q).join(" ")}`).toEqual([]);
    else expect(det).toEqual([g === "c" ? "cualquiera" : String(g)]);
  });
});

describe("corpus coloquial: lo que ve el agente en buscar_producto (busqueda + composicion)", () => {
  const pesos = corpus.filter((f): f is Fila & { g: number } => typeof f.g === "number" && f.nota !== "producto que no se vende por kilo: el peso se detecta, el resultado no inventa" && f.nota !== "producto inexistente" && !(f.nota ?? "").match(/^(contexto numerico|coma o contexto|la coma corta|.y algo|DECISION)/));

  it.each(pesos.map((f) => [f.q, f.g] as const))("%s (%d g)", async (q, g) => {
    const r = await buscar(q);
    const conPeso = r.filter((p) => pesoDeProductoEnGramos(p.name) !== null);
    // Una frase de peso valido NO puede quedar sin resultados en silencio; solo estas excepciones documentadas (basura alrededor o pesos menores a 250 g).
    if (r.length === 0) return expect(SIN_RESULTADO_PERMITIDO.has(q) || g < 250, `sin resultados: ${q}`).toBe(true);
    // menos de 250 g (100 g): ninguna presentacion cabe, vacio honesto (nunca una mayor)
    if (conPeso.length === 0) return expect(g).toBeLessThan(250);
    const pesosListados = conPeso.map((p) => pesoDeProductoEnGramos(p.name)!);
    if (PRESENTACIONES.includes(g)) {
      // presentacion exacta: solo esa, sin ambiguo y sin composicion
      expect(pesosListados.every((x) => x === g)).toBe(true);
      expect(conPeso.every((p) => p.ambiguo !== true && p.composicion_peso === undefined)).toBe(true);
      return;
    }
    // nunca una presentacion mayor a la pedida (cobraria de mas) y todo ambiguo
    expect(pesosListados.every((x) => x <= g)).toBe(true);
    expect(conPeso.every((p) => p.ambiguo === true)).toBe(true);
    for (const p of conPeso) {
      const c = p.composicion_peso;
      expect(c, p.name).toBeDefined();
      if (g % 250 === 0 && g <= 10000) {
        // composicion exacta: suma de gramos = lo pedido, precio = suma de presentaciones = proporcional, piezas minimas
        expect(c!.tipo).toBe("composicion");
        const partes = c!.partes!;
        expect(partes.reduce((a, x) => a + x.cantidad * x.gramos, 0)).toBe(g);
        expect(c!.total).toBe(partes.reduce((a, x) => a + x.cantidad * x.precio_unitario, 0));
        const base = p.name.replace(/\s—.*$/, "");
        expect(c!.total).toBeCloseTo((KILO[base]! * g) / 1000, 2);
        expect(c!.proporcional).toBe(true);
        expect(partes.reduce((a, x) => a + x.cantidad, 0)).toBeLessThanOrEqual(Math.ceil(g / 2000) + 2);
      } else {
        expect(c!.tipo).toBe("preguntar");
        expect(c!.motivo).toBe(g > 10000 ? "mas_del_tope" : "no_multiplo_de_250");
        expect(c!.total).toBeUndefined();
      }
    }
  });

  it.each(corpus.filter((f) => f.g === "c").map((f) => [f.q] as const))("aproximado '%s': todo ambiguo y la composicion es 'preguntar' (no se elige por el cliente)", async (q) => {
    const r = await buscar(q);
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((p) => p.ambiguo === true)).toBe(true);
    for (const p of r.filter((x) => pesoDeProductoEnGramos(x.name) !== null)) expect(p.composicion_peso).toMatchObject({ tipo: "preguntar", motivo: "cantidad_aproximada" });
  });

  it.each(corpus.filter((f) => f.g === null).map((f) => [f.q] as const))("negativo '%s': ningun producto lleva composicion_peso", async (q) => {
    const r = await buscar(q);
    expect(r.every((p) => p.composicion_peso === undefined)).toBe(true);
  });
});

describe("contexto numerico y comas (revision): el numero de contexto o lo que va despues de la coma NO se une a la unidad", () => {
  const compuesta = async (q: string) => (await buscar(q)).map((p) => p.composicion_peso).filter((c) => c !== undefined);
  it.each(["para las 3, kilo y cuarto de pastor", "a las 3 kilo y cuarto de pastor", "somos 4, kilo y cuarto de pastor", "mesa de 4 kilo y cuarto de pastor"])("%s: ninguna composicion de 3250 / 4250 g", async (q) => {
    for (const c of await compuesta(q)) expect([3250, 4250]).not.toContain(c!.gramos_pedidos);
    expect(gramosDetectados(q)).toEqual(["1250"]);
  });
  it.each(["mesa 3, kilo de pastor", "en la 5 un kilo de pastor"])("%s: 1 kg, no 3000 ni 5000", (q) => {
    expect(gramosDetectados(q)).toEqual(["1000"]);
  });
  it("la coma corta: 'un kilo, 250 de bistec' y 'pastor un kilo, 500 de bistec' son 1 kg (no 1.25 ni 1.5 kg) y nunca arman una composicion de 1250/1500", async () => {
    for (const q of ["un kilo, 250 de bistec", "pastor un kilo, 500 de bistec"]) {
      expect(gramosDetectados(q)).toEqual(["1000"]);
      for (const c of await compuesta(q)) expect([1250, 1500]).not.toContain(c!.gramos_pedidos);
    }
  });
});

describe("los pesos de ejemplo del dueno (A42 y compania) con la frase exacta que ve el modelo", () => {
  const FRASE: ReadonlyArray<readonly [string, string]> = [
    ["1250", "le armo 1 kg + 250 g de Pastor, $1,125"],
    ["1750", "le armo 1.5 kg + 250 g de Pastor, $1,575"],
    ["2250", "le armo 2 kg + 250 g de Pastor, $2,025"],
    ["2500", "le armo 2 kg + 500 g de Pastor, $2,250"],
    ["2750", "le armo 2 kg + 750 g de Pastor, $2,475"],
    ["3000", "le armo 2 kg + 1 kg de Pastor, $2,700"],
    ["3500", "le armo 2 kg + 1.5 kg de Pastor, $3,150"],
    ["3750", "le armo 2 kg + 1.5 kg + 250 g de Pastor, $3,375"],
    ["4000", "le armo 2 × 2 kg de Pastor, $3,600"],
    ["10000", "le armo 5 × 2 kg de Pastor, $9,000"],
  ];
  it.each(FRASE)("%s g de pastor arma la frase esperada", async (g, frase) => {
    for (const channel of ["whatsapp", "voz"] as const) {
      const r = await buscar(`${Number(g) / 1000} kg de pastor`, channel);
      expect(r.length).toBeGreaterThan(0);
      for (const p of r) expect(p.composicion_peso, p.name).toMatchObject({ tipo: "composicion", frase });
    }
  });
});

describe("de la busqueda al total: lo que dice la composicion es lo que cotiza el servidor", () => {
  it.each(["whatsapp", "voz"] as const)("%s: 'kilo y cuarto de pastor' trae la composicion, el aviso la manda decir antes del si, y cotizar las dos partes da 1125 pesos", async (channel) => {
    const w = await mundo;
    let turn = 1;
    const ctx = () => ({ organizationId: w.organizationId, channel, phone: "9991234567", flow: { key: `k:${channel}`, turn: String(turn), now: () => Date.now() } });
    const r = (await invokeAgentTool(w.repo, ctx(), "buscar_producto", { branch_slug: "garcia-lavin", query: "kilo y cuarto de pastor" })).result as Array<Resultado & { aviso_peso?: string }>;
    const kilo = r.find((p) => p.name === "Pastor — 1 kg")!;
    expect(kilo.aviso_peso).toMatch(/composicion_peso/);
    expect(kilo.aviso_peso).toMatch(/ANTES del sí/);
    expect(kilo.aviso_peso).toMatch(/tres cuartos = 750 g/);
    const partes = (kilo.composicion_peso as unknown as { partes: Array<{ product_id: string; name: string; cantidad: number }> }).partes;
    expect(partes.map((p) => p.name)).toEqual(["Pastor — 1 kg", "Pastor — 250 g"]);
    turn += 1;
    const q = (await invokeAgentTool(w.repo, ctx(), "cotizar_pedido", {
      branch_slug: "garcia-lavin",
      canal: "recoger",
      items: partes.map((p) => ({ product_id: p.product_id, product_name: p.name, requested_quantity: p.cantidad })),
    })).result as { quote: { total: number; lines: Array<{ name: string; line_total: number }> } };
    expect(q.quote.total).toBe(1125);
    expect(q.quote.lines.map((l) => [l.name, l.line_total])).toEqual([["Pastor — 1 kg", 900], ["Pastor — 250 g", 225]]);
  });
});

describe("regresion: 'son N' y 'de la N' con unidad pegada son la CANTIDAD del pedido, no mesa ni hora", () => {
  it.each([
    ["son 2 kilos de arrachera", "2000"],
    ["son 3 kilos de pastor", "3000"],
    ["ya son 2 kilos de pastor", "2000"],
    ["en total son 3 kilos de pastor", "3000"],
    ["de la 2 kilos de pastor", "2000"],
    ["son 2 kilos y medio de pastor", "2500"],
    ["son 500 gramos de pastor", "500"],
    ["son 3 kilo y cuarto de pastor", "3250"],
  ])("%s -> peso:%s", (q, g) => {
    expect(gramosDetectados(q)).toEqual([g]);
  });
  it("'son 3 tacos' no inventa peso y 'de la 2 quiero un kilo' conserva el kilo", () => {
    expect(gramosDetectados("son 3 tacos de pastor")).toEqual([]);
    expect(gramosDetectados("de la 2 quiero un kilo de pastor")).toEqual(["1000"]);
  });
  it("sigue sin romper mesa, hora y 'cuarto de hora'", () => {
    expect(gramosDetectados("mesa 4 kilo de pastor")).toEqual(["1000"]);
    expect(gramosDetectados("mesa de 4 kilo y cuarto de pastor")).toEqual(["1250"]);
    expect(gramosDetectados("a las 3 kilo y cuarto de pastor")).toEqual(["1250"]);
    expect(gramosDetectados("somos 4, kilo y cuarto de pastor")).toEqual(["1250"]);
    expect(gramosDetectados("en un cuarto de hora paso por un kilo de pastor")).toEqual(["1000"]);
  });
});
