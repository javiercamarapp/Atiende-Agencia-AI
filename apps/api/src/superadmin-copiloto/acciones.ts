// Acciones del Copiloto de superadmin (CHAT-17): la herramienta `proponer_accion` y el estado/confirmacion de las propuestas.
//
// PRINCIPIO RECTOR: el modelo SOLO PROPONE. `proponer_accion` nunca ejecuta nada: crea una propuesta de vida corta (5 minutos) y la UI la
// muestra como tarjeta; ejecutar exige que la MISMA persona la confirme con un segundo POST, con step-up (MFA reciente) y, para los interruptores,
// con motivo de 20 caracteres o mas. Esa confirmacion NO pasa por el modelo ni por este modulo del catalogo: la hacen rutas con el middleware de step-up.
//
// Dos clases de propuesta (catalogo CERRADO; cualquier otro tipo es rechazado por el esquema de parametros de la herramienta):
//   * `intent`: reencolar_mensaje_muerto, cerrar_prospecto y ejecutar_mantenimiento_ahora. Es un `core.superadmin_action_intent` REAL (un solo uso,
//     vence en 5 minutos, ligado al actor `creado_por = auth.uid()`; el payload se valida con las mismas reglas que la pantalla de Acciones
//     -- `superadmin-acciones/componer.ts`). Se confirma con `POST /superadmin/acciones/intents/:id/confirmar` (ya exige step-up).
//   * `interruptor`: apagar/encender un agente (`core.platform_switch`, solo los de `SWITCHABLE_AGENT_ROLES`). El CHECK de tipo de
//     `core.superadmin_action_intent` solo admite los tres tipos de arriba, y esta tarea no agrega SQL: la propuesta es un TOKEN firmado
//     (HMAC-SHA256 con una subllave de JWT_SECRET) que liga actor + agente + efecto + estado observado + vencimiento + nonce. Un solo uso se garantiza de dos
//     formas: (1) el nonce se consume en memoria de la instancia, y (2) compare-and-set: el token recuerda si el agente estaba apagado al proponer y la
//     confirmacion se rechaza si el interruptor ya cambio (asi un token ya aplicado no se reaplica aunque la peticion caiga en otra instancia).
//     Hueco declarado: cuando exista SQL, mover esta clase a un tipo mas de `superadmin_action_intent`.
//
// El token usa solo letras minusculas a proposito: viaja en una celda del bloque de la respuesta y el motor redacta como "telefono" o "tarjeta" las
// rachas largas de digitos. Nunca lleva datos legibles: el agente y el efecto los manda la UI en la confirmacion y la firma los valida.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError } from "@atiende/core-auth";
import { sanitizeCell, type DataChatTool, type DataChatToolResult } from "@atiende/agent-core/data-chat";
import type { PlatformSwitchRow, SuperadminActionIntentRow } from "@atiende/db";
import { SWITCHABLE_AGENT_ROLES } from "../platform-switches.ts";
import type { PlatformScope } from "./alcance.ts";
import type { Fuente } from "./fuentes.ts";

export const VIDA_PROPUESTA_MS = 5 * 60_000;
export const TOOL_PROPONER_ACCION = "proponer_accion";

export const TIPOS_PROPUESTA = ["apagar_agente", "encender_agente", "reencolar_mensaje_muerto", "cerrar_prospecto", "ejecutar_mantenimiento_ahora"] as const;
export type TipoPropuesta = (typeof TIPOS_PROPUESTA)[number];
const TIPOS_INTENT: ReadonlySet<string> = new Set(["reencolar_mensaje_muerto", "cerrar_prospecto", "ejecutar_mantenimiento_ahora"]);

export type EstadoPropuesta = "pendiente" | "ejecutada" | "fallida" | "cancelada" | "vencida" | "archivada";

/** Lo que `proponer_accion` necesita del exterior (inyectado: las pruebas usan dobles, nunca la base). */
export interface DependenciasAcciones {
  /** Subllave de firma (derivada de JWT_SECRET con separacion de dominio). */
  readonly secreto: string;
  readonly ahora: () => number;
  /** Valida el payload y arma el resumen legible con las MISMAS reglas que `POST /superadmin/acciones/intents`. Lanza `ApiError` si es invalido. */
  componerIntent(tipo: string, payload: Record<string, unknown>): Promise<{ readonly resumen: string; readonly payloadValidado: Record<string, unknown> }>;
  /** Crea el intent (NUNCA lo ejecuta). */
  crearIntent(tipo: "reencolar_mensaje_muerto" | "cerrar_prospecto" | "ejecutar_mantenimiento_ahora", payload: Record<string, unknown>, resumen: string, minutos: number): Promise<Pick<SuperadminActionIntentRow, "id" | "venceEn">>;
  interruptores(): Promise<Fuente<readonly PlatformSwitchRow[]>>;
  /** Aviso in-app (mejor esfuerzo; nunca lanza). `clave` = clave de dedupe estable de la propuesta. */
  avisar(clave: string): Promise<void>;
}

// ------------------------------------------------------------------------------------------------------------------------------
// Token firmado de la propuesta de interruptor
// ------------------------------------------------------------------------------------------------------------------------------
const LETRAS = "abcdefghijklmnopqrstuvwxyz";
/** 16 letras: cada letra sale de UN nibble (4 bits) de bytes aleatorios o de la firma, asi el mapeo no tiene sesgo de modulo. */
const NIBBLES = "abcdefghijklmnop";
const TOKEN_RE = /^[a-z]{44}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const esTokenInterruptor = (s: string): boolean => TOKEN_RE.test(s);

/** `n` letras (alfabeto de 16) a partir de los nibbles de `buf`: sin modulo, por lo tanto sin sesgo. */
function aLetras(buf: Uint8Array, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) {
    const byte = buf[i >> 1] ?? 0;
    s += NIBBLES[i % 2 === 0 ? byte >> 4 : byte & 15];
  }
  return s;
}

function expALetras(seg: number): string {
  let s = "";
  let v = seg;
  for (let i = 0; i < 7; i++) {
    s = `${LETRAS[v % 26]}${s}`;
    v = Math.floor(v / 26);
  }
  return s;
}

function letrasAExp(s: string): number {
  let v = 0;
  for (const ch of s) v = v * 26 + LETRAS.indexOf(ch);
  return v;
}

/** Efecto y estado observado codificados en una letra: bit 1 = bloquear (apagar); bit 2 = se conocia el estado previo; bit 4 = estaba apagado. */
function banderas(bloquear: boolean, antes: boolean | null): string {
  return LETRAS[(bloquear ? 1 : 0) + (antes === null ? 0 : 2) + (antes === true ? 4 : 0)] ?? "a";
}

function leerBanderas(ch: string): { readonly bloquear: boolean; readonly antes: boolean | null } {
  const n = LETRAS.indexOf(ch);
  return { bloquear: (n & 1) === 1, antes: (n & 2) === 0 ? null : (n & 4) === 4 };
}

function firma(secreto: string, actor: string, agente: string, flag: string, exp: string, nonce: string): string {
  return aLetras(createHmac("sha256", secreto).update(["interruptor", actor, agente, flag, exp, nonce].join("|")).digest(), 26);
}

export interface PropuestaInterruptor {
  readonly nonce: string;
  readonly venceMs: number;
  readonly bloquear: boolean;
  readonly antes: boolean | null;
}

export function firmarPropuestaInterruptor(secreto: string, actor: string, agente: string, bloquear: boolean, antes: boolean | null, ahoraMs: number): string {
  const flag = banderas(bloquear, antes);
  const exp = expALetras(Math.floor((ahoraMs + VIDA_PROPUESTA_MS) / 1000));
  const nonce = aLetras(randomBytes(5), 10);
  return `${flag}${exp}${nonce}${firma(secreto, actor, agente, flag, exp, nonce)}`;
}

export type VerificacionPropuesta = { readonly ok: true; readonly propuesta: PropuestaInterruptor } | { readonly ok: false; readonly motivo: "malformada" | "firma" | "vencida" };

/** Verifica la firma (ligada al actor y al agente) y el vencimiento. Una firma distinta, de otro actor o de otro agente es `firma`. */
export function verificarPropuestaInterruptor(secreto: string, actor: string, agente: string, token: string, ahoraMs: number): VerificacionPropuesta {
  if (!TOKEN_RE.test(token)) return { ok: false, motivo: "malformada" };
  const flag = token.slice(0, 1);
  const exp = token.slice(1, 8);
  const nonce = token.slice(8, 18);
  const esperada = Buffer.from(firma(secreto, actor, agente, flag, exp, nonce));
  const recibida = Buffer.from(token.slice(18));
  if (esperada.length !== recibida.length || !timingSafeEqual(esperada, recibida)) return { ok: false, motivo: "firma" };
  const venceMs = letrasAExp(exp) * 1000;
  if (venceMs <= ahoraMs) return { ok: false, motivo: "vencida" };
  return { ok: true, propuesta: { nonce, venceMs, ...leerBanderas(flag) } };
}

// Nonces ya consumidos EN ESTA INSTANCIA (el compare-and-set del estado cubre las demas). Se purgan al vencer.
const CONSUMIDOS = new Map<string, number>();
function purgarConsumidos(ahoraMs: number): void {
  for (const [n, venceMs] of CONSUMIDOS) if (venceMs <= ahoraMs) CONSUMIDOS.delete(n);
}
export function nonceConsumido(nonce: string, ahoraMs: number): boolean {
  purgarConsumidos(ahoraMs);
  return CONSUMIDOS.has(nonce);
}
export function consumirNonce(nonce: string, venceMs: number, ahoraMs: number): boolean {
  purgarConsumidos(ahoraMs);
  if (CONSUMIDOS.has(nonce)) return false;
  CONSUMIDOS.set(nonce, venceMs);
  return true;
}
export function liberarNonce(nonce: string): void {
  CONSUMIDOS.delete(nonce);
}
/** Solo para pruebas. */
export function reiniciarNoncesConsumidos(): void {
  CONSUMIDOS.clear();
}

// ------------------------------------------------------------------------------------------------------------------------------
// Textos (deterministas: ninguna redaccion del modelo llega a la tarjeta)
// ------------------------------------------------------------------------------------------------------------------------------
export function resumenInterruptor(agente: string, bloquear: boolean): string {
  return bloquear
    ? `Apagar el agente ${agente}: deja de llamar al modelo de IA en toda la plataforma hasta que alguien lo encienda. Se revierte desde Interruptores o desde el Copiloto.`
    : `Encender el agente ${agente}: vuelve a llamar al modelo de IA en toda la plataforma. Se revierte desde Interruptores o desde el Copiloto.`;
}

export function estaApagado(interruptores: readonly PlatformSwitchRow[], agente: string): boolean {
  return interruptores.some((s) => s.scope === "agente" && s.target === agente && s.blocked);
}

function noDisponible(message: string): DataChatToolResult {
  return { status: "unavailable", message, source: "Propuesta de acción del Copiloto", scopeLabel: "Toda la plataforma", columns: [], rows: [] };
}

function aclaracion(message: string): DataChatToolResult {
  return { status: "needs_clarification", message, source: "Propuesta de acción del Copiloto", scopeLabel: "Toda la plataforma", columns: [], rows: [] };
}

// ------------------------------------------------------------------------------------------------------------------------------
// La herramienta
// ------------------------------------------------------------------------------------------------------------------------------
const COLAS = ["citas", "hoteles", "restaurantes", "despachos", "rentas", "licitaciones"] as const;

/** Catalogo cerrado. Solo el superadmin completo la ve (el rol `finanzas` es de solo lectura y nunca la recibe). Nunca ejecuta: crea la propuesta. */
export function crearHerramientaProponerAccion(scope: PlatformScope, dep: DependenciasAcciones): DataChatTool {
  return {
    name: TOOL_PROPONER_ACCION,
    label: "Proponer una acción",
    description: "Prepara UNA acción para que una persona la confirme (no la ejecuta): apagar o encender un agente, reencolar un mensaje muerto, cerrar un prospecto o correr el mantenimiento.",
    params: {
      tipo: { type: "enum", values: TIPOS_PROPUESTA, description: "La acción a proponer." },
      agente: { type: "enum", values: SWITCHABLE_AGENT_ROLES, optional: true, description: "Rol del agente (solo apagar_agente y encender_agente)." },
      cola: { type: "enum", values: COLAS, optional: true, description: "Cola del mensaje muerto (solo reencolar_mensaje_muerto)." },
      mensaje_id: { type: "string", maxLength: 64, optional: true, description: "Id del mensaje muerto (solo reencolar_mensaje_muerto)." },
      prospecto_id: { type: "string", maxLength: 64, optional: true, description: "Id del prospecto (solo cerrar_prospecto)." },
      estado: { type: "enum", values: ["perdido", "descartado"], optional: true, description: "Estado destino (solo cerrar_prospecto)." },
    },
    async run(_ctx, args): Promise<DataChatToolResult> {
      // Defensa en profundidad: el catalogo ya no la ofrece a `finanzas`, pero una herramienta que puede crear intents jamas confia solo en eso.
      if (scope.rol !== "superadmin") return noDisponible("Tu rol es de solo lectura: no puede proponer acciones.");
      const tipo = args["tipo"] as TipoPropuesta | undefined;
      if (!tipo || !(TIPOS_PROPUESTA as readonly string[]).includes(tipo)) return aclaracion("Dime qué acción quieres proponer.");
      const ahora = dep.ahora();
      const venceIso = new Date(ahora + VIDA_PROPUESTA_MS).toISOString();
      const fila = (propuesta: string, clase: "intent" | "interruptor", objetivo: string, resumen: string, agente?: string): DataChatToolResult => ({
        status: "ok",
        source: "Propuesta de acción del Copiloto (no se ejecuta hasta que una persona la confirma)",
        scopeLabel: "Toda la plataforma",
        columns: [
          { key: "propuesta", label: "Propuesta", kind: "text" },
          { key: "clase", label: "Clase", kind: "text" },
          { key: "tipo", label: "Acción", kind: "text" },
          { key: "objetivo", label: "Objetivo", kind: "text" },
          { key: "resumen", label: "Efecto", kind: "text" },
          { key: "vence", label: "Vence", kind: "text" },
          ...(agente ? [{ key: "agente", label: "Agente", kind: "text" as const }] : []),
        ],
        rows: [{ propuesta, clase, tipo, objetivo, resumen, vence: venceIso, ...(agente ? { agente } : {}) }],
        summary: "Dejé la acción preparada como propuesta. No se ejecuta sola: revísala en la tarjeta, confírmala con tu verificación o ignórala.",
      });

      if (tipo === "apagar_agente" || tipo === "encender_agente") {
        const agente = typeof args["agente"] === "string" ? args["agente"] : "";
        if (!agente || !SWITCHABLE_AGENT_ROLES.includes(agente)) return aclaracion("Dime qué agente (rol) quieres apagar o encender.");
        const sw = await dep.interruptores();
        if (!sw.ok) return noDisponible("No pude leer el estado de los interruptores en este momento, así que no propongo el cambio.");
        const bloquear = tipo === "apagar_agente";
        const actual = estaApagado(sw.data, agente);
        if (actual === bloquear) return aclaracion(`Ese agente ya está ${bloquear ? "apagado" : "encendido"}: no hay nada que proponer.`);
        const token = firmarPropuestaInterruptor(dep.secreto, scope.userId, agente, bloquear, actual, ahora);
        await dep.avisar(`sw-${token.slice(8, 18)}`);
        return fila(token, "interruptor", sanitizeCell(agente, 60), resumenInterruptor(agente, bloquear), agente);
      }

      if (!TIPOS_INTENT.has(tipo)) return aclaracion("Esa acción no está en el catálogo.");
      const payload: Record<string, unknown> =
        tipo === "reencolar_mensaje_muerto"
          ? { queue: args["cola"], mensajeId: args["mensaje_id"] }
          : tipo === "cerrar_prospecto"
            ? { prospectoId: args["prospecto_id"], estado: args["estado"] }
            : {};
      try {
        const { resumen, payloadValidado } = await dep.componerIntent(tipo, payload);
        const intent = await dep.crearIntent(tipo as "reencolar_mensaje_muerto" | "cerrar_prospecto" | "ejecutar_mantenimiento_ahora", payloadValidado, resumen, VIDA_PROPUESTA_MS / 60_000);
        await dep.avisar(`intent-${intent.id}`);
        return fila(intent.id, "intent", tipo === "ejecutar_mantenimiento_ahora" ? "Mantenimiento" : sanitizeCell(resumen, 60), resumen);
      } catch (err) {
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) return aclaracion(sanitizeCell(err.message, 200));
        // Base sin la tabla de intents u otro fallo: se dice, no se inventa una propuesta.
        return noDisponible("No pude preparar esa acción en este momento. Inténtalo de nuevo o hazla desde Acciones.");
      }
    },
  };
}

// ------------------------------------------------------------------------------------------------------------------------------
// Estado de una propuesta (lo que la tarjeta consulta al abrirse y al reabrir una conversacion)
// ------------------------------------------------------------------------------------------------------------------------------
export interface VistaPropuesta {
  readonly propuesta: string;
  readonly clase: "intent" | "interruptor";
  readonly tipo: string;
  readonly resumen: string;
  readonly estado: EstadoPropuesta;
  readonly venceEn: string | null;
  readonly agente?: string;
  readonly bloquear?: boolean;
}

export function vistaDeIntent(i: SuperadminActionIntentRow, callerId: string, ahoraMs: number): VistaPropuesta | null {
  if (i.creadoPor !== callerId) return null; // ajena o inexistente: indistinguibles (nunca se filtra que existe)
  const venceMs = new Date(i.venceEn).getTime();
  const estado: EstadoPropuesta =
    i.estado === "executed" ? "ejecutada" : i.estado === "failed" ? "fallida" : i.estado === "cancelled" ? "cancelada" : i.estado === "expired" || venceMs <= ahoraMs ? "vencida" : "pendiente";
  return { propuesta: i.id, clase: "intent", tipo: i.tipo, resumen: i.resumen, estado, venceEn: i.venceEn };
}

export function vistaDeInterruptor(args: {
  readonly secreto: string;
  readonly actor: string;
  readonly agente: string;
  readonly token: string;
  readonly ahoraMs: number;
  /** null = no se pudo leer el estado actual (se muestra pendiente: la confirmacion volvera a comprobarlo). */
  readonly apagadoAhora: boolean | null;
}): VistaPropuesta | null {
  if (!SWITCHABLE_AGENT_ROLES.includes(args.agente)) return null;
  const v = verificarPropuestaInterruptor(args.secreto, args.actor, args.agente, args.token, args.ahoraMs);
  if (!v.ok) {
    if (v.motivo !== "vencida") return null;
    // Vencida: se distingue de "archivada" solo si la firma es valida; se reverifica con el reloj adelantado para leer los datos.
    const lejos = verificarPropuestaInterruptor(args.secreto, args.actor, args.agente, args.token, 0);
    if (!lejos.ok) return null;
    return { propuesta: args.token, clase: "interruptor", tipo: lejos.propuesta.bloquear ? "apagar_agente" : "encender_agente", resumen: resumenInterruptor(args.agente, lejos.propuesta.bloquear), estado: "vencida", venceEn: new Date(lejos.propuesta.venceMs).toISOString(), agente: args.agente, bloquear: lejos.propuesta.bloquear };
  }
  const p = v.propuesta;
  let estado: EstadoPropuesta = "pendiente";
  if (nonceConsumido(p.nonce, args.ahoraMs)) estado = "ejecutada";
  else if (p.antes !== null && args.apagadoAhora !== null && args.apagadoAhora !== p.antes) estado = "archivada";
  return {
    propuesta: args.token,
    clase: "interruptor",
    tipo: p.bloquear ? "apagar_agente" : "encender_agente",
    resumen: resumenInterruptor(args.agente, p.bloquear),
    estado,
    venceEn: new Date(p.venceMs).toISOString(),
    agente: args.agente,
    bloquear: p.bloquear,
  };
}
