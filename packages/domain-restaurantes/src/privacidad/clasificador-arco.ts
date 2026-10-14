// Clasificador LLM barato de derechos ARCO: RED DE SEGURIDAD de la capa regex (arco-deteccion.ts). Un detector de regex no generaliza a frases nuevas y un falso negativo de ARCO es
// incumplimiento legal (LFPDPPP, plazo de 20 dias), asi que cuando la capa regex no vio una senal FUERTE, un modelo barato con salida JSON estructurada lee el mensaje.
//
// Contrato (todo esto esta probado):
//   - NUNCA bloquea el pedido: ante cualquier falla (proveedor, timeout, JSON invalido, tope diario, interruptor apagado) devuelve `null` y el llamador degrada a regex. La falla se
//     informa a `alFinalizar` (sin texto del cliente) para que quede registrada.
//   - Timeout corto (2 s por omision) con AbortSignal.
//   - Sin datos personales extra: solo viaja el texto del propio mensaje del cliente, con tarjetas redactadas y numeros largos enmascarados; ningun telefono, nombre de
//     organizacion ni historial.
//   - Costo por llamada: `alFinalizar` recibe tokens y costo (el gateway ademas lo registra por rol en el control de gasto de API); tope diario propio por organizacion.
//   - Un prefiltro de vocabulario evita llamar al modelo con mensajes claramente solo-pedido («2 tacos de pastor»).
import { redactarTranscripcion } from "../voz/transcripcion.ts";
import { normalizarParaArco } from "./arco-deteccion.ts";
import type { DataRightType } from "./data-rights.ts";

export const INTENCIONES_CLASIFICADAS = ["acceso", "rectificacion", "cancelacion", "oposicion", "revocacion_contacto", "ninguna"] as const;
export type IntencionClasificada = (typeof INTENCIONES_CLASIFICADAS)[number];

export interface ResultadoClasificadorArco {
  readonly intencion: IntencionClasificada;
  /** 0..1 */
  readonly confianza: number;
  readonly derechoMasProbable: DataRightType | null;
}

/** Esquema JSON estricto de la salida (`response_format: json_schema`). El resultado se vuelve a validar a mano: ningun modelo se toma al pie de la letra. */
export const ESQUEMA_CLASIFICADOR_ARCO = {
  type: "object",
  additionalProperties: false,
  properties: {
    intencion: { type: "string", enum: [...INTENCIONES_CLASIFICADAS] },
    confianza: { type: "number" },
    derecho_mas_probable: { type: ["string", "null"], enum: ["acceso", "rectificacion", "cancelacion", "oposicion", null] },
  },
  required: ["intencion", "confianza", "derecho_mas_probable"],
} as const;

export const PROMPT_CLASIFICADOR_ARCO = `Eres un clasificador. Lees UN mensaje que un cliente le escribio por WhatsApp a un restaurante y decides si pide ejercer un derecho sobre sus datos personales (derechos ARCO de la ley mexicana) o frenar que lo contacten. No conversas ni respondes al cliente.

Intenciones:
- acceso: quiere saber que datos suyos tiene el restaurante, para que los usa, con quien los comparte, cuanto tiempo los guarda, de donde los obtuvo, o pide una copia.
- rectificacion: pide corregir o actualizar sus datos personales GUARDADOS por el restaurante (nombre, telefono, correo en su registro de cliente).
- cancelacion: pide que borren, eliminen, quiten, descarten o den de baja sus datos, su numero o su registro; que ya no lo tengan en su base o sistema.
- oposicion: pide que dejen de USAR o COMPARTIR sus datos o retira su consentimiento, sin pedir borrado.
- revocacion_contacto: pide que dejen de escribirle, llamarle o mandarle mensajes, promociones, ofertas o publicidad, o salir de sus listas o grupos de promociones.
- ninguna: cualquier otra cosa.

Es "ninguna" (muy importante, no inventes derechos):
- Todo lo que sea del PEDIDO: agregar, quitar, cambiar o cancelar productos u ordenes; la cuenta o ticket; cambiar el nombre, la direccion o el telefono DE ENTREGA o de la orden; datos para la factura o el envio («mis datos son...», «te paso mis datos», «anota mi direccion»); preguntar que datos hacen falta.
- Quejas en pasado: «nunca me llamaron», «no me llego el mensaje de confirmacion», «el repartidor no me escribio».
- Preferencias del servicio: «no me llamen al llegar, toquen el timbre», «no me manden cubiertos», «mejor escribanme».
- Preguntas sobre menu, horarios, precios, promociones que si quiere recibir.
- Cuando la persona habla de datos de OTRA persona.

Responde SOLO con el JSON del esquema. "confianza" es tu seguridad entre 0 y 1. "derecho_mas_probable" es acceso, rectificacion, cancelacion u oposicion (revocacion_contacto cuenta como oposicion), o null si la intencion es ninguna.

Ejemplos:
«para que quieren mi numero» -> {"intencion":"acceso","confianza":0.95,"derecho_mas_probable":"acceso"}
«ya no quiero estar en su sistema» -> {"intencion":"cancelacion","confianza":0.93,"derecho_mas_probable":"cancelacion"}
«paren de mandarme mensajes» -> {"intencion":"revocacion_contacto","confianza":0.96,"derecho_mas_probable":"oposicion"}
«mi correo esta mal en su registro, es ana@mail.com» -> {"intencion":"rectificacion","confianza":0.9,"derecho_mas_probable":"rectificacion"}
«borra el refresco y cambia el nombre del pedido a Luis» -> {"intencion":"ninguna","confianza":0.98,"derecho_mas_probable":null}
«te mando mis datos para la factura» -> {"intencion":"ninguna","confianza":0.97,"derecho_mas_probable":null}
«el repartidor nunca me llamo» -> {"intencion":"ninguna","confianza":0.97,"derecho_mas_probable":null}`;

/**
 * Prefiltro de vocabulario: ¿el mensaje toca datos, contacto o listas, o pide quitar/borrar/parar algo? Si no, es claramente solo-pedido y NO se llama al modelo
 * (ahorra costo y latencia). Es deliberadamente AMPLIO: un falso «si» solo cuesta una llamada barata; un falso «no» seria un falso negativo legal.
 */
const VOCABULARIO_ARCO =
  /\b(?:dato|datos|informacion|info|numero|telefono|celular|cel|correo|email|mail|nombre|apellido|direccion|domicilio|registr\w*|guard\w*|conserv\w*|almacen\w*|base|bases|sistema|lista|listas|grupo|grupos|contact\w*|escrib\w*|llam\w*|mand\w*|envi\w*|mensaj\w*|publicidad|promo\w*|oferta\w*|aviso\w*|notificac\w*|spam|suscri\w*|desuscri\w*|boletin|baja|borr\w*|elimin\w*|suprim\w*|quit\w*|descart\w*|saqu\w*|sac\w*|olvid\w*|destru\w*|retir\w*|revoc\w*|oponer\w*|opongo|oposicion|autoriz\w*|consent\w*|permiso|privacidad|arco|derecho\w*|comparte\w*|compart\w*|vend\w*|ced\w*|usan|usen|utiliz\w*|trat\w*|cliente|clienta|cuenta|perfil|historial|paren|pare|basta|dejen|dejar|ya no|no mas|nunca|jamas|sigan|vuelvan|salir\w*|desactiv\w*|cancel\w*|actualic\w*|corrij\w*|corrig\w*|modifiqu\w*|rectific\w*|cambi\w*|consiguieron|obtuvieron|sacaron|quien\w* les|para que|por que tienen|hacen con)\b/;

/** `true` si el mensaje merece pasar por el clasificador (no es claramente solo-pedido). */
export function debeClasificarArco(texto: string): boolean {
  if (typeof texto !== "string") return false;
  const n = normalizarParaArco(texto);
  if (n.length < 4) return false;
  return VOCABULARIO_ARCO.test(n);
}

/** Texto que viaja al modelo: tarjetas redactadas, numeros largos enmascarados, acotado. Nada mas del cliente ni de la organizacion. */
export function textoParaClasificador(texto: string, maximo = 1200): string {
  const sinTarjetas = redactarTranscripcion(texto);
  const sinNumeros = sinTarjetas.replace(/\+?\d[\d\s().-]{6,}\d/g, "[numero]");
  return sinNumeros.replace(/\s+/g, " ").trim().slice(0, maximo);
}

export interface EntradaCompletarJson {
  readonly system: string;
  readonly user: string;
  readonly schemaName: string;
  readonly schema: Record<string, unknown>;
  readonly maxOutputTokens: number;
  readonly signal: AbortSignal;
  readonly organizationId: string;
}

export interface SalidaCompletarJson {
  readonly text: string;
  readonly model?: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly costUsd?: number;
}

/** Puerto hacia el gateway LLM (apps/api lo implementa con el rol `restaurantes:clasificador_arco`; el script de medicion con OpenRouter directo). */
export type CompletarJson = (entrada: EntradaCompletarJson) => Promise<SalidaCompletarJson>;

export type FallaClasificador = "timeout" | "proveedor" | "json_invalido" | "tope_diario" | "apagado";

export interface EventoClasificador {
  readonly ok: boolean;
  readonly falla?: FallaClasificador;
  readonly ms: number;
  readonly intencion?: IntencionClasificada;
  readonly confianza?: number;
  readonly model?: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly costUsd?: number;
}

export interface ClasificadorArco {
  /** `null` = no disponible (falla, tope, timeout): el llamador degrada a la capa regex. Nunca lanza. */
  clasificar(entrada: { readonly texto: string; readonly organizationId: string }): Promise<ResultadoClasificadorArco | null>;
}

export interface OpcionesClasificadorArco {
  readonly completar: CompletarJson;
  /** Por omision 2000 ms. */
  readonly timeoutMs?: number;
  /** Tope de llamadas por organizacion y dia UTC en ESTE proceso (defensa en profundidad; el rol del gateway trae su tope diario persistente). Por omision 1000. */
  readonly topeDiarioPorOrganizacion?: number;
  readonly alFinalizar?: (evento: EventoClasificador) => void;
  readonly ahoraMs?: () => number;
}

/** Valida y normaliza la salida del modelo; `null` si no cumple el esquema. */
export function parsearSalidaClasificador(texto: string): ResultadoClasificadorArco | null {
  let crudo: unknown;
  try {
    crudo = JSON.parse(texto.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return null;
  }
  if (!crudo || typeof crudo !== "object" || Array.isArray(crudo)) return null;
  const o = crudo as Record<string, unknown>;
  const intencion = o.intencion;
  if (typeof intencion !== "string" || !(INTENCIONES_CLASIFICADAS as readonly string[]).includes(intencion)) return null;
  const confianzaCruda = typeof o.confianza === "number" ? o.confianza : typeof o.confianza === "string" ? Number(o.confianza) : NaN;
  if (!Number.isFinite(confianzaCruda)) return null;
  const confianza = Math.min(1, Math.max(0, confianzaCruda));
  const d = o.derecho_mas_probable;
  const derecho = d === "acceso" || d === "rectificacion" || d === "cancelacion" || d === "oposicion" ? d : null;
  return { intencion: intencion as IntencionClasificada, confianza, derechoMasProbable: derecho };
}

export function crearClasificadorArco(opciones: OpcionesClasificadorArco): ClasificadorArco {
  const timeoutMs = opciones.timeoutMs ?? 2000;
  const tope = opciones.topeDiarioPorOrganizacion ?? 1000;
  const ahora = opciones.ahoraMs ?? Date.now;
  const contadores = new Map<string, number>();
  const informar = (e: EventoClasificador): void => {
    try {
      opciones.alFinalizar?.(e);
    } catch {
      /* el registro nunca rompe el turno */
    }
  };

  return {
    async clasificar({ texto, organizationId }) {
      const t0 = ahora();
      const fallar = (falla: FallaClasificador): null => {
        informar({ ok: false, falla, ms: Math.max(0, ahora() - t0) });
        return null;
      };
      const dia = new Date(t0).toISOString().slice(0, 10);
      const clave = `${organizationId}|${dia}`;
      const usadas = contadores.get(clave) ?? 0;
      if (usadas >= tope) return fallar("tope_diario");
      contadores.set(clave, usadas + 1);
      if (contadores.size > 5000) for (const k of contadores.keys()) if (!k.endsWith(dia)) contadores.delete(k);

      const control = new AbortController();
      let vencido = false;
      const reloj = setTimeout(() => {
        vencido = true;
        control.abort();
      }, timeoutMs);
      try {
        const salida = await Promise.race([
          opciones.completar({ system: PROMPT_CLASIFICADOR_ARCO, user: `Mensaje del cliente:\n«${textoParaClasificador(texto)}»`, schemaName: "clasificacion_arco", schema: ESQUEMA_CLASIFICADOR_ARCO as unknown as Record<string, unknown>, maxOutputTokens: 120, signal: control.signal, organizationId }),
          new Promise<never>((_, rechazar) => control.signal.addEventListener("abort", () => rechazar(new Error("timeout")), { once: true })),
        ]);
        const resultado = parsearSalidaClasificador(salida.text);
        if (!resultado) {
          informar({ ok: false, falla: "json_invalido", ms: ahora() - t0, ...(salida.model ? { model: salida.model } : {}), ...(salida.tokensIn !== undefined ? { tokensIn: salida.tokensIn } : {}), ...(salida.tokensOut !== undefined ? { tokensOut: salida.tokensOut } : {}), ...(salida.costUsd !== undefined ? { costUsd: salida.costUsd } : {}) });
          return null;
        }
        informar({
          ok: true,
          ms: ahora() - t0,
          intencion: resultado.intencion,
          confianza: resultado.confianza,
          ...(salida.model ? { model: salida.model } : {}),
          ...(salida.tokensIn !== undefined ? { tokensIn: salida.tokensIn } : {}),
          ...(salida.tokensOut !== undefined ? { tokensOut: salida.tokensOut } : {}),
          ...(salida.costUsd !== undefined ? { costUsd: salida.costUsd } : {}),
        });
        return resultado;
      } catch (err) {
        if (vencido || (err instanceof Error && err.message === "timeout")) return fallar("timeout");
        const nombre = err instanceof Error ? err.name : "";
        if (nombre === "KillSwitchEngagedError") return fallar("apagado");
        if (nombre === "RoleDailyTurnLimitExceededError") return fallar("tope_diario");
        return fallar("proveedor");
      } finally {
        clearTimeout(reloj);
      }
    },
  };
}

/** Umbrales de decision (ver `decidirConClasificador`). */
export const UMBRAL_CONFIANZA_ALTA = 0.7;
export const UMBRAL_CONFIANZA_MEDIA = 0.4;
export const UMBRAL_NINGUNA_ALTA = 0.8;

export type DecisionDelClasificador =
  | { readonly tipo: "peticion"; readonly right: DataRightType; readonly contacto: boolean }
  | { readonly tipo: "debil"; readonly derechoProbable: DataRightType | null }
  | { readonly tipo: "ninguna_segura" }
  | { readonly tipo: "nada" };

/** Traduce la clasificacion en una decision: peticion concreta (confianza alta), senal debil (media) o nada. «ninguna_segura» permite descartar una senal regex debil. */
export function decidirConClasificador(r: ResultadoClasificadorArco | null): DecisionDelClasificador {
  if (!r) return { tipo: "nada" };
  if (r.intencion === "ninguna") return r.confianza >= UMBRAL_NINGUNA_ALTA ? { tipo: "ninguna_segura" } : { tipo: "nada" };
  const right: DataRightType = r.intencion === "revocacion_contacto" ? "oposicion" : r.intencion;
  if (r.confianza >= UMBRAL_CONFIANZA_ALTA) return { tipo: "peticion", right, contacto: r.intencion === "revocacion_contacto" };
  if (r.confianza >= UMBRAL_CONFIANZA_MEDIA) return { tipo: "debil", derechoProbable: r.derechoMasProbable ?? right };
  return { tipo: "nada" };
}
