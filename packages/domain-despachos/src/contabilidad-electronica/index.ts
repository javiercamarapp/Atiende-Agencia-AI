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
export { NATURALEZAS_VALIDAS, CATALOGO_ANEXO24_BASE, CATEGORIA_A_CUENTA_ANEXO24, crearCatalogoBase, findCuenta, erroresCatalogo, validarCatalogo, mergeCuentas, asignarAutomatico, generarXmlCatalogo } from "./catalogo-cuentas.ts";
export type { OpcionesXmlCatalogo } from "./catalogo-cuentas.ts";

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
