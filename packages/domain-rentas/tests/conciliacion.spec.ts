// Tests reales de la conciliación de payout (Fase 2, Flujo 6, alcance recortado) —
// matching determinista por referencia externa -> por monto exacto -> pendiente/
// discrepancia (ver diseño §1.4/§5 y finanzas/conciliacion.ts).
import { describe, expect, it } from "vitest";
import { conciliarPayout } from "../src/finanzas/conciliacion.ts";
import type { CandidataConciliacion, LineaPayoutEntrada } from "../src/finanzas/conciliacion.ts";

const candidatas: CandidataConciliacion[] = [
  { ocupacionId: "res-1", externalId: "AIRBNB-100", montoEsperadoCentavos: 500000 },
  { ocupacionId: "res-2", externalId: "AIRBNB-200", montoEsperadoCentavos: 300000 },
  { ocupacionId: "res-3", externalId: null, montoEsperadoCentavos: 700000 },
];

describe("conciliarPayout", () => {
  it("concilia por referencia externa cuando el monto coincide exacto", () => {
    const lineas: LineaPayoutEntrada[] = [{ referenciaExternaReserva: "AIRBNB-100", montoCentavos: 500000 }];
    const { lineas: resultado, resumen } = conciliarPayout(lineas, candidatas);
    expect(resultado[0]!.estado).toBe("conciliado");
    expect(resultado[0]!.ocupacionId).toBe("res-1");
    expect(resumen).toEqual({ conciliadas: 1, pendientes: 0, discrepancias: 0 });
  });

  it("discrepancia cuando la referencia coincide pero el monto NO -- nunca se fuerza a conciliado", () => {
    const lineas: LineaPayoutEntrada[] = [{ referenciaExternaReserva: "AIRBNB-100", montoCentavos: 499999 }];
    const { lineas: resultado, resumen } = conciliarPayout(lineas, candidatas);
    expect(resultado[0]!.estado).toBe("discrepancia");
    expect(resultado[0]!.ocupacionId).toBe("res-1"); // la identidad de la reserva SÍ se resuelve
    expect(resumen).toEqual({ conciliadas: 0, pendientes: 0, discrepancias: 1 });
  });

  it("sin referencia, concilia por monto exacto contra una candidata sin external_id", () => {
    const lineas: LineaPayoutEntrada[] = [{ referenciaExternaReserva: null, montoCentavos: 700000 }];
    const { lineas: resultado } = conciliarPayout(lineas, candidatas);
    expect(resultado[0]!.estado).toBe("conciliado");
    expect(resultado[0]!.ocupacionId).toBe("res-3");
  });

  it("pendiente cuando ninguna candidata coincide ni por referencia ni por monto -- nunca 'a ojo'", () => {
    const lineas: LineaPayoutEntrada[] = [{ referenciaExternaReserva: "DESCONOCIDA", montoCentavos: 999999 }];
    const { lineas: resultado, resumen } = conciliarPayout(lineas, candidatas);
    expect(resultado[0]!.estado).toBe("pendiente");
    expect(resultado[0]!.ocupacionId).toBeNull();
    expect(resumen).toEqual({ conciliadas: 0, pendientes: 1, discrepancias: 0 });
  });

  it("una candidata ya usada por una línea no puede volver a conciliar otra línea del mismo payout", () => {
    const lineas: LineaPayoutEntrada[] = [
      { referenciaExternaReserva: "AIRBNB-100", montoCentavos: 500000 },
      { referenciaExternaReserva: null, montoCentavos: 500000 }, // mismo monto que res-1, ya usada
    ];
    const { lineas: resultado, resumen } = conciliarPayout(lineas, candidatas);
    expect(resultado[0]!.estado).toBe("conciliado");
    expect(resultado[1]!.estado).toBe("pendiente"); // res-1 ya no está disponible
    expect(resumen).toEqual({ conciliadas: 1, pendientes: 1, discrepancias: 0 });
  });

  it("varias líneas resuelven cada una su propia candidata -- resumen agrega correctamente", () => {
    const lineas: LineaPayoutEntrada[] = [
      { referenciaExternaReserva: "AIRBNB-100", montoCentavos: 500000 }, // conciliado
      { referenciaExternaReserva: "AIRBNB-200", montoCentavos: 1 }, // discrepancia
      { referenciaExternaReserva: "NO-EXISTE", montoCentavos: 12345 }, // pendiente
    ];
    const { resumen } = conciliarPayout(lineas, candidatas);
    expect(resumen).toEqual({ conciliadas: 1, pendientes: 1, discrepancias: 1 });
  });
});
