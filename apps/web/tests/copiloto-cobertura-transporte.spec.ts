// `coverage` del motor -> cobertura de la UI: solo enteros coherentes (1..50 consultadas, 0..consultadas con datos); lo demas se descarta.
import { describe, expect, it } from "vitest";
import { coberturaDe, normalizarRespuesta } from "../src/lib/copiloto/transporte.ts";

describe("cobertura de fuentes en el transporte", () => {
  it("traduce { consulted, withData } y la deja en la respuesta normalizada", () => {
    expect(coberturaDe({ consulted: 3, withData: 2 })).toEqual({ conDatos: 2, consultadas: 3 });
    expect(normalizarRespuesta({ status: "ok", text: "x", coverage: { consulted: 1, withData: 1 } }).cobertura).toEqual({ conDatos: 1, consultadas: 1 });
  });

  it("descarta formas imposibles o ausentes", () => {
    for (const raw of [undefined, null, {}, { consulted: 0, withData: 0 }, { consulted: 2, withData: 3 }, { consulted: 1.5, withData: 1 }, { consulted: "3", withData: 2 }, { consulted: 99, withData: 1 }]) {
      expect(coberturaDe(raw)).toBeUndefined();
    }
    expect(normalizarRespuesta({ status: "ok", text: "x" }).cobertura).toBeUndefined();
  });
});
