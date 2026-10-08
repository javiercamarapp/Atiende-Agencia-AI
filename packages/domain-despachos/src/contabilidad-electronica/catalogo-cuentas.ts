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
import { esCodigoAgrupadorSat } from "./codigos-agrupadores.ts";
import type { CuentaAnexo24, NaturalezaCuenta } from "./types.ts";
import { escaparAtributoXml, exigirEjercicioYMes, exigirRfcSat, mesDosDigitos, recortarTexto } from "./xml-comun.ts";

export const NATURALEZAS_VALIDAS: readonly NaturalezaCuenta[] = ["D", "A"];

// Catálogo por defecto (Código Agrupador SAT / NT 2026, simplificado) —
// puerto EXACTO de `_CATALOGO_BASE` (mismos códigos, descripciones, niveles,
// naturalezas y grupos).
// SubCtaDe y CodAgrup de este catálogo heredado del origen son PROPUESTAS (todas válidas en la lista cerrada del XSD, comprobado en
// tests/contabilidad-electronica-xsd.spec.ts) que el fiscalista debe validar: el origen no trae código agrupador.
export const CATALOGO_ANEXO24_BASE: readonly CuentaAnexo24[] = [
  { codigo: "1000", descripcion: "ACTIVO", nivel: 1, naturaleza: "D", grupo: "ACTIVO", codAgrup: "100" },
  { codigo: "1100", descripcion: "ACTIVO CIRCULANTE", nivel: 2, naturaleza: "D", grupo: "ACTIVO", subCtaDe: "1000", codAgrup: "100.01" },
  { codigo: "1101", descripcion: "BANCOS", nivel: 3, naturaleza: "D", grupo: "ACTIVO", subCtaDe: "1100", codAgrup: "102.01" },
  { codigo: "1102", descripcion: "CLIENTES", nivel: 3, naturaleza: "D", grupo: "ACTIVO", subCtaDe: "1100", codAgrup: "105.01" },
  { codigo: "1103", descripcion: "IVA ACREDITABLE", nivel: 3, naturaleza: "D", grupo: "ACTIVO", subCtaDe: "1100", codAgrup: "118.01" },
  { codigo: "1104", descripcion: "INVENTARIOS", nivel: 3, naturaleza: "D", grupo: "ACTIVO", subCtaDe: "1100", codAgrup: "115.01" },
  { codigo: "1200", descripcion: "ACTIVO FIJO", nivel: 2, naturaleza: "D", grupo: "ACTIVO", subCtaDe: "1000", codAgrup: "151" },
  { codigo: "1201", descripcion: "MOBILIARIO Y EQUIPO", nivel: 3, naturaleza: "D", grupo: "ACTIVO", subCtaDe: "1200", codAgrup: "155.01" },
  { codigo: "1202", descripcion: "EQUIPO DE COMPUTO", nivel: 3, naturaleza: "D", grupo: "ACTIVO", subCtaDe: "1200", codAgrup: "156.01" },
  { codigo: "1300", descripcion: "ACTIVOS DIFERIDOS", nivel: 2, naturaleza: "D", grupo: "ACTIVO", subCtaDe: "1000", codAgrup: "190" },
  { codigo: "2000", descripcion: "PASIVO", nivel: 1, naturaleza: "A", grupo: "PASIVO", codAgrup: "200" },
  { codigo: "2100", descripcion: "PASIVO CIRCULANTE", nivel: 2, naturaleza: "A", grupo: "PASIVO", subCtaDe: "2000", codAgrup: "200.01" },
  { codigo: "2101", descripcion: "PROVEEDORES", nivel: 3, naturaleza: "A", grupo: "PASIVO", subCtaDe: "2100", codAgrup: "201.01" },
  { codigo: "2102", descripcion: "ACREEDORES DIVERSOS", nivel: 3, naturaleza: "A", grupo: "PASIVO", subCtaDe: "2100", codAgrup: "205.01" },
  { codigo: "2103", descripcion: "IVA POR ACREDITAR", nivel: 3, naturaleza: "A", grupo: "PASIVO", subCtaDe: "2100", codAgrup: "119.01" },
  { codigo: "2104", descripcion: "IMPUESTOS POR PAGAR", nivel: 3, naturaleza: "A", grupo: "PASIVO", subCtaDe: "2100", codAgrup: "213.01" },
  { codigo: "2200", descripcion: "PASIVO A LARGO PLAZO", nivel: 2, naturaleza: "A", grupo: "PASIVO", subCtaDe: "2000", codAgrup: "251" },
  { codigo: "3000", descripcion: "CAPITAL CONTABLE", nivel: 1, naturaleza: "A", grupo: "CAPITAL", codAgrup: "300" },
  { codigo: "3100", descripcion: "CAPITAL SOCIAL", nivel: 2, naturaleza: "A", grupo: "CAPITAL", subCtaDe: "3000", codAgrup: "301.01" },
  { codigo: "3200", descripcion: "RESULTADOS ACUMULADOS", nivel: 2, naturaleza: "A", grupo: "CAPITAL", subCtaDe: "3000", codAgrup: "305.01" },
  { codigo: "4000", descripcion: "INGRESOS", nivel: 1, naturaleza: "A", grupo: "INGRESOS", codAgrup: "400" },
  { codigo: "4100", descripcion: "INGRESOS POR SERVICIOS", nivel: 2, naturaleza: "A", grupo: "INGRESOS", subCtaDe: "4000", codAgrup: "401.01" },
  { codigo: "4200", descripcion: "OTROS INGRESOS", nivel: 2, naturaleza: "A", grupo: "INGRESOS", subCtaDe: "4000", codAgrup: "403.01" },
  { codigo: "5000", descripcion: "COSTOS", nivel: 1, naturaleza: "D", grupo: "COSTOS", codAgrup: "500" },
  { codigo: "5100", descripcion: "COSTO DE VENTAS", nivel: 2, naturaleza: "D", grupo: "COSTOS", subCtaDe: "5000", codAgrup: "501.01" },
  { codigo: "6000", descripcion: "GASTOS", nivel: 1, naturaleza: "D", grupo: "GASTOS", codAgrup: "600" },
  { codigo: "6100", descripcion: "GASTOS DE OPERACION", nivel: 2, naturaleza: "D", grupo: "GASTOS", subCtaDe: "6000", codAgrup: "601" },
  { codigo: "6101", descripcion: "SUELDOS Y SALARIOS", nivel: 3, naturaleza: "D", grupo: "GASTOS", subCtaDe: "6100", codAgrup: "601.01" },
  { codigo: "6102", descripcion: "GASTOS ADMINISTRATIVOS", nivel: 3, naturaleza: "D", grupo: "GASTOS", subCtaDe: "6100", codAgrup: "603" },
  { codigo: "6103", descripcion: "GASTOS FINANCIEROS", nivel: 3, naturaleza: "D", grupo: "GASTOS", subCtaDe: "6100", codAgrup: "701" },
  { codigo: "6200", descripcion: "GASTOS NO DEDUCIBLES", nivel: 2, naturaleza: "D", grupo: "GASTOS", subCtaDe: "6000", codAgrup: "601.84" },
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

/** Una cuenta que el generador no puede declarar porque le falta el código agrupador del SAT. */
export interface CuentaSinCodigoAgrupador {
  readonly codigo: string;
  readonly descripcion: string;
  /** `faltante` = sin código; `invalido` = trae uno que no está en la lista cerrada del Anexo 24. */
  readonly motivo: "faltante" | "invalido";
}

/** El catálogo trae cuentas sin código agrupador (CodAgrup es obligatorio en CADA cuenta del XSD): no se genera el XML y se devuelve la lista. */
export class CatalogoSinCodigoAgrupadorError extends Error {
  readonly cuentas: readonly CuentaSinCodigoAgrupador[];
  constructor(cuentas: readonly CuentaSinCodigoAgrupador[]) {
    super(`El catálogo tiene ${cuentas.length} cuenta(s) sin código agrupador del SAT válido: asígnalo en la pestaña Catálogo antes de generar el XML.`);
    this.name = "CatalogoSinCodigoAgrupadorError";
    this.cuentas = cuentas;
  }
}

/** Cuentas a las que les falta un código agrupador válido (vacío o fuera de la lista cerrada). */
export function cuentasSinCodigoAgrupador(catalogo: readonly CuentaAnexo24[]): readonly CuentaSinCodigoAgrupador[] {
  const out: CuentaSinCodigoAgrupador[] = [];
  for (const c of catalogo) {
    const cod = c.codAgrup;
    if (cod === undefined || cod === null || String(cod).trim() === "") out.push({ codigo: c.codigo, descripcion: c.descripcion, motivo: "faltante" });
    else if (!esCodigoAgrupadorSat(String(cod).trim())) out.push({ codigo: c.codigo, descripcion: c.descripcion, motivo: "invalido" });
  }
  return out;
}

/** Errores de jerarquía que el XSD no puede expresar pero el SAT exige: `SubCtaDe` obligatorio para nivel > 1, que exista y sea de nivel n-1. */
export function erroresJerarquiaCatalogo(catalogo: readonly CuentaAnexo24[]): readonly string[] {
  const errs: string[] = [];
  const porCodigo = new Map(catalogo.map((c) => [c.codigo, c] as const));
  for (const c of catalogo) {
    const padre = c.subCtaDe ? String(c.subCtaDe) : null;
    if (c.nivel > 1 && !padre) {
      errs.push(`Cuenta ${c.codigo} de nivel ${c.nivel} sin cuenta padre (SubCtaDe).`);
      continue;
    }
    if (c.nivel === 1 && padre) errs.push(`Cuenta ${c.codigo} de nivel 1 no lleva cuenta padre (SubCtaDe).`);
    if (padre) {
      const p = porCodigo.get(padre);
      if (!p) errs.push(`Cuenta ${c.codigo}: su cuenta padre ${padre} no está en el catálogo.`);
      else if (p.nivel !== c.nivel - 1) errs.push(`Cuenta ${c.codigo}: su cuenta padre ${padre} debe ser de nivel ${c.nivel - 1}.`);
    }
  }
  return errs;
}

export interface OpcionesXmlCatalogo {
  /** RFC del contribuyente que envía (se valida contra el patrón del XSD). */
  readonly rfc: string;
  readonly ejercicio: number;
  readonly mes: number;
}

/**
 * Catálogo de cuentas conforme a `CatalogoCuentas_1_3.xsd` (validado en las pruebas contra el XSD oficial). Estructura del XSD: la raíz
 * `Catalogo` contiene una secuencia de nodos `Ctas` (uno por cuenta) con CodAgrup, NumCta, Desc, SubCtaDe (si nivel > 1), Nivel y Natur.
 *
 * Decisiones documentadas:
 *  - NO hay `FechaModificacion` (no existe en el XSD 1.3) -- el generador heredado la emitía y el XML no era conforme.
 *  - Sello, noCertificado y Certificado son OPCIONALES en el XSD y se OMITEN: emitirlos vacíos violaba el XSD (noCertificado exige 20
 *    posiciones). Los llena el firmado con e.firma, que esta aplicación no hace (el envío al SAT es humano, D-18).
 *  - Se niega a generar si alguna cuenta no tiene un código agrupador válido (CatalogoSinCodigoAgrupadorError) o si la jerarquía es incoherente.
 */
export function generarXmlCatalogo(catalogo: readonly CuentaAnexo24[], opciones: OpcionesXmlCatalogo): string {
  validarCatalogo(catalogo);
  const rfc = exigirRfcSat(opciones.rfc);
  exigirEjercicioYMes(opciones.ejercicio, opciones.mes);
  const sinCodigo = cuentasSinCodigoAgrupador(catalogo);
  if (sinCodigo.length > 0) throw new CatalogoSinCodigoAgrupadorError(sinCodigo);
  const jerarquia = erroresJerarquiaCatalogo(catalogo);
  if (jerarquia.length > 0) throw new Error(`Catálogo inválido: ${jerarquia.join("; ")}`);
  const esc = escaparAtributoXml;

  const ctas = catalogo
    .slice()
    .sort((a, b) => (a.codigo < b.codigo ? -1 : a.codigo > b.codigo ? 1 : 0))
    .map((c) => {
      const subCtaDe = c.nivel > 1 && c.subCtaDe ? ` SubCtaDe="${esc(String(c.subCtaDe))}"` : "";
      return `  <catalogocuentas:Ctas CodAgrup="${esc(String(c.codAgrup).trim())}" NumCta="${esc(c.codigo)}" Desc="${esc(recortarTexto(c.descripcion, 400))}"${subCtaDe} Nivel="${c.nivel}" Natur="${esc(c.naturaleza.toUpperCase())}"/>`;
    })
    .join("\n");

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<catalogocuentas:Catalogo xmlns:catalogocuentas="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xsi:schemaLocation="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas ' +
    'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas/CatalogoCuentas_1_3.xsd" ' +
    `Version="1.3" RFC="${esc(rfc)}" Mes="${mesDosDigitos(opciones.mes)}" Anio="${opciones.ejercicio}">\n` +
    `${ctas}\n` +
    "</catalogocuentas:Catalogo>\n"
  );
}
