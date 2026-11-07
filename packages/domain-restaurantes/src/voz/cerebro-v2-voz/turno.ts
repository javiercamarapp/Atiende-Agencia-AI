// Un turno de la llamada de voz (contrato del cliente del voice-worker, `cerebro-voz-turno.ts`): el worker manda lo que dijo el cliente y habla el
// `texto` que regresa. Port de `turnoVoz` (voz-turno.ts del repo suelto) sobre los puertos del monorrepo: el cerebro es EL MISMO turno de WhatsApp de
// restaurantes (inyectado como `agente`), aqui solo se guarda el hilo por call_id, se resuelve la idempotencia por (call_id, seq), la apertura con aviso
// de grabacion, el silencio, los cierres sin modelo y la limpieza para TTS.
//
// Transacciones: (1) leer + decidir + marcar «en proceso» (o guardar la respuesta sin modelo) y confirmar, para que un reintento concurrente del mismo
// seq vea la marca y reciba 409 sin gastar modelo; (2) turno del agente + guardar la respuesta en la MISMA transaccion (el pedido y su respuesta se
// confirman juntos: si el compare-and-swap pierde, el pedido tambien se revierte); (3) si (2) falla, se libera la marca (mejor esfuerzo; caduca sola).
import { canonicalizeMexicanPhone } from "../../phone.ts";
import type { CambioHiloVoz, HiloVoz, MensajeHiloVoz, RepositorioHilosVoz, RespuestaVozTurno } from "./hilos.ts";
import {
  AVISO_VOZ_INICIAL,
  esDespedidaDelCliente,
  esSilencioVoz,
  MARCA_TEXTO_LARGO_VOZ,
  RESPUESTA_SILENCIO_VOZ,
  respuestaParaVoz,
  saludoVoz,
  TEXTO_DESPEDIDA,
  TEXTO_FALLO_PERSONA,
  TEXTO_LIMITE_LLAMADA,
  TEXTO_REPETIR_POR_PARTES,
  TEXTO_SILENCIO_FIN,
} from "./texto.ts";

export const MAX_TEXTO_VOZ_CHARS = 2000;
export const MAX_TURNOS_LLAMADA = 40;
export const CALL_ID_RE = /^[A-Za-z0-9_.:-]{6,128}$/;
/** Marca «en proceso» mas vieja que esto = turno muerto (presupuesto del turno con modelo ~18 s + margen). */
export const EN_PROCESO_MAX_MS = 60_000;
/** Respuestas seguidas de fallo del proveedor tras las cuales se deriva a una persona. */
export const MAX_FALLOS_SEGUIDOS = 2;
export const MARCA_AVISO_DADO_POR_WORKER = "[aviso de grabación dicho por el worker]";
const FALLO_PROVEEDOR = /problema t[eé]cnico/i;

/** 400: entrada invalida (el worker no reintenta). */
export class VozTurnoInvalidoError extends Error {}
/** 409. El mensaje importa: el worker reintenta el MISMO seq solo si dice «en proceso» o «se adelantó»; cualquier otro 409 lo trata como bug. */
export class VozTurnoConflictoError extends Error {}
/** 429 con Retry-After: <= 5 s = rafaga (el worker repite el mismo seq); > 5 s = tope (frase de devolver la llamada y colgar). */
export class VozTurnoLimiteError extends Error {
  constructor(message: string, readonly retryAfterS: number) {
    super(message);
  }
}

export interface EntradaVozTurno {
  readonly call_id?: unknown;
  readonly telefono?: unknown;
  readonly texto?: unknown;
  readonly seq?: unknown;
  readonly aviso_dado?: unknown;
}

export interface EntradaValidada {
  readonly callId: string;
  readonly telefono: string;
  readonly texto: string;
  readonly seq: number;
  readonly avisoDado: boolean;
}

export function validarEntradaVoz(entrada: EntradaVozTurno): EntradaValidada {
  if (typeof entrada.call_id !== "string" || !CALL_ID_RE.test(entrada.call_id)) {
    throw new VozTurnoInvalidoError("call_id inválido (6 a 128 caracteres: letras, números y _ . : -)");
  }
  const telefono = typeof entrada.telefono === "string" ? canonicalizeMexicanPhone(entrada.telefono) : null;
  if (!telefono) throw new VozTurnoInvalidoError("telefono inválido: se requieren 10 dígitos");
  const texto = entrada.texto === undefined || entrada.texto === null ? "" : entrada.texto;
  if (typeof texto !== "string") throw new VozTurnoInvalidoError("texto inválido");
  const seq = entrada.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || seq > 100_000) {
    throw new VozTurnoInvalidoError("seq inválido u omitido: entero >= 0 obligatorio (número de turno del worker)");
  }
  if (entrada.aviso_dado !== undefined && entrada.aviso_dado !== null && typeof entrada.aviso_dado !== "boolean") {
    throw new VozTurnoInvalidoError("aviso_dado inválido: solo true o false");
  }
  return { callId: entrada.call_id, telefono, texto, seq, avisoDado: entrada.aviso_dado === true && seq === 0 && !texto.trim() };
}

/** El turno del cerebro (el handler de WhatsApp de restaurantes con el adaptador de voz). */
export type AgenteVoz = (args: {
  readonly mensajes: readonly MensajeHiloVoz[];
  readonly telefono: string;
  readonly callId: string;
  readonly turno: number;
}) => Promise<{ readonly reply: string; readonly orderId: string | null }>;

/** Lo disponible DENTRO de una transaccion de sistema. */
export interface TransaccionVoz {
  readonly hilos: RepositorioHilosVoz;
  readonly agente: AgenteVoz;
  /** Consume un cupo (clave, maximo, ventana en s); false = tope rebasado. Solo se llama antes de gastar modelo. */
  consumirCupo(clave: string, max: number, ventanaSeg: number): Promise<boolean>;
  /** Zona horaria y nombre del negocio para el saludo (null = sin nombre). */
  contextoSaludo(): Promise<{ readonly zonaHoraria: string; readonly nombreNegocio: string | null }>;
}

export interface LimitesVoz {
  /** Rafaga por llamada (por minuto): 429 corto, el worker reintenta. */
  readonly porLlamadaPorMinuto: number;
  /** Anti-abuso por telefono (por hora): 429 largo (tope). */
  readonly porTelefonoPorHora: number;
  /** Capacidad por sucursal (por minuto): 429 largo (tope). */
  readonly porSucursalPorMinuto: number;
}
export const LIMITES_VOZ_DEFECTO: LimitesVoz = { porLlamadaPorMinuto: 30, porTelefonoPorHora: 100, porSucursalPorMinuto: 90 };

export interface DepsTurnoVoz {
  readonly organizationId: string;
  readonly propertyId: string | null;
  /** Abre UNA transaccion de sistema, corre `fn` y la confirma (o la revierte si `fn` lanza). */
  enTransaccion<T>(fn: (tx: TransaccionVoz) => Promise<T>): Promise<T>;
  readonly ahora?: () => Date;
  readonly limites?: LimitesVoz;
}

type Decision = { readonly tipo: "lista"; readonly respuesta: RespuestaVozTurno } | { readonly tipo: "modelo"; readonly hilo: HiloVoz; readonly versionMarcada: number; readonly turno: number };

const ultimoDelAsistente = (h: readonly MensajeHiloVoz[]): string =>
  String([...h].reverse().find((m) => m.role === "assistant" && m.content.trim() !== "")?.content ?? "");
const ultimoDelCliente = (h: readonly MensajeHiloVoz[]): string | undefined => [...h].reverse().find((m) => m.role === "user")?.content;
/** Solo dijo silencios o se despidio: no hay nada en curso que «es todo» deba cerrar. */
const sinConversacion = (h: readonly MensajeHiloVoz[]): boolean => h.filter((m) => m.role === "user").every((m) => esSilencioVoz(m.content) || esDespedidaDelCliente(m.content));

export async function turnoVoz(entrada: EntradaVozTurno, deps: DepsTurnoVoz): Promise<RespuestaVozTurno> {
  const e = validarEntradaVoz(entrada);
  const ahora = deps.ahora ?? (() => new Date());
  const limites = deps.limites ?? LIMITES_VOZ_DEFECTO;
  const { organizationId, propertyId } = deps;
  const esApertura = !e.texto.trim();

  const decision = await deps.enTransaccion<Decision>(async (tx) => {
    const fila = await tx.hilos.leer(organizationId, e.callId);
    // Un call_id es de UN telefono: otro numero no lee ni continua el hilo de esa llamada.
    if (fila && fila.telefono !== e.telefono) throw new VozTurnoConflictoError("call_id ya pertenece a otra llamada");
    const hilo = fila?.mensajes ?? [];
    const turnos = fila?.turnos ?? 0;

    // Idempotencia por seq (apertura = 0; turnos = 1, 2, ...): el mismo seq devuelve la respuesta guardada; uno menor = 409; uno MAYOR que el
    // siguiente se acepta (el worker se salto un seq: un 409 eterno colgaria la llamada).
    if (esApertura) {
      if (e.seq !== 0) throw new VozTurnoConflictoError("la apertura de la llamada lleva seq 0");
    } else if (e.seq === 0) {
      throw new VozTurnoConflictoError("seq 0 es solo la apertura; los turnos con texto empiezan en 1");
    } else if (fila && e.seq === fila.seqUltimo && fila.respuestaUltima) {
      return { tipo: "lista", respuesta: fila.respuestaUltima };
    } else if (fila && e.seq <= fila.seqUltimo) {
      throw new VozTurnoConflictoError(`seq fuera de orden (el último fue ${fila.seqUltimo}, llegó ${e.seq})`);
    }

    const guardar = async (mensajes: readonly MensajeHiloVoz[], respuesta: RespuestaVozTurno, extra: Partial<CambioHiloVoz> = {}): Promise<RespuestaVozTurno> => {
      const cambio: CambioHiloVoz = {
        propertyId: fila?.propertyId ?? propertyId,
        telefono: e.telefono,
        mensajes,
        pedidoId: respuesta.pedido_id ?? fila?.pedidoId ?? null,
        turnos: respuesta.turno,
        seqUltimo: e.seq,
        respuestaUltima: respuesta,
        fallosSeguidos: fila?.fallosSeguidos ?? 0,
        enProcesoSeq: null,
        enProcesoDesde: null,
        ahora: ahora(),
        ...extra,
      };
      const ok = fila ? await tx.hilos.avanzar(organizationId, e.callId, fila.version, cambio) : await tx.hilos.crear(organizationId, e.callId, cambio);
      if (!ok) throw new VozTurnoConflictoError("otra petición de la misma llamada se adelantó");
      return respuesta;
    };

    // Apertura (sin texto): saludo + aviso de grabacion, fijos, sin modelo. Repetida (reconexion del worker): la ultima frase y seq_ultimo.
    if (esApertura) {
      if (fila && hilo.length > 0) {
        return { tipo: "lista", respuesta: { texto: ultimoDelAsistente(hilo), pedido_id: fila.pedidoId, fin: false, turno: turnos, seq_ultimo: fila.seqUltimo } };
      }
      const ctx = await tx.contextoSaludo();
      const saludo = saludoVoz({ ahora: ahora(), zonaHoraria: ctx.zonaHoraria, nombreNegocio: ctx.nombreNegocio, avisoDado: e.avisoDado });
      const inicio: MensajeHiloVoz[] = e.avisoDado ? [{ role: "system", content: MARCA_AVISO_DADO_POR_WORKER }] : [];
      return { tipo: "lista", respuesta: await guardar([...inicio, { role: "assistant", content: saludo }], { texto: saludo, pedido_id: null, fin: false, turno: 0 }) };
    }

    const pedidoId = fila?.pedidoId ?? null;
    const conCliente = (texto: string, respuesta: string): MensajeHiloVoz[] => [...hilo, { role: "user", content: texto }, { role: "assistant", content: respuesta }];
    const sinModelo = async (textoCliente: string, texto: string, fin: boolean): Promise<Decision> => ({
      tipo: "lista",
      respuesta: await guardar(conCliente(textoCliente, texto), { texto, pedido_id: pedidoId, fin, turno: turnos + 1 }),
    });

    // Una marca viva de OTRO turno (o de este mismo seq) en proceso: 409 «en proceso», sin gastar doble ni crear dos pedidos.
    if (fila?.enProcesoSeq !== null && fila?.enProcesoSeq !== undefined && fila.enProcesoSeq <= e.seq && fila.enProcesoDesde) {
      const edad = ahora().getTime() - fila.enProcesoDesde.getTime();
      if (edad < EN_PROCESO_MAX_MS) throw new VozTurnoConflictoError("turno en proceso: reintente en unos segundos");
    }

    if (turnos >= MAX_TURNOS_LLAMADA) return { tipo: "lista", respuesta: { texto: TEXTO_LIMITE_LLAMADA, pedido_id: pedidoId, fin: true, turno: turnos } };
    // Texto del STT demasiado largo: no se recorta (se perdia el medio), se pide por partes sin modelo.
    if (e.texto.trim().length > MAX_TEXTO_VOZ_CHARS) return sinModelo(MARCA_TEXTO_LARGO_VOZ, TEXTO_REPETIR_POR_PARTES, false);
    const texto = e.texto.trim();
    // Silencio: el 1.º se repregunta sin modelo; el 2.º seguido cierra.
    if (esSilencioVoz(texto)) {
      return esSilencioVoz(ultimoDelCliente(hilo)) ? sinModelo(texto, TEXTO_SILENCIO_FIN, true) : sinModelo(texto, RESPUESTA_SILENCIO_VOZ, false);
    }
    // Despedida sin pedido ni conversacion en curso: cierre sin modelo.
    if (!pedidoId && sinConversacion(hilo) && esDespedidaDelCliente(texto)) return sinModelo(texto, TEXTO_DESPEDIDA, true);

    // Cupos ANTES de gastar modelo: primero los del abusador (llamada, telefono), luego la capacidad de la sucursal.
    if (!(await tx.consumirCupo(`call:${organizationId}:${e.callId}`, limites.porLlamadaPorMinuto, 60))) {
      throw new VozTurnoLimiteError("demasiadas solicitudes en esta llamada", 3);
    }
    if (!(await tx.consumirCupo(`tel:${organizationId}:${e.telefono}`, limites.porTelefonoPorHora, 3600))) {
      throw new VozTurnoLimiteError("tope de turnos de voz por teléfono", 30);
    }
    if (!(await tx.consumirCupo(`branch:${organizationId}:${propertyId ?? "org"}`, limites.porSucursalPorMinuto, 60))) {
      throw new VozTurnoLimiteError("tope de turnos de voz de la sucursal", 30);
    }

    // Marca «en proceso» (version + 1) y se CONFIRMA antes del modelo.
    const desde = ahora();
    const marca: CambioHiloVoz = {
      propertyId: fila?.propertyId ?? propertyId,
      telefono: e.telefono,
      mensajes: hilo,
      pedidoId,
      turnos,
      seqUltimo: fila?.seqUltimo ?? 0,
      respuestaUltima: fila?.respuestaUltima ?? null,
      fallosSeguidos: fila?.fallosSeguidos ?? 0,
      enProcesoSeq: e.seq,
      enProcesoDesde: desde,
      ahora: desde,
    };
    const ok = fila ? await tx.hilos.avanzar(organizationId, e.callId, fila.version, marca) : await tx.hilos.crear(organizationId, e.callId, marca);
    if (!ok) throw new VozTurnoConflictoError("turno en proceso: otra petición de la misma llamada se adelantó");
    const versionMarcada = fila ? fila.version + 1 : 1;
    const hiloMarcado: HiloVoz = { organizationId, callId: e.callId, ...marca, version: versionMarcada };
    return { tipo: "modelo", hilo: hiloMarcado, versionMarcada, turno: turnos + 1 };
  });

  if (decision.tipo === "lista") return decision.respuesta;
  const { hilo, versionMarcada, turno } = decision;
  const texto = e.texto.trim();

  try {
    return await deps.enTransaccion(async (tx) => {
      const mensajes: MensajeHiloVoz[] = [...hilo.mensajes, { role: "user", content: texto }];
      const res = await tx.agente({ mensajes, telefono: e.telefono, callId: e.callId, turno });
      const pedidoId = res.orderId ?? hilo.pedidoId;
      // Fallo del proveedor del modelo (texto fijo de problema tecnico): al 2.º seguido se deriva a una persona y se cierra.
      const fallo = !res.orderId && FALLO_PROVEEDOR.test(res.reply);
      const fallos = fallo ? hilo.fallosSeguidos + 1 : 0;
      let respuesta: RespuestaVozTurno;
      if (fallos >= MAX_FALLOS_SEGUIDOS) {
        respuesta = { texto: TEXTO_FALLO_PERSONA, pedido_id: pedidoId, fin: true, turno };
      } else {
        // Sin apertura previa (texto con el hilo vacio): el cliente aun no oyo el aviso de grabacion.
        const aviso = hilo.mensajes.length === 0 ? `${AVISO_VOZ_INICIAL} ` : "";
        respuesta = { texto: aviso + respuestaParaVoz(res.reply, { pedidoCreado: res.orderId !== null }), pedido_id: pedidoId, fin: false, turno };
      }
      const ok = await tx.hilos.avanzar(organizationId, e.callId, versionMarcada, {
        propertyId: hilo.propertyId,
        telefono: e.telefono,
        mensajes: [...mensajes, { role: "assistant", content: respuesta.texto }],
        pedidoId,
        turnos: turno,
        seqUltimo: e.seq,
        respuestaUltima: respuesta,
        fallosSeguidos: fallos,
        enProcesoSeq: null,
        enProcesoDesde: null,
        ahora: ahora(),
      });
      // Otra peticion movio el hilo mientras el modelo pensaba: se revierte TODO (incluido el pedido) y el worker reintenta.
      if (!ok) throw new VozTurnoConflictoError("otra petición de la misma llamada se adelantó");
      return respuesta;
    });
  } catch (err) {
    // Libera la marca (mejor esfuerzo) para que el reintento inmediato del mismo seq proceda; si falla, caduca sola.
    try {
      await deps.enTransaccion(async (tx) => {
        await tx.hilos.avanzar(organizationId, e.callId, versionMarcada, {
          propertyId: hilo.propertyId,
          telefono: hilo.telefono,
          mensajes: hilo.mensajes,
          pedidoId: hilo.pedidoId,
          turnos: hilo.turnos,
          seqUltimo: hilo.seqUltimo,
          respuestaUltima: hilo.respuestaUltima,
          fallosSeguidos: hilo.fallosSeguidos,
          enProcesoSeq: null,
          enProcesoDesde: null,
          ahora: ahora(),
        });
      });
    } catch {
      // la marca caduca sola a los EN_PROCESO_MAX_MS
    }
    throw err;
  }
}
