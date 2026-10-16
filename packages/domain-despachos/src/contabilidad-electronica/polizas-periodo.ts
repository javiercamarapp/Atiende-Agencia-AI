// XML «Pólizas del periodo» (PolizasPeriodo_1_3.xsd, contabilidad electrónica 1.3) a partir de las pólizas ya persistidas en el libro.
// Puro: sin I/O, sin SAT, sin firma. El archivo lo descarga y envía una persona (D-18); aquí solo se arma y se valida contra el XSD oficial.
//
// Qué se declara y qué NO (para no inventar datos):
//  - Se declaran los nodos obligatorios del XSD: Poliza (NumUnIdenPol, Fecha, Concepto) y Transaccion (NumCta, DesCta, Concepto, Debe, Haber).
//  - NO se emiten los nodos de complemento (CompNal con el UUID del CFDI, Cheque, Transferencia, OtrMetodoPago...): son OPCIONALES en el XSD y el
//    libro todavía no guarda los datos que exigen (RFC de la contraparte, banco, cuenta origen, beneficiario). Queda como siguiente paso.
//  - TipoSolicitud, NumOrden y NumTramite son ENTRADA del usuario (los fija la autoridad en la orden o el trámite): AF/FC exigen NumOrden y
//    DE/CO exigen NumTramite; nunca se inventan.
//  - Sello, noCertificado y Certificado son opcionales y se omiten (los llena la e.firma, que esta aplicación no usa).
//  - NumUnIdenPol = «<I|E|D>-<AAAAMM>-<folio de 4 dígitos>»: única por tipo y mes porque el folio es consecutivo por (cliente, ejercicio, mes, tipo).
//  - El concepto de una partida vacío se completa con el de la póliza; los textos libres se recortan al máximo del XSD (DesCta 100, Concepto 200).
import { escaparAtributoXml, ContabilidadElectronicaDatosInvalidosError, exigirEjercicioYMes, exigirRfcSat, importeDesdeCentavos, mesDosDigitos, recortarTexto } from "./xml-comun.ts";

export const TIPOS_SOLICITUD_POLIZAS = ["AF", "FC", "DE", "CO"] as const;
export type TipoSolicitudPolizas = (typeof TIPOS_SOLICITUD_POLIZAS)[number];

/** `NumOrden` del XSD: 3 letras, 7 dígitos, «/» y 2 dígitos. */
export const NUM_ORDEN_RE = /^[A-Z]{3}[0-9]{7}\/[0-9]{2}$/;
/** `NumTramite` del XSD: 2 letras y 12 dígitos. */
export const NUM_TRAMITE_RE = /^[A-Z]{2}[0-9]{12}$/;

export interface MovimientoParaXml {
  readonly cuenta: string;
  readonly concepto: string;
  readonly debeCentavos: number;
  readonly haberCentavos: number;
}

export interface PolizaParaXml {
  readonly tipo: "ingreso" | "egreso" | "diario";
  readonly folio: number;
  /** YYYY-MM-DD. */
  readonly fecha: string;
  readonly concepto: string;
  readonly movimientos: readonly MovimientoParaXml[];
}

export interface OpcionesXmlPolizas {
  readonly rfc: string;
  readonly ejercicio: number;
  readonly mes: number;
  readonly tipoSolicitud: TipoSolicitudPolizas;
  readonly numOrden?: string;
  readonly numTramite?: string;
}

const LETRA_TIPO: Readonly<Record<PolizaParaXml["tipo"], string>> = { ingreso: "I", egreso: "E", diario: "D" };

/** `cuentas`: código -> descripción del catálogo del cliente (para `DesCta`). */
export function generarXmlPolizasPeriodo(polizas: readonly PolizaParaXml[], cuentas: ReadonlyMap<string, string>, opciones: OpcionesXmlPolizas): string {
  const rfc = exigirRfcSat(opciones.rfc);
  exigirEjercicioYMes(opciones.ejercicio, opciones.mes);
  if (!(TIPOS_SOLICITUD_POLIZAS as readonly string[]).includes(opciones.tipoSolicitud)) {
    throw new ContabilidadElectronicaDatosInvalidosError("TipoSolicitud: AF, FC, DE o CO.");
  }
  const exigeOrden = opciones.tipoSolicitud === "AF" || opciones.tipoSolicitud === "FC";
  if (exigeOrden) {
    if (!opciones.numOrden || !NUM_ORDEN_RE.test(opciones.numOrden)) throw new ContabilidadElectronicaDatosInvalidosError("Las solicitudes AF y FC requieren el número de orden (3 letras, 7 dígitos, «/» y 2 dígitos).");
    if (opciones.numTramite) throw new ContabilidadElectronicaDatosInvalidosError("Las solicitudes AF y FC no llevan número de trámite.");
  } else {
    if (!opciones.numTramite || !NUM_TRAMITE_RE.test(opciones.numTramite)) throw new ContabilidadElectronicaDatosInvalidosError("Las solicitudes DE y CO requieren el número de trámite (2 letras y 12 dígitos).");
    if (opciones.numOrden) throw new ContabilidadElectronicaDatosInvalidosError("Las solicitudes DE y CO no llevan número de orden.");
  }
  if (polizas.length === 0) throw new ContabilidadElectronicaDatosInvalidosError("El periodo no tiene pólizas: no hay nada que declarar.");
  const esc = escaparAtributoXml;
  const periodo = `${opciones.ejercicio}-${mesDosDigitos(opciones.mes)}`;

  const nodos = polizas.map((p) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.fecha) || p.fecha.slice(0, 7) !== periodo) {
      throw new ContabilidadElectronicaDatosInvalidosError(`La póliza ${LETRA_TIPO[p.tipo]}-${p.folio} no es del periodo ${periodo}.`);
    }
    if (p.movimientos.length === 0) throw new ContabilidadElectronicaDatosInvalidosError(`La póliza ${LETRA_TIPO[p.tipo]}-${p.folio} no tiene partidas.`);
    const debe = p.movimientos.reduce((s, m) => s + m.debeCentavos, 0);
    const haber = p.movimientos.reduce((s, m) => s + m.haberCentavos, 0);
    if (debe !== haber) throw new ContabilidadElectronicaDatosInvalidosError(`La póliza ${LETRA_TIPO[p.tipo]}-${p.folio} está descuadrada: no se declara.`);
    const numero = `${LETRA_TIPO[p.tipo]}-${opciones.ejercicio}${mesDosDigitos(opciones.mes)}-${String(p.folio).padStart(4, "0")}`;
    const conceptoPoliza = recortarTexto(p.concepto, 300);
    if (conceptoPoliza.length === 0) throw new ContabilidadElectronicaDatosInvalidosError(`La póliza ${numero} no tiene concepto.`);
    const trans = p.movimientos.map((m) => {
      const desc = cuentas.get(m.cuenta);
      if (desc === undefined) throw new ContabilidadElectronicaDatosInvalidosError(`La póliza ${numero} usa la cuenta ${m.cuenta}, que no está en el catálogo.`);
      const concepto = recortarTexto(m.concepto.trim() === "" ? p.concepto : m.concepto, 200);
      return `    <PLZ:Transaccion NumCta="${esc(m.cuenta)}" DesCta="${esc(recortarTexto(desc, 100))}" Concepto="${esc(concepto)}" Debe="${importeDesdeCentavos(m.debeCentavos)}" Haber="${importeDesdeCentavos(m.haberCentavos)}"/>`;
    });
    return `  <PLZ:Poliza NumUnIdenPol="${esc(numero)}" Fecha="${esc(p.fecha)}" Concepto="${esc(conceptoPoliza)}">\n${trans.join("\n")}\n  </PLZ:Poliza>`;
  });

  const solicitud = exigeOrden ? ` NumOrden="${esc(opciones.numOrden as string)}"` : ` NumTramite="${esc(opciones.numTramite as string)}"`;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<PLZ:Polizas xmlns:PLZ="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/PolizasPeriodo" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xsi:schemaLocation="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/PolizasPeriodo ' +
    'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/PolizasPeriodo/PolizasPeriodo_1_3.xsd" ' +
    `Version="1.3" RFC="${esc(rfc)}" Mes="${mesDosDigitos(opciones.mes)}" Anio="${opciones.ejercicio}" TipoSolicitud="${opciones.tipoSolicitud}"${solicitud}>\n` +
    `${nodos.join("\n")}\n` +
    "</PLZ:Polizas>\n"
  );
}
