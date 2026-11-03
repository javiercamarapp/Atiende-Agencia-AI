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

describe("hablarPendiente (P2-b)", () => {
  it("no consume el pendiente si la senal murio al terminar de hablarlo (sigue en la cola para el siguiente turno)", async () => {
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body)) as Peticion;
      await dormir(10);
      return new Response(JSON.stringify({ texto: "Su total es 80 pesos.", pedido_id: null, turno: b.seq }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new CerebroVozTurno({ url: "https://x.invalid/voz-turno", secreto: "s", callId: "llamada-123", telefono: "9991234567", fetchFn, esperar: async () => undefined, temporizador: () => () => undefined });
    const ctl = new AbortController();
    const p = c.turno("dos tacos", { senal: ctl.signal }).catch(() => "abort");
    await dormir(2);
    ctl.abort();
    await p;
    await dormir(20);
    // Senal que "muere" a la tercera lectura: viva al empezar a hablar, muerta al terminar.
    let lecturas = 0;
    const senal = { get aborted() { lecturas += 1; return lecturas >= 3; } } as unknown as AbortSignal;
    await c.hablarPendiente({ senal });
    const otra = await c.hablarPendiente();
    expect(otra?.texto).toBe("Como le decía, su total es 80 pesos.");
  });
});

