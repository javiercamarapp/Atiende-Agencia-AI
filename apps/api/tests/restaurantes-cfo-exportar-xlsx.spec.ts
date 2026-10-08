// CFO-06 · libro de Excel del CFO: el zip abre (lector real de adjuntos y JSZip), una hoja por sucursal con nombre seguro y único, el total del estado de
// resultados coincide con la vista y es una FÓRMULA `SUM` con valor cacheado, los textos de origen jamás son fórmulas, `null` sale como «—» y la salida es
// determinista.
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { parsearXlsx } from "../src/data-chat/adjuntos-analisis.ts";
import { construirLibroCfo, textoSeguro } from "../src/routes/verticals/restaurantes/cfo-exportar-xlsx.ts";
import { GENERADO, armarVistas } from "./restaurantes-cfo-exportar-fixtures.ts";

const HIPERVINCULO = '=HYPERLINK("http://malo.example/x","clic")';

async function abrir(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const workbook = await zip.file("xl/workbook.xml")!.async("string");
  const nombres = [...workbook.matchAll(/<sheet name="([^"]*)" sheetId="(\d+)"/g)].map((m) => ({ nombre: m[1]!.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").replace(/&amp;/g, "&"), id: Number(m[2]) }));
  const hoja = async (nombre: string): Promise<string> => zip.file(`xl/worksheets/sheet${nombres.find((x) => x.nombre === nombre)!.id}.xml`)!.async("string");
  return { zip, nombres, hoja };
}

/** Celda por referencia: devuelve { f, v, t, texto }. */
function celda(xml: string, ref: string): { f: string | null; v: string | null; t: string | null; texto: string | null } {
  const m = new RegExp(`<c r="${ref}"([^>]*)>([\\s\\S]*?)</c>`).exec(xml);
  if (!m) throw new Error(`sin celda ${ref}`);
  const cuerpo = m[2]!;
  return {
    f: /<f>([\s\S]*?)<\/f>/.exec(cuerpo)?.[1] ?? null,
    v: /<v>([\s\S]*?)<\/v>/.exec(cuerpo)?.[1] ?? null,
    t: /\bt="([^"]+)"/.exec(m[1]!)?.[1] ?? null,
    texto: /<t[^>]*>([\s\S]*?)<\/t>/.exec(cuerpo)?.[1] ?? null,
  };
}

/** Fila de la hoja cuyo primer texto es `etiqueta`. */
function filaDe(xml: string, etiqueta: string): number {
  const m = new RegExp(`<c r="A(\\d+)"[^>]*t="inlineStr"[^>]*><is><t[^>]*>${etiqueta.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</t>`).exec(xml);
  if (!m) throw new Error(`sin fila ${etiqueta}`);
  return Number(m[1]);
}

describe("libro de Excel del CFO", () => {
  it("es un zip real: lo abre el lector de adjuntos (primera hoja) y JSZip; trae todas las hojas del brief", async () => {
    const { vistas, alcance } = await armarVistas();
    const bytes = construirLibroCfo(vistas, alcance, GENERADO);
    const filas = await parsearXlsx(bytes);
    expect(filas[0]).toEqual(["Reporte del CFO"]);
    expect(filas.some((f) => f[0] === "Periodo" && f[1] === "2026-08-31 a 2026-09-27")).toBe(true);
    expect(filas.flat().join(" ")).toContain("no sustituye a su contabilidad");
    const { nombres } = await abrir(bytes);
    expect(nombres.map((n) => n.nombre)).toEqual(["Portada", "Resumen", "Estado de resultados", "Ventas por día", "Sucursales", "Clientes", "Platillos", "Operación", "SoftRestaurant", ...vistas.estadoResultados!.sucursales.map((s) => `Suc ${s.nombre}`)]);
  });

  it("una hoja por sucursal; nombres de hoja seguros (sin []:*?/\\), de hasta 31 caracteres y únicos aun con nombres hostiles o repetidos", async () => {
    const { vistas, alcance } = await armarVistas({ n: 3, nombreSucursal: "A/B:C*D?[E]\\ con un nombre larguísimo que pasa de los treinta y un caracteres" });
    const { nombres } = await abrir(construirLibroCfo(vistas, alcance, GENERADO));
    const porSucursal = nombres.filter((n) => n.nombre.startsWith("Suc "));
    expect(porSucursal).toHaveLength(3);
    for (const { nombre } of nombres) {
      expect(nombre).not.toMatch(/[[\]:*?/\\]/);
      expect(nombre.length).toBeLessThanOrEqual(31);
    }
    expect(new Set(nombres.map((n) => n.nombre.toLowerCase())).size).toBe(nombres.length);
    // Dos sucursales con el mismo nombre: la segunda lleva sufijo, ninguna se pisa.
    const dup = await armarVistas({ n: 2 });
    const sucs = dup.sucursales.map((s) => ({ ...s, nombre: "Centro" }));
    const { nombres: n2 } = await abrir(construirLibroCfo({ ...dup.vistas, resumen: { ...dup.vistas.resumen!, sucursales: sucs } }, dup.alcance, GENERADO));
    expect(n2.filter((n) => n.nombre.startsWith("Suc Centro")).map((n) => n.nombre)).toEqual(["Suc Centro", "Suc Centro (2)"]);
  });

  it("el estado de resultados de la hoja coincide con la vista y el Total es una fórmula SUM con el valor cacheado correcto", async () => {
    const { vistas, alcance } = await armarVistas({ n: 3 });
    const { hoja } = await abrir(construirLibroCfo(vistas, alcance, GENERADO));
    const xml = await hoja("Estado de resultados");
    const cols = vistas.estadoResultados!.estadoResultados.acumulado.columnas;
    const total = cols.find((c) => c.clave === "total")!;
    const iTotal = cols.indexOf(total) + 1; // columna B = índice 1
    const letra = String.fromCharCode(65 + iTotal);
    const ultimaSuc = String.fromCharCode(65 + iTotal - 1);
    const fila = filaDe(xml, "Ventas brutas \\(lista\\)".replace(/\\/g, ""));
    const c = celda(xml, `${letra}${fila}`);
    expect(c.f).toMatch(new RegExp(`^SUM\\(([B-${ultimaSuc}]${fila},)*[B-${ultimaSuc}]${fila}\\)$`));
    const valorVista = total.lineas.find((l) => l.id === "ventas_brutas")!.cifra.valor!;
    expect(Number(c.v)).toBeCloseTo(valorVista / 100, 2);
    // La suma de las celdas de sucursal reproduce el total (la fórmula es verdadera, no decorativa).
    let suma = 0;
    for (let i = 1; i < iTotal; i += 1) suma += Number(celda(xml, `${String.fromCharCode(65 + i)}${fila}`).v);
    expect(suma).toBeCloseTo(valorVista / 100, 2);
    // Subtotal vivo: ventas netas = brutas - descuentos - compensaciones, con valor cacheado igual a la vista.
    const filaNetas = filaDe(xml, "Ventas netas con IVA");
    const cn = celda(xml, `B${filaNetas}`);
    expect(cn.f).toMatch(/^B\d+(-B\d+){1,2}$/);
    const sucNetas = cols[0]!.lineas.find((l) => l.id === "ventas_netas")!.cifra.valor!;
    expect(Number(cn.v)).toBeCloseTo(sucNetas / 100, 2);
  });

  it("con costos capturados el EBITDA y la utilidad bruta son fórmulas vivas con el valor cacheado de la vista (y estimado/capturado llevan estilo propio)", async () => {
    const { vistas, alcance } = await armarVistas({ n: 2 });
    const { hoja } = await abrir(construirLibroCfo(vistas, alcance, GENERADO));
    const xml = await hoja("Estado de resultados");
    const col = vistas.estadoResultados!.estadoResultados.acumulado.columnas[0]!;
    for (const [etiqueta, id] of [["Utilidad bruta", "utilidad_bruta"], ["EBITDA operativo", "ebitda"]] as const) {
      const valor = col.lineas.find((l) => l.id === id)!.cifra.valor;
      expect(valor, id).not.toBeNull();
      const c = celda(xml, `B${filaDe(xml, etiqueta)}`);
      expect(c.f, id).toMatch(/^B\d+(-B\d+)+$/);
      expect(Number(c.v), id).toBeCloseTo(valor! / 100, 2);
    }
  });

  it("un platillo, sucursal o texto de origen que empieza con = + - @ sale como texto (inlineStr), jamás como fórmula", async () => {
    const { vistas, alcance } = await armarVistas({ platillo: HIPERVINCULO, nombreSucursal: "+SUM(1+1)" });
    const bytes = construirLibroCfo(vistas, alcance, GENERADO);
    const { zip, nombres } = await abrir(bytes);
    const todo: string[] = [];
    for (const n of nombres) todo.push(await zip.file(`xl/worksheets/sheet${n.id}.xml`)!.async("string"));
    const platillos = todo[nombres.findIndex((n) => n.nombre === "Platillos")]!;
    expect(platillos.includes("&apos;=HYPERLINK(")).toBe(true);
    expect(platillos).not.toMatch(/<f>[^<]*HYPERLINK/);
    // Ninguna fórmula del libro contiene texto de origen: solo referencias y SUM/restas que generamos nosotros.
    for (const xml of todo) for (const m of xml.matchAll(/<f>([\s\S]*?)<\/f>/g)) expect(m[1]).toMatch(/^(SUM\([A-Z]+\d+(,[A-Z]+\d+)*\)|[A-Z]+\d+(-[A-Z]+\d+)*)$/);
    // Y el texto es inlineStr, nunca una celda de fórmula ni con tipo `str`.
    expect(platillos).not.toMatch(/t="str"/);
    expect(nombres.some((n) => n.nombre.includes("SUM(1+1)"))).toBe(true); // el nombre de hoja no es una celda: solo se sanea
    const sucursales = todo[nombres.findIndex((n) => n.nombre === "Sucursales")]!;
    expect(sucursales.includes("&apos;+SUM(1+1)")).toBe(true);
  });

  it("las cifras null salen como «—» (texto), nunca como 0", async () => {
    const { vistas, alcance } = await armarVistas({ capturarCostos: false });
    const { hoja } = await abrir(construirLibroCfo(vistas, alcance, GENERADO));
    const xml = await hoja("Estado de resultados");
    const fila = filaDe(xml, "Costo de ventas \\(food cost\\)".replace(/\\/g, ""));
    const c = celda(xml, `B${fila}`);
    expect(c.t).toBe("inlineStr");
    expect(c.texto).toBe("—");
    expect(c.v).toBeNull();
    // El EBITDA incompleto tampoco se rellena con 0.
    const e = celda(xml, `B${filaDe(xml, "EBITDA operativo")}`);
    expect(e.texto).toBe("—");
    expect(xml.includes("EBITDA incompleto")).toBe(true);
  });

  it("estimado y capturado llevan fondo propio y la portada trae la leyenda", async () => {
    const { vistas, alcance } = await armarVistas();
    const bytes = construirLibroCfo(vistas, alcance, GENERADO);
    const { zip, hoja } = await abrir(bytes);
    const styles = await zip.file("xl/styles.xml")!.async("string");
    expect(styles).toContain("FFFFF4CC"); // estimado
    expect(styles).toContain("FFDDEBFA"); // capturado
    expect(styles).toContain("&quot;$&quot;#,##0.00");
    expect(styles).toContain("0.0%");
    const portada = await hoja("Portada");
    expect(portada.includes("Leyenda de confianza")).toBe(true);
    expect(portada).toMatch(/Estimado/);
    expect(portada).toMatch(/Capturado/);
    // El IVA estimado de la hoja usa el estilo con fondo (el estilo no es el de una cifra medida).
    const xml = await hoja("Estado de resultados");
    const ref = `B${filaDe(xml, "IVA estimado")}`;
    const iva = new RegExp(`<c r="${ref}" s="(\\d+)"`).exec(xml)![1]!;
    const bruta = new RegExp(`<c r="B${filaDe(xml, "Ventas brutas (lista)")}" s="(\\d+)"`).exec(xml)![1]!;
    expect(iva).not.toBe(bruta);
  });

  it("es determinista: mismos datos y mismo generadoEn -> los mismos bytes; otra fecha -> otros bytes", async () => {
    const { vistas, alcance } = await armarVistas();
    const a = construirLibroCfo(vistas, alcance, GENERADO);
    const b = construirLibroCfo(vistas, alcance, GENERADO);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const c = construirLibroCfo(vistas, alcance, new Date("2026-09-29T15:00:00Z"));
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
  });

  it("vista «estado-resultados»: solo portada, estado de resultados y las hojas de sucursal (con sus KPIs)", async () => {
    const { vistas, alcance } = await armarVistas({ vista: "estado-resultados" });
    const { nombres } = await abrir(construirLibroCfo(vistas, alcance, GENERADO));
    expect(nombres.map((n) => n.nombre)).toEqual(["Portada", "Estado de resultados", ...vistas.estadoResultados!.sucursales.map((s) => `Suc ${s.nombre}`)]);
  });

  /** Toda celda citada por una fórmula generada (resta o SUM, en TODAS las hojas) debe ser numérica: una celda «—» (texto) daría #VALUE! al recalcular. */
  async function verificarFormulasNumericas(bytes: Uint8Array): Promise<number> {
    const { zip, nombres } = await abrir(bytes);
    let formulas = 0;
    for (const n of nombres) {
      const xml = await zip.file(`xl/worksheets/sheet${n.id}.xml`)!.async("string");
      for (const m of xml.matchAll(/<f>([\s\S]*?)<\/f>/g)) {
        formulas += 1;
        for (const ref of m[1]!.match(/[A-Z]+\d+/g)!) {
          const c = celda(xml, ref);
          expect(c.t, `${n.nombre}!${ref} en =${m[1]}`).not.toBe("inlineStr");
          expect(c.v, `${n.nombre}!${ref}`).not.toBeNull();
          expect(Number.isFinite(Number(c.v)), `${n.nombre}!${ref}`).toBe(true);
        }
      }
    }
    return formulas;
  }

  it.each([
    ["base", {}],
    ["sin costos capturados", { capturarCostos: false }],
    ["una sucursal sin ventas", { sinVentasPrimera: true }],
    ["admin acotado (sin No asignado)", { organizacionCompleta: false, n: 2 }],
  ] as const)("ninguna fórmula cita una celda de texto (sin #VALUE! al recalcular): %s", async (_n, op) => {
    const { vistas, alcance } = await armarVistas(op);
    expect(await verificarFormulasNumericas(construirLibroCfo(vistas, alcance, GENERADO))).toBeGreaterThan(5);
  });

  it("un renglón sin dato dentro de una resta (compensaciones) no se cita: ventas netas = brutas - descuentos con valor cacheado de la vista", async () => {
    const { vistas, alcance } = await armarVistas({ n: 2 });
    const { hoja } = await abrir(construirLibroCfo(vistas, alcance, GENERADO));
    const xml = await hoja("Estado de resultados");
    const comp = celda(xml, `B${filaDe(xml, "Compensaciones")}`);
    expect(comp.texto).toBe("—");
    const netas = celda(xml, `B${filaDe(xml, "Ventas netas con IVA")}`);
    expect(netas.f).toMatch(/^B\d+-B\d+$/);
  });

  it("el nombre de hoja de una sucursal no empieza ni termina con apóstrofo (Excel repara el archivo)", async () => {
    const { vistas, alcance } = await armarVistas({ n: 2, nombreSucursal: "'Don Pepe'" });
    const { nombres } = await abrir(construirLibroCfo(vistas, alcance, GENERADO));
    for (const { nombre } of nombres) expect(nombre).not.toMatch(/^'|'$/);
    expect(nombres.some((n) => n.nombre === "Suc Don Pepe")).toBe(true);
  });

  it.each(["=1+1", "+1", "-1", "@SUM(1)", "\t=1", "\r=1", "\n=1", "  =1", "\u00a0=HYPERLINK(1)", "\uFF1DHYPERLINK(1)", " \t @x", "\uFF0Bx"])("textoSeguro neutraliza %j", (t) => {
    expect(textoSeguro(t)).toBe(`'${t}`);
  });

  it("textoSeguro no toca texto normal", () => {
    for (const t of ["Taco al pastor", "Agua 1 L", "Café", "a=b", "—", ""]) expect(textoSeguro(t)).toBe(t);
  });
});
