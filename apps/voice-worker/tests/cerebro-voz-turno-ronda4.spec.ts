// Ronda 4 del ataque al cerebro suelto: version corta del pendiente sin perder datos ni despedirse, y pendiente que no se consume si la senal murio.
import { describe, expect, it } from "vitest";
import { CerebroSuelto } from "../src/cerebro-suelto.ts";
import { CerebroVozTurno, TEXTO_PENDIENTE, versionCortaDePendiente } from "../src/cerebro-voz-turno.ts";

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
interface Peticion { seq: number; texto: string }

describe("versionCortaDePendiente (P1, P2-a)", () => {
  it("P1: si el pendiente es solo una pregunta se repite la pregunta, nunca «Hasta luego.»", () => {
    const v = versionCortaDePendiente("¿Me confirma su dirección de entrega?");
    expect(v).toBe("¿Me confirma su dirección de entrega?");
    expect(v).not.toContain("Hasta luego");
  });
  it("P2-a: conserva total y folio (y todo lo que cabe en tres oraciones sin pregunta)", () => {
    const v = versionCortaDePendiente("Son dos tacos. Su total es trescientos veinte pesos. Su folio es A B C. ¿Algo más?");
    expect(v).toContain("total es trescientos veinte pesos");
    expect(v).toContain("folio es A B C");
  });
  it("P2-a: con mas de tres oraciones conserva las de datos (cifras, folio, pedido, numero) y descarta el relleno", () => {
    const v = versionCortaDePendiente("Perfecto. Anotado. Muy bien. Gracias. Su folio es A B C. Su pedido es el cuarenta y dos.");
    expect(v).toBe("Como le decía, su folio es A B C. Su pedido es el cuarenta y dos.");
  });
});

