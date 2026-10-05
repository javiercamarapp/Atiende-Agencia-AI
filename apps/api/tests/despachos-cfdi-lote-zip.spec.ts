// D-13: lector de ZIP con defensa anti zip-bomb (cfdi-lote-zip.ts). ZIP hostiles fabricados a proposito con fixtures/zip-builder.ts.
import { describe, expect, it } from "vitest";
import { LIMITES_ZIP_CFDI, ZipCfdiInvalidoError, leerZipCfdi } from "../src/routes/verticals/despachos/cfdi-lote-zip.ts";
import { construirZip } from "./fixtures/zip-builder.ts";
import { cfdiXml } from "./fixtures/cfdi-xml.ts";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const xml = (n: number) => cfdiXml({ uuid: U(n) });
const rechaza = (zip: Uint8Array, fragmento: RegExp, limites = { ...LIMITES_ZIP_CFDI }) => {
  expect(() => leerZipCfdi(zip, limites)).toThrow(ZipCfdiInvalidoError);
  expect(() => leerZipCfdi(zip, limites)).toThrow(fragmento);
};

describe("leerZipCfdi — camino feliz", () => {
  it("lee entradas deflate y stored, separa los que no son XML y omite carpetas/basura de macOS", () => {
    const zip = construirZip([
      { nombre: "a.xml", datos: xml(1) },
      { nombre: "sub/b.XML", datos: xml(2), metodo: 0 },
      { nombre: "leeme.pdf", datos: "no se descomprime" },
      { nombre: "sub/", datos: "" },
      { nombre: "__MACOSX/._a.xml", datos: "basura" },
      { nombre: ".DS_Store", datos: "x" },
    ]);
    const r = leerZipCfdi(zip);
    expect(r.xml.map((e) => e.nombre)).toEqual(["a.xml", "sub/b.XML"]);
    expect(new TextDecoder().decode(r.xml[0]!.bytes)).toBe(xml(1));
    expect(new TextDecoder().decode(r.xml[1]!.bytes)).toBe(xml(2));
    expect(r.noXml).toEqual(["leeme.pdf"]);
    expect(r.ignorados).toBe(3);
  });
});

describe("leerZipCfdi — zip-bomb y ZIP hostiles (se rechaza el ZIP completo)", () => {
  it("bomba honesta: 8 MB de ceros en ~8 KB comprimidos; se rechaza por el tope por archivo SIN descomprimir", () => {
    const zip = construirZip([{ nombre: "bomba.xml", datos: new Uint8Array(8 * 1024 * 1024) }]);
    expect(zip.byteLength).toBeLessThan(20 * 1024);
    const rssAntes = process.memoryUsage().rss;
    rechaza(zip, /excede 512 KB/);
    expect(process.memoryUsage().rss - rssAntes).toBeLessThan(64 * 1024 * 1024);
  });

  it("encabezado que MIENTE: declara 1 KB pero el flujo descomprime a 5 MB; maxOutputLength corta la inflacion", () => {
    const zip = construirZip([{ nombre: "miente.xml", datos: new Uint8Array(5 * 1024 * 1024), declararDescomprimido: 1000 }]);
    const rssAntes = process.memoryUsage().rss;
    rechaza(zip, /dañado o se descomprime a más/);
    expect(process.memoryUsage().rss - rssAntes).toBeLessThan(64 * 1024 * 1024);
  });

  it("razon de compresion sospechosa: 400 KB de ceros (dentro del tope por archivo) se rechazan por razon", () => {
    rechaza(construirZip([{ nombre: "ratio.xml", datos: new Uint8Array(400 * 1024) }]), /razón de compresión/);
  });

  it("tope de entradas del directorio central y de XML por ZIP", () => {
    const muchas = Array.from({ length: 201 }, (_, i) => ({ nombre: `f${i}.pdf`, datos: "x" }));
    rechaza(construirZip(muchas), /201 entradas/);
    const xmls = Array.from({ length: 51 }, (_, i) => ({ nombre: `f${i}.xml`, datos: xml(i) }));
    rechaza(construirZip(xmls), /más de 50 archivos XML/);
  });

  it("tope de tamano descomprimido TOTAL (con limites reducidos)", () => {
    const zip = construirZip([
      { nombre: "a.xml", datos: xml(1) },
      { nombre: "b.xml", datos: xml(2) },
    ]);
    rechaza(zip, /descomprimido/, { ...LIMITES_ZIP_CFDI, maxBytesTotal: xml(1).length + 10 });
  });

  it.each([
    ["segmento ..", "../../etc/passwd.xml"],
    ["ruta con .. intermedio", "a/../b.xml"],
    ["ruta absoluta", "/etc/a.xml"],
    ["separador de Windows", "a\\b.xml"],
    ["letra de unidad", "C:/a.xml"],
  ])("ruta no permitida (%s)", (_t, nombre) => {
    rechaza(construirZip([{ nombre, datos: xml(1) }]), /ruta no permitida/);
  });

  it("ZIP anidado: por extension y por la firma PK del contenido", () => {
    const interno = construirZip([{ nombre: "x.xml", datos: xml(1) }]);
    rechaza(construirZip([{ nombre: "interno.zip", datos: interno }]), /anidados/);
    rechaza(construirZip([{ nombre: "disfrazado.xml", datos: interno }]), /anidados/);
  });

  it("cifrado, metodo no soportado, nombres duplicados y archivos que no son ZIP", () => {
    rechaza(construirZip([{ nombre: "c.xml", datos: xml(1), flags: 0x0801 }]), /cifrados/);
    const bz = construirZip([{ nombre: "m.xml", datos: xml(1) }]);
    new DataView(bz.buffer).setUint16(bz.byteLength - 22 - 46 - "m.xml".length + 10, 12, true); // metodo 12 en el directorio central
    rechaza(bz, /método de compresión/);
    rechaza(construirZip([{ nombre: "d.xml", datos: xml(1) }, { nombre: "D.xml", datos: xml(2) }]), /mismo nombre/);
    rechaza(new TextEncoder().encode("esto no es un zip, solo texto de relleno largo"), /no es un ZIP/);
    rechaza(new Uint8Array(5), /no es un ZIP/);
  });

  it("ZIP mayor que el tope de 4 MB", () => {
    rechaza(new Uint8Array(LIMITES_ZIP_CFDI.maxBytesZip + 1), /excede 4 MB/);
  });

  it("ZIP sin entradas utiles", () => {
    rechaza(construirZip([{ nombre: "carpeta/", datos: "" }]), /no trae archivos/);
  });
});
