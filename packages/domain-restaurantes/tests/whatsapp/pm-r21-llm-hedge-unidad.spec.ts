// PM-R21: el hedging de la llamada al modelo (`completarConHedging`) como unidad, con reloj simulado: gana la primera pata que conteste, la otra se aborta,
// ningun atasco pasa del limite y un error rapido del primario no lanza al alterno (la escalera del gateway ya lo manejo).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HEDGE_LLM_RETRASO_MIN_EFECTIVO_MS,
  hedgeLlmRetrasoEfectivoMs,
  completarConHedging,
  HEDGE_LLM_DESPUES_MIN_MS,
  HEDGE_LLM_DESPUES_MS_POR_OMISION,
  HedgeLlmFalloError,
  hedgeLlmDespuesMs,
} from "../../src/whatsapp/llm-hedge.ts";
import { esCancelacionDelLlamador } from "@atiende/agent-core";
import { TopeLlamadaLlmError } from "../../src/whatsapp/observabilidad-turno.ts";

let T0 = 0;
beforeEach(() => {
  vi.useFakeTimers();
  T0 = Date.now();
});
afterEach(() => void vi.useRealTimers());

/** Pata que contesta `valor` tras `ms` y se rechaza si la abortan (proveedor cooperativo). */
const tarda = (ms: number, valor: string, log: string[], nombre: string) => (signal: AbortSignal) =>
  new Promise<string>((resolve, reject) => {
    log.push(`${nombre}:inicio@${Date.now() - T0}`);
    const t = setTimeout(() => resolve(valor), ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      log.push(`${nombre}:abortada@${Date.now() - T0}`);
      reject(new Error("abortada"));
    });
  });
const nunca = (log: string[], nombre: string) => (signal: AbortSignal) =>
  new Promise<string>(() => {
    log.push(`${nombre}:inicio@${Date.now() - T0}`);
    signal.addEventListener("abort", () => log.push(`${nombre}:abortada@${Date.now() - T0}`));
  });

describe("PM-R21 hedging: configuracion", () => {
  it("APAGADO por omision (ausente o vacio); 0/off/false/no lo apagan; un numero >= 1500 lo enciende; invalido o bajo el piso lo deja apagado", () => {
    expect(hedgeLlmDespuesMs({})).toBeNull();
    expect(hedgeLlmDespuesMs({ WHATSAPP_LLM_HEDGE_MS: "  " })).toBeNull();
    for (const v of ["0", "off", "OFF", "false", "no"]) expect(hedgeLlmDespuesMs({ WHATSAPP_LLM_HEDGE_MS: v }), v).toBeNull();
    expect(hedgeLlmDespuesMs({ WHATSAPP_LLM_HEDGE_MS: String(HEDGE_LLM_DESPUES_MS_POR_OMISION) })).toBe(5500);
    expect(hedgeLlmDespuesMs({ WHATSAPP_LLM_HEDGE_MS: "4000" })).toBe(4000);
    expect(hedgeLlmDespuesMs({ WHATSAPP_LLM_HEDGE_MS: "abc" })).toBeNull();
    expect(hedgeLlmDespuesMs({ WHATSAPP_LLM_HEDGE_MS: String(HEDGE_LLM_DESPUES_MIN_MS - 1) })).toBeNull();
  });
  it("retraso efectivo: el configurado si sobra tiempo; si el presupuesto aprieta se adelanta para dejarle 3.5 s al alterno; con menos de ~7 s no hay hedging", () => {
    expect(hedgeLlmRetrasoEfectivoMs(18_000, 5_500)).toBe(5_500);
    expect(hedgeLlmRetrasoEfectivoMs(9_000, 5_500)).toBe(5_500);
    expect(hedgeLlmRetrasoEfectivoMs(8_000, 5_500)).toBe(4_500);
    expect(hedgeLlmRetrasoEfectivoMs(7_000, 5_500)).toBe(HEDGE_LLM_RETRASO_MIN_EFECTIVO_MS);
    expect(hedgeLlmRetrasoEfectivoMs(6_999, 5_500)).toBeNull();
    expect(hedgeLlmRetrasoEfectivoMs(0, 5_500)).toBeNull();
  });
});

describe("PM-R21 hedging: quien gana", () => {
  it("primario rapido (< retraso): contesta solo el primario y el alterno NUNCA se lanza (cero costo extra en el caso normal)", async () => {
    const log: string[] = [];
    const p = completarConHedging({ limiteMs: Date.now() + 18_000, hedgeDespuesMs: 5_500, primario: tarda(3_500, "P", log, "P"), alterno: tarda(1_000, "A", log, "A") });
    await vi.advanceTimersByTimeAsync(20_000);
    const r = await p;
    expect(r.valor).toBe("P");
    expect(r.ganador).toBe("primario");
    expect(r.alternoLanzado).toBe(false);
    expect(log.some((l) => l.startsWith("A:"))).toBe(false);
    expect(r.patas).toEqual([{ pata: "primario", resultado: "ok", ms: 3_500 }]);
  });

  it("primario atascado: a los 5.5 s se lanza el alterno EN PARALELO y su respuesta gana; el primario se aborta (no queda trabajando)", async () => {
    const log: string[] = [];
    const p = completarConHedging({ limiteMs: Date.now() + 18_000, hedgeDespuesMs: 5_500, primario: nunca(log, "P"), alterno: tarda(3_000, "A", log, "A") });
    await vi.advanceTimersByTimeAsync(20_000);
    const r = await p;
    expect(r.valor).toBe("A");
    expect(r.ganador).toBe("alterno");
    expect(r.alternoLanzado).toBe(true);
    expect(log).toContain("P:inicio@0");
    expect(log).toContain("A:inicio@5500");
    expect(log).toContain("P:abortada@8500");
    expect(r.patas.map((x) => [x.pata, x.resultado])).toEqual([["alterno", "ok"], ["primario", "cancelada"]]);
  });

  it("la pata perdedora se aborta con el motivo 'cancelada por el llamador' (el gateway no la cuenta como falla del proveedor); un tope NO lleva ese motivo", async () => {
    const senales: Record<string, AbortSignal> = {};
    const capturar = (n: string, ms: number) => (signal: AbortSignal) => {
      senales[n] = signal;
      return new Promise<string>((resolve) => void setTimeout(() => resolve(n), ms));
    };
    const p = completarConHedging({ limiteMs: Date.now() + 18_000, hedgeDespuesMs: 5_500, primario: capturar("P", 30_000), alterno: capturar("A", 1_000) });
    await vi.advanceTimersByTimeAsync(7_000);
    await p;
    expect(senales.P!.aborted).toBe(true);
    expect(esCancelacionDelLlamador(senales.P)).toBe(true);
    expect(senales.A!.aborted).toBe(false);
    // Tope del turno: ambas se abortan SIN motivo de cancelacion (cuenta contra el proveedor, como un atasco real).
    const s2: Record<string, AbortSignal> = {};
    const colgar = (n: string) => (signal: AbortSignal) => {
      s2[n] = signal;
      return new Promise<string>(() => undefined);
    };
    const q = completarConHedging({ limiteMs: Date.now() + 10_000, hedgeDespuesMs: 5_500, primario: colgar("P"), alterno: colgar("A") });
    const asercion = expect(q).rejects.toBeInstanceOf(HedgeLlmFalloError);
    await vi.advanceTimersByTimeAsync(10_001);
    await asercion;
    expect(s2.P!.aborted).toBe(true);
    expect(esCancelacionDelLlamador(s2.P)).toBe(false);
  });

  it("primario lento pero que contesta tras el retraso (7 s) gana a un alterno que tarda mas (4 s tras lanzarse): el alterno se aborta", async () => {
    const log: string[] = [];
    const p = completarConHedging({ limiteMs: Date.now() + 18_000, hedgeDespuesMs: 5_500, primario: tarda(7_000, "P", log, "P"), alterno: tarda(4_000, "A", log, "A") });
    await vi.advanceTimersByTimeAsync(20_000);
    const r = await p;
    expect(r.ganador).toBe("primario");
    expect(r.alternoLanzado).toBe(true);
    expect(log).toContain("A:abortada@7000");
  });

  it("el alterno falla con error y el primario termina contestando: gana el primario (un error del alterno no tumba el turno)", async () => {
    const p = completarConHedging<string>({
      limiteMs: Date.now() + 18_000,
      hedgeDespuesMs: 5_500,
      primario: tarda(8_000, "P", [], "P"),
      alterno: () => Promise.reject(Object.assign(new Error("OpenRouter 500"), { status: 500 })),
    });
    await vi.advanceTimersByTimeAsync(20_000);
    const r = await p;
    expect(r.valor).toBe("P");
    expect(r.patas.find((x) => x.pata === "alterno")?.resultado).toBe("error");
  });
});

describe("PM-R21 hedging: fallos", () => {
  it("ambas patas atascadas: rechaza al limite del turno con causa TopeLlamadaLlmError y aborta las dos", async () => {
    const log: string[] = [];
    const p = completarConHedging({ limiteMs: Date.now() + 18_000, hedgeDespuesMs: 5_500, primario: nunca(log, "P"), alterno: nunca(log, "A") });
    const asercion = expect(p).rejects.toMatchObject({ name: "HedgeLlmFalloError", alternoLanzado: true });
    await vi.advanceTimersByTimeAsync(20_000);
    await asercion;
    const e = (await p.catch((x: unknown) => x)) as HedgeLlmFalloError;
    expect(e.causa).toBeInstanceOf(TopeLlamadaLlmError);
    expect(log).toContain("P:abortada@18000");
    expect(log).toContain("A:abortada@18000");
    expect(e.patas.map((x) => x.resultado)).toEqual(["tope", "tope"]);
  });

  it("error RAPIDO del primario (antes del retraso): se propaga tal cual y el alterno no se lanza (la escalera del gateway ya probo los demas modelos)", async () => {
    const log: string[] = [];
    const err = Object.assign(new Error("OpenRouter 429"), { status: 429 });
    const p = completarConHedging({ limiteMs: Date.now() + 18_000, hedgeDespuesMs: 5_500, primario: () => Promise.reject(err), alterno: tarda(1_000, "A", log, "A") });
    const asercion = expect(p).rejects.toMatchObject({ name: "HedgeLlmFalloError", causa: err, alternoLanzado: false });
    await vi.advanceTimersByTimeAsync(20_000);
    await asercion;
    expect(log).toEqual([]);
  });

  it("primario atascado y alterno con 5xx: la causa visible es el tope (el modelo no contesto) y la pata alterna conserva su error", async () => {
    const p = completarConHedging<string>({
      limiteMs: Date.now() + 18_000,
      hedgeDespuesMs: 5_500,
      primario: nunca([], "P"),
      alterno: () => Promise.reject(Object.assign(new Error("OpenRouter 500"), { status: 500 })),
    });
    const asercion = expect(p).rejects.toMatchObject({ name: "HedgeLlmFalloError", alternoLanzado: true });
    await vi.advanceTimersByTimeAsync(20_000);
    await asercion;
    const e = (await p.catch((x: unknown) => x)) as HedgeLlmFalloError;
    // El primario vencio el limite del turno: la causa visible es el tope (el modelo no contesto) y la pata del alterno conserva su error.
    expect(e.causa).toBeInstanceOf(TopeLlamadaLlmError);
    expect(e.patas.find((x) => x.pata === "alterno")?.resultado).toBe("error");
  });

  it("un proveedor que IGNORA la senal de aborto tampoco pasa del limite", async () => {
    const p = completarConHedging({ limiteMs: Date.now() + 10_000, hedgeDespuesMs: 5_500, primario: () => new Promise<string>(() => undefined), alterno: () => new Promise<string>(() => undefined) });
    const asercion = expect(p).rejects.toBeInstanceOf(HedgeLlmFalloError);
    await vi.advanceTimersByTimeAsync(10_001);
    await asercion;
  });
});

describe("PM-R21 hedging: resolucion simultanea", () => {
  it("si las dos patas resuelven en el mismo tick gana una sola, la otra queda cancelada y el resultado se resuelve una vez", async () => {
    const p = completarConHedging({ limiteMs: Date.now() + 18_000, hedgeDespuesMs: 1_500, primario: () => new Promise<string>((r) => void setTimeout(() => r("P"), 2_000)), alterno: () => new Promise<string>((r) => void setTimeout(() => r("A"), 500)) });
    await vi.advanceTimersByTimeAsync(2_001);
    const r = await p;
    expect(["P", "A"]).toContain(r.valor);
    expect(r.patas.filter((x) => x.resultado === "ok")).toHaveLength(1);
    expect(r.patas.filter((x) => x.resultado === "cancelada")).toHaveLength(1);
  });

  it("al limite del turno el primario se aborta como falla real y el alterno como cancelacion (no se culpa al alterno recien lanzado)", async () => {
    const s: Record<string, AbortSignal> = {};
    const colgar = (n: string) => (signal: AbortSignal) => {
      s[n] = signal;
      return new Promise<string>(() => undefined);
    };
    const q = completarConHedging({ limiteMs: Date.now() + 8_000, hedgeDespuesMs: 4_500, primario: colgar("P"), alterno: colgar("A") });
    const asercion = expect(q).rejects.toBeInstanceOf(HedgeLlmFalloError);
    await vi.advanceTimersByTimeAsync(8_001);
    await asercion;
    expect(esCancelacionDelLlamador(s.P)).toBe(false);
    expect(esCancelacionDelLlamador(s.A)).toBe(true);
  });
});
