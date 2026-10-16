// CFO-04 · consolidación total vs. sucursales: total = Σ sucursales + «No asignado»; razones desde sumas; no aditivos nunca se suman.
import { describe, expect, it } from "vitest";
import {
  COLUMNAS_NO_ADITIVAS, ColumnaNoAditivaError, ErrorAditividad, consolidar, consolidarClientes, percentil, razonPct, textoMultiSucursal, verificarAditividad,
} from "../src/cfo/consolidar.ts";
import type { Consolidado } from "../src/cfo/consolidar.ts";
import { sumarVentas } from "../src/cfo/formulas.ts";
import type { FilaAgenteDiario, FilaClientesResumen, FilaVentasDiarias } from "../src/cfo/tipos.ts";
import { generarDatasetSintetico, mulberry32, SUCURSALES_PM_SINTETICAS } from "./fixtures/cfo-pm-sintetico.ts";

interface Fila { propertyId: string | null; pedidos: number; cancelados: number; neta: number | null }

const COLS = ["pedidos", "cancelados", "neta"] as const;

describe("consolidar: un renglón por sucursal, «No asignado» y total", () => {
  const filas: Fila[] = [
    { propertyId: "A", pedidos: 9, cancelados: 1, neta: 100 },
    { propertyId: "A", pedidos: 1, cancelados: 0, neta: 50 },
    { propertyId: "B", pedidos: 50, cancelados: 50, neta: 700 },
    { propertyId: null, pedidos: 0, cancelados: 0, neta: 30 },
  ];

  it("total = Σ sucursales + No asignado", () => {
    const c = consolidar(filas, { propertyId: "propertyId" }, COLS);
    expect(c.sucursales.map((s) => s.propertyId)).toEqual(["A", "B"]);
    expect(c.sucursales[0]!.valores).toEqual({ pedidos: 10, cancelados: 1, neta: 150 });
    expect(c.sucursales[1]!.valores).toEqual({ pedidos: 50, cancelados: 50, neta: 700 });
    expect(c.noAsignado.valores.neta).toBe(30);
    expect(c.noAsignado.valores.pedidos).toBe(0);
    expect(c.total.valores).toEqual({ pedidos: 60, cancelados: 51, neta: 880 });
    expect(c.total.filas).toBe(4);
  });

  it("una sola sucursal: total igual a la sucursal y «No asignado» vacío (null, no 0)", () => {
    const c = consolidar(filas.filter((f) => f.propertyId === "B"), { propertyId: "propertyId" }, COLS);
    expect(c.sucursales).toHaveLength(1);
    expect(c.total.valores).toEqual(c.sucursales[0]!.valores);
    expect(c.noAsignado.filas).toBe(0);
    expect(c.noAsignado.valores.neta).toBeNull();
  });

  it("sucursal sin datos aparece con valores null y filas 0, y no altera el total", () => {
    const c = consolidar(filas, { propertyId: "propertyId" }, COLS, { sucursales: ["A", "B", "C"] });
    const sinDatos = c.sucursales.find((s) => s.propertyId === "C")!;
    expect(sinDatos.filas).toBe(0);
    expect(sinDatos.valores).toEqual({ pedidos: null, cancelados: null, neta: null });
    expect(c.total.valores.neta).toBe(880);
  });

  it("cero filas: todo null (sin dato), nunca 0", () => {
    const c = consolidar([] as Fila[], { propertyId: "propertyId" }, COLS, { sucursales: ["A"] });
    expect(c.total.valores).toEqual({ pedidos: null, cancelados: null, neta: null });
  });

  it("el admin acotado no recibe «No asignado»: esas filas se descartan y no entran al total", () => {
    const c = consolidar(filas, { propertyId: "propertyId" }, COLS, { permitirNoAsignado: false });
    expect(c.noAsignado.filas).toBe(0);
    expect(c.total.valores.neta).toBe(850);
    expect(c.filasFueraDeAlcance).toBe(1);
  });

  it("filas de sucursales fuera de alcance se descartan", () => {
    const c = consolidar(filas, { propertyId: "propertyId" }, COLS, { sucursales: ["A"], permitirNoAsignado: false });
    expect(c.total.valores.neta).toBe(150);
    expect(c.filasFueraDeAlcance).toBe(2);
  });

  it("valores null en una columna: el total es parcial y se marca; todos null = sin dato", () => {
    const c = consolidar<Fila, "neta">(
      [{ propertyId: "A", pedidos: 1, cancelados: 0, neta: null }, { propertyId: "A", pedidos: 1, cancelados: 0, neta: 70 }, { propertyId: "B", pedidos: 1, cancelados: 0, neta: null }],
      { propertyId: "propertyId" }, ["neta"],
    );
    expect(c.sucursales[0]!.valores.neta).toBe(70);
    expect(c.sucursales[0]!.parciales).toEqual(["neta"]);
    expect(c.sucursales[1]!.valores.neta).toBeNull();
    expect(c.total.valores.neta).toBe(70);
  });

  it("negativos y devoluciones se suman con su signo", () => {
    const c = consolidar<Fila, "neta">([{ propertyId: "A", pedidos: 1, cancelados: 0, neta: 500 }, { propertyId: "A", pedidos: 0, cancelados: 0, neta: -120 }, { propertyId: "B", pedidos: 0, cancelados: 0, neta: -30 }], { propertyId: "propertyId" }, ["neta"]);
    expect(c.sucursales[0]!.valores.neta).toBe(380);
    expect(c.total.valores.neta).toBe(350);
  });

  it("duplicados exactos SE SUMAN: deduplicar es responsabilidad de SQL (una fila por llave); aquí no se adivina", () => {
    const f: Fila = { propertyId: "A", pedidos: 1, cancelados: 0, neta: 10 };
    expect(consolidar([f, f], { propertyId: "propertyId" }, ["neta"]).total.valores.neta).toBe(20);
  });

  it("un valor no numérico lanza", () => {
    expect(() => consolidar([{ propertyId: "A", neta: "x" }], { propertyId: "propertyId" }, ["neta"])).toThrow(TypeError);
  });
});

describe("columnas no aditivas", () => {
  it("consolidar se niega a sumar percentiles y conteos distintos", () => {
    const filas = [{ propertyId: "A", p90Min: 50, clientesConPedido: 10 }, { propertyId: "B", p90Min: 60, clientesConPedido: 20 }];
    expect(() => consolidar(filas, { propertyId: "propertyId" }, ["p90Min"])).toThrow(ColumnaNoAditivaError);
    expect(() => consolidar(filas, { propertyId: "propertyId" }, ["clientesConPedido"])).toThrow(/no aditivas/);
    for (const c of ["p50Min", "p90Min", "activos", "frecuentes", "nuevos", "multiSucursal", "diasEntrePedidosMediana"]) expect(COLUMNAS_NO_ADITIVAS.has(c)).toBe(true);
  });
  it("verificarAditividad también las rechaza", () => {
    const c = consolidar([{ propertyId: "A", neta: 1 }], { propertyId: "propertyId" }, ["neta"]);
    expect(() => verificarAditividad(c, ["p90Min" as never])).toThrow(ColumnaNoAditivaError);
  });
  it("el percentil del conjunto se calcula sobre los valores crudos, no promediando los de cada sucursal", () => {
    const a = [30, 31, 32, 33, 34, 35, 36, 37, 38, 90]; // p90 (nearest-rank, 9.º de 10) = 38
    const b = [50, 51, 52, 53, 54]; // p90 = 54
    expect(percentil(a, 90)).toBe(38);
    expect(percentil(b, 90)).toBe(54);
    const conjunto = percentil([...a, ...b], 90); // 14.º de 15 = 54
    expect(conjunto).toBe(54);
    expect(conjunto).not.toBe(Math.round((38 + 54) / 2)); // 46: el promedio de percentiles NO es el percentil del conjunto
    expect(percentil([], 90)).toBeNull();
    expect(() => percentil([1], 101)).toThrow(RangeError);
  });
});

describe("verificarAditividad", () => {
  it("lanza ErrorAditividad si el total no es Σ + No asignado", () => {
    const c = consolidar<Fila, "neta">([{ propertyId: "A", pedidos: 1, cancelados: 0, neta: 10 }, { propertyId: null, pedidos: 0, cancelados: 0, neta: 5 }], { propertyId: "propertyId" }, ["neta"]);
    const roto: Consolidado<"neta"> = { ...c, total: { ...c.total, valores: { neta: 999 } } };
    expect(() => verificarAditividad(roto)).toThrow(ErrorAditividad);
    expect(() => verificarAditividad(c)).not.toThrow();
  });
  it("detecta un total null cuando sí hay datos", () => {
    const c = consolidar<Fila, "neta">([{ propertyId: "A", pedidos: 1, cancelados: 0, neta: 10 }], { propertyId: "propertyId" }, ["neta"]);
    expect(() => verificarAditividad({ ...c, total: { ...c.total, valores: { neta: null } } })).toThrow(ErrorAditividad);
  });
});

describe("la razón consolidada es Σnum/Σden, NO el promedio de las razones", () => {
  it("caso explícito: 10 % y 50 % de cancelación no dan 30 %", () => {
    // Sucursal A: 9 pedidos + 1 cancelado -> 10 %. Sucursal B: 50 + 50 -> 50 %.
    const filas = [{ propertyId: "A", denominador: 10, cancelados: 1 }, { propertyId: "B", denominador: 100, cancelados: 50 }];
    const c = consolidar(filas, { propertyId: "propertyId" }, ["cancelados", "denominador"]);
    const a = razonPct(c.sucursales[0]!, "cancelados", "denominador");
    const b = razonPct(c.sucursales[1]!, "cancelados", "denominador");
    expect(a).toBe(10);
    expect(b).toBe(50);
    const promedioDeRazones = ((a ?? 0) + (b ?? 0)) / 2;
    const consolidada = razonPct(c.total, "cancelados", "denominador");
    expect(promedioDeRazones).toBe(30);
    expect(consolidada).toBe(46.4); // 51/110
    expect(consolidada).not.toBe(promedioDeRazones);
  });
  it("denominador 0 o ausente: null", () => {
    const c = consolidar([{ propertyId: "A", n: 0, d: 0 }], { propertyId: "propertyId" }, ["n", "d"]);
    expect(razonPct(c.total, "n", "d")).toBeNull();
    const c2 = consolidar([] as Array<{ propertyId: string; n: number; d: number }>, { propertyId: "propertyId" }, ["n", "d"], { sucursales: ["A"] });
    expect(razonPct(c2.sucursales[0]!, "n", "d")).toBeNull();
  });
});

describe("clientes únicos no se suman entre sucursales", () => {
  const base = (p: Partial<FilaClientesResumen>): FilaClientesResumen => ({
    propertyId: null, alcance: "sucursal", clientesConPedido: 0, nuevos: 0, recurrentes: 0, activos: 0, dormidos: 0, perdidos: 0, frecuentes: 0, multiSucursal: null, clientesVariasSucursales: null,
    recuperados: 0, recuperadosPorCampana: 0, activosAlInicio: 0, pasanAPerdidos: 0, pedidosConCliente: 0, pedidosSinCliente: 0, diasEntrePedidosMediana: null, netaTop10pctCentavos: 0, netaTotalCentavos: 0, pedidosPorCliente12mPromedio: null, ...p,
  });
  it("Σ sucursales − conjunto = multi-sucursal, con el texto «X compraron en más de una sucursal»", () => {
    const r = consolidarClientes([
      base({ propertyId: "A", clientesConPedido: 100 }),
      base({ propertyId: "B", clientesConPedido: 80 }),
      base({ alcance: "conjunto", clientesConPedido: 165, multiSucursal: 15 }),
    ]);
    expect(r.sumaClientesPorSucursal).toBe(180);
    expect(r.conjunto?.clientesConPedido).toBe(165); // NO 180
    expect(r.multiSucursal).toBe(15);
    expect(r.texto).toBe("15 clientes compraron en más de una sucursal");
  });
  it("el texto usa clientes_varias_sucursales (conteo exacto) cuando la SQL lo trae: Σ − conjunto cuenta k−1 por cliente de 3 o más sucursales", () => {
    const r = consolidarClientes([
      base({ propertyId: "A", clientesConPedido: 100 }),
      base({ propertyId: "B", clientesConPedido: 80 }),
      base({ propertyId: "C", clientesConPedido: 60 }),
      // Un cliente compró en las 3 sucursales y otro en 2: Σ − conjunto = 240 − 237 = 3, pero solo 2 clientes distintos.
      base({ alcance: "conjunto", clientesConPedido: 237, multiSucursal: 3, clientesVariasSucursales: 2 }),
    ]);
    expect(r.multiSucursal).toBe(3);
    expect(r.clientesVariasSucursales).toBe(2);
    expect(r.texto).toBe("2 clientes compraron en más de una sucursal");
  });
  it("si SQL declara un multi_sucursal que no cuadra, falla", () => {
    expect(() => consolidarClientes([base({ propertyId: "A", clientesConPedido: 100 }), base({ propertyId: "B", clientesConPedido: 80 }), base({ alcance: "conjunto", clientesConPedido: 165, multiSucursal: 99 })])).toThrow(ErrorAditividad);
  });
  it("un conjunto mayor que la suma es imposible", () => {
    expect(() => consolidarClientes([base({ propertyId: "A", clientesConPedido: 10 }), base({ propertyId: "B", clientesConPedido: 10 }), base({ alcance: "conjunto", clientesConPedido: 25 })])).toThrow(ErrorAditividad);
  });
  it("una sola sucursal: el conjunto es ella y multi = 0; varias sin conjunto: no se inventa", () => {
    const una = consolidarClientes([base({ propertyId: "A", clientesConPedido: 100 })]);
    expect(una.conjunto?.clientesConPedido).toBe(100);
    expect(una.multiSucursal).toBe(0);
    const dos = consolidarClientes([base({ propertyId: "A", clientesConPedido: 100 }), base({ propertyId: "B", clientesConPedido: 80 })]);
    expect(dos.conjunto).toBeNull();
    expect(dos.multiSucursal).toBeNull();
    expect(dos.texto).toBeNull();
  });
  it("concordancia del texto", () => {
    expect(textoMultiSucursal(0)).toBe("Ningún cliente compró en más de una sucursal");
    expect(textoMultiSucursal(1)).toBe("1 cliente compró en más de una sucursal");
    expect(textoMultiSucursal(1234)).toBe("1,234 clientes compraron en más de una sucursal");
    expect(textoMultiSucursal(null)).toBeNull();
  });
  it("con el dataset sintético: Σ sucursales − conjunto = multi-sucursal y es > 0", () => {
    const d = generarDatasetSintetico();
    const r = consolidarClientes(d.clientes);
    expect(r.multiSucursal).toBeGreaterThan(0);
    expect(r.sumaClientesPorSucursal - r.conjunto!.clientesConPedido).toBe(r.multiSucursal);
  });
});

// ---- Propiedades con datos aleatorios deterministas ----------------------------------------------------------------------------------------

const COLS_VENTAS = [
  "pedidos", "brutaCentavos", "descPromoCentavos", "descCompCentavos", "netaCentavos", "propinaCentavos", "cancelados", "canceladosCentavos", "noRecogidos", "noRecogidosCentavos",
  "reposiciones", "reposicionUnidades", "entregados", "entregaMinSuma", "entregaTarde",
] as const;

describe("propiedad: consolidado == Σ sucursales + No asignado (datos sintéticos de PM)", () => {
  const d = generarDatasetSintetico();

  it("para cada columna aditiva de cfo_ventas_diarias", () => {
    const c = consolidar<FilaVentasDiarias, (typeof COLS_VENTAS)[number]>(d.ventasDiarias, { propertyId: "propertyId" }, COLS_VENTAS);
    for (const col of COLS_VENTAS) {
      const suma = c.sucursales.reduce((s, r) => s + (r.valores[col] ?? 0), 0) + (c.noAsignado.valores[col] ?? 0);
      expect(c.total.valores[col]).toBe(suma);
      // y coincide con sumar directamente las filas (camino independiente)
      expect(Math.round((c.total.valores[col] ?? 0) * 100)).toBe(d.ventasDiarias.reduce((s, f) => s + Math.round(f[col] * 100), 0));
    }
    expect(c.sucursales).toHaveLength(7);
  });

  it("coincide con sumarVentas sobre las filas de cada sucursal", () => {
    const c = consolidar<FilaVentasDiarias, "netaCentavos" | "pedidos">(d.ventasDiarias, { propertyId: "propertyId" }, ["netaCentavos", "pedidos"]);
    for (const s of SUCURSALES_PM_SINTETICAS) {
      const directo = sumarVentas(d.ventasDiarias.filter((f) => f.propertyId === s.propertyId));
      const r = c.sucursales.find((x) => x.propertyId === s.propertyId)!;
      expect(r.valores.netaCentavos).toBe(directo.netaCentavos);
      expect(r.valores.pedidos).toBe(directo.pedidos);
    }
  });

  it("incluye el renglón «No asignado» del agente (LLM de la organización)", () => {
    const cols = ["costoVozCentavos", "costoTelefoniaCentavos", "costoLlmCentavos", "vozLlamadas", "waConversacionesNuevas"] as const;
    const c = consolidar<FilaAgenteDiario, (typeof cols)[number]>(d.agenteDiario, { propertyId: "propertyId" }, cols);
    expect(c.noAsignado.filas).toBeGreaterThan(0);
    expect(c.noAsignado.valores.costoLlmCentavos).toBeGreaterThan(0);
    expect(c.noAsignado.valores.costoVozCentavos).toBeNull(); // el LLM no trae voz
    for (const col of cols) {
      const suma = c.sucursales.reduce((s, r) => s + (r.valores[col] ?? 0), 0) + (c.noAsignado.valores[col] ?? 0);
      expect(c.total.valores[col]).toBe(suma);
    }
    // Meta sin eventos: jamás suma 0 como si fuera dato
    expect(consolidar<FilaAgenteDiario, "costoMetaCentavos">(d.agenteDiario, { propertyId: "propertyId" }, ["costoMetaCentavos"]).total.valores.costoMetaCentavos).toBeNull();
  });

  it("el orden de las filas no cambia nada (aleatorio determinista, 25 barajas)", () => {
    const ref = consolidar<FilaVentasDiarias, (typeof COLS_VENTAS)[number]>(d.ventasDiarias, { propertyId: "propertyId" }, COLS_VENTAS);
    const rnd = mulberry32(99);
    for (let i = 0; i < 25; i++) {
      const baraja = [...d.ventasDiarias];
      for (let j = baraja.length - 1; j > 0; j--) {
        const k = Math.floor(rnd() * (j + 1));
        [baraja[j], baraja[k]] = [baraja[k]!, baraja[j]!];
      }
      const c = consolidar<FilaVentasDiarias, (typeof COLS_VENTAS)[number]>(baraja, { propertyId: "propertyId" }, COLS_VENTAS);
      expect(c.total.valores).toEqual(ref.total.valores);
      expect(c.sucursales.map((s) => s.valores)).toEqual(ref.sucursales.map((s) => s.valores));
    }
  });
});

describe("propiedad: datos aleatorios con nulos, negativos y sucursales sin datos (300 casos deterministas)", () => {
  it("total == Σ sucursales + No asignado y, con alcance acotado, == Σ de las permitidas", () => {
    const rnd = mulberry32(2026);
    for (let caso = 0; caso < 300; caso++) {
      const nSuc = 1 + Math.floor(rnd() * 6);
      const ids = Array.from({ length: nSuc }, (_, i) => `S${i}`);
      const n = Math.floor(rnd() * 40);
      const filas = Array.from({ length: n }, () => {
        const r = rnd();
        return {
          propertyId: r < 0.15 ? null : ids[Math.floor(rnd() * ids.length)]!,
          a: rnd() < 0.2 ? null : Math.floor(rnd() * 20001) - 5000,
          b: Math.floor(rnd() * 1000),
        };
      });
      const c = consolidar(filas, { propertyId: "propertyId" }, ["a", "b"], { sucursales: ids });
      for (const col of ["a", "b"] as const) {
        const conDato = filas.filter((f) => f[col] != null);
        const esperado = conDato.length === 0 ? null : conDato.reduce((s, f) => s + (f[col] as number), 0);
        expect(c.total.valores[col]).toBe(esperado);
        const suma = [...c.sucursales, c.noAsignado].reduce((s, r) => s + (r.valores[col] ?? 0), 0);
        expect(c.total.valores[col] ?? 0).toBe(suma);
      }
      // acotado: sin «No asignado»
      const permitidas = ids.filter(() => rnd() < 0.6);
      const ac = consolidar(filas, { propertyId: "propertyId" }, ["a"], { sucursales: permitidas, permitirNoAsignado: false });
      const esperadoAc = filas.filter((f) => f.propertyId !== null && permitidas.includes(f.propertyId) && f.a != null);
      expect(ac.total.valores.a).toBe(esperadoAc.length === 0 ? null : esperadoAc.reduce((s, f) => s + (f.a as number), 0));
      expect(ac.noAsignado.filas).toBe(0);
    }
  });
});
