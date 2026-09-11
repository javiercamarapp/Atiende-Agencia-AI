import { describe, it, expect } from 'vitest';
import {
  calcularPerSeat,
  SEAT_HOTELES,
  SEAT_CITAS_RESERVACIONES,
  SEAT_RESTAURANTES,
  type SeatVerticalConfig,
} from '../src/index.ts';

describe('calcularPerSeat — funciona igual de bien para verticales distintos', () => {
  it('hoteles: cobra solo las habitaciones que exceden las incluidas en el plan', () => {
    // 5 incluidas, $89/habitación adicional.
    const r0 = calcularPerSeat(SEAT_HOTELES, 3); // por debajo del incluido
    expect(r0.seatsFacturables).toBe(0);
    expect(r0.totalMxn).toBe(0);

    const r1 = calcularPerSeat(SEAT_HOTELES, 12); // 12 - 5 incluidas = 7 facturables
    expect(r1.seatsFacturables).toBe(7);
    expect(r1.totalMxn).toBe(7 * 89);
    expect(r1.vertical).toBe('hoteles');
  });

  it('citas-reservaciones: cobra por doctor/proveedor con un mínimo de 1', () => {
    // Sin seats incluidos, mínimo facturable 1, $599/doctor.
    const r0 = calcularPerSeat(SEAT_CITAS_RESERVACIONES, 0); // el mínimo contractual aplica igual
    expect(r0.seatsFacturables).toBe(1);
    expect(r0.totalMxn).toBe(599);

    const r1 = calcularPerSeat(SEAT_CITAS_RESERVACIONES, 4);
    expect(r1.seatsFacturables).toBe(4);
    expect(r1.totalMxn).toBe(4 * 599);
    expect(r1.vertical).toBe('citas-reservaciones');
  });

  it('restaurantes: cobra por agente de voz activo con 1 incluido', () => {
    const r0 = calcularPerSeat(SEAT_RESTAURANTES, 1);
    expect(r0.seatsFacturables).toBe(0);

    const r1 = calcularPerSeat(SEAT_RESTAURANTES, 3);
    expect(r1.seatsFacturables).toBe(2);
    expect(r1.totalMxn).toBe(2 * 799);
  });

  it('las tres verticales calculan de forma consistente para el mismo número crudo de seats', () => {
    // El punto de "generalizable": el MISMO calculador, sin ifs por vertical,
    // produce resultados coherentes con la config de cada quien.
    const verticales: SeatVerticalConfig[] = [SEAT_HOTELES, SEAT_CITAS_RESERVACIONES, SEAT_RESTAURANTES];
    for (const v of verticales) {
      const r = calcularPerSeat(v, 10);
      expect(r.seatsActivos).toBe(10);
      expect(r.totalMxn).toBeCloseTo(r.seatsFacturables * v.precioPorSeatMxn, 2);
      expect(r.totalMxn).toBeGreaterThanOrEqual(0);
    }
  });

  it('rechaza un conteo de seats negativo o no finito (bug de conteo, no caso de negocio)', () => {
    expect(() => calcularPerSeat(SEAT_HOTELES, -1)).toThrow();
    expect(() => calcularPerSeat(SEAT_HOTELES, NaN)).toThrow();
  });
});
