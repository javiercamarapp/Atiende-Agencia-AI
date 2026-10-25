// Servicio de los agregados por validar: orquesta el repositorio, el WhatsApp saliente al cliente, la tarea de «devolver llamada» (callback_requests) y las
// notificaciones in-app (campana). Reglas de producto (dueno, 24-oct):
//   * El agente NUNCA confirma el agregado: crea la solicitud y dice la frase aprobada (sin minutos). Solo una persona la acepta o la rechaza.
//   * Aceptar aplica los renglones al pedido (misma transaccion) y avisa al cliente. Rechazar exige motivo, avisa al cliente con disculpa y oferta de pedido
//     nuevo, y deja una tarea de devolver llamada con guion sugerido.
//   * SLA por sucursal (sin distinguir cajero de encargado): a los 10 min sin respuesta se avisa al dueno y al cliente (aviso UNICO); a los 20 min se cierra como
//     `vencido` y se ofrece pedido aparte o recoger. El sistema nunca acepta solo. Se calcula al LEER (estado derivado) y en el tick existente de 5 min.
//   * Ningun texto lleva «retraso», dinero a devolver ni minutos prometidos. Los mensajes al cliente van como texto libre dentro de la ventana de 24 h (el cliente
//     acaba de escribir); no inventan plantillas de Meta.
import { emitirNotificacion } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { descripcionSeguraDeError } from "../log-seguro.ts";
import { registerCallbackRequest } from "../callback-requests.ts";
import { toWhatsAppRecipient } from "../phone.ts";
import type { RestaurantesRepository } from "../repository.ts";
import { FRASE_MOTIVO_AL_CLIENTE, SLA_AGREGADO } from "./tipos.ts";
import type { AgregadosHook, AgregadosRepository, AgregadoVista, DecisionAgregado, NuevoAgregado, ResultadoCrearAgregado, ResultadoDecidirAgregado } from "./tipos.ts";

export interface AgregadosServicioDeps {
  readonly agregados: AgregadosRepository;
  readonly repo: RestaurantesRepository;
  readonly db: TenantDbSession;
}

const formatoMxn = (n: number): string => `$${n.toFixed(2).replace(/\.00$/, "")}`;

/** «2 Coca y 1 Taco»: solo nombres de catalogo y cantidades (sin PII). */
export function listaProductos(items: readonly { readonly name: string; readonly quantity: number }[]): string {
  const partes = items.map((i) => `${i.quantity} ${i.name}`);
  if (partes.length <= 1) return partes[0] ?? "";
  return `${partes.slice(0, -1).join(", ")} y ${partes[partes.length - 1]}`;
}

const saludo = (a: AgregadoVista): string => (a.customerName ? `Hola ${a.customerName}, ` : "Hola, ");
const folio = (a: AgregadoVista): string => (a.orderNumber !== null ? ` #${a.orderNumber}` : "");

// ---- Textos al cliente (WhatsApp). Sin «retraso», sin dinero a devolver, sin minutos. ----
export const textoAgregadoAceptado = (a: AgregadoVista): string =>
  `${saludo(a)}listo, ya agregamos ${listaProductos(a.itemsAdded)} a tu pedido${folio(a)}. Tu nuevo total es ${formatoMxn(a.totalAfter)}.`;

export const textoAgregadoRechazado = (a: AgregadoVista): string =>
  `${saludo(a)}una disculpa: por ahora no pudimos agregar ${listaProductos(a.itemsAdded)} a tu pedido${folio(a)}. Tu pedido original sigue en marcha. ` +
  `En breve te llamamos para ofrecerte opciones; si no alcanzas a contestar, respóndenos por aquí y te tomamos un pedido nuevo con eso.`;

export const textoAgregadoSeguimiento = (a: AgregadoVista): string =>
  `${saludo(a)}seguimos confirmando con la sucursal si se puede agregar ${listaProductos(a.itemsAdded)} a tu pedido${folio(a)}. Tu pedido original sigue en marcha; te avisamos en cuanto nos confirmen.`;

export const textoAgregadoVencido = (a: AgregadoVista): string =>
  `${saludo(a)}no alcanzamos a confirmar el agregado de ${listaProductos(a.itemsAdded)} a tu pedido${folio(a)}. Tu pedido original sigue en marcha. ` +
  `Si gustas, te tomamos un pedido aparte con eso, o puedes recogerlo en la sucursal. Respóndenos por aquí.`;

export const textoAgregadoNoAplicable = (a: AgregadoVista): string =>
  `${saludo(a)}una disculpa: tu pedido${folio(a)} ya no admite agregados porque ya salió de la sucursal. Si gustas, te tomamos un pedido nuevo con ${listaProductos(a.itemsAdded)}; respóndenos por aquí.`;

/** Guion sugerido para quien devuelve la llamada (solo texto: nunca se lee en voz alta por la IA). */
export function guionDevolverLlamada(a: AgregadoVista, motivo: keyof typeof FRASE_MOTIVO_AL_CLIENTE): string {
  return (
    `Hola ${a.customerName || "buen día"}, te habla ${a.sucursal ?? "la sucursal"}. Sobre tu pedido${folio(a)}: no pudimos agregar ${listaProductos(a.itemsAdded)} porque ${FRASE_MOTIVO_AL_CLIENTE[motivo]}. ` +
    `Tu pedido original sigue en marcha por ${formatoMxn(a.orderTotal)}. ¿Te gustaría que te lo tomemos como pedido nuevo aparte, o prefieres dejarlo así? Gracias por tu paciencia.`
  );
}

/** Encola el WhatsApp al cliente del pedido (mismo outbox y dispatcher que el aviso de estado). Idempotente por `dedupeKey`. Devuelve si se encolo. */
async function avisarCliente(deps: AgregadosServicioDeps, a: AgregadoVista, tipo: string, cuerpo: string): Promise<boolean> {
  const recipient = a.customerPhone ? toWhatsAppRecipient(a.customerPhone) : null;
  if (!recipient) return false;
  const phoneNumberId = await deps.repo.resolveActiveWhatsAppPhoneNumberId(a.organizationId, a.propertyId);
  if (!phoneNumberId) return false;
  await deps.repo.enqueueMessagingOutbox(a.organizationId, "whatsapp", `agregado.${tipo}`, `agregado-${tipo}:${a.id}`, { to: recipient, phone_number_id: phoneNumberId, body: cuerpo, transaccional: true });
  return true;
}

async function conSavepoint(deps: AgregadosServicioDeps, nombre: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await deps.repo.runWithRowSavepoint(fn);
    return true;
  } catch (err) {
    // Un efecto secundario fallido (aviso, tarea) nunca revierte la decision ya tomada: se registra y el panel muestra el estado real.
    console.error(`agregados: el efecto "${nombre}" fallo (la decision ya quedo guardada):`, descripcionSeguraDeError(err));
    return false;
  }
}

async function avisoClienteConBitacora(deps: AgregadosServicioDeps, a: AgregadoVista, tipo: string, cuerpo: string): Promise<void> {
  await conSavepoint(deps, `aviso_cliente_${tipo}`, async () => {
    const encolado = await avisarCliente(deps, a, tipo, cuerpo);
    await deps.agregados.registrarEvento({ amendmentId: a.id, organizationId: a.organizationId, propertyId: a.propertyId, tipoEvento: "cliente_avisado", actor: { tipo: "sistema" }, detalle: { tipo, encolado } });
  });
}

async function crearTareaDevolverLlamada(deps: AgregadosServicioDeps, a: AgregadoVista, reason: "agregado_rechazado" | "agregado_vencido", guion: string): Promise<void> {
  await conSavepoint(deps, `callback_${reason}`, async () => {
    const cb = await registerCallbackRequest(deps.repo, {
      organizationId: a.organizationId,
      propertyId: a.propertyId,
      customerName: a.customerName,
      customerPhone: a.customerPhone,
      reason,
      message: `Devolver llamada${folio(a)}: el cliente quiso agregar ${listaProductos(a.itemsAdded)} (${formatoMxn(a.totalAdded)}). Guion sugerido (editable): «${guion}»`,
      source: "admin",
      sourceEventId: `agregado:${a.id}:${reason}`,
    });
    await deps.agregados.registrarEvento({ amendmentId: a.id, organizationId: a.organizationId, propertyId: a.propertyId, tipoEvento: "callback_creado", actor: { tipo: "sistema" }, detalle: { callbackId: cb.id, reason } });
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// 1. Crear la solicitud (herramienta del agente)
// ---------------------------------------------------------------------------------------------------------------------------------------

/** Crea (o fusiona en la abierta) la solicitud y avisa a la sucursal en la campana. Idempotente: el mismo evento no crea dos. */
export async function registrarSolicitudAgregado(deps: AgregadosServicioDeps, input: NuevoAgregado): Promise<ResultadoCrearAgregado> {
  const r = await deps.agregados.crear(input);
  if (r.estado === "creado") {
    await emitirNotificacion(deps.db, {
      evento: "restaurantes.pedido.agregado_pendiente",
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      clave: r.agregado.id,
      entidadTipo: "order_amendment",
      entidadId: r.agregado.id,
    });
  }
  return r;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// 2. Decidir (aceptar / rechazar)
// ---------------------------------------------------------------------------------------------------------------------------------------

export interface ResultadoResolverAgregado {
  readonly resultado: ResultadoDecidirAgregado;
  /** Efectos disparados en ESTA llamada (vacio en un doble clic). */
  readonly efectos: readonly string[];
}

export async function resolverAgregado(
  deps: AgregadosServicioDeps,
  input: { readonly organizationId: string; readonly id: string; readonly decision: DecisionAgregado; readonly actorUserId: string; readonly propertyIds: readonly string[] | null },
): Promise<ResultadoResolverAgregado> {
  const resultado = await deps.agregados.decidir(input.organizationId, input.id, input.decision, input.actorUserId, input.propertyIds);
  const efectos: string[] = [];
  if (resultado.resultado === "aplicado") {
    const a = resultado.agregado;
    if (input.decision.tipo === "aceptar") {
      await avisoClienteConBitacora(deps, a, "aceptado", textoAgregadoAceptado(a));
      efectos.push("aviso_cliente_aceptado");
    } else {
      await avisoClienteConBitacora(deps, a, "rechazado", textoAgregadoRechazado(a));
      efectos.push("aviso_cliente_rechazado");
      await crearTareaDevolverLlamada(deps, a, "agregado_rechazado", guionDevolverLlamada(a, input.decision.motivo));
      efectos.push("tarea_devolver_llamada");
    }
  } else if (resultado.resultado === "no_aplicable") {
    await avisoClienteConBitacora(deps, resultado.agregado, "no_aplicable", textoAgregadoNoAplicable(resultado.agregado));
    efectos.push("aviso_cliente_no_aplicable");
  }
  return { resultado, efectos };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// 3. SLA: barrido del tick de 5 minutos (SIN cron nuevo)
// ---------------------------------------------------------------------------------------------------------------------------------------

export interface ResumenBarridoAgregados {
  readonly disponible: boolean;
  readonly avisados: number;
  readonly vencidos: number;
  readonly errores: number;
}

/**
 * Escala lo que lleva 10+ minutos sin respuesta: a los 10 avisa al dueno (campana critica) y al cliente UNA vez; a los 20 lo cierra como `vencido`, ofrece pedido
 * aparte o recoger y deja la tarea de devolver llamada. Idempotente (compare-and-set en la base): reintentar el tick o correrlo en dos instancias no duplica nada.
 * Limite honesto: corre cada 5 min, asi que el aviso de los 10 min sale entre el minuto 10 y el 15, y el cierre entre el 20 y el 25. La LECTURA del panel
 * calcula el estado exacto por el reloj (`calcularSla`) sin esperar al tick.
 */
export async function barrerAgregadosSla(deps: AgregadosServicioDeps, ahora: Date, limite = 100): Promise<ResumenBarridoAgregados> {
  const corte = new Date(ahora.getTime() - SLA_AGREGADO.avisoMin * 60_000).toISOString();
  const lectura = await deps.agregados.pendientesAntesDe(corte, limite);
  if (!lectura.disponible) return { disponible: false, avisados: 0, vencidos: 0, errores: 0 };
  let avisados = 0;
  let vencidos = 0;
  let errores = 0;
  for (const a of lectura.valor) {
    const minutos = Math.floor((ahora.getTime() - Date.parse(a.requestedAt)) / 60_000);
    try {
      await deps.repo.runWithRowSavepoint(async () => {
        const vence = minutos >= SLA_AGREGADO.vencimientoMin;
        if (vence) {
          if (!(await deps.agregados.vencer(a.organizationId, a.id, ahora))) return; // otro tick u otra persona ya lo resolvio
          vencidos++;
        } else {
          if (!(await deps.agregados.escalarNivel1(a.organizationId, a.id, ahora))) return;
          avisados++;
        }
        await emitirNotificacion(deps.db, {
          evento: "restaurantes.pedido.agregado_sin_respuesta",
          organizationId: a.organizationId,
          propertyId: a.propertyId,
          clave: a.id,
          entidadTipo: "order_amendment",
          entidadId: a.id,
          parametros: { minutos },
        });
        if (vence) {
          await avisoClienteConBitacora(deps, a, "vencido", textoAgregadoVencido(a));
          await crearTareaDevolverLlamada(deps, a, "agregado_vencido", guionDevolverLlamada(a, "otro"));
        } else {
          await avisoClienteConBitacora(deps, a, "seguimiento", textoAgregadoSeguimiento(a));
        }
      });
    } catch (err) {
      errores++;
      console.error("agregados: el barrido del SLA fallo para una solicitud:", descripcionSeguraDeError(err));
    }
  }
  return { disponible: true, avisados, vencidos, errores };
}

/** El cliente se arrepiente: cierra la solicitud abierta del pedido. */
export async function cancelarAgregadoPorCliente(deps: AgregadosServicioDeps, organizationId: string, orderId: string): Promise<AgregadoVista | null> {
  const r = await deps.agregados.cancelarPorCliente(organizationId, orderId);
  return r.valor;
}

/** Hook de la herramienta `solicitar_agregado_pedido` sobre UNA sesion (WhatsApp: el turno; voz: la llamada). Cada operacion degrada a «no disponible» contra la base sin migrar. */
export function crearHookAgregados(deps: AgregadosServicioDeps): AgregadosHook {
  return {
    crear: (input) => registrarSolicitudAgregado(deps, input),
    cancelarPendiente: async (organizationId, orderId) => (await cancelarAgregadoPorCliente(deps, organizationId, orderId)) !== null,
  };
}
