// Catálogo de cuentas Anexo 24 (CUC) del SAT — puerto de
// `b2b_ai/services/catalogo_cuentas.py::CatalogoCuentas`.
//
// Funcional (sin clase con estado mutable), mismo estilo que
// `migracion-catalogo/matching.ts` y `bookkeeping/rules-engine.ts`: el
// catálogo se pasa explícito por parámetro en vez de vivir en `this.cuentas`
// mutable.
//
// FUERA DE ALCANCE (deliberado, documentado): `importar_csv`/
// `importar_excel` del original leen archivos del disco (I/O de filesystem,
// `csv.Sniffer`, `openpyxl`) — inconsistente con el resto de
// `domain-despachos` (motores puros, sin I/O; la capa que sí hace I/O vive
// fuera de este paquete). Lo que SÍ se porta 1:1 es la lógica real que esas
// funciones delegaban en `_merge_cuentas` (REQ-MIG-017): `mergeCuentas`
// recibe las cuentas YA PARSEADAS (de un CSV, un XLSX, o cualquier otro
// origen) y aplica exactamente la misma semántica de fusión — parsear el
// archivo es responsabilidad de la capa con I/O.
import type { CuentaAnexo24, NaturalezaCuenta } from "./types.ts";

export const NATURALEZAS_VALIDAS: readonly NaturalezaCuenta[] = ["D", "A"];

// Catálogo por defecto (Código Agrupador SAT / NT 2026, simplificado) —
// puerto EXACTO de `_CATALOGO_BASE` (mismos códigos, descripciones, niveles,
// naturalezas y grupos).
export const CATALOGO_ANEXO24_BASE: readonly CuentaAnexo24[] = [
  { codigo: "1000", descripcion: "ACTIVO", nivel: 1, naturaleza: "D", grupo: "ACTIVO" },
  { codigo: "1100", descripcion: "ACTIVO CIRCULANTE", nivel: 2, naturaleza: "D", grupo: "ACTIVO" },
  { codigo: "1101", descripcion: "BANCOS", nivel: 3, naturaleza: "D", grupo: "ACTIVO" },
  { codigo: "1102", descripcion: "CLIENTES", nivel: 3, naturaleza: "D", grupo: "ACTIVO" },
  { codigo: "1103", descripcion: "IVA ACREDITABLE", nivel: 3, naturaleza: "D", grupo: "ACTIVO" },
  { codigo: "1104", descripcion: "INVENTARIOS", nivel: 3, naturaleza: "D", grupo: "ACTIVO" },
  { codigo: "1200", descripcion: "ACTIVO FIJO", nivel: 2, naturaleza: "D", grupo: "ACTIVO" },
  { codigo: "1201", descripcion: "MOBILIARIO Y EQUIPO", nivel: 3, naturaleza: "D", grupo: "ACTIVO" },
  { codigo: "1202", descripcion: "EQUIPO DE COMPUTO", nivel: 3, naturaleza: "D", grupo: "ACTIVO" },
  { codigo: "1300", descripcion: "ACTIVOS DIFERIDOS", nivel: 2, naturaleza: "D", grupo: "ACTIVO" },
  { codigo: "2000", descripcion: "PASIVO", nivel: 1, naturaleza: "A", grupo: "PASIVO" },
  { codigo: "2100", descripcion: "PASIVO CIRCULANTE", nivel: 2, naturaleza: "A", grupo: "PASIVO" },
  { codigo: "2101", descripcion: "PROVEEDORES", nivel: 3, naturaleza: "A", grupo: "PASIVO" },
  { codigo: "2102", descripcion: "ACREEDORES DIVERSOS", nivel: 3, naturaleza: "A", grupo: "PASIVO" },
  { codigo: "2103", descripcion: "IVA POR ACREDITAR", nivel: 3, naturaleza: "A", grupo: "PASIVO" },
  { codigo: "2104", descripcion: "IMPUESTOS POR PAGAR", nivel: 3, naturaleza: "A", grupo: "PASIVO" },
  { codigo: "2200", descripcion: "PASIVO A LARGO PLAZO", nivel: 2, naturaleza: "A", grupo: "PASIVO" },
  { codigo: "3000", descripcion: "CAPITAL CONTABLE", nivel: 1, naturaleza: "A", grupo: "CAPITAL" },
  { codigo: "3100", descripcion: "CAPITAL SOCIAL", nivel: 2, naturaleza: "A", grupo: "CAPITAL" },
  { codigo: "3200", descripcion: "RESULTADOS ACUMULADOS", nivel: 2, naturaleza: "A", grupo: "CAPITAL" },
  { codigo: "4000", descripcion: "INGRESOS", nivel: 1, naturaleza: "A", grupo: "INGRESOS" },
  { codigo: "4100", descripcion: "INGRESOS POR SERVICIOS", nivel: 2, naturaleza: "A", grupo: "INGRESOS" },
  { codigo: "4200", descripcion: "OTROS INGRESOS", nivel: 2, naturaleza: "A", grupo: "INGRESOS" },
  { codigo: "5000", descripcion: "COSTOS", nivel: 1, naturaleza: "D", grupo: "COSTOS" },
  { codigo: "5100", descripcion: "COSTO DE VENTAS", nivel: 2, naturaleza: "D", grupo: "COSTOS" },
  { codigo: "6000", descripcion: "GASTOS", nivel: 1, naturaleza: "D", grupo: "GASTOS" },
  { codigo: "6100", descripcion: "GASTOS DE OPERACION", nivel: 2, naturaleza: "D", grupo: "GASTOS" },
  { codigo: "6101", descripcion: "SUELDOS Y SALARIOS", nivel: 3, naturaleza: "D", grupo: "GASTOS" },
  { codigo: "6102", descripcion: "GASTOS ADMINISTRATIVOS", nivel: 3, naturaleza: "D", grupo: "GASTOS" },
  { codigo: "6103", descripcion: "GASTOS FINANCIEROS", nivel: 3, naturaleza: "D", grupo: "GASTOS" },
  { codigo: "6200", descripcion: "GASTOS NO DEDUCIBLES", nivel: 2, naturaleza: "D", grupo: "GASTOS" },
] as const;

// Mapeo categoría de factura del agente -> cuenta contable por defecto —
// puerto EXACTO de `CATEGORIA_A_CUENTA`. DISTINTO de
// `bookkeeping/catalogo.ts::DEFAULT_MAPPINGS` (ese mapea `tipoCfdi|categoria`
// -> cargo/abono de 7 dígitos para generar pólizas; este mapea una
// categoría suelta -> UNA cuenta de 4 dígitos del catálogo Anexo 24, uso
// distinto en el origen).
export const CATEGORIA_A_CUENTA_ANEXO24: Readonly<Record<string, string>> = {
  gasto_operativo: "6102",
  inversion: "1202",
  activo_fijo: "1201",
  nomina: "6101",
  ingreso: "4100",
  venta: "4100",
  servicios: "4100",
  costo: "5100",
  impuestos: "2104",
  desconocido: "6102",
};

/** Copia mutable del catálogo por defecto — para que un llamador pueda
 * partir de él y pasarlo por `mergeCuentas` sin mutar la constante
 * exportada. */
export function crearCatalogoBase(): CuentaAnexo24[] {
  return CATALOGO_ANEXO24_BASE.map((c) => ({ ...c }));
}

/** `CatalogoCuentas.find`. */
export function findCuenta(catalogo: readonly CuentaAnexo24[], codigo: string): CuentaAnexo24 | null {
  const cod = String(codigo);
  return catalogo.find((c) => c.codigo === cod) ?? null;
}

/** `CatalogoCuentas.errores` — mismo orden y mismos mensajes que el
 * origen. */
export function erroresCatalogo(catalogo: readonly CuentaAnexo24[]): readonly string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  for (const c of catalogo) {
    if (!c.codigo || !String(c.codigo).trim()) {
      errs.push("Cuenta sin código.");
      continue;
    }
    if (seen.has(String(c.codigo))) errs.push(`Código duplicado: ${c.codigo}`);
    seen.add(String(c.codigo));
    if (!c.descripcion || !String(c.descripcion).trim()) errs.push(`Cuenta ${c.codigo} sin descripción.`);
    const nivel = Number(c.nivel);
    if (!Number.isFinite(nivel)) {
      errs.push(`Cuenta ${c.codigo} con nivel inválido: ${JSON.stringify(c.nivel)}`);
    } else if (nivel < 1) {
      errs.push(`Cuenta ${c.codigo} con nivel < 1.`);
    }
    if (!NATURALEZAS_VALIDAS.includes(String(c.naturaleza).toUpperCase() as NaturalezaCuenta)) {
      errs.push(`Cuenta ${c.codigo} con naturaleza inválida: ${JSON.stringify(c.naturaleza)}`);
    }
  }
  return errs;
}

/** `CatalogoCuentas.validar` — lanza `Error` con el detalle si hay
 * errores. */
export function validarCatalogo(catalogo: readonly CuentaAnexo24[]): void {
  const errs = erroresCatalogo(catalogo);
  if (errs.length > 0) throw new Error(`Catálogo inválido: ${errs.join("; ")}`);
}

/** `CatalogoCuentas._merge_cuentas` — REQ-MIG-017: nunca borra una cuenta
 * existente solo porque `nuevas` no la mencione. Cuentas con el mismo código
 * se actualizan in place (mismo índice); cuentas con código nuevo se agregan
 * al final. */
export function mergeCuentas(catalogo: readonly CuentaAnexo24[], nuevas: readonly CuentaAnexo24[]): CuentaAnexo24[] {
  const resultado = catalogo.map((c) => ({ ...c }));
  const indicePorCodigo = new Map<string, number>();
  resultado.forEach((c, i) => indicePorCodigo.set(c.codigo, i));

  for (const nueva of nuevas) {
    const idx = indicePorCodigo.get(nueva.codigo);
    if (idx !== undefined) {
      resultado[idx] = { ...nueva };
    } else {
      indicePorCodigo.set(nueva.codigo, resultado.length);
      resultado.push({ ...nueva });
    }
  }
  return resultado;
}

/** `CatalogoCuentas.asignar_automatico` — asigna cuentas del catálogo a las
 * clasificaciones del agente; usa el mapeo por defecto cuando la
 * clasificación no especifica cuenta o la cuenta no existe en el
 * catálogo. */
export function asignarAutomatico(catalogo: readonly CuentaAnexo24[], clasificaciones: Readonly<Record<string, string | null | undefined>> | null | undefined): Record<string, string> {
  const asignacion: Record<string, string> = {};
  for (const [cat, cuenta] of Object.entries(clasificaciones ?? {})) {
    const key = cat.toLowerCase();
    if (!cuenta) {
      asignacion[key] = CATEGORIA_A_CUENTA_ANEXO24[key] ?? "6102";
    } else if (findCuenta(catalogo, cuenta)) {
      asignacion[key] = String(cuenta);
    } else {
      asignacion[key] = CATEGORIA_A_CUENTA_ANEXO24[key] ?? "6102";
    }
  }
  return asignacion;
}

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export interface OpcionesXmlCatalogo {
  readonly rfc?: string;
  readonly ejercicio: number;
  readonly mes: number;
  /** "YYYY-MM-DDTHH:MM:SS" — DESVIACIÓN DE FIDELIDAD (documentada): el
   * original defaultea este campo a `datetime.now()` (lectura del reloj de
   * sistema dentro del generador de XML fiscal). Este puerto lo exige
   * explícito, mismo criterio que `nomina/xml-nomina.ts` (motor puro y
   * determinista; la capa con I/O decide qué timestamp usar). */
  readonly fechaModificacion: string;
}

/** `CatalogoCuentas.generar_xml` — XML del catálogo conforme al XSD del SAT
 * (`CatalogoCuentas_1_3.xsd`). Valida el catálogo antes de generar (igual
 * que el origen, que llama `self.validar()` al inicio). */
export function generarXmlCatalogo(catalogo: readonly CuentaAnexo24[], opciones: OpcionesXmlCatalogo): string {
  validarCatalogo(catalogo);
  const rfc = opciones.rfc ?? "";
  const mesS = String(opciones.mes).padStart(2, "0");
  const esc = (v: string) => escapeXmlAttr(v);

  const ctas = catalogo
    .slice()
    .sort((a, b) => (a.codigo < b.codigo ? -1 : a.codigo > b.codigo ? 1 : 0))
    .map((c) => `      <Cat:Cta NumCta="${esc(c.codigo)}" Desc="${esc(c.descripcion)}" Nivel="${c.nivel}" Natur="${esc(c.naturaleza.toUpperCase())}"/>`)
    .join("\n");

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Cat:Catalogo xmlns:Cat="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xsi:schemaLocation="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas ' +
    'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas/CatalogoCuentas_1_3.xsd" ' +
    `Version="1.3" RFC="${esc(rfc)}" Anio="${opciones.ejercicio}" Mes="${mesS}" ` +
    `FechaModificacion="${esc(opciones.fechaModificacion)}" Sello="" noCertificado="" Certificado="">\n` +
    `  <Cat:Ctas>\n${ctas}\n  </Cat:Ctas>\n` +
    "</Cat:Catalogo>\n"
  );
}
