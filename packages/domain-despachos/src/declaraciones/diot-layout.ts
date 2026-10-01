// ═══════════════════════════════════════════════════════════════════════════
// LAYOUT DIOT (TXT delimitado por "|" y XML) — Declaración Informativa de
// Operaciones con Terceros (art. 32 fr. VIII LIVA, regla 4.5.1 RMF vigente: la DIOT
// reporta por tercero el valor de las operaciones efectivamente PAGADAS en el mes).
// Puro, sin I/O, SIN firma ni envío (el envío con e.firma es D-18, bloqueado por
// credenciales reales).
//
// QUÉ ES ESTO Y QUÉ NO ES. Es un generador de archivo para REVISIÓN y carga asistida
// por un contador: aplica las reglas de captura que el sistema sí puede decidir
// (terminología de tipo de tercero / tipo de operación, redondeo a pesos enteros,
// exclusión de RFC genéricos, validación de RFC, montos en MXN) y deja las columnas que
// el sistema no conoce (extranjeros, IVA no acreditable, importaciones, devoluciones)
// vacías en vez de inventarlas. El orden y nombre de las columnas de valores está
// declarado en UNA sola tabla (`COLUMNAS_DIOT`) y la versión se expone en
// `LAYOUT_DIOT_VERSION`: la transcripción del anexo oficial NO pudo cotejarse contra el
// validador del SAT en este entorno (sin acceso a Internet), así que antes de cargar un
// archivo real hay que validarlo con el validador oficial (hueco conocido del PR).
//
// REGLAS DE CAPTURA aplicadas (cada una con su prueba en tests/diot-layout.spec.ts):
//  - Tipo de tercero: "04" proveedor nacional (RFC de 12/13 caracteres). Extranjeros
//    ("05") y global ("15") NO se generan: el sistema no modela ID fiscal ni país; un
//    RFC genérico (XAXX/XEXX) se OMITE y se reporta en `omitidos`, nunca se captura.
//  - Tipo de operación: catálogo real 03 / 06 / 85 (ver DIOT_TIPO_OPERACION); nunca se
//    deriva de la tasa de IVA (ver `resolverTipoOperacion`).
//  - Valores en PESOS ENTEROS (la DIOT no admite centavos): se suma en MXN con
//    centavos (ya convertido por tipo de cambio) y se redondea UNA vez por celda,
//    mitad hacia arriba. El redondeo por celda puede diferir ±1 peso de la suma de
//    renglones: es el comportamiento de captura de la DIOT, no un error de cuadre.
//  - El valor reportado es la BASE (subtotal) por tasa: 16% | 8% (región fronteriza) |
//    0% | exento; cualquier otra tasa se trata como exento (misma limitación heredada
//    que `agregarDiot`, ver su cabecera).
//  - Renglón sin ningún valor distinto de cero tras el redondeo se omite (la DIOT no
//    admite terceros sin operaciones).
//  - IVA retenido por el contribuyente: hoy NO se persiste por CFDI (`InvoiceRecord` no
//    guarda retenciones), así que sale vacío y se avisa; no se estima.
// ═══════════════════════════════════════════════════════════════════════════
import { esRfcGenerico, resolverTipoOperacion } from "./diot-aggregate.ts";
import type { DiotTipoOperacion, RegistroDiotCandidato } from "./types.ts";

export const LAYOUT_DIOT_VERSION = "diot-batch-sin-cotejar-con-validador-sat";

/** Terminología SAT: "04" proveedor nacional, "05" proveedor extranjero, "15" proveedor global. */
export type DiotTipoTercero = "04" | "05" | "15";

export type DiotCeldaFuente = "tipoTercero" | "tipoOperacion" | "rfc" | "base16" | "base8" | "base0" | "exento" | "vacia";

/** Una sola tabla define el orden del TXT, los nombres del XML y el origen de cada
 * celda — un ajuste al anexo oficial es un cambio de una línea aquí. */
export const COLUMNAS_DIOT: readonly { readonly campo: number; readonly xml: string; readonly nombre: string; readonly fuente: DiotCeldaFuente }[] = [
  { campo: 1, xml: "TipoTercero", nombre: "Tipo de tercero", fuente: "tipoTercero" },
  { campo: 2, xml: "TipoOperacion", nombre: "Tipo de operación", fuente: "tipoOperacion" },
  { campo: 3, xml: "RFC", nombre: "RFC", fuente: "rfc" },
  { campo: 4, xml: "NumIdFiscal", nombre: "Número de ID fiscal (extranjeros)", fuente: "vacia" },
  { campo: 5, xml: "NombreExtranjero", nombre: "Nombre del extranjero", fuente: "vacia" },
  { campo: 6, xml: "PaisResidencia", nombre: "País o jurisdicción de residencia fiscal", fuente: "vacia" },
  { campo: 7, xml: "LugarJurisdiccion", nombre: "Lugar de jurisdicción fiscal", fuente: "vacia" },
  { campo: 8, xml: "ValorActos16", nombre: "Valor de los actos o actividades pagados a la tasa del 16%", fuente: "base16" },
  { campo: 9, xml: "ValorActos8", nombre: "Valor de los actos o actividades pagados a la tasa del 8% (región fronteriza)", fuente: "base8" },
  { campo: 10, xml: "IvaNoAcreditable16", nombre: "IVA pagado no acreditable a la tasa del 16%", fuente: "vacia" },
  { campo: 11, xml: "IvaNoAcreditable8", nombre: "IVA pagado no acreditable a la tasa del 8%", fuente: "vacia" },
  { campo: 12, xml: "ValorImportacion16", nombre: "Valor de los actos pagados en importación a la tasa del 16%", fuente: "vacia" },
  { campo: 13, xml: "IvaNoAcreditableImportacion", nombre: "IVA pagado no acreditable en importación", fuente: "vacia" },
  { campo: 14, xml: "ValorImportacionExenta", nombre: "Valor de los actos pagados en importación exentos o a tasa 0%", fuente: "vacia" },
  { campo: 15, xml: "ValorActos0", nombre: "Valor de los demás actos o actividades pagados a la tasa del 0%", fuente: "base0" },
  { campo: 16, xml: "ValorExentos", nombre: "Valor de los actos o actividades pagados por los que no se pagará el IVA (exentos)", fuente: "exento" },
  { campo: 17, xml: "IvaRetenido", nombre: "IVA retenido por el contribuyente", fuente: "vacia" },
  { campo: 18, xml: "IvaDevoluciones", nombre: "IVA correspondiente a devoluciones, descuentos y bonificaciones", fuente: "vacia" },
];

export interface RenglonDiotLayout {
  readonly tipoTercero: DiotTipoTercero;
  readonly tipoOperacion: DiotTipoOperacion;
  readonly rfc: string;
  /** Valores en pesos enteros (MXN). */
  readonly valorActos16: number;
  readonly valorActos8: number;
  readonly valorActos0: number;
  readonly valorExentos: number;
}

export interface DiotOmitido {
  readonly rfc: string;
  readonly motivo: "rfc_generico" | "rfc_invalido" | "sin_valor_tras_redondeo";
}

export interface DiotLayout {
  readonly version: typeof LAYOUT_DIOT_VERSION;
  readonly periodo: string;
  readonly rfcContribuyente: string;
  readonly renglones: readonly RenglonDiotLayout[];
  readonly omitidos: readonly DiotOmitido[];
  readonly advertencias: readonly string[];
  readonly txt: string;
  readonly xml: string;
}

export class DiotLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiotLayoutError";
  }
}

// RFC persona moral (12) / física (13): letras (incl. Ñ y &) + fecha + homoclave.
const RFC_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;
const PERIODO_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function esRfcValidoDiot(rfc: string): boolean {
  return RFC_RE.test(rfc);
}

/** Mitad hacia arriba a pesos enteros, sobre centavos ya enteros para evitar el ruido binario. */
export function redondearPesos(centavos: number): number {
  return Math.floor((centavos + 50) / 100);
}

function aCentavos(n: number): number {
  return Math.round((n + Number.EPSILON) * 100);
}

type TasaBucket = "base16" | "base8" | "base0" | "exento";

function bucketTasa(tasaIva: number): TasaBucket {
  if (Math.abs(tasaIva - 0.16) < 0.001) return "base16";
  if (Math.abs(tasaIva - 0.08) < 0.001) return "base8";
  if (Math.abs(tasaIva) < 0.001) return "base0";
  return "exento";
}

export function construirDiotLayout(candidatos: readonly RegistroDiotCandidato[], rfcContribuyente: string, periodo: string): DiotLayout {
  if (!PERIODO_RE.test(periodo)) throw new DiotLayoutError("periodo: se esperaba el formato YYYY-MM.");
  const rfcDeclarante = rfcContribuyente.trim().toUpperCase();
  if (!esRfcValidoDiot(rfcDeclarante)) throw new DiotLayoutError("RFC del contribuyente inválido para la DIOT.");

  interface Acc { rfc: string; tipoOperacion: DiotTipoOperacion; base16: number; base8: number; base0: number; exento: number }
  const grupos = new Map<string, Acc>();
  const omitidos: DiotOmitido[] = [];
  const omitidosVistos = new Set<string>();
  const omitir = (rfc: string, motivo: DiotOmitido["motivo"]) => {
    const k = `${rfc}|${motivo}`;
    if (omitidosVistos.has(k)) return;
    omitidosVistos.add(k);
    omitidos.push({ rfc, motivo });
  };

  for (const c of candidatos) {
    const rfc = c.rfcEmisor.trim().toUpperCase();
    if (esRfcGenerico(rfc)) {
      omitir(rfc, "rfc_generico");
      continue;
    }
    if (!esRfcValidoDiot(rfc)) {
      omitir(rfc, "rfc_invalido");
      continue;
    }
    const tipoOperacion = resolverTipoOperacion(c);
    const key = `${rfc}|${tipoOperacion}`;
    let g = grupos.get(key);
    if (!g) {
      g = { rfc, tipoOperacion, base16: 0, base8: 0, base0: 0, exento: 0 };
      grupos.set(key, g);
    }
    // Base en MXN con centavos (subtotal × tipo de cambio), igual que `agregarDiot`.
    g[bucketTasa(c.tasaIva)] += aCentavos(c.subtotal * c.tipoCambio);
  }

  const renglones: RenglonDiotLayout[] = [];
  for (const g of [...grupos.values()].sort((a, b) => (a.rfc === b.rfc ? (a.tipoOperacion < b.tipoOperacion ? -1 : 1) : a.rfc < b.rfc ? -1 : 1))) {
    const r: RenglonDiotLayout = {
      tipoTercero: "04",
      tipoOperacion: g.tipoOperacion,
      rfc: g.rfc,
      valorActos16: redondearPesos(g.base16),
      valorActos8: redondearPesos(g.base8),
      valorActos0: redondearPesos(g.base0),
      valorExentos: redondearPesos(g.exento),
    };
    if (r.valorActos16 === 0 && r.valorActos8 === 0 && r.valorActos0 === 0 && r.valorExentos === 0) {
      omitir(g.rfc, "sin_valor_tras_redondeo");
      continue;
    }
    renglones.push(r);
  }

  const advertencias: string[] = [];
  if (renglones.length === 0) advertencias.push("No hay terceros reportables en el periodo: el archivo no contiene renglones.");
  if (omitidos.some((o) => o.motivo === "rfc_generico")) advertencias.push("Se omitieron operaciones con RFC genérico (XAXX/XEXX): la DIOT exige el RFC o ID fiscal real del tercero.");
  if (omitidos.some((o) => o.motivo === "rfc_invalido")) advertencias.push("Se omitieron terceros con RFC de formato inválido; corrígelos en el CFDI antes de declarar.");
  advertencias.push("IVA retenido, IVA no acreditable, importaciones y devoluciones/descuentos no se persisten por CFDI: salen vacíos y deben capturarse a mano si aplican.");
  advertencias.push("Solo se generan terceros nacionales (tipo 04); proveedores extranjeros (05) y globales (15) deben capturarse a mano.");
  advertencias.push(`Layout ${LAYOUT_DIOT_VERSION}: valídalo con el validador oficial del SAT antes de cargarlo. Este archivo no está firmado ni se envía.`);

  return {
    version: LAYOUT_DIOT_VERSION,
    periodo,
    rfcContribuyente: rfcDeclarante,
    renglones,
    omitidos,
    advertencias,
    txt: generarDiotTxt(renglones),
    xml: generarDiotXml(renglones, rfcDeclarante, periodo),
  };
}

function valorCelda(r: RenglonDiotLayout, fuente: DiotCeldaFuente): string {
  switch (fuente) {
    case "tipoTercero": return r.tipoTercero;
    case "tipoOperacion": return r.tipoOperacion;
    case "rfc": return r.rfc;
    case "base16": return r.valorActos16 === 0 ? "" : String(r.valorActos16);
    case "base8": return r.valorActos8 === 0 ? "" : String(r.valorActos8);
    case "base0": return r.valorActos0 === 0 ? "" : String(r.valorActos0);
    case "exento": return r.valorExentos === 0 ? "" : String(r.valorExentos);
    case "vacia": return "";
  }
}

/** Una línea por tercero, campos separados por "|", fin de línea CRLF (como el
 * archivo de carga batch), sin encabezado. */
export function generarDiotTxt(renglones: readonly RenglonDiotLayout[]): string {
  return renglones.map((r) => COLUMNAS_DIOT.map((c) => valorCelda(r, c.fuente)).join("|") + "\r\n").join("");
}

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** XML sin firma con los mismos campos que el TXT. Los campos sin valor se omiten. */
export function generarDiotXml(renglones: readonly RenglonDiotLayout[], rfcContribuyente: string, periodo: string): string {
  const [anio, mes] = periodo.split("-");
  const filas = renglones
    .map((r) => {
      const campos = COLUMNAS_DIOT.map((c) => ({ c, v: valorCelda(r, c.fuente) }))
        .filter((x) => x.v !== "")
        .map((x) => `      <${x.c.xml}>${escXml(x.v)}</${x.c.xml}>`)
        .join("\n");
      return `    <Tercero>\n${campos}\n    </Tercero>`;
    })
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<DIOT version="${LAYOUT_DIOT_VERSION}" rfc="${escXml(rfcContribuyente)}" ejercicio="${anio}" periodo="${mes}" firmado="false">\n` +
    `  <Terceros>\n${filas}${filas ? "\n" : ""}  </Terceros>\n` +
    `</DIOT>\n`
  );
}
