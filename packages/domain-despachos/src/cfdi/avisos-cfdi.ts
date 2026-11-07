// D-P3-31: validaciones de un CFDI que el motor no tenia, TODAS como AVISO (`warnings`), nunca como error.
//
// Por que avisos y no errores: un CFDI timbrado ya paso las validaciones del PAC (que son las que el SAT exige como rechazo); lo que
// hace este modulo es senalar al contador incongruencias para revisar. Convertir un aviso en error sacaria un CFDI de los pagos
// provisionales (`valido=false`) y eso solo se permite con fundamento citado en la norma; ninguna de estas reglas lo tiene validado
// todavia por el fiscalista (ver docs/despachos/PREGUNTAS-AL-FISCALISTA.md). Cual es cual:
//   1. IVA por concepto: Importe ~ Base x Tasa y suma por concepto ~ IVA del comprobante        -> aviso (Anexo 20, guia de llenado: Traslado.Importe).
//   2. MetodoPago PPD exige FormaPago 99; MetodoPago PUE no admite 99 (en ingreso/egreso)       -> aviso (Anexo 20, guia de llenado: MetodoPago/FormaPago).
//   3. UsoCFDI contra RegimenFiscalReceptor (catalogo c_UsoCFDI, columna "Regimen fiscal receptor") -> aviso; la tabla local es una transcripcion y esta pendiente de validar con el fiscalista.
// La retencion de ISR del 1.25 % de RESICO PF vive en `reglas-fiscales-avanzadas.ts` (ajusta el aviso existente de 10 %); los avisos del REP
// (FormaDePagoP, MonedaP, TipoCambioP, TipoCadPago) viven en `rep.ts`.
import type { ConceptoCfdi } from "@atiende/billing";

const TOLERANCIA_IMPORTE = 0.02;

function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

const REGIMENES_GENERAL = ["601", "603", "606", "612", "620", "621", "622", "623", "624", "625", "626"];
const REGIMENES_PERSONAL = ["605", "606", "607", "608", "611", "612", "614", "615", "625"];
const REGIMENES_SIN_EFECTOS = ["601", "603", "605", "606", "607", "608", "610", "611", "612", "614", "615", "616", "620", "621", "622", "623", "624", "625", "626"];

/** UsoCFDI -> regimenes fiscales del receptor admitidos por el catalogo c_UsoCFDI (CFDI 4.0). Pendiente de validar con el fiscalista. */
export const REGIMENES_RECEPTOR_POR_USO: Readonly<Record<string, readonly string[]>> = {
  G01: REGIMENES_GENERAL,
  G02: [...REGIMENES_GENERAL, "616"],
  G03: REGIMENES_GENERAL,
  I01: REGIMENES_GENERAL,
  I02: REGIMENES_GENERAL,
  I03: REGIMENES_GENERAL,
  I04: REGIMENES_GENERAL,
  I05: REGIMENES_GENERAL,
  I06: REGIMENES_GENERAL,
  I07: REGIMENES_GENERAL,
  I08: REGIMENES_GENERAL,
  D01: REGIMENES_PERSONAL,
  D02: REGIMENES_PERSONAL,
  D03: REGIMENES_PERSONAL,
  D04: REGIMENES_PERSONAL,
  D05: REGIMENES_PERSONAL,
  D06: REGIMENES_PERSONAL,
  D07: REGIMENES_PERSONAL,
  D08: REGIMENES_PERSONAL,
  D09: REGIMENES_PERSONAL,
  D10: REGIMENES_PERSONAL,
  S01: REGIMENES_SIN_EFECTOS,
  CP01: REGIMENES_SIN_EFECTOS,
  CN01: ["605"],
};

export interface EntradaAvisosCfdi {
  readonly tipo: string;
  readonly iva?: number | null;
  readonly metodoPago: string;
  readonly formaPago: string;
  readonly usoCfdi: string;
  readonly regimenFiscalReceptor?: string | null;
  readonly conceptos: readonly ConceptoCfdi[];
}

export function avisosCfdi(d: EntradaAvisosCfdi): string[] {
  const avisos: string[] = [];

  // 1. IVA por concepto.
  let sumaIvaConceptos = 0;
  let conceptosConIva = 0;
  d.conceptos.forEach((c, i) => {
    for (const t of c.traslados ?? []) {
      if (t.impuesto !== "002" || t.tipoFactor !== "Tasa" || t.base === null || t.tasaOCuota === null || t.importe === null) continue;
      conceptosConIva += 1;
      sumaIvaConceptos += t.importe;
      const esperado = r2(t.base * t.tasaOCuota);
      if (Math.abs(esperado - t.importe) > TOLERANCIA_IMPORTE) {
        avisos.push(`Concepto ${i + 1}: IVA ${t.importe.toFixed(2)} no corresponde a Base ${t.base.toFixed(2)} × Tasa ${(t.tasaOCuota * 100).toFixed(2)} % (${esperado.toFixed(2)}).`);
      }
    }
  });
  if (conceptosConIva > 0 && d.iva != null && Math.abs(r2(sumaIvaConceptos) - d.iva) > TOLERANCIA_IMPORTE * conceptosConIva) {
    avisos.push(`La suma del IVA por concepto (${r2(sumaIvaConceptos).toFixed(2)}) difiere del IVA del comprobante (${d.iva.toFixed(2)}).`);
  }

  // 2. MetodoPago vs FormaPago (solo ingreso/egreso: la nomina y los complementos usan 99 con PUE legitimamente).
  if (d.tipo === "I" || d.tipo === "E") {
    if (d.metodoPago === "PPD" && d.formaPago !== "99") {
      avisos.push(`MetodoPago PPD exige FormaPago 99 (Por definir); el CFDI trae FormaPago ${d.formaPago || "(vacia)"}.`);
    } else if (d.metodoPago === "PUE" && d.formaPago === "99") {
      avisos.push("MetodoPago PUE no admite FormaPago 99 (Por definir): se paga en una sola exhibicion y la forma de pago debe ser una real.");
    }
  }

  // 3. UsoCFDI vs RegimenFiscalReceptor.
  const regimenes = REGIMENES_RECEPTOR_POR_USO[d.usoCfdi];
  const regimenReceptor = d.regimenFiscalReceptor ?? "";
  if (regimenes && regimenReceptor !== "" && !regimenes.includes(regimenReceptor)) {
    avisos.push(`UsoCFDI ${d.usoCfdi} no es compatible con el regimen fiscal del receptor ${regimenReceptor} segun el catalogo c_UsoCFDI; revisar (validar con fiscalista).`);
  }

  return avisos;
}
