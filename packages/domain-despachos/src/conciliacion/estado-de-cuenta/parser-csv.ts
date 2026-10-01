// Parser CSV de estados de cuenta de bancos mexicanos (BBVA, Banorte, Santander, HSBC,
// Scotiabank, Citibanamex, Inbursa y genérico). Ver cabecera de layouts.ts para el
// alcance honesto de los layouts. Reglas de signo:
//  - columnas separadas cargo/abono: cargo → monto negativo, abono → positivo, SIEMPRE
//    por la columna (un cargo escrito como "-500" o "(500)" sigue siendo salida de 500);
//  - una sola columna importe con signo: negativo = cargo (la convención de Santander
//    "Cargo/Abono" con "+"/"-" o "C"/"A" aplica cuando hay columna `tipo`);
//  - cargo Y abono con valor en la misma fila → error del renglón (ambigua).
import { bancoPorClabe, detectarBanco, esFilaEncabezado, mapearColumnas, normalizarEncabezado, clabeValida } from "./layouts.ts";
import type { CampoCsv } from "./layouts.ts";
import { detectarDelimitador, quitarBom, tokenizarCsv } from "./csv.ts";
import type { RegistroCsv } from "./csv.ts";
import { parsearFechaMx } from "./fechas.ts";
import { parsearMonto } from "./montos.ts";
import { finalizarMovimientos, limpiarTexto, verificarContinuidadSaldo } from "./normalizacion.ts";
import type { BorradorMovimiento } from "./normalizacion.ts";
import { armar, MAX_RENGLONES_ESTADO } from "./resultado.ts";
import type { AdvertenciaEstado, BancoMx, ErrorRenglonEstado, ResultadoParseoEstado } from "./types.ts";


export interface OpcionesParseoCsv {
  /** Banco forzado por el usuario; si falta se detecta del contenido. */
  readonly banco?: BancoMx;
  /** CLABE/cuenta indicada por el usuario (prevalece sobre la del archivo). */
  readonly cuenta?: string | null;
}

const MAX_BUSQUEDA_ENCABEZADO = 60;
const FILA_NO_MOVIMIENTO = /^(total|totales|saldo|saldos|resumen|suma|periodo|subtotal|importe total)\b/;

function sinAcentosMin(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function buscarCuenta(preambulo: readonly RegistroCsv[]): string | null {
  for (const reg of preambulo) {
    const texto = reg.celdas.join(" ");
    const candidatos = texto.match(/\d[\d -]{8,24}\d/g) ?? [];
    for (const c of candidatos) {
      const limpio = c.replace(/[ -]/g, "");
      if (limpio.length === 18 && clabeValida(limpio)) return limpio;
    }
    if (/(cuenta|clabe)/i.test(texto)) {
      for (const c of candidatos) {
        const limpio = c.replace(/[ -]/g, "");
        if (limpio.length >= 10 && limpio.length <= 18) return limpio;
      }
    }
  }
  return null;
}

function interpretarTipo(valor: string): "cargo" | "abono" | null {
  const v = sinAcentosMin(valor);
  if (v === "") return null;
  if (["-", "c", "cargo", "cargos", "retiro", "retiros", "d", "debito", "dr", "db", "salida"].includes(v)) return "cargo";
  if (["+", "a", "abono", "abonos", "deposito", "depositos", "credito", "cr", "entrada"].includes(v)) return "abono";
  return null;
}

export function parsearCsvEstadoCuenta(textoCrudo: string, opciones: OpcionesParseoCsv = {}): ResultadoParseoEstado {
  const texto = quitarBom(textoCrudo);
  const registros = tokenizarCsv(texto, detectarDelimitador(texto));

  const errores: ErrorRenglonEstado[] = [];
  const advertencias: AdvertenciaEstado[] = [];

  let idxEncabezado = -1;
  for (let i = 0; i < Math.min(registros.length, MAX_BUSQUEDA_ENCABEZADO); i++) {
    if (esFilaEncabezado(registros[i]!.celdas.map(normalizarEncabezado))) {
      idxEncabezado = i;
      break;
    }
  }
  if (idxEncabezado === -1) {
    errores.push({ renglon: 1, campo: "fila", codigo: "fila_incompleta", mensaje: "No se encontró la fila de encabezados: se esperaba una columna de fecha y al menos una de cargo/abono o importe." });
    return vacio(opciones, errores, advertencias);
  }

  const preambulo = registros.slice(0, idxEncabezado);
  const encabezadosNorm = registros[idxEncabezado]!.celdas.map(normalizarEncabezado);
  let cuenta = (opciones.cuenta ?? null) || buscarCuenta(preambulo);
  if (!cuenta) {
    // Algunos layouts (Banorte, Santander) repiten la cuenta en una columna de cada renglón.
    const idxCuenta = mapearColumnas(encabezadosNorm).cuenta;
    if (idxCuenta !== undefined) {
      for (const reg of registros.slice(idxEncabezado + 1, idxEncabezado + 6)) {
        const limpio = (reg.celdas[idxCuenta] ?? "").replace(/[\s-]/g, "");
        if (/^\d{10,18}$/.test(limpio)) {
          cuenta = limpio;
          break;
        }
      }
    }
  }
  const bancoDetectado = opciones.banco ? null : (detectarBanco(preambulo.map((r) => r.celdas.join(" ")).join("\n"), encabezadosNorm) ?? bancoPorClabe(cuenta));
  const banco: BancoMx = opciones.banco ?? bancoDetectado ?? "generico";
  if (!opciones.banco && bancoDetectado === null) {
    advertencias.push({ renglon: null, codigo: "banco_no_detectado", mensaje: "No se identificó el banco por el contenido; se usó el layout genérico. Puedes indicar el banco manualmente." });
  }
  if (!cuenta) advertencias.push({ renglon: null, codigo: "sin_cuenta", mensaje: "El archivo no trae CLABE o número de cuenta; el control de duplicados se aplica sin distinguir cuentas. Captúrala para separar cuentas distintas." });

  const col = mapearColumnas(encabezadosNorm);
  const borradores: BorradorMovimiento[] = [];
  const datos = registros.slice(idxEncabezado + 1);
  let leidos = 0;

  const celda = (reg: RegistroCsv, campo: CampoCsv): string | null => {
    const i = col[campo];
    if (i === undefined) return null;
    return reg.celdas[i] ?? "";
  };

  for (const reg of datos) {
    if (leidos >= MAX_RENGLONES_ESTADO) {
      errores.push({ renglon: reg.linea, campo: "fila", codigo: "fila_incompleta", mensaje: `El archivo excede ${MAX_RENGLONES_ESTADO} renglones; divídelo por periodos.` });
      break;
    }
    const fechaCruda = limpiarTexto(celda(reg, "fecha") ?? "");
    const primera = sinAcentosMin(reg.celdas[0] ?? "");
    // Pie del archivo (totales, saldo final...): no es un movimiento ni un error.
    if (FILA_NO_MOVIMIENTO.test(sinAcentosMin(fechaCruda)) || (fechaCruda === "" && FILA_NO_MOVIMIENTO.test(primera))) continue;
    leidos++;

    const fecha = parsearFechaMx(fechaCruda);
    if (!fecha.ok) {
      errores.push({ renglon: reg.linea, campo: "fecha", codigo: "fecha_invalida", mensaje: fecha.motivo });
      continue;
    }

    let centavos: number | null = null;
    const cargoCrudo = celda(reg, "cargo");
    const abonoCrudo = celda(reg, "abono");
    const importeCrudo = celda(reg, "importe");

    if (cargoCrudo !== null || abonoCrudo !== null) {
      const cargo = cargoCrudo !== null ? parsearMonto(cargoCrudo) : ({ ok: true, centavos: 0, vacio: true } as const);
      const abono = abonoCrudo !== null ? parsearMonto(abonoCrudo) : ({ ok: true, centavos: 0, vacio: true } as const);
      if (!cargo.ok) {
        errores.push({ renglon: reg.linea, campo: "cargo", codigo: "importe_invalido", mensaje: cargo.motivo });
        continue;
      }
      if (!abono.ok) {
        errores.push({ renglon: reg.linea, campo: "abono", codigo: "importe_invalido", mensaje: abono.motivo });
        continue;
      }
      const hayCargo = !cargo.vacio && cargo.centavos !== 0;
      const hayAbono = !abono.vacio && abono.centavos !== 0;
      if (hayCargo && hayAbono) {
        errores.push({ renglon: reg.linea, campo: "fila", codigo: "cargo_y_abono", mensaje: "El renglón trae cargo y abono a la vez; no se puede determinar el sentido del movimiento." });
        continue;
      }
      if (hayCargo) centavos = -Math.abs(cargo.centavos);
      else if (hayAbono) centavos = Math.abs(abono.centavos);
      else if ((!cargo.vacio || !abono.vacio) && importeCrudo === null) {
        advertencias.push({ renglon: reg.linea, codigo: "monto_cero", mensaje: "Renglón con importe 0.00: se omitió." });
        continue;
      }
    }

    if (centavos === null && importeCrudo !== null) {
      const imp = parsearMonto(importeCrudo);
      if (!imp.ok) {
        errores.push({ renglon: reg.linea, campo: "importe", codigo: "importe_invalido", mensaje: imp.motivo });
        continue;
      }
      if (!imp.vacio) {
        if (imp.centavos === 0) {
          advertencias.push({ renglon: reg.linea, codigo: "monto_cero", mensaje: "Renglón con importe 0.00: se omitió." });
          continue;
        }
        const tipoCrudo = celda(reg, "tipo");
        if (tipoCrudo !== null && tipoCrudo.trim() !== "") {
          const tipo = interpretarTipo(tipoCrudo);
          if (tipo === null) {
            errores.push({ renglon: reg.linea, campo: "tipo", codigo: "tipo_desconocido", mensaje: `No se reconoce la naturaleza del movimiento: "${tipoCrudo.trim()}" (se esperaba cargo/abono, C/A, +/-).` });
            continue;
          }
          centavos = tipo === "cargo" ? -Math.abs(imp.centavos) : Math.abs(imp.centavos);
        } else {
          centavos = imp.centavos;
        }
      }
    }

    if (centavos === null) {
      errores.push({ renglon: reg.linea, campo: "importe", codigo: "sin_importe", mensaje: "El renglón no trae importe (cargo, abono o monto)." });
      continue;
    }

    let saldoCentavos: number | null = null;
    const saldoCrudo = celda(reg, "saldo");
    if (saldoCrudo !== null && saldoCrudo.trim() !== "") {
      const s = parsearMonto(saldoCrudo);
      if (!s.ok) {
        errores.push({ renglon: reg.linea, campo: "saldo", codigo: "importe_invalido", mensaje: s.motivo });
        continue;
      }
      saldoCentavos = s.vacio ? null : s.centavos;
    }

    const refCruda = limpiarTexto(celda(reg, "referencia") ?? "");
    borradores.push({
      renglon: reg.linea,
      fecha: fecha.iso,
      descripcion: limpiarTexto(celda(reg, "descripcion") ?? ""),
      referencia: refCruda === "" ? null : refCruda,
      centavos,
      saldoCentavos,
    });
  }

  advertencias.push(...verificarContinuidadSaldo(borradores));
  const fin = finalizarMovimientos(borradores, { banco, cuenta, formato: "csv" });
  advertencias.push(...fin.advertencias);
  return armar("csv", banco, bancoDetectado !== null, cuenta, "MXN", fin.movimientos, errores, advertencias, leidos);
}

function vacio(opciones: OpcionesParseoCsv, errores: ErrorRenglonEstado[], advertencias: AdvertenciaEstado[]): ResultadoParseoEstado {
  return armar("csv", opciones.banco ?? "generico", false, opciones.cuenta ?? null, "MXN", [], errores, advertencias, 0);
}
