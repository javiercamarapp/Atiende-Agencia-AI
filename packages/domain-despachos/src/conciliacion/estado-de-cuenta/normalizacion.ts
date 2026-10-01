// Normalización de movimientos importados: importes en centavos → pesos, hash de
// idempotencia, ocurrencia de movimientos idénticos, avisos de posible duplicado y
// verificación de continuidad de saldo.
import { createHash } from "node:crypto";
import { centavosAPesos } from "./montos.ts";
import type { AdvertenciaEstado, BancoMx, FormatoEstadoCuenta, MovimientoImportado } from "./types.ts";

export interface BorradorMovimiento {
  readonly renglon: number;
  readonly fecha: string; // YYYY-MM-DD ya validada
  readonly descripcion: string;
  readonly referencia: string | null;
  /** Importe con signo en centavos (abono > 0, cargo < 0). Nunca 0 (se rechaza antes). */
  readonly centavos: number;
  readonly saldoCentavos: number | null;
}

/** Colapsa espacios y recorta. Conserva acentos y mayúsculas para mostrar. */
export function limpiarTexto(s: string): string {
  let sinControl = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    // Quita caracteres de control (salvo tab/LF/CR, que el colapso de espacios normaliza).
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) continue;
    sinControl += ch;
  }
  return sinControl.replace(/\s+/g, " ").trim();
}

/** Forma canónica del concepto para el hash: sin acentos, minúsculas, espacios colapsados. */
export function conceptoCanonico(s: string): string {
  return limpiarTexto(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Clave del movimiento SIN ocurrencia ni cuenta: lo que hace "idéntico" a otro. */
function claveBase(b: Pick<BorradorMovimiento, "fecha" | "centavos" | "descripcion">): string {
  return `${b.fecha}|${b.centavos}|${conceptoCanonico(b.descripcion)}`;
}

/** Hash de idempotencia (SHA-256 hex). Versionado ("v1") para poder cambiar el
 * algoritmo sin colisionar con hashes ya guardados. NO incluye saldo ni referencia:
 * algunos bancos regeneran folios (p. ej. FITID de OFX) en cada descarga y el saldo
 * cambia de formato; incluirlos rompería la idempotencia al re-subir el mismo periodo. */
export function hashMovimiento(banco: BancoMx, cuenta: string | null, base: Pick<BorradorMovimiento, "fecha" | "centavos" | "descripcion">, ocurrencia: number): string {
  return createHash("sha256").update(`v1|${banco}|${cuenta ?? ""}|${claveBase(base)}|${ocurrencia}`, "utf8").digest("hex");
}

export interface OpcionesFinalizar {
  readonly banco: BancoMx;
  readonly cuenta: string | null;
  readonly formato: FormatoEstadoCuenta;
}

export function finalizarMovimientos(borradores: readonly BorradorMovimiento[], opciones: OpcionesFinalizar): { readonly movimientos: MovimientoImportado[]; readonly advertencias: AdvertenciaEstado[] } {
  const vistos = new Map<string, { n: number; primerRenglon: number }>();
  const advertencias: AdvertenciaEstado[] = [];
  const movimientos: MovimientoImportado[] = [];

  for (const b of borradores) {
    const clave = claveBase(b);
    const previo = vistos.get(clave);
    const ocurrencia = (previo?.n ?? 0) + 1;
    vistos.set(clave, { n: ocurrencia, primerRenglon: previo?.primerRenglon ?? b.renglon });
    if (previo) {
      advertencias.push({
        renglon: b.renglon,
        codigo: "posible_duplicado",
        mensaje: `El renglón ${b.renglon} repite fecha, importe y concepto del renglón ${previo.primerRenglon}. Se importa como movimiento distinto (ocurrencia ${ocurrencia}); revísalo si no son dos operaciones reales.`,
      });
    }
    const pesos = centavosAPesos(b.centavos);
    movimientos.push({
      fecha: b.fecha,
      descripcion: b.descripcion,
      referencia: b.referencia,
      cargo: b.centavos < 0 ? Math.abs(pesos) : null,
      abono: b.centavos > 0 ? pesos : null,
      saldo: b.saldoCentavos === null ? null : centavosAPesos(b.saldoCentavos),
      monto: pesos,
      banco: opciones.banco,
      formato: opciones.formato,
      renglon: b.renglon,
      ocurrencia,
      hash: hashMovimiento(opciones.banco, opciones.cuenta, b, ocurrencia),
    });
  }
  return { movimientos, advertencias };
}

/** Verifica saldo[i] = saldo[i-1] + monto[i] (archivo ascendente) o su inverso
 * (descendente, más reciente primero). Solo avisa; nunca descarta movimientos. */
export function verificarContinuidadSaldo(borradores: readonly BorradorMovimiento[]): AdvertenciaEstado[] {
  const conSaldo = borradores.filter((b) => b.saldoCentavos !== null);
  if (conSaldo.length < 3) return [];
  const rompeAsc: number[] = [];
  const rompeDesc: number[] = [];
  for (let i = 1; i < conSaldo.length; i++) {
    const prev = conSaldo[i - 1]!;
    const cur = conSaldo[i]!;
    if (prev.saldoCentavos! + cur.centavos !== cur.saldoCentavos!) rompeAsc.push(cur.renglon);
    if (cur.saldoCentavos! + prev.centavos !== prev.saldoCentavos!) rompeDesc.push(prev.renglon);
  }
  const pares = conSaldo.length - 1;
  const romp = rompeAsc.length <= rompeDesc.length ? rompeAsc : rompeDesc;
  if (romp.length === 0) return [];
  if (romp.length * 2 > pares) {
    return [{ renglon: null, codigo: "saldo_discontinuo", mensaje: "La columna de saldo no cuadra con los importes en ningún orden (ascendente o descendente). Verifica que el archivo esté completo y sin filtros." }];
  }
  return romp.slice(0, 20).map((renglon) => ({ renglon, codigo: "saldo_discontinuo" as const, mensaje: `El saldo del renglón ${renglon} no cuadra con el saldo anterior más el importe del movimiento; puede faltar un movimiento.` }));
}
