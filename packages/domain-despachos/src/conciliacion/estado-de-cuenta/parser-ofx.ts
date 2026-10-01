// Parser OFX (Open Financial Exchange) 1.x (SGML, hojas sin cierre) y 2.x (XML).
// Diferencias frente al origen Python (`ofx_parser.py`): el saldo sale de
// <LEDGERBAL><BALAMT> (el origen buscaba un tag <BALANCE> que no existe en OFX), los
// importes se parsean en centavos enteros (acepta coma decimal de algunas
// exportaciones) y el signo viene SIEMPRE de TRNAMT (negativo = cargo), no de
// heurísticas sobre el texto. Cada renglón con error se reporta y se excluye.
import { bancoPorClabe, detectarBanco } from "./layouts.ts";
import { parsearFechaOfx } from "./fechas.ts";
import { parsearMonto, centavosAPesos } from "./montos.ts";
import { finalizarMovimientos, limpiarTexto } from "./normalizacion.ts";
import type { BorradorMovimiento } from "./normalizacion.ts";
import { armar, MAX_RENGLONES_ESTADO } from "./resultado.ts";
import type { AdvertenciaEstado, BancoMx, ErrorRenglonEstado, ResultadoParseoEstado } from "./types.ts";

export interface OpcionesParseoOfx {
  readonly banco?: BancoMx;
  readonly cuenta?: string | null;
}

function decodificarEntidades(s: string): string {
  return s
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&amp;/gi, "&");
}

/** Valor de la primera hoja `<TAG>valor` (SGML sin cierre o XML con `</TAG>`). */
function hoja(bloque: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, "i").exec(bloque);
  if (!m) return null;
  return decodificarEntidades(m[1]!).trim();
}

export function parsearOfxEstadoCuenta(textoCrudo: string, opciones: OpcionesParseoOfx = {}): ResultadoParseoEstado {
  const texto = textoCrudo.charCodeAt(0) === 0xfeff ? textoCrudo.slice(1) : textoCrudo;
  const errores: ErrorRenglonEstado[] = [];
  const advertencias: AdvertenciaEstado[] = [];

  const inicio = texto.search(/<OFX>/i);
  if (inicio === -1) {
    errores.push({ renglon: 1, campo: "fila", codigo: "ofx_invalido", mensaje: "El archivo no contiene un documento OFX (falta la etiqueta <OFX>)." });
    return armar("ofx", opciones.banco ?? "generico", false, opciones.cuenta ?? null, "MXN", [], errores, advertencias, 0);
  }
  const cuerpo = texto.slice(inicio);

  const cuentasEnArchivo = new Set<string>();
  for (const m of cuerpo.matchAll(/<ACCTID>([^<\r\n]*)/gi)) cuentasEnArchivo.add(m[1]!.trim());
  if (cuentasEnArchivo.size > 1) {
    errores.push({ renglon: 1, campo: "fila", codigo: "ofx_invalido", mensaje: "El archivo OFX contiene varias cuentas; sube un archivo por cuenta." });
    return armar("ofx", opciones.banco ?? "generico", false, opciones.cuenta ?? null, "MXN", [], errores, advertencias, 0);
  }

  const cuentaArchivo = [...cuentasEnArchivo][0] ?? null;
  const cuenta = (opciones.cuenta ?? null) || cuentaArchivo;
  const encabezadoFi = [hoja(cuerpo, "ORG"), hoja(texto.slice(0, inicio), "ORG"), hoja(cuerpo, "FID")].filter((v): v is string => !!v).join(" ");
  const bancoDetectado = opciones.banco ? null : (bancoPorClabe(cuenta) ?? detectarBanco(encabezadoFi, []));
  const banco: BancoMx = opciones.banco ?? bancoDetectado ?? "generico";
  if (!opciones.banco && bancoDetectado === null) {
    advertencias.push({ renglon: null, codigo: "banco_no_detectado", mensaje: "No se identificó el banco por el contenido; se usó el layout genérico. Puedes indicar el banco manualmente." });
  }
  if (!cuenta) advertencias.push({ renglon: null, codigo: "sin_cuenta", mensaje: "El archivo no trae CLABE o número de cuenta; el control de duplicados se aplica sin distinguir cuentas." });

  const moneda = (hoja(cuerpo, "CURDEF") ?? "MXN").toUpperCase();

  let saldoFinal: number | null = null;
  const bloqueSaldo = /<LEDGERBAL>([\s\S]*?)(?:<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>|$)/i.exec(cuerpo);
  if (bloqueSaldo) {
    const bal = hoja(bloqueSaldo[1]!, "BALAMT");
    if (bal !== null) {
      const p = parsearMonto(bal);
      if (p.ok && !p.vacio) saldoFinal = centavosAPesos(p.centavos);
    }
  }

  const borradores: BorradorMovimiento[] = [];
  let leidos = 0;
  const reTrn = /<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>|<\/STMTRS>|<\/CCSTMTRS>|$)/gi;
  for (const m of cuerpo.matchAll(reTrn)) {
    leidos++;
    const renglon = leidos;
    if (leidos > MAX_RENGLONES_ESTADO) {
      errores.push({ renglon, campo: "fila", codigo: "fila_incompleta", mensaje: `El archivo excede ${MAX_RENGLONES_ESTADO} movimientos; divídelo por periodos.` });
      break;
    }
    const bloque = m[1]!;
    const fecha = parsearFechaOfx(hoja(bloque, "DTPOSTED") ?? "");
    if (!fecha.ok) {
      errores.push({ renglon, campo: "fecha", codigo: "fecha_invalida", mensaje: fecha.motivo });
      continue;
    }
    const montoCrudo = hoja(bloque, "TRNAMT");
    if (montoCrudo === null) {
      errores.push({ renglon, campo: "importe", codigo: "sin_importe", mensaje: "El movimiento OFX no trae TRNAMT." });
      continue;
    }
    const monto = parsearMonto(montoCrudo);
    if (!monto.ok) {
      errores.push({ renglon, campo: "importe", codigo: "importe_invalido", mensaje: monto.motivo });
      continue;
    }
    if (monto.vacio) {
      errores.push({ renglon, campo: "importe", codigo: "sin_importe", mensaje: "El movimiento OFX trae TRNAMT vacío." });
      continue;
    }
    if (monto.centavos === 0) {
      advertencias.push({ renglon, codigo: "monto_cero", mensaje: "Movimiento con importe 0.00: se omitió." });
      continue;
    }
    const nombre = limpiarTexto(hoja(bloque, "NAME") ?? hoja(bloque, "PAYEE") ?? "");
    const memo = limpiarTexto(hoja(bloque, "MEMO") ?? "");
    const descripcion = nombre && memo && nombre.toLowerCase() !== memo.toLowerCase() ? `${nombre} ${memo}` : nombre || memo;
    const ref = limpiarTexto(hoja(bloque, "REFNUM") ?? hoja(bloque, "CHECKNUM") ?? hoja(bloque, "FITID") ?? "");
    borradores.push({ renglon, fecha: fecha.iso, descripcion, referencia: ref === "" ? null : ref, centavos: monto.centavos, saldoCentavos: null });
  }

  if (leidos === 0) {
    errores.push({ renglon: 1, campo: "fila", codigo: "ofx_invalido", mensaje: "El documento OFX no contiene movimientos (<STMTTRN>)." });
  }

  const fin = finalizarMovimientos(borradores, { banco, cuenta, formato: "ofx" });
  advertencias.push(...fin.advertencias);
  return armar("ofx", banco, bancoDetectado !== null, cuenta, moneda, fin.movimientos, errores, advertencias, leidos, saldoFinal);
}
