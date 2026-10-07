// Puente entre el turno del agente de WhatsApp y el autopiloto (cancelaciones y quejas). Vive aparte de `llm-turn-handler.ts` a proposito: el handler solo
// llama a estas funciones. Reglas:
//   * Cancelacion: SOLO con la bandera por organizacion encendida (`autopiloto_org_config.cancelacion_agente`, apagada por omision). El clasificador de alto
//     riesgo (guards.ts) sigue decidiendo cuando hay una cancelacion; sus patrones no cambian. Con la bandera apagada, sin pedido activo o con la base sin
//     migrar, devuelve `null` y el turno sigue EXACTAMENTE por el camino anterior (aviso fijo al equipo y toma de handoff).
//   * El pedido sale del telefono del contexto (remitente de WhatsApp), nunca de un id que escriba el modelo o el cliente.
//   * Queja: ademas del aviso al equipo de siempre, se liga al ultimo pedido del telefono (solicitud de compensacion) y se guarda su subtipo. Nunca cambia lo
//     que se le responde al cliente ni compensa nada por su cuenta.
import { normalizePhone } from "../phone.ts";
import { esConsultaDeCancelacion, normalizarParaClasificar } from "./guards.ts";
import type { RestaurantesRepository } from "../repository.ts";
import { PostgresAutopilotoRepository } from "../autopiloto/postgres-repository.ts";
import { crearHookPedidoGrande, registrarQuejaConPedido, solicitarCancelacion } from "../autopiloto/servicio.ts";
import type { AutopilotoServicioDeps, ResultadoSolicitarCancelacion } from "../autopiloto/servicio.ts";
import { subtipoQueja } from "../autopiloto/taxonomia.ts";
import type { MotivoQueja } from "../autopiloto/taxonomia.ts";
import type { AutopilotoRepository, PedidoGrandeHook } from "../autopiloto/tipos.ts";

/** Hasta donde atras se busca el pedido del cliente al cancelar o quejarse. */
export const VENTANA_PEDIDO_AUTOPILOTO_MS = 24 * 3_600_000;

export interface AutopilotoTurnoHooks {
  cancelacionActiva(organizationId: string): Promise<boolean>;
  solicitarCancelacion(input: { readonly organizationId: string; readonly customerPhone: string; readonly ahora: Date }): Promise<ResultadoSolicitarCancelacion>;
  registrarQueja(input: { readonly organizationId: string; readonly customerPhone: string; readonly subtipo: MotivoQueja; readonly ahora: Date }): Promise<unknown>;
  /** Pedido grande: `crear_pedido` lo deja `por_aprobar` (la sucursal lo aprueba con un clic) en vez de solo avisar. Ausente = camino del aviso de siempre. */
  readonly pedidoGrande?: PedidoGrandeHook;
}

/** Hooks reales sobre UNA sesion (los usa `buildRestaurantesTurnHandlerForSession`). Cada llamada degrada a "no disponible" contra la base sin migrar. */
export function crearHooksAutopilotoTurno(deps: AutopilotoServicioDeps): AutopilotoTurnoHooks {
  return {
    pedidoGrande: crearHookPedidoGrande(deps),
    async cancelacionActiva(organizationId) {
      return (await deps.auto.leerConfigOrg(organizationId)).valor.cancelacionAgente;
    },
    solicitarCancelacion: (i) =>
      solicitarCancelacion(deps, { organizationId: i.organizationId, customerPhone: normalizePhone(i.customerPhone), desdeIso: new Date(i.ahora.getTime() - VENTANA_PEDIDO_AUTOPILOTO_MS).toISOString(), avisarCliente: false }),
    registrarQueja: (i) =>
      registrarQuejaConPedido(deps, { organizationId: i.organizationId, customerPhone: normalizePhone(i.customerPhone), desdeIso: new Date(i.ahora.getTime() - VENTANA_PEDIDO_AUTOPILOTO_MS).toISOString(), subtipo: i.subtipo }),
  };
}

export function crearHooksAutopilotoTurnoPostgres(deps: Omit<AutopilotoServicioDeps, "auto"> & { readonly auto?: AutopilotoRepository }): AutopilotoTurnoHooks {
  return crearHooksAutopilotoTurno({ ...deps, auto: deps.auto ?? new PostgresAutopilotoRepository(deps.db) });
}

/**
 * El clasificador de alto riesgo (guards.ts) no entiende la negacion: "no cancelen mi pedido" y "ya llego, no hace falta cancelar" coinciden con
 * la cancelacion. Para el aviso al equipo eso es inocuo, pero la cancelacion AUTOMATICA no puede ejecutarse con un mensaje que dice lo contrario.
 * Con negacion cerca del verbo no se interviene (`null`): el turno sigue por el camino de siempre (aviso a una persona).
 */
export function negacionDeCancelacion(texto: string): boolean {
  // Criterio asimetrico: cancelar por error un pedido real es lo caro, asi que POR DEFECTO la negacion cruza comas y cualquier forma desconocida NO cancela
  // (pasa a una persona). Solo se EXIMEN (se quitan antes de buscar la negacion) formas explicitas que si son una orden de cancelar, y NINGUNA exencion
  // aplica si una palabra condicional antecede en la frase ("si llega frio ya no lo quiero, cancelo" es una amenaza, no una orden):
  //  - "no, cancelen..." / "ya no, cancelen..." al inicio (solo si el resto es una orden simple: "no, cancelen el pedido [por favor]"; "no, cancelar el pedido jamas/ni de broma/ni loco" no se exime);
  //  - "(ya) no lo/la quiero|necesito|voy a querer" como motivo, salvo "no lo quiero (tener que) cancelar";
  //  - cortesias ("si no es molestia", "si no les molesta", "si no hay problema"), salvo "si no les molesta esperar, cancelo";
  //  - motivos ya ocurridos ("no llego", "no ha llegado", "nunca llego", "llevo una hora esperando y no llega").
  const CONDICIONAL = /\b(?:si|como|cuando|mientras|de|al|sino|a\s+menos\s+que|en\s+cuanto|caso\s+de\s+que)\b/;
  const eximir = (extra?: (resto: string) => boolean) => (m: string, ...args: unknown[]): string => {
    const off = args[args.length - 2] as number;
    const todo = args[args.length - 1] as string;
    const frase = todo.slice(0, off).split(/[.!?\n]/).pop() ?? "";
    const condicionalPrevio = CONDICIONAL.test(frase);
    // Exencion POSICIONAL: solo al inicio de la frase (con muletillas) o justo despues de la orden de cancelar; no depende de una lista cerrada de condicionales.
    const previoNeutral = /^[\s,]*(?:(?:hola|oigan|oye|pues|bueno|ok|ya|no|porque)\b[\s,]*)*$/.test(frase) || /\bcancel\w*\b[^.!?\n]*(?:,|\bporque)\s*$/.test(frase);
    return condicionalPrevio || !previoNeutral || (extra?.(todo.slice(off + m.length)) ?? false) ? m : " ";
  };
  const t = normalizarParaClasificar(texto)
    .replace(/\b([ap])\.\s?m\./g, "$1m")
    .replace(/(\d)[:.](\d)/g, "$1$2")
    .replace(/^\s*(?:ya\s+)?no\s*,\s*(?=cancel\w*\s+(?:el|mi|la|su)\s+(?:pedido|orden)\s*(?:,?\s*(?:por\s+favor|porfa|ya|gracias))*\s*[.!]*\s*$)/, " ")
    .replace(/\b(?:ya\s+)?no\s+(?:lo|la|los|las)\s+(?:quiero|necesito|voy\s+a\s+querer)\b(?!\s+(?:tener\s+que\s+)?cancelar\b)/g, eximir())
    .replace(/\bsi\s+no\s+(?:es\s+(?:mucha\s+)?molestia|(?:le|les|te|me)\s+molesta|hay\s+(?:mayor\s+)?(?:problema|inconveniente)|es\s+mucho\s+pedir)\b/g, eximir((resto) => /^[^,.!?\n]*\besper\w*/.test(resto)))
    .replace(/\bllevo\s+[^.!?\n,]{0,25}\besperando\s+y\s+no\s+llega\b/g, eximir())
    .replace(/\b(?:ya\s+)?no\s+(?:llego|llegaron|ha\s+llegado|han\s+llegado)\b|\bnunca\s+(?:llego|llegaron)\b/g, eximir());
  return /\b(?:si|como|cuando|mientras|de|al|por\s+si|caso\s+de\s+que)\b[^.!?\n]{0,60}\bno\b[^.!?\n]{0,50}\bcancel\w*|\b(?:no|nunca|ni|tampoco)\b[^.!?\n]{0,25}\bcancel\w*|\bcancel\w*[^.!?\n]{0,30}\b(?:no|nunca)\b|\bsin\s+cancelar\b|\bya\s+no\b[^.!?\n]{0,20}\bcancel\w*/.test(t);
}

/**
 * Intenta resolver la cancelacion con el autopiloto. Devuelve la respuesta fija al cliente, o `null` para seguir por el camino anterior (bandera apagada,
 * sin pedido activo, base sin migrar o cualquier error: nunca se rompe el turno).
 */
export async function intentarCancelacionConAutopiloto(
  repo: Pick<RestaurantesRepository, "runWithRowSavepoint">,
  hooks: AutopilotoTurnoHooks,
  args: { readonly organizationId: string; readonly phone: string; readonly ahora: Date; readonly texto?: string },
): Promise<{ readonly reply: string } | null> {
  // Defensa en profundidad: una pregunta ("¿se cancelo?", "¿hasta que hora se puede cancelar?") ni cancela ni abre solicitud aunque el clasificador la deje pasar.
  if (args.texto !== undefined && (negacionDeCancelacion(args.texto) || esConsultaDeCancelacion(args.texto))) return null;
  try {
    return await repo.runWithRowSavepoint(async () => {
      if (!(await hooks.cancelacionActiva(args.organizationId))) return null;
      const r = await hooks.solicitarCancelacion({ organizationId: args.organizationId, customerPhone: args.phone, ahora: args.ahora });
      if (r.resultado === "cancelado" || r.resultado === "solicitud_creada") return { reply: r.mensaje };
      return null;
    });
  } catch (err) {
    console.error("whatsapp: la cancelacion con autopiloto fallo (se sigue por el camino anterior):", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Liga la queja al ultimo pedido del telefono (best-effort; nunca cambia la respuesta ni tumba el turno). Devuelve el subtipo detectado. */
export async function registrarQuejaConAutopiloto(
  repo: Pick<RestaurantesRepository, "runWithRowSavepoint">,
  hooks: AutopilotoTurnoHooks,
  args: { readonly organizationId: string; readonly phone: string; readonly texto: string; readonly ahora: Date },
): Promise<MotivoQueja> {
  const subtipo = subtipoQueja(args.texto);
  try {
    await repo.runWithRowSavepoint(() => hooks.registrarQueja({ organizationId: args.organizationId, customerPhone: args.phone, subtipo, ahora: args.ahora }));
  } catch (err) {
    console.error("whatsapp: ligar la queja al pedido fallo (el aviso al equipo ya quedo registrado):", err instanceof Error ? err.message : err);
  }
  return subtipo;
}
