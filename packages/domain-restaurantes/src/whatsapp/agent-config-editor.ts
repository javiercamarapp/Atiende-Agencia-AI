// R-10 -- editor del agente de WhatsApp: validacion de lo que un owner/admin puede cambiar, valores por omision de cada
// perfil, vista previa (solo lectura) del prompt resultante y diferencias contra lo vigente. Todo es PURO (sin base):
// la API lo usa para validar, previsualizar y comparar ANTES de guardar.
//
// Lo editable es texto corto de una linea (nunca el prompt completo): las reglas duras viven en el codigo
// (`perfil-pm.ts`) y no se pueden borrar desde aqui. Los motivos de escalacion de seguridad (queja, alergia, cliente
// lo pide, falla, transferencia...) tampoco se pueden apagar: solo `MOTIVOS_ESCALACION_DESACTIVABLES`.
import type { BranchSummary, CustomerLookupResult, PerfilAgenteWhatsApp, WhatsAppAgentConfigInput, TonoAgenteWhatsApp } from "../types.ts";
import { MOTIVOS_ESCALACION_DESACTIVABLES, PERFILES_AGENTE_WHATSAPP, TONOS_AGENTE_WHATSAPP } from "../types.ts";
import type { MotivoEscalacionDesactivable } from "../types.ts";
import { ESPERA_RAFAGAS_MAX_SEGUNDOS, PM_CONFIG_POR_OMISION, FALLBACK_CONFIG, aplicarFilaAConfig, buildSystemPrompt } from "./llm-turn-handler.ts";
export { ESPERA_RAFAGAS_MAX_SEGUNDOS };
import { PM_PEDIDO_GRANDE_POR_OMISION, PM_PROMOS_POR_OMISION, PM_SALSAS_POR_OMISION } from "./perfil-pm.ts";

/** Topes de longitud (los mismos CHECK de la migracion 029/033). */
export const AGENTE_LIMITES = { agentName: 60, businessName: 120, deliveryTimeText: 200, greetingText: 80, salsasText: 300, promosText: 300, largeOrderText: 200 } as const;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export type ResultadoValidacion<T> = { readonly ok: true; readonly valor: T } | { readonly ok: false; readonly error: string };

function textoOpcional(raw: unknown, campo: string, max: number): ResultadoValidacion<string | null> {
  if (raw === undefined || raw === null) return { ok: true, valor: null };
  if (typeof raw !== "string") return { ok: false, error: `${campo}: se esperaba un texto o null.` };
  const recortado = raw.trim();
  if (recortado.length === 0) return { ok: true, valor: null };
  if (recortado.length > max || CONTROL.test(recortado)) return { ok: false, error: `${campo}: de 1 a ${max} caracteres, en una sola linea.` };
  return { ok: true, valor: recortado };
}

/** Valida el cuerpo de un guardado o de una vista previa. `perfil` es obligatorio. Los textos de saludo, salsas,
 * promociones y los motivos apagados solo existen en el perfil `taqueria_pm`: en el generico se rechazan para no
 * guardar una configuracion que nunca se aplica. */
export function validarConfigAgenteWhatsapp(raw: {
  readonly perfil?: unknown;
  readonly agentName?: unknown;
  readonly businessName?: unknown;
  readonly toneStyle?: unknown;
  readonly deliveryTimeText?: unknown;
  readonly greetingText?: unknown;
  readonly salsasText?: unknown;
  readonly promosText?: unknown;
  readonly escalationReasonsOff?: unknown;
  readonly largeOrderText?: unknown;
  readonly replyDebounceSeconds?: unknown;
}): ResultadoValidacion<WhatsAppAgentConfigInput> {
  if (typeof raw.perfil !== "string" || !(PERFILES_AGENTE_WHATSAPP as readonly string[]).includes(raw.perfil)) {
    return { ok: false, error: `perfil: uno de ${PERFILES_AGENTE_WHATSAPP.join(", ")}.` };
  }
  const perfil = raw.perfil as PerfilAgenteWhatsApp;
  if (raw.toneStyle !== undefined && raw.toneStyle !== null && !(TONOS_AGENTE_WHATSAPP as readonly string[]).includes(String(raw.toneStyle))) {
    return { ok: false, error: `toneStyle: uno de ${TONOS_AGENTE_WHATSAPP.join(", ")} o null.` };
  }
  const campos = {
    agentName: textoOpcional(raw.agentName, "agentName", AGENTE_LIMITES.agentName),
    businessName: textoOpcional(raw.businessName, "businessName", AGENTE_LIMITES.businessName),
    deliveryTimeText: textoOpcional(raw.deliveryTimeText, "deliveryTimeText", AGENTE_LIMITES.deliveryTimeText),
    greetingText: textoOpcional(raw.greetingText, "greetingText", AGENTE_LIMITES.greetingText),
    salsasText: textoOpcional(raw.salsasText, "salsasText", AGENTE_LIMITES.salsasText),
    promosText: textoOpcional(raw.promosText, "promosText", AGENTE_LIMITES.promosText),
    largeOrderText: textoOpcional(raw.largeOrderText, "largeOrderText", AGENTE_LIMITES.largeOrderText),
  };
  for (const r of Object.values(campos)) if (!r.ok) return r;

  // Espera de rafagas: entero de 0 a 30 o vacio (= apagado). Un texto, un decimal o un negativo se rechaza (no se redondea en silencio).
  let espera: number | null = null;
  if (raw.replyDebounceSeconds !== undefined && raw.replyDebounceSeconds !== null && raw.replyDebounceSeconds !== "") {
    const n = typeof raw.replyDebounceSeconds === "number" ? raw.replyDebounceSeconds : Number.NaN;
    if (!Number.isInteger(n) || n < 0 || n > ESPERA_RAFAGAS_MAX_SEGUNDOS) {
      return { ok: false, error: `replyDebounceSeconds: un entero de 0 a ${ESPERA_RAFAGAS_MAX_SEGUNDOS} (segundos) o vacio.` };
    }
    espera = n;
  }
  let apagados: MotivoEscalacionDesactivable[] = [];
  if (raw.escalationReasonsOff !== undefined && raw.escalationReasonsOff !== null) {
    if (!Array.isArray(raw.escalationReasonsOff)) return { ok: false, error: "escalationReasonsOff: se esperaba una lista." };
    for (const m of raw.escalationReasonsOff) {
      if (typeof m !== "string" || !(MOTIVOS_ESCALACION_DESACTIVABLES as readonly string[]).includes(m)) {
        return { ok: false, error: `escalationReasonsOff: solo se pueden desactivar ${MOTIVOS_ESCALACION_DESACTIVABLES.join(", ")} (los demas motivos protegen al cliente).` };
      }
    }
    apagados = [...new Set(raw.escalationReasonsOff as MotivoEscalacionDesactivable[])];
  }

  const value = (r: ResultadoValidacion<string | null>): string | null => (r.ok ? r.valor : null);
  const config: WhatsAppAgentConfigInput = {
    perfil,
    agentName: value(campos.agentName),
    businessName: value(campos.businessName),
    toneStyle: (raw.toneStyle ?? null) as TonoAgenteWhatsApp | null,
    deliveryTimeText: value(campos.deliveryTimeText),
    greetingText: value(campos.greetingText),
    salsasText: value(campos.salsasText),
    promosText: value(campos.promosText),
    escalationReasonsOff: apagados,
    largeOrderText: value(campos.largeOrderText),
    replyDebounceSeconds: espera,
  };
  if (perfil === "generico" && (config.greetingText || config.salsasText || config.promosText || apagados.length > 0 || config.largeOrderText || espera !== null)) {
    return { ok: false, error: "greetingText, salsasText, promosText, escalationReasonsOff, largeOrderText y replyDebounceSeconds solo aplican al perfil taqueria_pm." };
  }
  return { ok: true, valor: config };
}

/** Config en blanco: todo cae a los valores del perfil. Es lo que deja "volver al perfil por defecto". */
export function configPorDefectoDelPerfil(perfil: PerfilAgenteWhatsApp): WhatsAppAgentConfigInput {
  return { perfil, agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null, greetingText: null, salsasText: null, promosText: null, escalationReasonsOff: [], largeOrderText: null, replyDebounceSeconds: null };
}

/** Lo que cada campo vale cuando esta vacio (para mostrarlo como sugerencia en la pantalla). */
export function valoresPorOmisionDelPerfil(perfil: PerfilAgenteWhatsApp) {
  const base = perfil === "taqueria_pm" ? PM_CONFIG_POR_OMISION : FALLBACK_CONFIG;
  return {
    perfil,
    agentName: base.agentName ?? null,
    businessName: base.businessName,
    toneStyle: base.toneStyle,
    deliveryTimeText: base.deliveryTimeText,
    greetingText: null,
    salsasText: perfil === "taqueria_pm" ? PM_SALSAS_POR_OMISION : null,
    promosText: perfil === "taqueria_pm" ? PM_PROMOS_POR_OMISION : null,
    escalationReasonsOff: [] as readonly MotivoEscalacionDesactivable[],
    largeOrderText: perfil === "taqueria_pm" ? PM_PEDIDO_GRANDE_POR_OMISION : null,
    /** Apagada por omision: una espera de rafagas nueva no se activa sola (la enciende el dueño desde el panel). */
    replyDebounceSeconds: null as number | null,
  };
}

const AHORA_DE_MUESTRA = new Date("2026-03-02T18:30:00.000Z"); // un lunes por la tarde, siempre el mismo
const CLIENTE_DE_MUESTRA: CustomerLookupResult = { isNew: true };
const SUCURSALES_DE_MUESTRA: readonly BranchSummary[] = [
  { propertyId: "00000000-0000-0000-0000-000000000001", name: "Sucursal Centro", slug: "centro", address: "Calle 60 #100" },
  { propertyId: "00000000-0000-0000-0000-000000000002", name: "Sucursal Norte", slug: "norte", address: null },
];

/** Prompt que el agente usaria con esta configuracion, con una conversacion de muestra (cliente nuevo, dos sucursales,
 * un lunes a las 12:30). Solo lectura: no toca la base. */
export function previewPromptAgente(config: WhatsAppAgentConfigInput): string {
  return buildSystemPrompt(aplicarFilaAConfig(config), SUCURSALES_DE_MUESTRA, CLIENTE_DE_MUESTRA, AHORA_DE_MUESTRA, null);
}

export interface DiferenciaCampo {
  readonly campo: string;
  readonly antes: string;
  readonly despues: string;
}

const ETIQUETAS_CAMPO: Readonly<Record<string, string>> = {
  perfil: "Perfil",
  agentName: "Nombre del agente",
  businessName: "Nombre del negocio",
  toneStyle: "Tono",
  deliveryTimeText: "Tiempos de entrega",
  greetingText: "Saludo",
  salsasText: "Salsas incluidas",
  promosText: "Promociones",
  escalationReasonsOff: "Motivos de escalacion desactivados",
  largeOrderText: "Umbral de pedido grande",
  replyDebounceSeconds: "Espera de rafagas (segundos)",
};

function comoTexto(v: unknown): string {
  if (v === null || v === undefined) return "";
  return Array.isArray(v) ? [...v].map(String).sort().join(", ") : String(v);
}

/** Foto de los campos editables (la que se guarda en el historial). */
export function fotoConfigAgente(config: WhatsAppAgentConfigInput | null): Record<string, unknown> | null {
  if (!config) return null;
  return {
    perfil: config.perfil,
    agentName: config.agentName,
    businessName: config.businessName,
    toneStyle: config.toneStyle,
    deliveryTimeText: config.deliveryTimeText,
    greetingText: config.greetingText ?? null,
    salsasText: config.salsasText ?? null,
    promosText: config.promosText ?? null,
    escalationReasonsOff: [...(config.escalationReasonsOff ?? [])],
    largeOrderText: config.largeOrderText ?? null,
    replyDebounceSeconds: config.replyDebounceSeconds ?? null,
  };
}

/** Campos que cambian entre dos fotos (lo vigente `antes`, o `null` si nunca se configuro). Un campo vacio y uno ausente
 * cuentan igual. */
export function diferenciasConfigAgente(antes: Readonly<Record<string, unknown>> | null, despues: Readonly<Record<string, unknown>>): readonly DiferenciaCampo[] {
  const out: DiferenciaCampo[] = [];
  for (const campo of Object.keys(ETIQUETAS_CAMPO)) {
    const a = comoTexto(antes?.[campo]);
    const d = comoTexto(despues[campo]);
    if (a !== d) out.push({ campo: ETIQUETAS_CAMPO[campo]!, antes: a, despues: d });
  }
  return out;
}

export interface LineaDiff {
  readonly tipo: "igual" | "agregada" | "quitada";
  readonly texto: string;
}

/** Diferencias por linea entre dos prompts (LCS clasico; los prompts son de ~100 lineas). Solo para mostrar. */
export function diffLineasPrompt(antes: string, despues: string): readonly LineaDiff[] {
  const a = antes.split("\n");
  const b = despues.split("\n");
  const m = a.length;
  const n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: LineaDiff[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ tipo: "igual", texto: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ tipo: "quitada", texto: a[i++]! });
    } else {
      out.push({ tipo: "agregada", texto: b[j++]! });
    }
  }
  while (i < m) out.push({ tipo: "quitada", texto: a[i++]! });
  while (j < n) out.push({ tipo: "agregada", texto: b[j++]! });
  return out;
}
