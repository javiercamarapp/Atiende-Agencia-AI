// i18n ES/EN: `traducir` (sin React) y `crearFormatos`. Lo que promete el nucleo: interpolacion, plurales por Intl.PluralRules,
// respaldo al espanol y formato es-MX / en-US de numeros, dinero, porcentajes y fechas.
import { beforeAll, describe, expect, it } from "vitest";
import { crearFormatos } from "../src/i18n/formato.ts";
import { comun } from "../src/i18n/mensajes/comun.ts";
import { registrarModuloEs } from "../src/i18n/mensajes/index.ts";

registrarModuloEs(comun);
import { cargarIdioma, idiomaListo, type Clave } from "../src/i18n/mensajes/index.ts";
import { crearTraductor, traducir } from "../src/i18n/traducir.ts";

describe("carga perezosa del ingles", () => {
  it("antes de cargar, el ingles cae al espanol (nunca una clave cruda); despues, ingles", async () => {
    if (!idiomaListo("en")) expect(traducir("en", "comun.reintentar")).toBe("Reintentar");
    await cargarIdioma("en");
    await cargarIdioma("en");
    expect(idiomaListo("en")).toBe(true);
    expect(traducir("en", "comun.reintentar")).toBe("Try again");
  });
});

describe("traducir", () => {
  beforeAll(() => cargarIdioma("en"));

  it("devuelve el texto del idioma pedido", () => {
    expect(traducir("es", "comun.reintentar")).toBe("Reintentar");
    expect(traducir("en", "comun.reintentar")).toBe("Try again");
  });

  it("elige el plural con Intl.PluralRules y formatea el numero de {count}", () => {
    expect(traducir("es", "comun.resultados", { count: 1 })).toBe("1 resultado");
    expect(traducir("es", "comun.resultados", { count: 0 })).toBe("0 resultados");
    expect(traducir("en", "comun.resultados", { count: 1 })).toBe("1 result");
    expect(traducir("en", "comun.resultados", { count: 1234 })).toBe("1,234 results");
    // Espanol byte a byte igual al texto que reemplaza: el numero sin agrupar.
    expect(traducir("es", "comun.resultados", { count: 1234 })).toBe("1234 resultados");
  });

  it("sin count un plural cae a `other`", () => {
    expect(traducir("en", "comun.resultados")).toBe("{count} results");
  });

  it("una clave que no existe (solo posible con un cast) se ve tal cual en vez de dejar un hueco", () => {
    expect(traducir("en", "no.existe" as Clave)).toBe("no.existe");
  });

  it("crearTraductor fija el idioma", () => {
    const t = crearTraductor("en");
    expect(t("comun.cancelar")).toBe("Cancel");
  });
});

describe("crearFormatos", () => {
  const es = crearFormatos("es");
  const en = crearFormatos("en");
  const fecha = new Date(Date.UTC(2026, 10, 6, 18, 5));

  it("locale por idioma", () => {
    expect(es.locale).toBe("es-MX");
    expect(en.locale).toBe("en-US");
  });

  it("numeros con separador de miles en los dos idiomas", () => {
    expect(es.numero(1234567.5)).toBe("1,234,567.5");
    expect(en.numero(1234567.5)).toBe("1,234,567.5");
  });

  it("dinero con simbolo corto, sin «MX$» en ingles", () => {
    expect(es.moneda(1234.5)).toBe("$1,234.50");
    expect(en.moneda(1234.5)).toBe("$1,234.50");
    expect(en.moneda(1234.5, { decimales: 0 })).toBe("$1,235");
    expect(en.moneda(10, { moneda: "USD" }).replace(/\s/g, " ")).toBe("USD 10.00");
    expect(es.moneda(10, { moneda: "USD" }).replace(/\s/g, " ")).toBe("USD 10.00");
  });

  it("porcentaje desde fraccion", () => {
    expect(en.porcentaje(0.125, 1)).toBe("12.5%");
    expect(es.porcentaje(0.5).replace(/\s/g, "")).toBe("50%");
  });

  it("fechas en el orden natural de cada idioma", () => {
    expect(es.fecha(fecha, "media", "UTC")).toBe("6 nov 2026");
    expect(en.fecha(fecha, "media", "UTC")).toBe("Nov 6, 2026");
    expect(en.fecha(fecha, "larga", "UTC")).toBe("Friday, November 6, 2026");
    expect(es.fecha(fecha, "larga", "UTC")).toBe("viernes, 6 de noviembre de 2026");
  });

  it("hora en 12 h con a.m./p.m. propio de cada idioma", () => {
    expect(en.hora(fecha, "UTC")).toBe("6:05 PM");
    expect(es.hora(fecha, "UTC").replace(/\s/g, " ")).toBe("6:05 p.m.");
  });

  it("tiempo relativo", () => {
    const ahora = fecha.getTime();
    expect(en.relativo(ahora - 5 * 60_000, ahora)).toBe("5 minutes ago");
    expect(es.relativo(ahora - 5 * 60_000, ahora)).toBe("hace 5 minutos");
    expect(en.relativo(ahora + 24 * 3600_000, ahora)).toBe("tomorrow");
    expect(es.relativo(ahora + 24 * 3600_000, ahora)).toBe("mañana");
  });

  it("listas con la conjuncion de cada idioma", () => {
    expect(en.lista(["A", "B", "C"])).toBe("A, B, and C");
    expect(es.lista(["A", "B", "C"])).toBe("A, B y C");
  });
});
