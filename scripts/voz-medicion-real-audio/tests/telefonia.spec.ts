import { describe, expect, it } from "vitest";
import { lineaTelefonica, mezclarRuido, mulawDecode, mulawEncode, pasaBandaTelefonica, rms } from "../telefonia.ts";
import { rngDesdeSemilla } from "../../voz-medicion-real/ruido-stt.ts";

const seno = (hz: number, n: number, amp = 8000, fs = 16_000) => Float64Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / fs));

describe("mu-law G.711", () => {
  it("vectores conocidos", () => {
    expect(mulawEncode(0)).toBe(0xff);
    expect(mulawEncode(-1)).toBe(0x7f);
    expect(mulawDecode(0xff)).toBe(0);
    expect(mulawDecode(0x00)).toBe(-32124);
    expect(mulawDecode(0x80)).toBe(32124);
  });
  it("ida y vuelta: el error relativo es pequeno (cuantizacion logaritmica)", () => {
    for (const v of [-30000, -5000, -300, -20, 20, 300, 5000, 30000]) {
      const r = mulawDecode(mulawEncode(v));
      expect(Math.abs(r - v)).toBeLessThanOrEqual(Math.max(8, Math.abs(v) * 0.04));
      expect(Math.sign(r)).toBe(Math.sign(v));
    }
  });
  it("mulawDecode(mulawEncode(x)) es idempotente", () => { for (let v = -32000; v < 32000; v += 997) { const a = mulawDecode(mulawEncode(v)); expect(mulawDecode(mulawEncode(a))).toBe(a); } });
});

describe("banda telefonica", () => {
  it("deja pasar 1 kHz y atenua 100 Hz y 6 kHz", () => {
    const n = 16_000;
    const g = (hz: number) => rms(pasaBandaTelefonica(seno(hz, n), 16_000).slice(4000)) / rms(seno(hz, n).slice(4000));
    expect(g(1000)).toBeGreaterThan(0.85);
    expect(g(100)).toBeLessThan(0.15);
    expect(g(6000)).toBeLessThan(0.1);
  });
});

describe("ruido y cadena completa", () => {
  it("la SNR pedida se cumple (+-1.5 dB)", () => {
    const x = seno(500, 32_000); const y = mezclarRuido(x, 16_000, 20, rngDesdeSemilla("a"));
    const ruido = y.map((v, i) => v - x[i]!);
    expect(20 * Math.log10(rms(x) / rms(ruido))).toBeGreaterThan(18.5);
    expect(20 * Math.log10(rms(x) / rms(ruido))).toBeLessThan(21.5);
  });
  it("determinista con la misma semilla y conserva la longitud", () => {
    const pcm = Int16Array.from(seno(800, 8000));
    const a = lineaTelefonica(pcm, rngDesdeSemilla("s"), { snrDb: 20 }); const b = lineaTelefonica(pcm, rngDesdeSemilla("s"), { snrDb: 20 });
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.length).toBe(pcm.length);
    expect(Array.from(lineaTelefonica(pcm, rngDesdeSemilla("s")))).not.toEqual(Array.from(a));
  });
});
