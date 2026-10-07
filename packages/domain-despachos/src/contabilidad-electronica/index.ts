// Barrel de contabilidad electrónica SAT (Anexo 24) — cierre del gap de
// auditoría "Motor de contabilidad electrónica SAT (catálogo/balanza/
// pólizas, XML Anexo 24)". Ver nota sobre "pólizas" en `types.ts`: el
// generador de pólizas Anexo 24 no existe en el origen Python, así que no se
// porta (no se fabrica una regla fiscal que el origen no tiene). Lo que sí
// se porta: catálogo de cuentas + balanza de comprobación (ambos con XML
// real conforme al XSD del SAT) + el orquestador de estado del paquete.
//
// Sigue, y seguirá, fuera de alcance de este módulo (mismo criterio que
// `nomina/index.ts`): el SELLADO/TIMBRADO real ante el SAT, RPA al portal
// del SAT, y la persistencia del paquete/`package_id` (a cargo de un
// repositorio de más arriba).
export { NATURALEZAS_VALIDAS, CATALOGO_ANEXO24_BASE, CATEGORIA_A_CUENTA_ANEXO24, crearCatalogoBase, findCuenta, erroresCatalogo, validarCatalogo, mergeCuentas, asignarAutomatico, generarXmlCatalogo, cuentasSinCodigoAgrupador, erroresJerarquiaCatalogo, CatalogoSinCodigoAgrupadorError } from "./catalogo-cuentas.ts";
export type { OpcionesXmlCatalogo, CuentaSinCodigoAgrupador } from "./catalogo-cuentas.ts";

export { acumularAsientos, generarBalanza, resumenBalanza, validarCuadratura, detectarSaldosAnomalos, generarXmlBalanza } from "./balanza.ts";
export type { TipoEnvioBalanza, OpcionesXmlBalanza } from "./balanza.ts";

export { calcularHashSha1, generarPaqueteContabilidadElectronica, generarResumenMensual, marcarListoParaTimbrar, marcarTimbrado, marcarEnviado, ESTADOS_PAQUETE_CONTABILIDAD, ESTADO_INICIAL_PAQUETE_CONTABILIDAD } from "./paquete.ts";
export type { DatosGenerarPaquete } from "./paquete.ts";

export type {
  NaturalezaCuenta,
  CuentaAnexo24,
  AsientoContable,
  LineaBalanza,
  LineaBalanzaAnomala,
  ResumenBalanza,
  EstadoPaqueteContabilidad,
  ArchivoContabilidadElectronica,
  PaqueteContabilidadElectronica,
  ResumenMensualContabilidad,
} from "./types.ts";

export { CODIGOS_AGRUPADORES_SAT, CODIGO_AGRUPADOR_FORMATO, esCodigoAgrupadorSat } from "./codigos-agrupadores.ts";
export { ContabilidadElectronicaDatosInvalidosError, RFC_SAT_RE, importeDesdeCentavos } from "./xml-comun.ts";

export { generarXmlPolizasPeriodo, TIPOS_SOLICITUD_POLIZAS, NUM_ORDEN_RE, NUM_TRAMITE_RE } from "./polizas-periodo.ts";
export type { PolizaParaXml, MovimientoParaXml, OpcionesXmlPolizas, TipoSolicitudPolizas } from "./polizas-periodo.ts";

export {
  ImportacionXmlContabilidadError,
  MAX_CUENTAS_IMPORTADAS,
  MAX_PARTIDAS_APERTURA,
  MAX_CARACTERES_XML_CONTABILIDAD,
  leerCatalogoXml,
  leerBalanzaXml,
  importeACentavos,
  fechaAperturaDe,
  construirAperturaDesdeBalanza,
} from "./importar-xml.ts";
export type { CuentaImportada, CuentaRechazada, CatalogoImportado, LineaBalanzaImportada, BalanzaImportada, PartidaApertura, ResultadoApertura } from "./importar-xml.ts";
