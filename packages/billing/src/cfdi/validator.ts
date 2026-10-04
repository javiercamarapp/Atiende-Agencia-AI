// ═══════════════════════════════════════════════════════════════════════════
// VALIDACIÓN FISCAL DETERMINÍSTICA DE UN CFDI — puerto (a TypeScript) de
// ~/Desktop/supabase/despachos/b2b_ai/cfdi/validator.py::validate_cfdi.
//
// Cubre lo mismo que el original, sin LLM:
//   1. Aritmética por concepto: cantidad × valor_unitario ≈ importe
//   2. Suma de conceptos ≈ subtotal
//   3. IVA global ≈ 16% del subtotal (solo warning: hay tasas mixtas/exentas)
//   4. Coherencia: subtotal + IVA − descuento ≈ total
//   5. Catálogos SAT (UsoCFDI, FormaPago, MetodoPago, TipoComprobante, Régimen)
//   6. RFC bien formados (emisor y receptor)
//
// La tolerancia (2 centavos) es la misma del original: redondeos de
// centavo por concepto no deben tumbar un CFDI real.
// ═══════════════════════════════════════════════════════════════════════════

import * as catalogs from './catalogs.ts';
import { esRfcValido } from './rfc.ts';

export const TOLERANCIA = 0.02;

/** Traslado de impuesto de UN concepto (Anexo 20). Los importes son pesos como número; `null` = el XML no lo trae (Exento no trae Importe). */
export interface TrasladoConceptoCfdi {
  impuesto: string; // c_Impuesto: 001 ISR, 002 IVA, 003 IEPS
  tipoFactor: string; // Tasa | Cuota | Exento
  tasaOCuota: number | null;
  base: number | null;
  importe: number | null;
}

export interface ConceptoCfdi {
  cantidad: number;
  valorUnitario: number;
  importe: number;
  /** D-P3-31: traslados por concepto (el parser los expone); ausente = no se conoce el desglose, no se valida. */
  traslados?: readonly TrasladoConceptoCfdi[];
}

export interface DatosCfdi {
  tipo: string; // I | E | T | P | N
  subtotal: number;
  total: number;
  descuento?: number;
  iva?: number | null;
  /** IEPS trasladado (c_Impuesto 003). D-P3-01: forma parte del total (Subtotal + IVA + IEPS ...). */
  ieps?: number | null;
  /** Complemento de impuestos locales (`implocal:ImpuestosLocales`, p. ej. ISH): TotaldeTraslados se SUMA al total. */
  impuestosLocalesTraslados?: number | null;
  /** `implocal:ImpuestosLocales` TotaldeRetenciones: se RESTA del total. */
  impuestosLocalesRetenciones?: number | null;
  /** Régimen fiscal del receptor (CFDI 4.0, atributo obligatorio del nodo Receptor); solo para el aviso UsoCFDI vs régimen. */
  regimenFiscalReceptor?: string | null;
  conceptos: ConceptoCfdi[];
  usoCfdi: string;
  formaPago: string;
  metodoPago: string;
  regimenFiscalEmisor: string;
  rfcEmisor: string;
  rfcReceptor: string;
  tieneSello: boolean;
  noCertificado: string;
  folioFiscal: string;
}

export interface HallazgoCfdi {
  codigo: string;
  mensaje: string;
  ref?: string;
}

export interface ResultadoValidacionCfdi {
  ok: boolean;
  issues: HallazgoCfdi[];
  warnings: string[];
  checks: { pass: number; fail: number };
}

function cerca(a: number, b: number, tolerancia = TOLERANCIA): boolean {
  return Math.abs(a - b) <= tolerancia;
}

/** Redondeo bancario a centavos, consistente con el resto del motor. */
function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function validarCfdi(datos: DatosCfdi): ResultadoValidacionCfdi {
  const issues: HallazgoCfdi[] = [];
  const warnings: string[] = [];
  const checks = { pass: 0, fail: 0 };

  const fail = (codigo: string, mensaje: string, ref?: string) => {
    issues.push({ codigo, mensaje, ref });
    checks.fail += 1;
  };
  const ok = () => {
    checks.pass += 1;
  };

  const descuento = datos.descuento ?? 0;
  const iva = datos.iva ?? null;

  // ---- 1. Aritmética por concepto ----
  for (const [i, c] of datos.conceptos.entries()) {
    const esperado = r2(c.cantidad * c.valorUnitario);
    if (!cerca(esperado, c.importe)) {
      fail(
        'importe_concepto_incoherente',
        `Concepto ${i + 1}: ${c.cantidad} × ${c.valorUnitario} = ${esperado} pero Importe=${c.importe}`,
        'Anexo 20 / Guia de llenado',
      );
    } else {
      ok();
    }
  }

  // ---- 2. Suma de conceptos == subtotal ----
  if (datos.conceptos.length > 0) {
    const suma = r2(datos.conceptos.reduce((acc, c) => acc + c.importe, 0));
    if (!cerca(suma, datos.subtotal)) {
      fail(
        'subtotal_descuadra_conceptos',
        `Suma de conceptos ${suma} != SubTotal ${datos.subtotal}`,
        'Anexo 20',
      );
    } else {
      ok();
    }
  }

  // ---- 3. IVA global (solo warning: hay tasas mixtas / frontera / exentas) ----
  // Con IEPS el IVA se calcula sobre (subtotal + IEPS) (art. 1 LIVA y art. 4 LIEPS: el IEPS integra la base del IVA):
  // se acepta cualquiera de las dos bases para no avisar en falso en gasolina, restaurantes o tabaco.
  const ieps = datos.ieps ?? 0;
  const locTraslados = datos.impuestosLocalesTraslados ?? 0;
  const locRetenciones = datos.impuestosLocalesRetenciones ?? 0;
  if (iva !== null) {
    const esperado = r2(datos.subtotal * 0.16);
    const esperadoConIeps = ieps > 0 ? r2((datos.subtotal + ieps) * 0.16) : esperado;
    if (!cerca(iva, esperado) && !cerca(iva, esperadoConIeps)) {
      warnings.push(
        `IVA global ${iva} difiere de 16% del subtotal (${esperado}); puede haber tasas diferenciadas ` +
        '(frontera 8%) u operaciones exentas.',
      );
    } else {
      ok();
    }
  }

  // ---- 4. Coherencia total ----
  // D-P3-01: Total = SubTotal − Descuento + IVA + IEPS + impuestos locales trasladados − impuestos locales retenidos
  // (Anexo 20, Total = SubTotal − Descuento + Traslados − Retenciones; el IEPS y el complemento `implocal` son parte de esa suma).
  const esperadoTotal = r2(datos.subtotal + (iva ?? 0) + ieps + locTraslados - descuento - locRetenciones);
  const conExtras = ieps !== 0 || locTraslados !== 0 || locRetenciones !== 0;
  if (!cerca(esperadoTotal, datos.total)) {
    if (datos.tipo === 'E' && datos.total === 0) {
      ok(); // nota de crédito con total=0: el SAT lo permite (BUG-F3 del original)
    } else {
      fail(
        'total_incoherente',
        conExtras
          ? `SubTotal + IVA + IEPS + impuestos locales − Descuento = ${esperadoTotal} pero Total=${datos.total}`
          : `SubTotal + IVA − Descuento = ${esperadoTotal} pero Total=${datos.total}`,
        'Anexo 20 / Guia de llenado',
      );
    }
  } else {
    ok();
  }

  // ---- 5. Catálogos SAT (CFF art. 29-A: obligatorios) ----
  const catalogo = (
    valor: string,
    esValido: (c: string) => boolean,
    campo: string,
    codigoAusente: string,
    codigoInvalido: string,
    ref: string,
  ) => {
    if (!valor) {
      fail(codigoAusente, `${campo} es obligatorio (CFF art. 29-A).`, 'CFF art. 29-A');
    } else if (!esValido(valor)) {
      fail(codigoInvalido, `${campo} '${valor}' no está en el catálogo SAT.`, ref);
    } else {
      ok();
    }
  };

  catalogo(datos.usoCfdi, catalogs.esUsoCfdiValido, 'UsoCFDI', 'uso_cfdi_faltante', 'uso_cfdi_invalido', 'c_UsoCFDI');
  catalogo(datos.formaPago, catalogs.esFormaPagoValida, 'FormaPago', 'forma_pago_faltante', 'forma_pago_invalida', 'c_FormaPago');
  catalogo(datos.metodoPago, catalogs.esMetodoPagoValido, 'MetodoPago', 'metodo_pago_ausente', 'metodo_pago_invalido', 'c_MetodoPago');
  catalogo(datos.tipo, catalogs.esTipoComprobanteValido, 'TipoDeComprobante', 'tipo_comprobante_ausente', 'tipo_comprobante_invalido', 'c_TipoDeComprobante');
  catalogo(datos.regimenFiscalEmisor, catalogs.esRegimenValido, 'RegimenFiscal', 'regimen_fiscal_ausente', 'regimen_fiscal_invalido', 'c_RegimenFiscal');

  // ---- CFF art. 29-A: sello, certificado, folio fiscal obligatorios ----
  if (!datos.tieneSello) {
    fail('sello_faltante', 'El Sello digital es obligatorio (CFF art. 29-A fracc. VIII). No está timbrado.', 'CFF art. 29-A');
  } else {
    ok();
  }
  if (!datos.noCertificado) {
    fail('no_certificado_faltante', 'NoCertificado del emisor es obligatorio.', 'CFF art. 29-A');
  } else {
    ok();
  }
  if (!datos.folioFiscal) {
    fail('folio_fiscal_faltante', 'El folio fiscal (UUID) es obligatorio; sin él no hay efecto fiscal.', 'CFF art. 29-A');
  } else {
    ok();
  }

  // ---- 6. RFCs ----
  if (!esRfcValido(datos.rfcEmisor)) {
    fail('rfc_emisor_invalido', `RFC emisor inválido: '${datos.rfcEmisor}'`, 'CFF art. 29-A');
  } else {
    ok();
  }
  if (!esRfcValido(datos.rfcReceptor)) {
    fail('rfc_receptor_invalido', `RFC receptor inválido: '${datos.rfcReceptor}'`, 'CFF art. 29-A');
  } else {
    ok();
  }

  return { ok: checks.fail === 0, issues, warnings, checks };
}
