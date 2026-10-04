// Filtros, orden, plazas y CSV del Cerebro (portados de cerebro.tsx de Likida y adaptados a la vertical).
import { describe, expect, it } from "vitest";
import type { ProspectoMapa } from "../src/superadmin/cerebro/datos.ts";
import { aProspectoMapa, tieneCoordenadas } from "../src/superadmin/cerebro/datos.ts";
import {
  CABECERA_CSV, SIN_FILTROS, alternarEnSet, calcularPlazas, contarFiltrosActivos, contarPorVertical, csvDe, esContactable,
  filtrar, filtrosParaBitacora, ordenar,
} from "../src/superadmin/cerebro/filtros.ts";

const AHORA = Date.parse("2026-10-03T12:00:00Z");

function p(extra: Partial<ProspectoMapa> & { id: string }): ProspectoMapa {
  return {
    empresa: `Empresa ${extra.id}`, vertical: "restaurantes", subtipo: null, ciudad: "Mérida", municipio: null, entidad: "Yucatán",
    lat: 20.97, lng: -89.62, telefono: "9991234567", correo: null, contacto: null, estado: "nuevo", fuente: "directorio", tamano: null,
    urgencia: 50, cierre: 40, ajuste: 60, completitud: 70, ultimoToque: null, creadoEn: "2026-09-01T00:00:00Z", actualizadoEn: "2026-09-01T00:00:00Z",
    notas: null, sitioWeb: null, sitioVerificado: false, baseLicitud: "fuente_publica_b2b", contactoLegado: false, siguientePaso: null,
    siguientePasoEn: null, suprimidoTelefono: false, suprimidoCorreo: false, supresionVerificada: true,
    ...extra,
  };
}

const lista = [
  p({ id: "a", vertical: "restaurantes", estado: "nuevo", urgencia: 80, cierre: 20, contacto: "Zoraida" }),
  p({ id: "b", vertical: "hoteles", estado: "demo", urgencia: 30, cierre: 90, entidad: "Quintana Roo", ciudad: "Cancún", lat: 21.16, lng: -86.85 }),
  p({ id: "c", vertical: "hoteles", estado: "ganado", urgencia: null, cierre: null, ajuste: null, completitud: 40, telefono: null }),
  p({ id: "d", vertical: "citas", estado: "contactado", ultimoToque: "2026-09-30T00:00:00Z", fuente: null, lat: null, lng: null }),
];

describe("alternarEnSet (aditivo, como Likida)", () => {
  it("un clic agrega, otro quita, y el conjunto vacio vuelve a null", () => {
    const uno = alternarEnSet(null, "hoteles");
    expect([...uno!]).toEqual(["hoteles"]);
    const dos = alternarEnSet(uno, "citas");
    expect([...dos!].sort()).toEqual(["citas", "hoteles"]);
    expect(alternarEnSet(alternarEnSet(dos, "citas"), "hoteles")).toBeNull();
  });
});

describe("filtrar", () => {
  it("sin filtros pasa todo", () => {
    expect(filtrar(lista, SIN_FILTROS, AHORA)).toHaveLength(4);
    expect(contarFiltrosActivos(SIN_FILTROS)).toBe(0);
  });
  it("por vertical (la leyenda) y por etapa", () => {
    expect(filtrar(lista, { ...SIN_FILTROS, verticales: new Set(["hoteles"]) }, AHORA).map((x) => x.id)).toEqual(["b", "c"]);
    expect(filtrar(lista, { ...SIN_FILTROS, verticales: new Set(["hoteles"]), etapas: new Set(["ganado"]) }, AHORA).map((x) => x.id)).toEqual(["c"]);
  });
  it("un score 'sin calificar' (null) NO pasa un minimo: no se le adivina un numero", () => {
    expect(filtrar(lista, { ...SIN_FILTROS, minUrgencia: 50 }, AHORA).map((x) => x.id)).toEqual(["a", "d"]);
    expect(filtrar(lista, { ...SIN_FILTROS, minCierre: 40 }, AHORA).map((x) => x.id)).toEqual(["b", "d"]);
    expect(filtrar(lista, { ...SIN_FILTROS, minAjuste: 40 }, AHORA).map((x) => x.id)).toEqual(["a", "b", "d"]);
  });
  it("con telefono, con decisor, fuente sin dato y tamano sin dato", () => {
    expect(filtrar(lista, { ...SIN_FILTROS, soloTel: true }, AHORA)).toHaveLength(3);
    expect(filtrar(lista, { ...SIN_FILTROS, soloDecisor: true }, AHORA).map((x) => x.id)).toEqual(["a"]);
    expect(filtrar(lista, { ...SIN_FILTROS, fuentes: new Set(["sin-fuente"]) }, AHORA).map((x) => x.id)).toEqual(["d"]);
    expect(filtrar(lista, { ...SIN_FILTROS, tamanos: new Set(["n/d"]) }, AHORA)).toHaveLength(4);
  });
  it("sin toque en N dias: pasa el nunca tocado y el tocado hace mas de N dias", () => {
    const f = { ...SIN_FILTROS, sinToqueDias: 7 as const };
    expect(filtrar(lista, f, AHORA).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(filtrar(lista, f, Date.parse("2026-10-20T00:00:00Z")).map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  });
  it("busqueda sin acentos ni mayusculas sobre empresa, ciudad, entidad, contacto y vertical", () => {
    expect(filtrar(lista, { ...SIN_FILTROS, busqueda: "cancun" }, AHORA).map((x) => x.id)).toEqual(["b"]);
    expect(filtrar(lista, { ...SIN_FILTROS, busqueda: "ZORAIDA" }, AHORA).map((x) => x.id)).toEqual(["a"]);
    expect(filtrar(lista, { ...SIN_FILTROS, busqueda: "hoteles" }, AHORA).map((x) => x.id)).toEqual(["b", "c"]);
  });
  it("radio: solo pasan los que TIENEN coordenadas y estan dentro; sin coordenadas no se les adivina distancia", () => {
    const merida = { lat: 20.97, lng: -89.62, nombre: "Mérida, Yucatán" };
    expect(filtrar(lista, { ...SIN_FILTROS, centro: merida, radioKm: 50 }, AHORA).map((x) => x.id)).toEqual(["a", "c"]);
    expect(filtrar(lista, { ...SIN_FILTROS, centro: merida, radioKm: 400 }, AHORA).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(filtrar(lista, { ...SIN_FILTROS, centro: merida, radioKm: 0 }, AHORA)).toHaveLength(4);
  });
  it("contactable = base de licitud + sin supresion + algun destino", () => {
    expect(esContactable(p({ id: "x" }))).toBe(true);
    expect(esContactable(p({ id: "x", suprimidoTelefono: true }))).toBe(false);
    expect(esContactable(p({ id: "x", contactoLegado: true }))).toBe(false);
    expect(esContactable(p({ id: "x", baseLicitud: null }))).toBe(false);
    expect(esContactable(p({ id: "x", telefono: null, correo: null }))).toBe(false);
    expect(filtrar(lista, { ...SIN_FILTROS, soloContactable: true }, AHORA).map((x) => x.id)).toEqual(["a", "b", "d"]);
  });
  it("cuenta los filtros activos (el numero de 'Filtros · N')", () => {
    expect(contarFiltrosActivos({ ...SIN_FILTROS, verticales: new Set(["hoteles"]), minUrgencia: 70, soloTel: true, busqueda: " x " })).toBe(4);
    expect(contarFiltrosActivos({ ...SIN_FILTROS, centro: { lat: 0, lng: 0, nombre: "x" }, radioKm: 0 })).toBe(0);
  });
});

describe("ordenar", () => {
  it("por cierre, urgencia y datos; los 'sin calificar' van al final", () => {
    expect(ordenar(lista, "cierre").map((x) => x.id)).toEqual(["b", "d", "a", "c"]);
    expect(ordenar(lista, "urgencia").map((x) => x.id)).toEqual(["a", "d", "b", "c"]);
    expect(ordenar(lista, "completos").map((x) => x.id)).toEqual(["b", "d", "a", "c"]);
  });
  it("recientes = por fecha de alta descendente, estable", () => {
    const l = [p({ id: "x", creadoEn: "2026-01-01T00:00:00Z" }), p({ id: "y", creadoEn: "2026-05-01T00:00:00Z" })];
    expect(ordenar(l, "recientes").map((x) => x.id)).toEqual(["y", "x"]);
  });
  it("no muta la lista de entrada", () => {
    const copia = [...lista];
    ordenar(lista, "urgencia");
    expect(lista).toEqual(copia);
  });
});

describe("plazas y conteos", () => {
  it("las plazas promedian por ciudad solo con coordenadas y se ordenan por cantidad", () => {
    const l = [p({ id: "1", lat: 20, lng: -89 }), p({ id: "2", lat: 22, lng: -91 }), p({ id: "3", ciudad: "Cancún", entidad: "Quintana Roo", lat: 21, lng: -87 }), p({ id: "4", lat: null, lng: null })];
    const plazas = calcularPlazas(l);
    expect(plazas[0]).toEqual({ nombre: "Mérida, Yucatán", lat: 21, lng: -90, n: 2 });
    expect(plazas).toHaveLength(2);
  });
  it("contarPorVertical", () => {
    expect([...contarPorVertical(lista).entries()].sort()).toEqual([["citas", 1], ["hoteles", 2], ["restaurantes", 1]]);
  });
  it("tieneCoordenadas rechaza null, NaN y fuera de rango", () => {
    expect(tieneCoordenadas({ lat: 20, lng: -89 })).toBe(true);
    expect(tieneCoordenadas({ lat: null, lng: -89 })).toBe(false);
    expect(tieneCoordenadas({ lat: Number.NaN, lng: -89 })).toBe(false);
    expect(tieneCoordenadas({ lat: 120, lng: -89 })).toBe(false);
  });
});

describe("CSV", () => {
  it("columnas fijas, BOM, comillas escapadas y 'sin calificar' como celda vacia", () => {
    const csv = csvDe([p({ id: "q", empresa: 'La "Esquina"', urgencia: null, contacto: null })]);
    expect(csv.startsWith("﻿")).toBe(true);
    const [cab, fila] = csv.slice(1).split("\n");
    expect(cab).toBe(CABECERA_CSV.join(","));
    expect(fila).toContain('"La ""Esquina"""');
    expect(cab!.split(",")).toHaveLength(fila!.match(/"[^"]*(?:""[^"]*)*"/g)!.length);
    expect(fila).toContain('"Restaurantes","","Nuevo","","40"');
  });
  it("neutraliza formulas de hoja de calculo (=, +, -, @)", () => {
    const csv = csvDe([p({ id: "f", empresa: "=HYPERLINK(\"http://x\")", contacto: "+52 1", notas: "@cmd" })]);
    expect(csv).toContain("\"'=HYPERLINK");
    expect(csv).toContain("\"'+52 1\"");
    expect(csv).toContain("\"'@cmd\"");
  });
  it("lo que va a la bitacora es la FORMA de la consulta, nunca el texto buscado ni datos", () => {
    const b = filtrosParaBitacora({ ...SIN_FILTROS, busqueda: "Juan Perez", verticales: new Set(["hoteles"]) });
    expect(JSON.stringify(b)).not.toContain("Juan");
    expect(b.conBusqueda).toBe(true);
    expect(b.verticales).toEqual(["hoteles"]);
  });
  it("una combinacion amplia de filtros siempre cabe en el tope de 2000 caracteres de la bitacora", () => {
    const muchos = (pref: string) => new Set(Array.from({ length: 200 }, (_, i) => `${pref}${i}-${"x".repeat(120)}`));
    const b = filtrosParaBitacora({ ...SIN_FILTROS, verticales: muchos("v"), etapas: muchos("e"), subtipos: muchos("s"), tamanos: muchos("t"), fuentes: muchos("f") });
    expect(JSON.stringify(b).length).toBeLessThanOrEqual(2000);
    expect(JSON.stringify(b)).not.toContain("x".repeat(81));
  });
});

describe("aProspectoMapa", () => {
  it("lo que el API no trae queda en null: nunca un 0 inventado", () => {
    const m = aProspectoMapa({ id: "1", empresa: "X", vertical: "citas", ciudad: null, contactoNombre: null, telefono: null, correo: null, estado: "nuevo", fuente: null, notas: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" });
    expect(m.urgencia).toBeNull();
    expect(m.cierre).toBeNull();
    expect(m.completitud).toBeNull();
    expect(m.lat).toBeNull();
    expect(m.supresionVerificada).toBe(false);
    expect(m.contactoLegado).toBe(false);
  });
  it("traduce scores, supresion verificada y coordenadas", () => {
    const m = aProspectoMapa({ id: "1", empresa: "X", vertical: "citas", ciudad: "Mérida", contactoNombre: "Ana", telefono: "1", correo: null, estado: "demo", fuente: "web", notas: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z", lat: 20.9, lng: -89.6, scoreUrgencia: 77, scoreCierre: 0, suprimido: { telefono: true, correo: false } });
    expect(m.urgencia).toBe(77);
    expect(m.cierre).toBe(0);
    expect(m.suprimidoTelefono).toBe(true);
    expect(m.supresionVerificada).toBe(true);
    expect(m.contacto).toBe("Ana");
  });
});
