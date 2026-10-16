// Alerta de EXPIRACION del token de acceso de Meta (WhatsApp) con avisos a 14, 7 y 1 dia. Es del operador de la plataforma, no de una
// organizacion: el token es uno solo (una Meta App compartida), asi que el aviso va a superadmin (`superadmin.whatsapp.token_por_vencer`)
// y, ya vencido, `superadmin.whatsapp.token_vencido`. El error 190 en un envio ya tiene su propia alerta por organizacion (`proveedor.ts`).
//
// La lectura del estado del token va detras de un PUERTO (`LectorEstadoTokenMeta`): este modulo nunca llama a Meta, nunca recibe ni imprime
// el token. En produccion el adaptador consulta Graph (`debug_token`, solo lectura); en pruebas se inyecta un doble.
//
// Reglas (todas con el reloj inyectado, nunca `new Date()` aqui):
//   * dias restantes = (expiraEn - ahora) / 24 h, sin redondear. Se avisa el umbral MAS URGENTE ya alcanzado: con 14 dias exactos sale el
//     aviso de 14; con 13,9 tambien el de 14; con 6,9 el de 7; con 0,5 el de 1. Con 14 dias y un milisegundo no sale nada.
//   * una sola vez por umbral y fecha de expiracion (clave = umbral + dia de Merida de la expiracion): reintentar el cron no repite el aviso,
//     y si el cron estuvo caido salta directo al umbral vigente (nunca emite los viejos).
//   * vencido = Meta dice `valido: false` o expiraEn <= ahora. Una vez por dia de Merida.
//   * sin fecha (`expiraEn: null`: token permanente de usuario de sistema, o Meta no la informa) y valido: no se alerta; es un estado
//     honesto (`sin_fecha`), no una falla.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { emitirNotificacion } from "@atiende/db";
import { diaMerida } from "./dia.ts";

/** Dias de anticipacion con que se avisa, de mayor a menor. */
export const UMBRALES_TOKEN_META_DIAS = [14, 7, 1] as const;
export type UmbralTokenMetaDias = (typeof UMBRALES_TOKEN_META_DIAS)[number];

const DIA_MS = 86_400_000;

export interface EstadoTokenMeta {
  /** `false` = Meta lo reporta invalido o revocado; `null` = no se pudo saber. */
  readonly valido: boolean | null;
  /** Instante de expiracion; `null` = sin fecha (token permanente o no informada). */
  readonly expiraEn: Date | null;
}

/** Puerto de lectura del estado del token. Solo lectura; nunca expone el token. Si no puede leer, lanza (el llamador lo cuenta como `no_leido`). */
export interface LectorEstadoTokenMeta {
  leer(): Promise<EstadoTokenMeta>;
}

export type DiagnosticoTokenMeta =
  | { readonly tipo: "vigente"; readonly diasRestantes: number }
  | { readonly tipo: "por_vencer"; readonly umbral: UmbralTokenMetaDias; readonly diasRestantes: number; readonly expiraEn: Date }
  | { readonly tipo: "vencido"; readonly expiraEn: Date | null }
  | { readonly tipo: "sin_fecha" };

/** Funcion pura: que tan cerca esta de vencer el token. */
export function evaluarExpiracionToken(estado: EstadoTokenMeta, ahora: Date): DiagnosticoTokenMeta {
  if (estado.valido === false) return { tipo: "vencido", expiraEn: estado.expiraEn };
  if (estado.expiraEn === null || Number.isNaN(estado.expiraEn.getTime())) return { tipo: "sin_fecha" };
  const restanteMs = estado.expiraEn.getTime() - ahora.getTime();
  if (restanteMs <= 0) return { tipo: "vencido", expiraEn: estado.expiraEn };
  const diasRestantes = restanteMs / DIA_MS;
  // El umbral mas urgente ya alcanzado = el menor de [14, 7, 1] que cubre los dias restantes.
  const alcanzados = UMBRALES_TOKEN_META_DIAS.filter((u) => diasRestantes <= u);
  if (alcanzados.length === 0) return { tipo: "vigente", diasRestantes };
  return { tipo: "por_vencer", umbral: Math.min(...alcanzados) as UmbralTokenMetaDias, diasRestantes, expiraEn: estado.expiraEn };
}

export type ResultadoVigilanciaToken =
  | { readonly estado: "no_leido" }
  | { readonly estado: "sin_fecha" }
  | { readonly estado: "vigente"; readonly diasRestantes: number }
  | { readonly estado: "por_vencer"; readonly umbral: UmbralTokenMetaDias; readonly emitida: boolean }
  | { readonly estado: "vencido"; readonly emitida: boolean };

/** Lee el estado, evalua y emite (idempotente). Nunca lanza: un fallo de lectura es `no_leido`; uno de emision, `emitida: false`. */
export async function vigilarTokenMeta(session: TenantDbSession, lector: LectorEstadoTokenMeta, ahora: Date): Promise<ResultadoVigilanciaToken> {
  let estado: EstadoTokenMeta;
  try {
    estado = await lector.leer();
  } catch {
    return { estado: "no_leido" };
  }
  const d = evaluarExpiracionToken(estado, ahora);
  if (d.tipo === "sin_fecha") return { estado: "sin_fecha" };
  if (d.tipo === "vigente") return { estado: "vigente", diasRestantes: d.diasRestantes };
  try {
    if (d.tipo === "por_vencer") {
      const r = await emitirNotificacion(session, {
        evento: "superadmin.whatsapp.token_por_vencer",
        organizationId: null,
        clave: `u${d.umbral}:${diaMerida(d.expiraEn)}`,
        parametros: { dias: Math.ceil(d.diasRestantes) },
      });
      return { estado: "por_vencer", umbral: d.umbral, emitida: r.estado === "emitida" || r.estado === "sin_nuevas" };
    }
    const r = await emitirNotificacion(session, { evento: "superadmin.whatsapp.token_vencido", organizationId: null, clave: diaMerida(ahora) });
    return { estado: "vencido", emitida: r.estado === "emitida" || r.estado === "sin_nuevas" };
  } catch {
    return d.tipo === "por_vencer" ? { estado: "por_vencer", umbral: d.umbral, emitida: false } : { estado: "vencido", emitida: false };
  }
}
