// Servicio de comandas hacia SoftRestaurant: encolar, enviar y drenar.
//
// Reglas duras (cuestionario PM + arquitectura-voz-pm.md §5.1):
//   1. Bandera por organizacion, default APAGADA: con `apagado` (o sin la migracion 024)
//      `encolarComandaParaPedido` no hace NADA y el comportamiento actual queda intacto.
//   2. Modo `sombra`: la comanda se encola en paralelo y NUNCA bloquea ni cambia lo que
//      el agente le dice al cliente (`agente = null`).
//   3. Modo `activo`: se encola y se intenta UNA vez en linea con timeout. El agente solo
//      puede decir lo que devuelve `respuestaAgenteComanda`: folio si el POS lo devolvio;
//      en cualquier otro caso "pendiente de confirmar" y NUNCA un folio inventado.
//   4. Si el POS no responde o rechaza, la comanda pasa por reintento con backoff y, al
//      agotarse, a captura manual con alerta al staff.
//   5. Nada de esto puede romper el pedido: todo fallo aqui se traga (con log) despues de
//      que el store recupero la sesion con SAVEPOINT.
import type { Order } from "../types.ts";
import type { RestaurantesRepository } from "../repository.ts";
import type { ResolverCodigosPos } from "./catalog-map.ts";
import {
  POLITICA_REINTENTO_DEFAULT,
  decidirTransicion,
  respuestaAgenteComanda,
  type DecisionTransicion,
  type PoliticaReintento,
  type RespuestaAgenteComanda,
} from "./outbox-state.ts";
import type { ComandaOutboxStore, FilaComandaOutbox, ModoSoftRestaurant } from "./outbox-store.ts";
import {
  esSucursalPos,
  validarComandaInput,
  type ComandaInput,
  type ComandaResultado,
  type FormaPagoComanda,
  type ItemComanda,
  type SoftRestaurantPort,
  type SucursalPos,
  type TipoComanda,
} from "./types.ts";

/** Resuelve la clave T1..T8 del POS a partir de la sucursal de Atiende. */
export type ResolverSucursalPos = (sucursal: { readonly propertyId: string; readonly nombre: string | null }) => SucursalPos | null;

/** Mapa explicito propertyId -> T#, con respaldo por nombre ("... T3"). Sin mapeo => null (captura manual). */
export function crearResolverSucursalPos(mapa: Readonly<Record<string, SucursalPos>> = {}): ResolverSucursalPos {
  return ({ propertyId, nombre }) => {
    const directo = mapa[propertyId];
    if (directo) return directo;
    const m = nombre ? /\bT([1-8])\b/i.exec(nombre) : null;
    const candidato = m ? (`T${m[1]}` as const) : null;
    return candidato && esSucursalPos(candidato) ? candidato : null;
  };
}

export type AlertarCapturaManual = (fila: FilaComandaOutbox, motivo: string) => Promise<void>;

export interface DepsComandaPos {
  readonly store: ComandaOutboxStore;
  readonly port: SoftRestaurantPort;
  readonly resolverCodigos: ResolverCodigosPos;
  readonly resolverSucursal: ResolverSucursalPos;
  readonly politica?: PoliticaReintento;
  readonly ahora?: () => Date;
  /** Tope del intento en linea (modo activo). Default 4000 ms. */
  readonly timeoutInlineMs?: number;
  readonly alertar?: AlertarCapturaManual;
  /** Si el llamador puede correr trabajo despues de responder (post-commit), el envio de `sombra` se programa aqui. */
  readonly programarEnvio?: (tarea: () => Promise<void>) => void;
}

export interface PedidoParaComanda {
  readonly order: Pick<Order, "id" | "organizationId" | "propertyId" | "customerName" | "customerPhone" | "customerAddress" | "notes" | "paymentMethod" | "items" | "branch"> & Partial<Pick<Order, "status">>;
  /** Si no se da: con direccion => domicilio, sin direccion => recoger. */
  readonly tipo?: TipoComanda;
  readonly colonia?: string;
  readonly propina?: number;
  readonly horaCompromiso?: string;
  /** Intentar el envio al POS dentro de la misma llamada (modo `activo`) o programarlo (`sombra`). Default `true`.
   * `false` = solo encolar: la fila queda `pendiente` y la drena el despachador (`drenarComandas`). Lo usa la
   * promocion de pedidos programados, que corre fuera de un turno de agente y no debe bloquearse en el POS. */
  readonly envioEnLinea?: boolean;
}

export type ResultadoEncolarPedido =
  | { readonly modo: "apagado"; readonly fila: null; readonly agente: null; readonly motivo: "bandera_apagada" | "no_disponible" | "programado" }
  | { readonly modo: "sombra"; readonly fila: FilaComandaOutbox | null; readonly agente: null; readonly motivo?: "error" }
  | { readonly modo: "activo"; readonly fila: FilaComandaOutbox | null; readonly agente: RespuestaAgenteComanda; readonly motivo?: "error" };

/** Llave estable por pedido: el POS devuelve la misma comanda si la recibe dos veces. */
export function llaveIdempotenciaComanda(organizationId: string, orderId: string): string {
  return `sr:${organizationId}:${orderId}`;
}

/** Arma el payload de la comanda. Un producto o sucursal sin codigo NO se inventa: queda vacio y la fila va a captura manual. */
export function construirPayloadComanda(pedido: PedidoParaComanda, deps: Pick<DepsComandaPos, "resolverCodigos" | "resolverSucursal">): ComandaInput {
  const { order } = pedido;
  const sucursal = deps.resolverSucursal({ propertyId: order.propertyId, nombre: order.branch });
  const sucursalParaCodigos: SucursalPos = sucursal ?? "T1";
  // Un producto sin codigo POS queda con codigo vacio (nunca inventado): la fila va a captura
  // manual y el staff ve `nombre` y `cantidad` para capturarla a mano.
  // D12: la unidad regalada por una promocion viaja en un renglon aparte a $0; la cocina y el POS la ven como UNA sola linea del producto (4 tacos, no 2 + 2).
  // Solo se unen renglones del mismo producto y la misma tortilla.
  const renglonesDeCocina = order.items.reduce<(typeof order.items)[number][]>((acc, i) => {
    const previo = acc.find((x) => x.id === i.id && (x.tortilla ?? null) === (i.tortilla ?? null));
    if (previo) acc[acc.indexOf(previo)] = { ...previo, quantity: previo.quantity + i.quantity };
    else acc.push(i);
    return acc;
  }, []);
  const items: ItemComanda[] = renglonesDeCocina.map((i) => ({
    codigo: deps.resolverCodigos.codigoDeProducto(i.id, sucursalParaCodigos) ?? "",
    cantidad: i.quantity,
    modificadores: [],
    nombre: i.name,
    ...(i.tortilla ? { nota: `Tortilla: ${i.tortilla === "maiz" ? "maiz" : i.tortilla === "mixta" ? "mixta (mitad maiz, mitad harina)" : "harina"}` } : {}),
  }));
  const tipo: TipoComanda = pedido.tipo ?? (order.customerAddress && order.customerAddress.trim() ? "domicilio" : "recoger");
  const formaPago: FormaPagoComanda = order.paymentMethod ?? "efectivo";
  return {
    idempotencyKey: llaveIdempotenciaComanda(order.organizationId, order.id),
    // Sucursal sin T#: marcador explicito (nunca un T# inventado); `validarComandaInput` lo rechaza.
    sucursal: sucursal ?? ("SIN_CODIGO" as SucursalPos),
    tipo,
    cliente: { nombre: order.customerName, telefono: order.customerPhone },
    ...(order.customerAddress && order.customerAddress.trim()
      ? { direccion: { texto: order.customerAddress, ...(pedido.colonia ? { colonia: pedido.colonia } : {}) } }
      : {}),
    formaPago,
    ...(pedido.propina !== undefined && pedido.propina > 0 ? { propina: pedido.propina } : {}),
    items,
    ...(order.notes ? { notas: order.notes } : {}),
    ...(pedido.horaCompromiso ? { horaCompromiso: pedido.horaCompromiso } : {}),
  };
}

/** Motivo tecnico (sin datos personales) por el que una comanda NO se puede mandar al POS, o null si es valida. */
export function motivoComandaInvalida(input: ComandaInput): string | null {
  if (!esSucursalPos(input.sucursal)) return "sucursal_sin_codigo_pos";
  if (input.items.some((i) => !i.codigo || i.codigo.trim() === "")) return "producto_sin_codigo_pos";
  return validarComandaInput(input).length > 0 ? "entrada_invalida" : null;
}

async function conTimeout(p: Promise<ComandaResultado>, ms: number): Promise<ComandaResultado> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<ComandaResultado>((resolve) => {
    timer = setTimeout(() => resolve({ status: "no_disponible", causa: "timeout" }), ms);
  });
  try {
    return await Promise.race([p, limite]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function alertarSeguro(deps: DepsComandaPos, fila: FilaComandaOutbox, motivo: string): Promise<void> {
  if (!deps.alertar) return;
  try {
    await deps.alertar(fila, motivo);
  } catch (err) {
    console.error("softrestaurant: no se pudo alertar captura manual (la fila queda visible en el panel):", err);
  }
}

export interface ResultadoProcesoFila {
  readonly fila: FilaComandaOutbox;
  readonly decision: DecisionTransicion;
}

/**
 * Envia UNA fila ya reclamada (`enviada`) al POS y cierra el intento. Nunca lanza por
 * fallas del POS: un adaptador que lance se trata como `no_disponible`.
 */
export async function procesarFilaReclamada(deps: DepsComandaPos, fila: FilaComandaOutbox): Promise<ResultadoProcesoFila> {
  const politica = deps.politica ?? POLITICA_REINTENTO_DEFAULT;
  const ahora = deps.ahora ?? (() => new Date());
  const invalida = motivoComandaInvalida(fila.payload);

  let decision: DecisionTransicion;
  if (invalida) {
    // Reintentar el mismo payload no sirve: captura manual directa, sin molestar al POS.
    decision = { estado: "captura_manual", folio: null, ultimoError: `rechazada:${invalida}`, proximoIntentoEn: null, alertarCapturaManual: true };
  } else {
    let resultado: ComandaResultado;
    try {
      resultado = await conTimeout(deps.port.crearComanda(fila.payload), deps.timeoutInlineMs ?? 4000);
    } catch (err) {
      console.error("softrestaurant: el adaptador lanzo en crearComanda (se trata como no_disponible):", err instanceof Error ? err.message : err);
      resultado = { status: "no_disponible", causa: "desconocida" };
    }
    decision = decidirTransicion(resultado, fila.intentos, ahora(), {
      ...politica,
      // `fila.maxIntentos` (persistido al encolar) manda sobre la politica por defecto.
      maxIntentos: fila.maxIntentos,
    });
  }

  const cerrada = await deps.store.completar(fila.id, decision);
  const actual: FilaComandaOutbox = {
    ...fila,
    estado: cerrada ? decision.estado : fila.estado,
    folio: cerrada ? decision.folio : fila.folio,
    ultimoError: cerrada ? decision.ultimoError : fila.ultimoError,
    proximoIntentoEn: cerrada && decision.proximoIntentoEn ? decision.proximoIntentoEn.toISOString() : fila.proximoIntentoEn,
  };
  if (cerrada && decision.alertarCapturaManual) {
    console.error(`softrestaurant: comanda ${fila.id} (pedido ${fila.orderId}) requiere captura manual: ${decision.ultimoError}`);
    await alertarSeguro(deps, actual, decision.ultimoError ?? "captura_manual");
  }
  return { fila: actual, decision };
}

/**
 * Punto de enganche del pedido: llamar DESPUES de crear el pedido. Nunca lanza ni cambia
 * el resultado del pedido. Ver reglas duras en la cabecera del archivo.
 */
export async function encolarComandaParaPedido(deps: DepsComandaPos, pedido: PedidoParaComanda): Promise<ResultadoEncolarPedido> {
  // Un pedido PROGRAMADO todavia no es de cocina: su comanda llegaria horas antes. La encola la promocion a `pending`
  // (`encolarComandasDePromovidos`). Es la unica puerta de entrada, asi que cubre checkout, voz, WhatsApp y cualquier canal nuevo.
  if (pedido.order.status === "programado") return { modo: "apagado", fila: null, agente: null, motivo: "programado" };
  let modo: ModoSoftRestaurant = "apagado";
  try {
    modo = await deps.store.leerModo(pedido.order.organizationId);
  } catch (err) {
    console.error("softrestaurant: no se pudo leer la bandera (se asume apagado):", err);
  }
  if (modo === "apagado") return { modo: "apagado", fila: null, agente: null, motivo: "bandera_apagada" };

  const politica = deps.politica ?? POLITICA_REINTENTO_DEFAULT;
  let fila: FilaComandaOutbox | null = null;
  try {
    const payload = construirPayloadComanda(pedido, deps);
    const enc = await deps.store.encolar({
      organizationId: pedido.order.organizationId,
      propertyId: pedido.order.propertyId,
      orderId: pedido.order.id,
      idempotencyKey: payload.idempotencyKey,
      modo,
      payload,
      maxIntentos: politica.maxIntentos,
    });
    if (!enc.disponible) return { modo: "apagado", fila: null, agente: null, motivo: "no_disponible" };
    fila = enc.fila;

    const ahora = deps.ahora ?? (() => new Date());
    if (pedido.envioEnLinea === false) {
      // Solo encolar (ver `PedidoParaComanda.envioEnLinea`): el despachador la envia con su backoff.
    } else if (modo === "activo") {
      // Un reintento del mismo pedido que ya estaba confirmado no vuelve a enviarse.
      const reclamada = await deps.store.reclamarPorId(fila.id, ahora(), politica.leaseMs);
      if (reclamada) fila = (await procesarFilaReclamada(deps, reclamada)).fila;
    } else if (deps.programarEnvio) {
      const id = fila.id;
      deps.programarEnvio(async () => {
        const r = await deps.store.reclamarPorId(id, ahora(), politica.leaseMs);
        if (r) await procesarFilaReclamada(deps, r);
      });
    }
  } catch (err) {
    console.error("softrestaurant: fallo best-effort al encolar/enviar la comanda (el pedido NO se ve afectado):", err);
    return modo === "activo"
      ? { modo: "activo", fila, agente: respuestaAgenteComanda(fila), motivo: "error" }
      : { modo: "sombra", fila, agente: null, motivo: "error" };
  }
  return modo === "activo" ? { modo: "activo", fila, agente: respuestaAgenteComanda(fila) } : { modo: "sombra", fila, agente: null };
}

/**
 * Envio EN LINEA de una comanda que ya quedo ENCOLADA (`encolarComandaParaPedido` con `envioEnLinea: false`) en una
 * transaccion YA CONFIRMADA. Existe para que el envio al POS (efecto externo) ocurra DESPUES del COMMIT del pedido:
 * enviarlo dentro de la transaccion dejaba una comanda en cocina de un pedido que, si el COMMIT fallaba, no existia
 * (y el reintento del cliente creaba otro pedido con otra llave). Reclama la fila por id (un reintento que ya la tomo
 * no la reenvia). Nunca lanza: un fallo deja la fila `pendiente` para el despachador, y se devuelve el estado real
 * (el agente solo puede decir un folio que el POS devolvio).
 */
export async function enviarComandaEncolada(deps: DepsComandaPos, fila: FilaComandaOutbox): Promise<Extract<ResultadoEncolarPedido, { modo: "activo" }>> {
  try {
    const politica = deps.politica ?? POLITICA_REINTENTO_DEFAULT;
    const ahora = deps.ahora ?? (() => new Date());
    const reclamada = await deps.store.reclamarPorId(fila.id, ahora(), politica.leaseMs);
    if (reclamada) fila = (await procesarFilaReclamada(deps, reclamada)).fila;
  } catch (err) {
    console.error("softrestaurant: fallo best-effort al enviar la comanda encolada (queda pendiente para el despachador):", err);
  }
  return { modo: "activo", fila, agente: respuestaAgenteComanda(fila) };
}

/** Nota que queda en la comanda cuya salida al POS se corto porque el pedido se cancelo antes de llegar. */
export const NOTA_COMANDA_CORTADA_POR_CANCELACION = "Pedido cancelado antes de llegar al POS: la comanda ya no se envia.";

/**
 * Un pedido CANCELADO antes de que su comanda llegara al POS no debe llegar a cocina despues: si el POS estaba lento o caido, la
 * comanda sigue `pendiente`/`fallida` en el outbox y el despachador (cron de 5 min) la mandaria al volver el POS, con comida que
 * nadie va a recoger. Aqui se corta con la MISMA operacion que ya usa el staff para cerrar una comanda a mano (`marcarCapturada`:
 * pasa a `capturada_manual`, estado terminal que corta los reintentos y no cuenta como "requiere atencion").
 *
 * Solo toca filas `pendiente`/`fallida`/`captura_manual` de ESE pedido (lectura filtrada por order_id); una `enviada` (en vuelo) o `confirmada`
 * (ya en el POS) no se modifica: esas ya estan en cocina y el POS no expone una cancelacion (limite documentado en docs/CICLO-PUNTA-A-PUNTA-RESTAURANTES.md).
 * Best-effort: nunca lanza ni revierte la cancelacion. Corre en sesion de STAFF (la funcion SQL exige un actor autenticado).
 * Base sin la migracion 024: `listar` responde `disponible: false` y no hace nada.
 */
export async function cortarComandaDePedidoCancelado(
  store: ComandaOutboxStore,
  organizationId: string,
  order: Pick<Order, "id" | "propertyId">,
  actorUserId: string,
): Promise<{ readonly cortadas: number }> {
  try {
    const lectura = await store.listar(organizationId, { propertyIds: [order.propertyId], orderId: order.id, estados: ["pendiente", "fallida", "captura_manual"], limite: 50, offset: 0 });
    if (!lectura.disponible) return { cortadas: 0 };
    let cortadas = 0;
    for (const fila of lectura.filas) {
      const r = await store.marcarCapturada(organizationId, fila.id, actorUserId, NOTA_COMANDA_CORTADA_POR_CANCELACION);
      if (r.resultado === "ok") cortadas += 1;
      else console.warn(`softrestaurant: no se pudo cortar la comanda ${fila.id} del pedido cancelado ${order.id} (resultado: ${r.resultado}); puede seguir su curso hacia el POS`);
    }
    return { cortadas };
  } catch (err) {
    console.error("softrestaurant: no se pudo cortar la comanda de un pedido cancelado (se registra y la cancelacion sigue):", err instanceof Error ? err.message : err);
    return { cortadas: 0 };
  }
}

export interface ResumenComandasPromovidos {
  /** Pedidos para los que se intento encolar (`pending` recien promovidos). */
  readonly intentados: number;
  /** Filas realmente creadas/recuperadas en el outbox (idempotente: reencolar devuelve la existente). */
  readonly encoladas: number;
  /** Bandera apagada o base sin la migracion 024: no se encolo nada (comportamiento anterior intacto). */
  readonly omitidas: number;
  readonly errores: number;
}

/**
 * R-29: al PROMOVER un pedido programado a `pending` (entra a cocina) se encola su comanda al POS, igual que un
 * pedido inmediato. Antes se omitia y quedaba a captura manual. Reglas:
 *  - Idempotente: la llave (`sr:<org>:<pedido>`) y el unique (organizacion, pedido) hacen que reintentar, o que
 *    dos promociones concurrentes entreguen el mismo pedido, deje UNA sola fila.
 *  - Nunca envia en linea (`envioEnLinea: false`): la fila queda `pendiente` y la drena el despachador.
 *  - La hora programada viaja como `horaCompromiso` (ISO UTC); el POS la muestra en la zona de la sucursal.
 *  - La propina (y el canal) del pedido viajan en la comanda, como en un pedido inmediato.
 *  - Solo pedidos en `pending` (un cancelado u otro estado nunca se encola).
 *  - Nunca lanza: `encolarComandaParaPedido` traga y registra sus errores (el store recupera la sesion con SAVEPOINT).
 */
export async function encolarComandasDePromovidos(
  deps: DepsComandaPos,
  promovidos: readonly Order[],
  /** `cualquierEstadoVivo`: la reconciliacion (QA-restaurantes-R1-automatizacion-02) reencola pedidos promovidos que la cocina ya
   * avanzo hasta `preparando`: siguen necesitando su comanda. Un pedido entregado, completado, cancelado, programado o con
   * problema nunca se reencola (mandar al POS la comanda de algo ya servido seria un duplicado en cocina). */
  opciones: { readonly cualquierEstadoVivo?: boolean } = {},
): Promise<ResumenComandasPromovidos> {
  let intentados = 0;
  let encoladas = 0;
  let omitidas = 0;
  let errores = 0;
  for (const order of promovidos) {
    if (opciones.cualquierEstadoVivo ? order.status !== "pending" && order.status !== "preparando" : order.status !== "pending") continue;
    intentados += 1;
    // La propina y el canal viajan en la fila del pedido (migracion 031) y `promover_pedidos_programados` devuelve la
    // fila completa: se pasan a la comanda igual que en un pedido inmediato (antes se perdian y el POS no la veia).
    const r = await encolarComandaParaPedido(deps, {
      order,
      ...(order.programadoPara ? { horaCompromiso: order.programadoPara } : {}),
      ...(order.canal ? { tipo: order.canal } : {}),
      ...(order.propina !== undefined && order.propina !== null && order.propina > 0 ? { propina: order.propina } : {}),
      envioEnLinea: false,
    });
    if (r.modo === "apagado") omitidas += 1;
    else if (r.motivo === "error" || r.fila === null) errores += 1;
    else encoladas += 1;
  }
  return { intentados, encoladas, omitidas, errores };
}

export interface ContextoUnidadComanda {
  readonly store: ComandaOutboxStore;
  readonly alertar?: AlertarCapturaManual;
}

export interface DepsDrenaje {
  readonly port: SoftRestaurantPort;
  /**
   * Abre una UNIDAD DE TRABAJO aislada (una transaccion por unidad: un envio fallido o
   * venenoso nunca revierte a los demas). En produccion: `engine.withAppSession({ userId: null }, ...)`.
   */
  readonly abrirUnidad: <T>(fn: (ctx: ContextoUnidadComanda) => Promise<T>) => Promise<T>;
  readonly resolverCodigos?: ResolverCodigosPos;
  readonly resolverSucursal?: ResolverSucursalPos;
  readonly politica?: PoliticaReintento;
  readonly ahora?: () => Date;
  readonly timeoutInlineMs?: number;
}

export interface ResumenDrenaje {
  readonly reclamadas: number;
  readonly confirmadas: number;
  readonly fallidas: number;
  readonly capturaManual: number;
  readonly errores: number;
}

/** Drena un lote del outbox (cron). Reclama en una unidad y procesa CADA fila en su propia unidad. */
export async function drenarComandas(deps: DepsDrenaje, limite = 10): Promise<ResumenDrenaje> {
  const politica = deps.politica ?? POLITICA_REINTENTO_DEFAULT;
  const ahora = deps.ahora ?? (() => new Date());
  const reclamadas = await deps.abrirUnidad((ctx) => ctx.store.reclamarLote(limite, ahora(), politica.leaseMs));
  const resumen = { reclamadas: reclamadas.length, confirmadas: 0, fallidas: 0, capturaManual: 0, errores: 0 };
  for (const fila of reclamadas) {
    try {
      const r = await deps.abrirUnidad((ctx) =>
        procesarFilaReclamada(
          {
            store: ctx.store,
            port: deps.port,
            resolverCodigos: deps.resolverCodigos ?? { codigoDeProducto: () => null, productoDeCodigo: () => null },
            resolverSucursal: deps.resolverSucursal ?? crearResolverSucursalPos(),
            politica,
            ahora,
            timeoutInlineMs: deps.timeoutInlineMs,
            alertar: ctx.alertar,
          },
          fila,
        ),
      );
      if (r.decision.estado === "confirmada") resumen.confirmadas += 1;
      else if (r.decision.estado === "fallida") resumen.fallidas += 1;
      else if (r.decision.estado === "captura_manual") resumen.capturaManual += 1;
    } catch (err) {
      // La fila queda `enviada`: el lease la hace reclamable de nuevo (idempotente en el POS).
      resumen.errores += 1;
      console.error(`softrestaurant: error procesando la comanda ${fila.id} (se reintenta al vencer el lease):`, err);
    }
  }
  return resumen;
}

/** Alerta al staff por la bandeja existente de notificaciones (evento `order.problema`). Best-effort con SAVEPOINT. */
export function crearAlertaCapturaManual(repo: RestaurantesRepository): AlertarCapturaManual {
  return async (fila, motivo) => {
    const nombre = fila.payload.cliente.nombre;
    await repo.runWithRowSavepoint(() =>
      repo.createStaffOrderNotification(
        fila.organizationId,
        fila.propertyId,
        fila.orderId,
        "order.problema",
        `La comanda del pedido de ${nombre} no llego a SoftRestaurant (${motivo}): captura manual requerida.`,
      ),
    );
  };
}
