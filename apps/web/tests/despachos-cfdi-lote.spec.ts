// D-13: logica de la carga masiva en el navegador (descompresion defensiva, tandas, cancelacion, cliente multipart).
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { armarTandas, descomprimirZip, ejecutarImportacion, importarLote, LIMITES_ZIP_NAVEGADOR, MAX_ARCHIVOS_POR_TANDA, sumarTotales, ZipNavegadorError } from "../src/verticals/despachos/lib/cfdi-lote.ts";
import type { ArchivoParaLote, RespuestaLote, TotalesLote } from "../src/verticals/despachos/lib/cfdi-lote.ts";

const xml = (n: number) => strToU8(`<cfdi:Comprobante n="${n}"/>`);
const archivo = (n: number, bytes = 10): ArchivoParaLote => ({ nombre: `f${n}.xml`, bytes: new Uint8Array(bytes) });
const cero: TotalesLote = { recibidos: 0, ingeridos: 0, enRevision: 0, duplicados: 0, rechazados: 0, reps: 0 };

describe("descomprimirZip", () => {
  it("separa XML de otros archivos, ignora basura de macOS y respeta subcarpetas", () => {
    const z = zipSync({ "a.xml": xml(1), "sub/b.XML": xml(2), "nota.pdf": strToU8("pdf"), "__MACOSX/._a.xml": strToU8("x"), ".DS_Store": strToU8("x") });
    const r = descomprimirZip(z);
    expect(r.xml.map((e) => e.nombre).sort()).toEqual(["a.xml", "sub/b.XML"]);
    expect(r.noXml).toEqual(["nota.pdf"]);
    expect(r.ignorados).toBe(2);
  });

  it.each([
    ["ruta con ..", { "../x.xml": xml(1) }, /ruta no permitida/],
    ["ruta absoluta", { "/etc/x.xml": xml(1) }, /ruta no permitida/],
    ["ZIP anidado por extension", { "otro.zip": strToU8("PK") }, /anidados/],
    ["ZIP anidado disfrazado de XML", { "x.xml": zipSync({ "i.xml": xml(1) }) }, /anidados/],
    ["XML de mas de 512 KB", { "grande.xml": new Uint8Array(600 * 1024).fill(65) }, /512 KB/],
  ])("rechaza el ZIP completo: %s", (_t, entradas, msg) => {
    expect(() => descomprimirZip(zipSync(entradas as Record<string, Uint8Array>, { level: 0 }))).toThrow(ZipNavegadorError);
    expect(() => descomprimirZip(zipSync(entradas as Record<string, Uint8Array>, { level: 0 }))).toThrow(msg);
  });

  it("razon de compresion sospechosa y tope de entradas", () => {
    expect(() => descomprimirZip(zipSync({ "ratio.xml": new Uint8Array(400 * 1024) }))).toThrow(/razón de compresión/);
    const muchas = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}.xml`, xml(i)]));
    expect(() => descomprimirZip(zipSync(muchas), { ...LIMITES_ZIP_NAVEGADOR, maxEntradas: 5 })).toThrow(/más de 5 entradas/);
  });

  it("un archivo que no es ZIP -> error legible", () => {
    expect(() => descomprimirZip(strToU8("esto no es un zip"))).toThrow(/no es un ZIP válido/);
  });
});

describe("armarTandas", () => {
  it("parte por numero de archivos (50) y por bytes", () => {
    const ciento = Array.from({ length: 120 }, (_, i) => archivo(i));
    expect(armarTandas(ciento).map((t) => t.length)).toEqual([MAX_ARCHIVOS_POR_TANDA, MAX_ARCHIVOS_POR_TANDA, 20]);
    const pesados = Array.from({ length: 5 }, (_, i) => archivo(i, 400));
    expect(armarTandas(pesados, 50, 1000).map((t) => t.length)).toEqual([2, 2, 1]);
    expect(armarTandas([])).toEqual([]);
  });
});

function respuesta(n: number): RespuestaLote {
  const totales: TotalesLote = { ...cero, recibidos: n, ingeridos: n };
  return { loteId: "l", resultados: Array.from({ length: n }, (_, i) => ({ archivo: `f${i}.xml`, estado: "ingerido", clase: "cfdi", folioFiscal: null, motivo: null })), totales, ignorados: 0 };
}

describe("ejecutarImportacion", () => {
  it("envia todas las tandas en orden y reporta progreso y totales sumados", async () => {
    const tandas = armarTandas(Array.from({ length: 120 }, (_, i) => archivo(i)));
    const enviar = vi.fn(async (t: readonly ArchivoParaLote[]) => respuesta(t.length));
    const progresos: number[] = [];
    const r = await ejecutarImportacion(tandas, enviar, () => false, (p) => progresos.push(p.archivosEnviados));
    expect(enviar).toHaveBeenCalledTimes(3);
    expect(progresos).toEqual([0, 50, 100, 120]);
    expect(r).toMatchObject({ sinProcesar: 0, cancelada: false, error: null, totales: { recibidos: 120, ingeridos: 120 } });
    expect(r.resultados).toHaveLength(120);
  });

  it("CANCELAR detiene las tandas pendientes sin revertir las ya hechas: la tanda en vuelo termina y las demas no se envian", async () => {
    const tandas = armarTandas(Array.from({ length: 120 }, (_, i) => archivo(i)));
    let cancelar = false;
    const enviar = vi.fn(async (t: readonly ArchivoParaLote[]) => {
      cancelar = true; // el usuario pulsa Cancelar mientras viaja la primera tanda
      return respuesta(t.length);
    });
    const r = await ejecutarImportacion(tandas, enviar, () => cancelar, () => undefined);
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ cancelada: true, sinProcesar: 70, error: null, totales: { recibidos: 50, ingeridos: 50 } });
    expect(r.resultados).toHaveLength(50);
  });

  it("un fallo de la segunda tanda detiene el resto, conserva lo ya importado y reporta el error", async () => {
    const tandas = armarTandas(Array.from({ length: 120 }, (_, i) => archivo(i)));
    const enviar = vi.fn(async (t: readonly ArchivoParaLote[]) => {
      if (enviar.mock.calls.length === 2) throw new Error("Error de red");
      return respuesta(t.length);
    });
    const r = await ejecutarImportacion(tandas, enviar, () => false, () => undefined);
    expect(enviar).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ cancelada: false, error: "Error de red", sinProcesar: 70, totales: { recibidos: 50 } });
  });

  it("sumarTotales suma campo a campo", () => {
    expect(sumarTotales([{ ...cero, recibidos: 2, rechazados: 1 }, { ...cero, recibidos: 3, reps: 1 }])).toEqual({ ...cero, recibidos: 5, rechazados: 1, reps: 1 });
  });
});

describe("importarLote (cliente)", () => {
  it("POST multipart con campo 'archivos' y bearer; devuelve la respuesta del servidor", async () => {
    const llamadas: { url: string; init: RequestInit }[] = [];
    const fetchMock = (async (url: string, init: RequestInit) => {
      llamadas.push({ url, init });
      return { ok: true, status: 200, json: async () => respuesta(2) } as unknown as Response;
    }) as unknown as typeof fetch;
    const r = await importarLote(fetchMock, "https://api.test", "tok", "prop-1", [archivo(1), archivo(2)]);
    expect(r.totales.recibidos).toBe(2);
    expect(llamadas[0]!.url).toBe("https://api.test/despachos/prop-1/cfdi/importar-lote");
    expect(llamadas[0]!.init.method).toBe("POST");
    expect((llamadas[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    const fd = llamadas[0]!.init.body as FormData;
    expect(fd.getAll("archivos").map((f) => (f as File).name)).toEqual(["f1.xml", "f2.xml"]);
  });

  it("un error del servidor se convierte en un Error con su mensaje", async () => {
    const fetchMock = (async () => ({ ok: false, status: 400, json: async () => ({ message: "El ZIP trae 201 entradas" }), text: async () => "" }) as unknown as Response) as unknown as typeof fetch;
    await expect(importarLote(fetchMock, "https://api.test", "tok", "prop-1", [archivo(1)])).rejects.toThrow(/201 entradas|No se pudo completar/);
  });
});
