// Topes de gasto del banco, reutilizando las guardas de #696 (`parseCorte`, `excedeTope`, `sumarCosto`, `TopeExcedido`): fallan CERRADO (un costo NaN, negativo o indefinido corta).
// Capas aqui: por llamada (`topeLlamadaUsd`) y por corrida (`corteUsd`). El libro por proveedor/dia con reserva previa y la lista de salida de red son tareas posteriores.
import { AbortoDeSeguridad, TopeExcedido, excedeTope, parseCorte, sumarCosto } from "../voz-medicion-real/guardas.ts";

export { AbortoDeSeguridad, TopeExcedido };

/** El banco baja el maximo por omision de VOZ_CORTE_USD a 25 (BANCO-DE-PRUEBAS 3.6); subirlo exige VOZ_CORTE_MAX_USD explicito. */
export const CORTE_MAXIMO_BANCO_USD = 25;

export function corteDeEntorno(env: Record<string, string | undefined>): number {
  return parseCorte(env["VOZ_CORTE_USD"], env["VOZ_CORTE_MAX_USD"] ?? String(CORTE_MAXIMO_BANCO_USD));
}

/** La llamada rebaso su propio tope: se cierra y se marca `tope_llamada`; NO detiene la corrida. */
export class TopeDeLlamada extends Error {
  constructor(readonly gastoUsd: number, readonly topeUsd: number) {
    super(`tope por llamada alcanzado: $${gastoUsd.toFixed(4)} >= $${topeUsd}`);
    this.name = "TopeDeLlamada";
  }
}

export class TopeGasto {
  private cerradoUsd = 0;
  private llamadaUsd = 0;

  constructor(readonly corteUsd: number, readonly topeLlamadaUsd: number) {
    // El constructor no acepta un tope invalido: nunca / siempre disparar serian fallas silenciosas.
    for (const [k, v] of [["corteUsd", corteUsd], ["topeLlamadaUsd", topeLlamadaUsd]] as const) {
      if (!Number.isFinite(v) || v <= 0) throw new AbortoDeSeguridad(`${k} invalido: debe ser un numero finito mayor que 0`);
    }
  }

  get gastoUsd(): number {
    return this.cerradoUsd + this.llamadaUsd;
  }

  iniciarLlamada(): void {
    this.llamadaUsd = 0;
  }

  /** Cierra la llamada en curso y la pasa al acumulado (aun si el costo quedo NaN: el NaN se arrastra y la corrida corta). */
  cerrarLlamada(): void {
    this.cerradoUsd += this.llamadaUsd;
    this.llamadaUsd = 0;
  }

  /** Suma un costo en micro-USD a la llamada en curso. Un valor no numerico o negativo vuelve el gasto NaN (corta). */
  registrarMicroUsd(micro: unknown): void {
    this.llamadaUsd = sumarCosto(this.llamadaUsd, typeof micro === "number" ? micro / 1e6 : micro);
  }

  /** Lanza `TopeExcedido` (corrida) o `TopeDeLlamada` (llamada). Primero la corrida: es la que no se puede continuar. */
  verificar(): void {
    if (excedeTope(this.gastoUsd, this.corteUsd)) throw new TopeExcedido(this.gastoUsd, this.corteUsd);
    if (excedeTope(this.llamadaUsd, this.topeLlamadaUsd)) throw new TopeDeLlamada(this.llamadaUsd, this.topeLlamadaUsd);
  }
}
