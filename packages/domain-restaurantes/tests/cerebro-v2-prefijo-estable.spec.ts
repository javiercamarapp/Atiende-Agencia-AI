// Cerebro v2 (latencia y costo): la fecha y hora iba en el caracter ~414 de un prompt de ~60 mil: el prefijo cambiaba cada minuto y la cache automatica del proveedor (Luna por
// Azure, solo PREFIJOS identicos) nunca acertaba. `buildSystemPrompt(..., prefijoEstable = true)` (lo pasa el turno con cerebro v2) deja el reloj al final.
import { describe, expect, it } from "vitest";
import { PM_CONFIG_POR_OMISION, buildSystemPrompt } from "../src/whatsapp/llm-turn-handler.ts";

const prefijoComun = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i;
};

describe("prompt PM con prefijo estable", () => {
  it("con prefijoEstable, dos turnos a distinta hora comparten casi todo el prompt", () => {
    const a = buildSystemPrompt(PM_CONFIG_POR_OMISION, [], { isNew: true }, new Date("2026-11-07T13:00:00-06:00"), null, "", "", false, true);
    const b = buildSystemPrompt(PM_CONFIG_POR_OMISION, [], { isNew: true }, new Date("2026-11-07T19:41:00-06:00"), null, "", "", false, true);
    expect(prefijoComun(a, b) / a.length).toBeGreaterThan(0.9);
    expect(a).not.toBe(b); // el reloj sigue en el prompt (al final); el formato de la hora depende del ICU del entorno
  });
  it("sin la opcion (y sin la variable de entorno) el prompt es el de siempre", () => {
    const a = buildSystemPrompt(PM_CONFIG_POR_OMISION, [], { isNew: true }, new Date("2026-11-07T13:00:00-06:00"));
    const b = buildSystemPrompt(PM_CONFIG_POR_OMISION, [], { isNew: true }, new Date("2026-11-07T19:41:00-06:00"));
    expect(prefijoComun(a, b)).toBeLessThan(1000);
  });
});
