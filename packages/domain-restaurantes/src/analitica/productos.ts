// Analítica del dueño · PRODUCTOS y COMBOS (puro). Margen solo con costo capturado; afinidad por pares con soporte, confianza y lift; cada par se marca
// «en el menú» (existe una promoción de cortesía vigente que lo une) o «no existe como combo» (oportunidad). Nunca se inventa un combo.
import { pct } from "./ratios.ts";
import type { ParCrudo, ProductoCrudo, ProductosCrudo } from "./tipos.ts";

export const MIN_PEDIDOS_PAR = 5;

export interface ProductoVista extends ProductoCrudo {
  readonly precioPromedioCentavos: number | null;
  readonly margenPct: number | null;
  readonly sinCosto: boolean;
}
export interface ParVista extends ParCrudo {
  /** juntos ÷ pedidos de la sucursal. */
  readonly soportePct: number | null;
  /** juntos ÷ pedidos con A. */
  readonly confianzaAB: number | null;
  /** juntos ÷ pedidos con B. */
  readonly confianzaBA: number | null;
  /** juntos × total ÷ (pedidos con A × pedidos con B). > 1 = se piden juntos más de lo que daría el azar. */
  readonly lift: number | null;
  readonly estado: "en_menu" | "oportunidad";
}
export interface ProductosVista {
  readonly productos: readonly ProductoVista[];
  readonly pares: readonly ParVista[];
  readonly oportunidades: readonly ParVista[];
  readonly costosCargados: number;
  readonly margenDisponible: boolean;
}

export function construirProductos(c: ProductosCrudo): ProductosVista {
  const productos: ProductoVista[] = c.productos.map((p) => ({
    ...p,
    precioPromedioCentavos: p.unidades > 0 ? Math.round(p.ingresoCentavos / p.unidades) : null,
    margenPct: p.margenCentavos !== null && p.ingresoCentavos > 0 ? pct(p.margenCentavos, p.ingresoCentavos) : null,
    sinCosto: p.costoUnitarioCentavos === null,
  }));
  const pares: ParVista[] = c.pares
    .filter((p) => p.juntos >= MIN_PEDIDOS_PAR)
    .map((p) => ({
      ...p,
      soportePct: pct(p.juntos, p.pedidosTotal),
      confianzaAB: pct(p.juntos, p.pedidosA),
      confianzaBA: pct(p.juntos, p.pedidosB),
      lift: p.pedidosA > 0 && p.pedidosB > 0 ? Math.round(((p.juntos * p.pedidosTotal) / (p.pedidosA * p.pedidosB)) * 100) / 100 : null,
      estado: p.enMenu ? ("en_menu" as const) : ("oportunidad" as const),
    }))
    .sort((a, b) => b.juntos - a.juntos || (a.productoA < b.productoA ? -1 : 1));
  return { productos, pares, oportunidades: pares.filter((p) => p.estado === "oportunidad"), costosCargados: c.costosCargados, margenDisponible: productos.some((p) => p.margenCentavos !== null) };
}
