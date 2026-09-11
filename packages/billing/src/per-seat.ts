// ═══════════════════════════════════════════════════════════════════════════
// MODELO PER-SEAT GENERALIZABLE
//
// "Seat" es intencionalmente abstracto: una habitación en hoteles, un agente
// de voz en restaurantes, un doctor/proveedor en citas-reservaciones, un
// despacho contable en despachos, una unidad en rentas, un usuario interno en
// licitaciones. El motor no sabe ni le importa qué es un seat para el
// vertical que lo usa — cada app declara su propio `SeatVerticalConfig` y el
// cálculo es el mismo para todas.
//
// Puerto conceptual del patrón per-doctor de atiende.ai
// (~/GitHub-repos-backup/atiende.ai/atiende-ai/src/lib/billing/per-doctor.ts,
// que hardcodeaba "doctor" como único seat) generalizado para que un seat sea
// cualquier unidad facturable por vertical, con seats incluidos en el plan
// base (no todos los verticales cobran seat 1 aparte) y un piso configurable.
// ═══════════════════════════════════════════════════════════════════════════

export interface SeatVerticalConfig {
  /** Slug del vertical — solo para trazabilidad en logs/reportes. */
  vertical: string;
  /** Cómo se llama un "seat" en este vertical, para mostrarlo en pantalla. */
  seatLabel: string;
  /** Precio mensual por seat facturable, en MXN. */
  precioPorSeatMxn: number;
  /**
   * Seats que YA vienen incluidos en el plan base y no se cobran aparte
   * (p. ej. "las primeras 3 habitaciones van en el plan Esencial"). `0` si
   * todos los seats se cobran.
   */
  seatsIncluidos?: number;
  /**
   * Piso de seats facturables aunque el tenant tenga menos activos (p. ej.
   * un mínimo contractual de 1 doctor). No compite con `seatsIncluidos`:
   * primero se restan los incluidos, y el resultado nunca baja de este piso.
   */
  minimoFacturable?: number;
}

export interface CalculoPerSeat {
  vertical: string;
  seatsActivos: number;
  seatsIncluidos: number;
  seatsFacturables: number;
  precioPorSeatMxn: number;
  totalMxn: number;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Calcula el cobro per-seat de un tenant para UN periodo.
 *
 * NO INVENTA SEATS NEGATIVOS: `seatsActivos` negativo o no finito es un error
 * de quien cuenta los seats (un COUNT mal filtrado, típicamente), no un caso
 * de negocio — se lanza en vez de facturar una cifra sin sentido.
 */
export function calcularPerSeat(config: SeatVerticalConfig, seatsActivos: number): CalculoPerSeat {
  if (!Number.isFinite(seatsActivos) || seatsActivos < 0) {
    throw new Error(
      `seatsActivos inválido (${seatsActivos}) para vertical '${config.vertical}': se esperaba un entero ≥ 0.`,
    );
  }
  if (!Number.isFinite(config.precioPorSeatMxn) || config.precioPorSeatMxn < 0) {
    throw new Error(`precioPorSeatMxn inválido para vertical '${config.vertical}'.`);
  }

  const incluidos = config.seatsIncluidos ?? 0;
  const minimo = config.minimoFacturable ?? 0;

  const sobreIncluidos = Math.max(seatsActivos - incluidos, 0);
  const facturables = Math.max(sobreIncluidos, minimo);

  return {
    vertical: config.vertical,
    seatsActivos,
    seatsIncluidos: incluidos,
    seatsFacturables: facturables,
    precioPorSeatMxn: config.precioPorSeatMxn,
    totalMxn: round2(facturables * config.precioPorSeatMxn),
  };
}

// ── Configuraciones de ejemplo para dos verticales distintos ───────────────
//
// Estas dos son las que ejercen los tests (calculo per-seat "funciona igual
// de bien para 2 verticales distintos"). Cualquier otra app del monorepo
// declara la suya sin tocar el motor.

/** Hoteles: el seat es la habitación activa en el inventario del tenant. */
export const SEAT_HOTELES: SeatVerticalConfig = {
  vertical: 'hoteles',
  seatLabel: 'habitación',
  precioPorSeatMxn: 89,
  seatsIncluidos: 5,
  minimoFacturable: 0,
};

/** Citas-reservaciones: el seat es el doctor/proveedor con agenda activa. */
export const SEAT_CITAS_RESERVACIONES: SeatVerticalConfig = {
  vertical: 'citas-reservaciones',
  seatLabel: 'doctor/proveedor',
  precioPorSeatMxn: 599,
  seatsIncluidos: 0,
  minimoFacturable: 1,
};

/** Restaurantes: el seat es el agente de voz activo por sucursal. */
export const SEAT_RESTAURANTES: SeatVerticalConfig = {
  vertical: 'restaurantes',
  seatLabel: 'agente de voz',
  precioPorSeatMxn: 799,
  seatsIncluidos: 1,
  minimoFacturable: 0,
};
