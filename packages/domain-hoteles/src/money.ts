// Port literal de hoteles/packages/domain-hotel/src/money.ts (H4). Redondeo monetario
// consistente (2 decimales, MXN/USD): centraliza el único punto donde el motor de
// cotización/folio redondea, para que sumar N noches/cargos redondeados por separado y
// luego redondear el total no diverja del redondeo hecho en un solo paso.
export function roundCurrency(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

// Unidad menor de la moneda (centavos MXN/USD), tipada aparte de los pesos. Todo el
// paquete maneja montos en PESOS con 2 decimales (igual que `hoteles.payment.amount
// numeric(12,2)`); un procesador de pagos cobra en CENTAVOS enteros. La marca de tipo
// impide pasar un `number` de pesos donde se esperan centavos: la única forma de
// obtener `Centavos` es `pesosACentavos()` (o `centavos()` para un entero ya en esa
// unidad, p. ej. en pruebas).
declare const CENTAVOS: unique symbol;
export type Centavos = number & { readonly [CENTAVOS]: true };

/** Error de validación de un monto que no es representable en centavos exactos. */
export class MontoInvalidoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MontoInvalidoError";
  }
}

/** Marca un entero no negativo como centavos. Lanza si no es entero seguro. */
export function centavos(value: number): Centavos {
  if (!Number.isSafeInteger(value) || value < 0) throw new MontoInvalidoError(`centavos: se esperaba un entero no negativo, llegó ${value}.`);
  return value as Centavos;
}

/** Convierte pesos (máx. 2 decimales) a centavos enteros. Tolera el ruido binario de
 *  punto flotante (0.1 + 0.2, 19.99) pero RECHAZA un tercer decimal real (10.005): un
 *  cobro nunca se redondea en silencio a un monto distinto del que se registra. */
export function pesosACentavos(pesos: number): Centavos {
  if (typeof pesos !== "number" || !Number.isFinite(pesos) || pesos < 0) {
    throw new MontoInvalidoError(`pesosACentavos: se esperaba un número finito no negativo, llegó ${pesos}.`);
  }
  const escalado = pesos * 100;
  const entero = Math.round(escalado);
  if (Math.abs(escalado - entero) > 1e-6) throw new MontoInvalidoError(`pesosACentavos: ${pesos} tiene más de 2 decimales.`);
  return centavos(entero);
}
