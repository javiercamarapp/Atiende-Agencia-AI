// Tope de gasto DURO del arnes: se acumula el costo real (usage.cost) de cada llamada, incluidas las del juez, y
// ANTES de cada llamada se exige que quepa una reserva. Al agotarse lanza TopeDeGastoError: el runner aborta la
// corrida y reporta los casos no corridos. (El gateway de produccion NO se usa aqui: este tope es del arnes.)
export class TopeDeGastoError extends Error {
  constructor(readonly gastoUsd: number, readonly maxUsd: number) {
    super(`tope de gasto alcanzado: ${gastoUsd.toFixed(4)} de ${maxUsd.toFixed(2)} USD`);
    this.name = "TopeDeGastoError";
  }
}

export class PresupuestoDuro {
  private gasto = 0;
  private porModelo = new Map<string, number>();
  private enVuelo = 0;

  constructor(
    readonly maxUsd: number,
    /** Reserva por llamada en vuelo: el peor caso razonable de UNA llamada (por defecto 2 centavos). */
    readonly reservaUsd = 0.02,
  ) {
    if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error("el tope de gasto debe ser un numero positivo");
  }

  get gastoUsd(): number {
    return this.gasto;
  }

  gastoDe(modelo: string): number {
    return this.porModelo.get(modelo) ?? 0;
  }

  get agotado(): boolean {
    return this.gasto >= this.maxUsd;
  }

  /** Llamar justo antes de gastar; devuelve la funcion que registra el costo real al terminar (o cancela). */
  reservar(modelo: string): { liberar(costoUsd: number): void } {
    if (this.gasto + (this.enVuelo + 1) * this.reservaUsd > this.maxUsd) throw new TopeDeGastoError(this.gasto, this.maxUsd);
    this.enVuelo += 1;
    let liberada = false;
    return {
      liberar: (costoUsd: number) => {
        if (liberada) return;
        liberada = true;
        this.enVuelo -= 1;
        const c = Number.isFinite(costoUsd) && costoUsd > 0 ? costoUsd : 0;
        this.gasto += c;
        this.porModelo.set(modelo, (this.porModelo.get(modelo) ?? 0) + c);
      },
    };
  }
}
