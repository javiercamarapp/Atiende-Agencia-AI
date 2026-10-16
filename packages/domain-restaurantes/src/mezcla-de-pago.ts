// Mezcla de pago y propinas (huecos-finales-restaurantes seccion 5.2, B-26): cuanto se vendio en efectivo, con tarjeta y
// por transferencia, y las propinas totales con tarjeta, para un periodo y una sucursal. Funcion PURA sobre filas de
// pedidos ya filtradas (sin cancelados, periodo y alcance de sucursal los fija quien lee). Es el nucleo de la herramienta
// `ventas_por_forma_de_pago(desde, hasta, sucursal?)` del copiloto y de la seccion del cierre del dia; ver el cuerpo del
// PR para la integracion pendiente (r42 y el catalogo del chat de datos).
import { redondearACentavos } from "./orders.ts";

export type FormaDePago = "efectivo" | "tarjeta" | "transferencia" | "sin_dato";

export interface FilaPago {
  /** Forma de pago tal como la guardo el pedido; cualquier valor no reconocido o null cuenta como "sin_dato". */
  readonly paymentMethod: string | null;
  /** Total cobrado del pedido (sin propina: la propina viaja aparte y no suma al total). */
  readonly total: number;
  /** Propina registrada en pesos, si hubo. */
  readonly propina: number | null;
}

export interface LineaMezclaPago {
  readonly forma: FormaDePago;
  readonly pedidos: number;
  readonly ventas: number;
  /** Porcentaje de las ventas totales (un decimal); 0 si no hay ventas. */
  readonly participacion: number;
}

export interface MezclaDePago {
  readonly lineas: readonly LineaMezclaPago[];
  readonly totalPedidos: number;
  readonly totalVentas: number;
  /** Propinas registradas en pedidos pagados con tarjeta. */
  readonly propinasTarjeta: number;
  /** Propinas registradas con otra forma de pago o sin dato (la politica de PM solo las admite con tarjeta: si aparece algo aqui, hay que revisarlo). */
  readonly propinasOtrasFormas: number;
}

const ORDEN: readonly FormaDePago[] = ["efectivo", "tarjeta", "transferencia", "sin_dato"];

function normalizarForma(valor: string | null): FormaDePago {
  return valor === "efectivo" || valor === "tarjeta" || valor === "transferencia" ? valor : "sin_dato";
}

/** Reparte las ventas por forma de pago y suma las propinas con tarjeta. Las formas sin pedidos se omiten. */
export function mezclaDePago(filas: readonly FilaPago[]): MezclaDePago {
  const acumulado = new Map<FormaDePago, { pedidos: number; ventas: number }>();
  let propinasTarjeta = 0;
  let propinasOtras = 0;
  for (const f of filas) {
    if (!Number.isFinite(f.total) || f.total < 0) continue;
    const forma = normalizarForma(f.paymentMethod);
    const a = acumulado.get(forma) ?? { pedidos: 0, ventas: 0 };
    a.pedidos += 1;
    a.ventas += f.total;
    acumulado.set(forma, a);
    const propina = f.propina !== null && Number.isFinite(f.propina) && f.propina > 0 ? f.propina : 0;
    if (forma === "tarjeta") propinasTarjeta += propina;
    else propinasOtras += propina;
  }
  const totalVentas = redondearACentavos([...acumulado.values()].reduce((n, a) => n + a.ventas, 0));
  const totalPedidos = [...acumulado.values()].reduce((n, a) => n + a.pedidos, 0);
  const lineas = ORDEN.filter((forma) => acumulado.has(forma)).map((forma) => {
    const a = acumulado.get(forma)!;
    return { forma, pedidos: a.pedidos, ventas: redondearACentavos(a.ventas), participacion: totalVentas > 0 ? Math.round((a.ventas / totalVentas) * 1000) / 10 : 0 };
  });
  return { lineas, totalPedidos, totalVentas, propinasTarjeta: redondearACentavos(propinasTarjeta), propinasOtrasFormas: redondearACentavos(propinasOtras) };
}
