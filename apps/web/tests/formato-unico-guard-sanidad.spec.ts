// PL-19 -- sanidad del guard de formato unico: demuestra con fixtures que el conteo SI detecta una llamada nueva,
// ignora comentarios y las funciones de mayusculas, respeta los archivos canonicos y que el trinquete falla al subir.
import { describe, expect, it } from "vitest";
import { ARCHIVOS_CANONICOS, archivosConLocaleAjeno, contar, PATRON_TO_LOCALE, totalToLocale } from "./test-utils/formato-unico-guard.ts";

describe("sanidad del guard de formato unico", () => {
  it("cuenta cada variante de toLocale*String", () => {
    expect(contar("a.toLocaleString(); b.toLocaleDateString('es-MX'); c.toLocaleTimeString ( )", PATRON_TO_LOCALE)).toBe(3);
  });

  it("ignora comentarios y toLocaleLowerCase/UpperCase", () => {
    expect(contar("// x.toLocaleString()\n/* y.toLocaleDateString() */\ns.toLocaleLowerCase(); s.toLocaleUpperCase();", PATRON_TO_LOCALE)).toBe(0);
  });

  it("el trinquete FALLA si se agrega una llamada nueva: el total sube por encima de un baseline fijado", () => {
    const base = [{ ruta: "apps/web/src/pages/A.tsx", codigo: "const a = n.toLocaleString('es-MX');" }];
    const baseline = totalToLocale(base);
    const conNueva = [...base, { ruta: "apps/web/src/pages/B.tsx", codigo: "const b = m.toLocaleString('es-MX');" }];
    expect(baseline).toBe(1);
    expect(totalToLocale(conNueva)).toBeGreaterThan(baseline);
  });

  it("el trinquete permite bajar: migrar una llamada reduce el total", () => {
    const antes = [{ ruta: "apps/web/src/pages/A.tsx", codigo: "n.toLocaleString('es-MX'); m.toLocaleString('es-MX');" }];
    const despues = [{ ruta: "apps/web/src/pages/A.tsx", codigo: "formatMoney(n); m.toLocaleString('es-MX');" }];
    expect(totalToLocale(despues)).toBeLessThan(totalToLocale(antes));
  });

  it("los archivos canonicos no cuentan (son el formateador)", () => {
    const f = ARCHIVOS_CANONICOS.map((ruta) => ({ ruta, codigo: "v.toLocaleString('es-MX');" }));
    expect(totalToLocale(f)).toBe(0);
  });

  it("detecta un locale ajeno a es-MX (en-US, comillas simples o backticks) y acepta es-MX", () => {
    const fuentes = [
      { ruta: "a.ts", codigo: 'n.toLocaleString("en-US", { minimumFractionDigits: 2 })' },
      { ruta: "b.ts", codigo: "d.toLocaleDateString('es-ES')" },
      { ruta: "c.ts", codigo: "n.toLocaleString(`en`)" },
      { ruta: "d.ts", codigo: 'n.toLocaleString("es-MX", { maximumFractionDigits: 2 })' },
      { ruta: "e.ts", codigo: "n.toLocaleString(undefined)" },
      { ruta: "f.ts", codigo: 'new Date().toLocaleDateString("en-CA")' },
    ];
    expect(archivosConLocaleAjeno(fuentes)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});
