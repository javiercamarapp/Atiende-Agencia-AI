// @vitest-environment jsdom
//
// Exportar CSV: contenido (BOM, comillas, numeros crudos, neutralizacion de formulas), nombre de archivo y el
// boton real de la respuesta, que genera un Blob y dispara la descarga.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopilotoAcciones, descargarCsv } from "../src/components/copiloto/CopilotoAcciones";
import { bloqueACsv, nombreArchivoCsv } from "../src/components/copiloto/formato";
import type { CopilotoBloque, CopilotoMensaje } from "../src/components/copiloto/tipos";
import { clic, limpiarDom, montar, porEtiqueta, transporteFalso, type Montado } from "./copiloto-utils";

let montado: Montado | undefined;
afterEach(() => {
  montado?.unmount();
  montado = undefined;
  limpiarDom();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BLOQUE: CopilotoBloque = {
  tool: "ventas_por_dia",
  title: "Ventas por día",
  columns: [
    { key: "dia", label: "Día", kind: "text" },
    { key: "ventas", label: "Ventas, MXN", kind: "mxn" },
    { key: "pedidos", label: "Pedidos", kind: "integer" },
  ],
  rows: [
    { dia: "Lunes", ventas: 1500.5, pedidos: 12 },
    { dia: 'Con "comillas", coma', ventas: null, pedidos: 0 },
    { dia: "=HIPERVINCULO(\"x\")", ventas: -3.25, pedidos: Number.NaN },
  ],
  truncated: false,
};

describe("bloqueACsv", () => {
  const csv = bloqueACsv(BLOQUE);

  it("empieza con BOM UTF-8 y usa CRLF", () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("encabezados citados si llevan separador y numeros sin formato (sin $ ni comas de miles)", () => {
    const lineas = csv.slice(1).split("\r\n");
    expect(lineas[0]).toBe('Día,"Ventas, MXN",Pedidos');
    expect(lineas[1]).toBe("Lunes,1500.5,12");
  });

  it("nulos y numeros no finitos quedan vacios; comillas se duplican", () => {
    const lineas = csv.slice(1).split("\r\n");
    expect(lineas[2]).toBe('"Con ""comillas"", coma",,0');
  });

  it("neutraliza celdas de texto que empiezan como formula", () => {
    const lineas = csv.slice(1).split("\r\n");
    expect(lineas[3]).toBe("\"'=HIPERVINCULO(\"\"x\"\")\",-3.25,");
  });

  it("acepta ';' como separador cuando la region lo pide", () => {
    expect(bloqueACsv(BLOQUE, ";").slice(1).split("\r\n")[0]).toBe("Día;Ventas, MXN;Pedidos");
  });
});

describe("nombreArchivoCsv", () => {
  it("atiende-{vertical}-{herramienta}-{AAAAMMDD-HHmm}.csv", () => {
    expect(nombreArchivoCsv("restaurantes", "ventas_por_dia", new Date(2026, 8, 5, 7, 4))).toBe("atiende-restaurantes-ventas_por_dia-20260905-0704.csv");
  });
  it("sin vertical omite el segmento y limpia caracteres raros", () => {
    expect(nombreArchivoCsv(undefined, "../Ventas Día!", new Date(2026, 0, 1, 0, 0))).toBe("atiende-ventas-d-a-20260101-0000.csv");
  });
});

function montarAcciones(blocks: CopilotoBloque[], vertical?: string) {
  const mensaje: CopilotoMensaje = { id: "m", role: "assistant", text: "ok", status: "ok", blocks };
  const { t } = transporteFalso();
  montado = montar(<CopilotoAcciones mensaje={mensaje} conversacionId="c" transporte={t} esUltima={false} ocupado={false} onRegenerar={() => undefined} vertical={vertical} />);
  return montado.container;
}

describe("boton CSV de la respuesta", () => {
  function stubDescarga() {
    const blobs: Blob[] = [];
    const crear = vi.fn((b: Blob) => {
      blobs.push(b);
      return "blob:fake";
    });
    const revocar = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: crear, revokeObjectURL: revocar }));
    const nombres: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      nombres.push(this.download);
    });
    return { blobs, nombres, crear, revocar };
  }

  it("descarga un Blob text/csv con el contenido del bloque y el nombre esperado", async () => {
    const d = stubDescarga();
    const c = montarAcciones([BLOQUE], "restaurantes");
    clic(porEtiqueta(c, "Descargar CSV"));
    expect(d.crear).toHaveBeenCalledTimes(1);
    expect(d.blobs[0]!.type).toBe("text/csv;charset=utf-8");
    const bytes = await new Promise<Uint8Array>((ok) => {
      const lector = new FileReader();
      lector.onload = () => ok(new Uint8Array(lector.result as ArrayBuffer));
      lector.readAsArrayBuffer(d.blobs[0]!);
    });
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes.slice(3))).toBe(bloqueACsv(BLOQUE).slice(1));
    expect(d.nombres[0]).toMatch(/^atiende-restaurantes-ventas_por_dia-\d{8}-\d{4}\.csv$/);
  });

  it("no hay boton CSV si el bloque no tiene filas; con varios bloques hay uno por bloque", () => {
    let c = montarAcciones([{ ...BLOQUE, rows: [] }]);
    expect(c.querySelector('[aria-label^="Descargar CSV"]')).toBeNull();
    montado?.unmount();
    limpiarDom();
    c = montarAcciones([BLOQUE, { ...BLOQUE, tool: "otra", title: "Otra" }]);
    expect(c.querySelectorAll('[aria-label^="Descargar CSV de"]')).toHaveLength(2);
  });

  it("si el navegador no puede crear el archivo, avisa en lugar de fallar en silencio", () => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => { throw new Error("no"); }, revokeObjectURL: vi.fn() }));
    const c = montarAcciones([BLOQUE]);
    clic(porEtiqueta(c, "Descargar CSV"));
    expect(c.querySelector('[role="alert"]')?.textContent).toContain("No se pudo crear el archivo CSV");
    expect(descargarCsv(BLOQUE, undefined)).toBe(false);
  });
});
