// PL-19 -- guard de formato unico con trinquete. Escanea el codigo real de presentacion: las llamadas a
// toLocale*String no pueden SUBIR (baseline en formato-unico-baseline.json, solo baja) y ninguna fija un locale
// distinto de es-MX. Para migrar una llamada: usa `formatMoney` / `resolverFormato` de `@atiende/ui` o
// `lib/formato-fecha.ts`; despues baja el baseline (nunca lo subas).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { archivosConLocaleAjeno, cargarFuentesRepo, totalToLocale } from "./test-utils/formato-unico-guard.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const raizRepo = path.resolve(here, "..", "..", "..");
const baseline = JSON.parse(readFileSync(path.join(here, "formato-unico-baseline.json"), "utf8")) as { toLocale: number };

describe("formato unico (PL-19)", () => {
  const fuentes = cargarFuentesRepo(raizRepo);

  it("el baseline es un entero valido y el escaneo encontro codigo (no pasa en vacio)", () => {
    expect(Number.isInteger(baseline.toLocale) && baseline.toLocale >= 0).toBe(true);
    expect(fuentes.length).toBeGreaterThan(100);
  });

  it("las llamadas a toLocale*String no suben por encima del baseline (usa el formateador canonico de @atiende/ui)", () => {
    const total = totalToLocale(fuentes);
    expect(total, `hay ${total} llamadas y el baseline es ${baseline.toLocale}: usa formatMoney/resolverFormato de @atiende/ui o lib/formato-fecha.ts en vez de agregar una nueva`).toBeLessThanOrEqual(baseline.toLocale);
  });

  it("cuando el numero baja, el baseline debe bajar con el (el piso solo desciende)", () => {
    const total = totalToLocale(fuentes);
    expect(baseline.toLocale - total, `bajaste a ${total} llamadas: baja formato-unico-baseline.json de ${baseline.toLocale} a ${total}`).toBeLessThanOrEqual(0);
  });

  it("ninguna llamada fija un locale distinto de es-MX (en-US, en, es-ES...)", () => {
    expect(archivosConLocaleAjeno(fuentes)).toEqual([]);
  });
});
