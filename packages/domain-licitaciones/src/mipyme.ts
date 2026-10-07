// REQ-109 -- estratificacion MIPyME determinista. Funcion PURA: la formula (pesos) y los topes NO estan en este archivo:
// salen de la ficha `ldcmipyme-estratificacion` del registro normativo (`normas.ts`, L-24), que hoy esta `sin_verificar`.
// Por eso TODO resultado trae `verificacion` y `validarConAbogado`: la pantalla lo muestra como "pendiente de
// verificacion legal" y nada de aqui se presenta como constancia. Dato ausente -> `no_evaluable` con su motivo; nunca se
// asume un sector, un numero de trabajadores ni unas ventas.
//
// Aritmetica exacta con BigInt (escala 1e9): los casos frontera (puntaje igual al tope) no dependen de coma flotante.
import { fichaNormaPorId } from "./normas.ts";
import type { NormaEstadoVerificacion, NormaFicha } from "./normas.ts";

export const MIPYME_FICHA_ID = "ldcmipyme-estratificacion";

export const MIPYME_SECTORES = ["industria", "comercio", "servicios"] as const;
export type MipymeSector = (typeof MIPYME_SECTORES)[number];
export function isMipymeSector(value: unknown): value is MipymeSector {
  return typeof value === "string" && (MIPYME_SECTORES as readonly string[]).includes(value);
}

export type MipymeEstrato = "micro" | "pequena" | "mediana" | "grande";

export interface MipymeInput {
  readonly sector: MipymeSector | null | undefined;
  readonly employeeCount: number | null | undefined;
  /** Ventas anuales en CENTAVOS de peso (entero). */
  readonly annualSalesCents: number | bigint | null | undefined;
}

interface TopesEstrato {
  readonly trabajadoresMax: number;
  readonly ventasMaxMdp: string;
  readonly topeCombinado: string;
}
interface EstratoFicha {
  readonly estrato: Exclude<MipymeEstrato, "grande">;
  readonly porSector: Readonly<Record<MipymeSector, TopesEstrato>>;
}
interface ParametrosFicha {
  readonly pesoTrabajadores: string;
  readonly pesoVentas: string;
  readonly estratos: readonly EstratoFicha[];
}

export type MipymeResultado =
  | {
      readonly status: "calculado";
      readonly estrato: MipymeEstrato;
      /** Puntaje combinado como decimal ("4.6"), en las unidades de la ficha. */
      readonly puntajeCombinado: string;
      readonly fichaId: string;
      readonly verificacion: NormaEstadoVerificacion;
      readonly validarConAbogado: boolean;
    }
  | {
      readonly status: "no_evaluable";
      readonly motivo: string;
      readonly faltan: readonly string[];
      readonly fichaId: string;
      readonly verificacion: NormaEstadoVerificacion;
      readonly validarConAbogado: boolean;
    };

const ESCALA = 1_000_000_000n;

/** "4.6" -> 4_600_000_000n. Acepta hasta 9 decimales; cualquier otra cosa es un error de la ficha, no un dato del usuario. */
export function decimalAEscala(valor: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(valor);
  if (!m) throw new Error(`Cifra de la ficha ${MIPYME_FICHA_ID} invalida: "${valor}".`);
  return BigInt(m[1]!) * ESCALA + BigInt((m[2] ?? "").padEnd(9, "0"));
}

function escalaADecimal(valor: bigint): string {
  const entero = valor / ESCALA;
  const frac = (valor % ESCALA).toString().padStart(9, "0").replace(/0+$/, "");
  return frac === "" ? entero.toString() : `${entero}.${frac}`;
}

function parametros(ficha: NormaFicha): ParametrosFicha {
  const p = ficha.parametros as ParametrosFicha | undefined;
  if (!p || !Array.isArray(p.estratos)) throw new Error(`La ficha ${ficha.id} no trae parametros de estratificacion.`);
  return p;
}

/**
 * Estratifica con la ficha dada (por omision, la del registro). `ficha` es inyectable para probar casos frontera con cifras
 * conocidas sin atar la prueba a la cifra capturada en el registro.
 */
export function estratificarMipyme(input: MipymeInput, ficha: NormaFicha | undefined = fichaNormaPorId(MIPYME_FICHA_ID)): MipymeResultado {
  if (!ficha) throw new Error(`Falta la ficha ${MIPYME_FICHA_ID} en el registro normativo.`);
  const meta = { fichaId: ficha.id, verificacion: ficha.estadoVerificacion, validarConAbogado: ficha.validarConAbogado } as const;

  const faltan: string[] = [];
  if (!isMipymeSector(input.sector)) faltan.push("sector");
  const trabajadores = input.employeeCount;
  if (trabajadores === null || trabajadores === undefined || !Number.isInteger(trabajadores) || trabajadores < 0) faltan.push("numero de trabajadores");
  const ventas = input.annualSalesCents;
  const ventasValidas = ventas !== null && ventas !== undefined && (typeof ventas === "bigint" ? ventas >= 0n : Number.isSafeInteger(ventas) && ventas >= 0);
  if (!ventasValidas) faltan.push("ventas anuales");
  if (faltan.length > 0) {
    return { status: "no_evaluable", motivo: `No se puede estratificar: falta o es invalido ${faltan.join(", ")}. No se asume ningun valor.`, faltan, ...meta };
  }

  const p = parametros(ficha);
  const sector = input.sector as MipymeSector;
  const ventasCents = BigInt(ventas as number | bigint);
  const wT = decimalAEscala(p.pesoTrabajadores);
  const wV = decimalAEscala(p.pesoVentas);
  // ventas en millones de pesos a escala 1e9: cents / 1e8 * 1e9 = cents * 10.
  const ventasMdp = ventasCents * 10n;
  const puntaje = (BigInt(trabajadores as number) * ESCALA * wT + ventasMdp * wV) / ESCALA;

  for (const e of p.estratos) {
    const t = e.porSector[sector];
    if (BigInt(trabajadores as number) <= BigInt(t.trabajadoresMax) && ventasMdp <= decimalAEscala(t.ventasMaxMdp) && puntaje <= decimalAEscala(t.topeCombinado)) {
      return { status: "calculado", estrato: e.estrato, puntajeCombinado: escalaADecimal(puntaje), ...meta };
    }
  }
  return { status: "calculado", estrato: "grande", puntajeCombinado: escalaADecimal(puntaje), ...meta };
}
