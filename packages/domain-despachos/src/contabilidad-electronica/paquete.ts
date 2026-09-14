// Orquestador del paquete de contabilidad electrónica del SAT — puerto de
// `b2b_ai/services/contabilidad_electronica.py::ContabilidadElectronica`.
// Integra catálogo de cuentas + balanza de comprobación en un solo paquete
// (catálogo XML, balanza XML, hash SHA-1 de cada uno, resumen mensual) y
// lleva el control de estados: borrador -> listo_para_timbrar -> timbrado ->
// enviado.
//
// Funcional y puro (mismo criterio que el resto de `domain-despachos`: sin
// I/O, sin fechas de sistema, sin persistencia). La persistencia opcional
// del original (`db`/`tenant_id`/`_persistir_paquete`, y el almacén en
// memoria por `package_id` de `b2b_ai/features/contabilidad/
// electronica_routes.py`) queda fuera de alcance de este paquete de
// dominio — a cargo de un repositorio de más arriba, mismo patrón que
// `cierre-mensual/engine.ts` deja la persistencia a `repository-types.ts`
// y sus implementaciones.
//
// DESVIACIONES DE FIDELIDAD (documentadas, no aplicadas en silencio):
//
// 1) `ejercicio`/`generadoEn`/`fechaModificacion` del XML son OBLIGATORIOS
//    aquí. El original defaultea `ejercicio` a `datetime.now().year` y
//    `generado_en`/`FechaModificacion` a `datetime.now()` — lecturas del
//    reloj de sistema dentro del motor de dominio, inconsistentes con el
//    resto de este paquete (ver p. ej. `nomina/xml-nomina.ts`, que exige
//    `folio` explícito por la misma razón). La capa con I/O que llama a este
//    módulo decide qué año/timestamp usar cuando el usuario no lo
//    especifica; `mes` SÍ conserva el default `1` del original porque es un
//    default estático, no una lectura de reloj.
//
// 2) `marcarListoParaTimbrar` valida el estado de origen
//    (`borrador`/`listo_para_timbrar`), igual que `marcarTimbrado` y
//    `marcarEnviado`. El `marcar_listo_para_timbrar` original NO tiene
//    ninguna guarda — puede forzar el estado a `listo_para_timbrar` desde
//    CUALQUIER estado, incluso `enviado` (confirmado leyendo el código: la
//    única llamada es `self._avanzar_estado("listo_para_timbrar")`, sin el
//    `if self.estado not in (...)` que sí tienen las otras dos
//    transiciones). Ningún test del origen cubre retroceder un paquete ya
//    `enviado`, así que no hay comportamiento intencional que preservar —
//    se trata como un bug de origen, igual que
//    `cierre-mensual/engine.ts::cerrarPeriodo` ya corrigió y documentó el
//    bug análogo de `close_period` (permitía re-cerrar un período ya
//    `closed`).
import { createHash } from "node:crypto";
import { generarXmlBalanza, generarBalanza } from "./balanza.ts";
import { generarXmlCatalogo } from "./catalogo-cuentas.ts";
import { ESTADOS_PAQUETE_CONTABILIDAD, ESTADO_INICIAL_PAQUETE_CONTABILIDAD } from "./types.ts";
import type { AsientoContable, CuentaAnexo24, EstadoPaqueteContabilidad, PaqueteContabilidadElectronica, ResumenMensualContabilidad } from "./types.ts";
import { TransicionPaqueteContabilidadInvalidaError } from "../errors.ts";

function periodoStr(ejercicio: number, mes: number): string {
  return `${ejercicio}-${String(mes).padStart(2, "0")}`;
}

/** `ContabilidadElectronica.calcular_hash_sha1` — SHA-1 en hexadecimal del
 * contenido (requisito SAT como checksum del archivo de catálogo/balanza;
 * NO es un uso criptográfico de seguridad, mismo criterio que el comentario
 * del origen sobre `usedforsecurity=False`). */
export function calcularHashSha1(contenidoUtf8: string): string {
  return createHash("sha1").update(contenidoUtf8, "utf8").digest("hex");
}

export interface DatosGenerarPaquete {
  readonly catalogo: readonly CuentaAnexo24[];
  readonly rfc?: string;
  readonly razonSocial?: string;
  readonly ejercicio: number;
  /** Default `1`, igual que el origen. */
  readonly mes?: number;
  readonly asientos: readonly AsientoContable[];
  readonly saldosIniciales?: Readonly<Record<string, number | string>> | null;
  /** Timestamp ISO del momento de generación — puerto de `generado_en`
   * (ver DESVIACIÓN 1 de cabecera). */
  readonly generadoEn: string;
  /** "YYYY-MM-DDTHH:MM:SS" usado como `FechaModificacion` en AMBOS XML
   * (catálogo y balanza) — puerto del `datetime.now()` compartido que el
   * original captura una sola vez por llamada a `generar_paquete` (ver
   * DESVIACIÓN 1 de cabecera). */
  readonly fechaModificacionXml: string;
}

/** `ContabilidadElectronica.generar_paquete` — genera el paquete de
 * contabilidad electrónica del mes: balanza (desde los asientos), catálogo y
 * balanza en XML, hash SHA-1 de cada uno. Deja el paquete en estado
 * `listo_para_timbrar` (igual que el origen: `self.estado = ESTADO_INICIAL`
 * al empezar, y `self._avanzar_estado("listo_para_timbrar")` al final —
 * nunca se devuelve un paquete en `borrador`). */
export function generarPaqueteContabilidadElectronica(datos: DatosGenerarPaquete): PaqueteContabilidadElectronica {
  const mes = datos.mes ?? 1;
  const periodo = periodoStr(datos.ejercicio, mes);
  const rfc = datos.rfc ?? "";

  const resumenBalanza = generarBalanza(datos.catalogo, datos.asientos, periodo, datos.saldosIniciales ?? null);

  const xmlCatalogo = generarXmlCatalogo(datos.catalogo, { rfc, ejercicio: datos.ejercicio, mes, fechaModificacion: datos.fechaModificacionXml });
  const xmlBalanza = generarXmlBalanza(resumenBalanza.lineas, { rfc, ejercicio: datos.ejercicio, mes, fechaModificacion: datos.fechaModificacionXml });

  const hashCatalogo = calcularHashSha1(xmlCatalogo);
  const hashBalanza = calcularHashSha1(xmlBalanza);

  return {
    periodo,
    ejercicio: datos.ejercicio,
    mes,
    rfc,
    razonSocial: datos.razonSocial ?? "",
    catalogo: { xml: xmlCatalogo, sha1: hashCatalogo, cuentas: datos.catalogo.length },
    balanza: { xml: xmlBalanza, sha1: hashBalanza, cuadrada: resumenBalanza.cuadrada, cuentas: resumenBalanza.cuentas },
    resumenBalanza,
    estado: "listo_para_timbrar",
    generadoEn: datos.generadoEn,
  };
}

/** `ContabilidadElectronica.generar_resumen_mensual` (rama con `paquete` ya
 * generado — la rama que recalcula una balanza desde `asientos` sueltos,
 * sin paquete, es exactamente `generarBalanza` + armar este mismo shape, así
 * que no se duplica aquí: el llamador que no tiene un paquete usa
 * `generarBalanza` directo). `estadoActual` es el estado ACTUAL del paquete
 * (puede ya haber avanzado más allá del que trae `paquete.estado` — mismo
 * motivo por el que el original separa `self.estado` de `paquete["estado"]`
 * una vez que las transiciones han corrido). */
export function generarResumenMensual(paquete: PaqueteContabilidadElectronica, estadoActual: EstadoPaqueteContabilidad = paquete.estado): ResumenMensualContabilidad {
  const r = paquete.resumenBalanza;
  return {
    periodo: paquete.periodo,
    rfc: paquete.rfc,
    razonSocial: paquete.razonSocial,
    cuentas: r.cuentas,
    totalDebe: r.totalDebe,
    totalHaber: r.totalHaber,
    cuadrada: r.cuadrada,
    saldosAnomalos: r.saldosAnomalos,
    estado: estadoActual,
  };
}

export { ESTADOS_PAQUETE_CONTABILIDAD, ESTADO_INICIAL_PAQUETE_CONTABILIDAD };

/** `ContabilidadElectronica.marcar_listo_para_timbrar` — transición
 * `borrador -> listo_para_timbrar` (idempotente si ya está en
 * `listo_para_timbrar`). Ver DESVIACIÓN 2 de cabecera: el original no
 * valida el estado de origen; aquí sí. */
export function marcarListoParaTimbrar(estadoActual: EstadoPaqueteContabilidad): EstadoPaqueteContabilidad {
  if (estadoActual !== "borrador" && estadoActual !== "listo_para_timbrar") {
    throw new TransicionPaqueteContabilidadInvalidaError(`No se puede marcar "listo para timbrar" desde el estado "${estadoActual}".`);
  }
  return "listo_para_timbrar";
}

/** `ContabilidadElectronica.marcar_timbrado` — transición
 * `listo_para_timbrar -> timbrado` (idempotente si ya está en `timbrado`).
 * Puerto 1:1 del `ValueError` del origen. */
export function marcarTimbrado(estadoActual: EstadoPaqueteContabilidad): EstadoPaqueteContabilidad {
  if (estadoActual !== "listo_para_timbrar" && estadoActual !== "timbrado") {
    throw new TransicionPaqueteContabilidadInvalidaError(`No se puede timbrar desde el estado "${estadoActual}".`);
  }
  return "timbrado";
}

/** `ContabilidadElectronica.marcar_enviado` — transición
 * `timbrado -> enviado` (idempotente si ya está en `enviado`). Puerto 1:1
 * del `ValueError` del origen. */
export function marcarEnviado(estadoActual: EstadoPaqueteContabilidad): EstadoPaqueteContabilidad {
  if (estadoActual !== "timbrado" && estadoActual !== "enviado") {
    throw new TransicionPaqueteContabilidadInvalidaError(`No se puede enviar desde el estado "${estadoActual}".`);
  }
  return "enviado";
}
