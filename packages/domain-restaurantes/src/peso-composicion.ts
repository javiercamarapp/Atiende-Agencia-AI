// Composicion de un pedido por peso con las presentaciones REALES del menu (L2b, 14-oct). Decision del dueno: cuando el cliente pide un peso que NO es una presentacion
// del menu (1.25 kg de pastor), el agente arma la combinacion con presentaciones existentes (1 kg + 250 g = $900 + $225 = $1,125) al precio proporcional del menu, la dice
// ANTES del "si" y NO redondea a 1 o 1.5 kg. Solo se compone en multiplos de 250 g (la presentacion mas chica) hasta 10 kg; lo demas (1.3 kg, "kilo y poquito", 20 kg) se
// marca "preguntar": no se inventa un peso ni un precio.
import { pesoDeProductoEnGramos, tokenizeForProductSearch } from "./product-search.ts";

export const PASO_COMPOSICION_G = 250;
export const TOPE_COMPOSICION_G = 10000;

export interface PresentacionPeso {
  readonly id: string;
  readonly name: string;
  readonly price: number;
  readonly gramos: number;
}

export interface ParteComposicion {
  readonly cantidad: number;
  readonly product_id: string;
  readonly name: string;
  readonly gramos: number;
  readonly precio_unitario: number;
  readonly subtotal: number;
}

export type ComposicionPeso =
  | {
      readonly tipo: "composicion";
      readonly gramos_pedidos: number;
      readonly partes: readonly ParteComposicion[];
      readonly total: number;
      /** Precio del kilo del menu x gramos / 1000; null si el platillo no tiene presentacion de 1 kg. */
      readonly precio_proporcional: number | null;
      /** `total` coincide con el precio proporcional del menu (a menos de $1). */
      readonly proporcional: boolean;
      readonly frase: string;
      readonly instruccion: string;
    }
  | {
      readonly tipo: "preguntar";
      readonly gramos_pedidos: number | null;
      readonly motivo: "no_multiplo_de_250" | "mas_del_tope" | "cantidad_aproximada" | "sin_presentaciones" | "peso_invalido";
      readonly mensaje: string;
    };

const dinero = (n: number): string => {
  const r = Math.round(n * 100) / 100;
  const [entero, dec] = r.toFixed(2).split(".");
  const miles = entero!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${miles}${dec === "00" ? "" : `.${dec}`}`;
};
export const etiquetaDePeso = (g: number): string => (g >= 1000 ? `${g / 1000} kg` : `${g} g`);

/** Nombre del platillo sin el peso ("Pastor — 500 g" -> "Pastor"). */
export const basePesoDeProducto = (nombre: string): string => nombre.replace(/[—–-]\s*\d+(?:[.,]\d+)?\s*(?:kg|g|gr)\b.*$/i, "").trim();

/** `a` es mejor que `b`: menos piezas y, a igualdad, la que usa las piezas mas grandes primero (ambas ordenadas de mayor a menor). */
function esMejor(a: readonly number[], b: readonly number[] | null): boolean {
  if (!b || a.length !== b.length) return !b || a.length < b.length;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/** Combinacion con MENOS piezas (a igualdad, la que usa las presentaciones mas grandes) que suma exactamente `gramos`; null si no hay. */
function mejorCombinacion(gramos: number, gramosDisponibles: readonly number[]): number[] | null {
  const pasos = gramos / PASO_COMPOSICION_G;
  const piezas = gramosDisponibles.map((g) => g / PASO_COMPOSICION_G);
  const mejor: Array<number[] | null> = new Array(pasos + 1).fill(null);
  mejor[0] = [];
  for (let n = 1; n <= pasos; n++) {
    for (const p of piezas) {
      const previa = n - p >= 0 ? mejor[n - p] : null;
      if (!previa) continue;
      const candidata = [p, ...previa].sort((x, y) => y - x);
      if (esMejor(candidata, mejor[n]!)) mejor[n] = candidata;
    }
  }
  return mejor[pasos]?.map((p) => p * PASO_COMPOSICION_G) ?? null;
}

/** Arma `gramos` con las presentaciones dadas (todas del MISMO platillo). Una presentacion exacta no necesita composicion: devuelve una sola parte. */
export function componerPeso(gramos: unknown, presentaciones: readonly PresentacionPeso[]): ComposicionPeso {
  if (typeof gramos !== "number" || !Number.isFinite(gramos) || gramos <= 0 || !Number.isInteger(gramos)) {
    return { tipo: "preguntar", gramos_pedidos: null, motivo: "peso_invalido", mensaje: "No se entendió el peso: pregunte cuánto quiere (por ejemplo 1 kg, 1 kg y un cuarto)." };
  }
  if (gramos % PASO_COMPOSICION_G !== 0) {
    const abajo = Math.floor(gramos / PASO_COMPOSICION_G) * PASO_COMPOSICION_G;
    const arriba = abajo + PASO_COMPOSICION_G;
    const opciones = abajo > 0 ? `${etiquetaDePeso(abajo)} o ${etiquetaDePeso(arriba)}` : etiquetaDePeso(arriba);
    return {
      tipo: "preguntar",
      gramos_pedidos: gramos,
      motivo: "no_multiplo_de_250",
      mensaje: `${etiquetaDePeso(gramos)} no se arma con el menú (solo en cuartos de kilo, de 250 g en 250 g). NO invente ni redondee en silencio: pregunte si prefiere ${opciones}.`,
    };
  }
  if (gramos > TOPE_COMPOSICION_G) {
    return { tipo: "preguntar", gramos_pedidos: gramos, motivo: "mas_del_tope", mensaje: `${etiquetaDePeso(gramos)} es un pedido muy grande (más de ${etiquetaDePeso(TOPE_COMPOSICION_G)}): no lo arme solo, confirme la cantidad con el cliente.` };
  }
  const porGramos = new Map<number, PresentacionPeso>();
  for (const p of presentaciones) {
    if (!Number.isFinite(p.gramos) || !Number.isFinite(p.price) || p.price <= 0 || p.gramos <= 0 || p.gramos % PASO_COMPOSICION_G !== 0) continue;
    const previa = porGramos.get(p.gramos);
    if (!previa || p.price < previa.price) porGramos.set(p.gramos, p);
  }
  const combinacion = mejorCombinacion(gramos, [...porGramos.keys()]);
  if (!combinacion) return { tipo: "preguntar", gramos_pedidos: gramos, motivo: "sin_presentaciones", mensaje: `Con las presentaciones del menú no se puede armar ${etiquetaDePeso(gramos)}: pregunte qué prefiere entre las presentaciones listadas.` };
  const cuenta = new Map<number, number>();
  for (const g of combinacion) cuenta.set(g, (cuenta.get(g) ?? 0) + 1);
  const partes: ParteComposicion[] = [...cuenta.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([g, cantidad]) => {
      const p = porGramos.get(g)!;
      return { cantidad, product_id: p.id, name: p.name, gramos: g, precio_unitario: p.price, subtotal: Math.round(p.price * cantidad * 100) / 100 };
    });
  const total = Math.round(partes.reduce((a, p) => a + p.subtotal, 0) * 100) / 100;
  const kilo = porGramos.get(1000);
  const precioProporcional = kilo ? Math.round(((kilo.price * gramos) / 1000) * 100) / 100 : null;
  const base = basePesoDeProducto([...porGramos.values()][0]!.name);
  const piezas = partes.map((p) => (p.cantidad > 1 ? `${p.cantidad} × ${etiquetaDePeso(p.gramos)}` : etiquetaDePeso(p.gramos))).join(" + ");
  return {
    tipo: "composicion",
    gramos_pedidos: gramos,
    partes,
    total,
    precio_proporcional: precioProporcional,
    proporcional: precioProporcional !== null && Math.abs(total - precioProporcional) < 1,
    frase: partes.length === 1 && partes[0]!.cantidad === 1 ? `${etiquetaDePeso(gramos)} de ${base}, ${dinero(total)}` : `le armo ${piezas} de ${base}, ${dinero(total)}`,
    instruccion: "Dígale al cliente la composición y el total ANTES de que diga sí; cotice cada parte como un renglón con su cantidad. No redondee a otra presentación.",
  };
}

/** Composicion para el platillo `nombreProducto` (cualquiera de sus presentaciones) con el catalogo de la sucursal; null si el peso pedido ya es una presentacion exacta. */
export function composicionParaProducto(
  catalogo: ReadonlyArray<{ readonly id: string; readonly name: string; readonly price: number | string }>,
  nombreProducto: string,
  gramos: number | "aproximado",
): ComposicionPeso | null {
  if (gramos === "aproximado") {
    return { tipo: "preguntar", gramos_pedidos: null, motivo: "cantidad_aproximada", mensaje: "El cliente dio una cantidad aproximada («casi un kilo», «kilo y pico»): NO elija; pregúntele cuánto quiere exactamente entre las presentaciones." };
  }
  const base = basePesoDeProducto(nombreProducto).toLowerCase();
  const presentaciones = catalogo
    .map((c) => ({ id: c.id, name: c.name, price: Number(c.price), gramos: pesoDeProductoEnGramos(c.name) }))
    .filter((c): c is PresentacionPeso => c.gramos !== null && basePesoDeProducto(c.name).toLowerCase() === base);
  if (presentaciones.some((p) => p.gramos === gramos)) return null;
  return componerPeso(gramos, presentaciones);
}

/** Peso que pide la consulta del cliente: gramos exactos (una sola frase de peso), "aproximado" (casi un kilo...) o null si no pide peso o pide varios distintos. */
export function pesoPedidoEnConsulta(consulta: string): number | "aproximado" | null {
  const pesos = tokenizeForProductSearch(consulta).filter((t) => t.startsWith("peso:")).map((t) => t.slice(5));
  const distintos = [...new Set(pesos)];
  if (distintos.length !== 1) return null;
  if (distintos[0] === "cualquiera") return "aproximado";
  const g = Number(distintos[0]);
  return Number.isFinite(g) && g > 0 ? g : null;
}
