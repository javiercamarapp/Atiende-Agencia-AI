// Validación de un XML contra los XSD OFICIALES del SAT de contabilidad electrónica 1.3 vendorizados en
// tests/fixtures/contabilidad-electronica-xsd/. Usa xmllint-wasm (libxml2 compilado a WebAssembly): sin binarios nativos, sin red y con el mismo
// motor de validación XSD que usa xmllint. Es dependencia de DESARROLLO (solo pruebas): ningún código de producción la importa.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateXML } from "xmllint-wasm";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "contabilidad-electronica-xsd");

export type EsquemaContabilidadElectronica = "CatalogoCuentas_1_3" | "BalanzaComprobacion_1_3" | "PolizasPeriodo_1_3";

function leer(nombre: string): string {
  return readFileSync(join(DIR, nombre), "utf8");
}

export function textoXsdVendorizado(nombre: string): string {
  return leer(nombre);
}

export interface ResultadoValidacionXsd {
  readonly valido: boolean;
  readonly errores: readonly string[];
}

/** Valida `xml` contra el XSD indicado (y el catálogo `CatalogosParaEsqContE.xsd` que importa). */
export async function validarContraXsd(xml: string, esquema: EsquemaContabilidadElectronica): Promise<ResultadoValidacionXsd> {
  const r = await validateXML({
    xml: [{ fileName: "documento.xml", contents: xml }],
    schema: [{ fileName: `${esquema}.xsd`, contents: leer(`${esquema}.xsd`) }],
    preload: [{ fileName: "CatalogosParaEsqContE.xsd", contents: leer("CatalogosParaEsqContE.xsd") }],
    initialMemoryPages: 512,
    maxMemoryPages: 1024,
  });
  return { valido: r.valid, errores: r.errors.map((e) => e.message) };
}
