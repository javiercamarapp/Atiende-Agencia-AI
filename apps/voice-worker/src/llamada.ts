// Atencion de UNA llamada, de punta a punta. Une las piezas que ya existen en main (token por llamada, `evaluarInicioLlamada`, `ControladorLlamada`
// con el ejecutor HTTP de restaurantes, escalera Gemini Live -> cascada, registrador de conversaciones) con el puente de audio de la telefonia.
//
//   1. DNIS -> sucursal (tabla de configuracion). Numero desconocido: se cuelga sin abrir nada.
//   2. Telefono del llamante SOLO del SIP From (`extraerTelefonoSipFrom`) Y solo si es CONFIABLE (`resolverTelefonoLlamante`): un From vacio, anonimo o que es un
//      numero puente / de la sucursal / del desvio (el desvio condicional puede re-originar la llamada) NO es del cliente. Entonces no se emite token todavia: el
//      agente PIDE el telefono al cliente y lo confirma, y solo con `confirmar_telefono_llamante` (herramienta del worker, una vez por llamada) se emite el token
//      con ESE telefono; mientras tanto ninguna otra herramienta corre.
//   3. Contexto de la API (instruccion, interruptor de la sucursal, gasto del mes), token de llamada, conversacion registrada con su modo de entrada.
//   4. `evaluarInicioLlamada` (dentro de `controlador.iniciar`) con el interruptor y el tope mensual: si no pasa, NO se abre sesion con el proveedor: pregrabado + callback.
//   5. Escalera, puente de audio, controlador. Al terminar: se vacia la despedida, se cuelga, se registran turnos, costo por escalon y cierre.
//
// El worker nunca contesta a medias: sin contexto de la API (o sin token) dice el pregrabado de falla y cuelga, sin abrir sesion con el proveedor.
import { ControladorLlamada, canonicalizeMexicanPhone, crearEjecutorTools, transporteHttp, LIMITES_POR_DEFECTO } from "@atiende/domain-restaurantes";
import type { AbrirSesionLlamada, EjecutorTools, MensajeId, SumideroLog, TransporteTools, VozResultado } from "@atiende/domain-restaurantes";
import { costoTotalMicroUsd, eventoSinPII, eventosCostoLlamada, referenciaLlamada } from "@atiende/voice-core";
import type { EscaleraLlamada, LimitesLlamada, VozSesionLlamada } from "@atiende/voice-core";
import { ErrorApi } from "./api-cliente.ts";
import type { AperturaPrivacidad, ClienteApi, ContextoLlamada, TurnoRegistro } from "./api-cliente.ts";
import { franjaDeHora, modoEntradaDeLlamada, normalizarNumero, resolverTopeMensualMicroUsd } from "./config.ts";
import { DEFINICION_CONFIRMAR_TELEFONO, INSTRUCCION_TELEFONO_NO_CONFIABLE, TOOL_CONFIRMAR_TELEFONO, resolverTelefonoLlamante } from "./telefono-llamante.ts";
import type { ConfigWorker, EntradaDnis } from "./config.ts";
import { PuenteAudio } from "./puente-audio.ts";
import type { AudioWav } from "./audio/pcm.ts";
import type { LlamadaTelefonica } from "./telefonia/puerto.ts";

/** Texto que dispara el saludo: el agente habla primero (la instruccion le dice como saludar). No es una frase del cliente y no se registra como turno. */
export const DISPARADOR_SALUDO = "(La llamada acaba de conectarse. Salude al cliente siguiendo sus instrucciones.)";

/** Frase que dispara el saludo y, si la API trajo el guion de apertura, le pide al agente decirlo TAL CUAL (aviso de privacidad + grabacion). */
export function disparadorDeApertura(apertura: AperturaPrivacidad | null): string {
  if (!apertura) return DISPARADOR_SALUDO;
  const espera = apertura.pideConsentimientoGrabacion ? " Después de decirlo, espere la respuesta del cliente sobre la grabación antes de tomar el pedido." : "";
  return `${DISPARADOR_SALUDO} Después del saludo diga al cliente, tal cual y sin cambiar nada, este aviso: «${apertura.guion}».${espera}`;
}

/** Cuantas veces se repite la pregunta de grabacion ante una respuesta ambigua antes de atender la llamada sin grabar. */
export const REINTENTOS_CONSENTIMIENTO = 2;

export interface DepsAtencion {
  readonly config: ConfigWorker;
  readonly pregrabados: ReadonlyMap<MensajeId, AudioWav>;
  readonly api: ClienteApi;
  /** Escalera NUEVA por llamada (lleva estado: quien ya fallo y los tramos para el costo). */
  readonly crearEscalera: () => EscaleraLlamada;
  readonly log: SumideroLog;
  /** `fetch` de las herramientas del agente (por omision el global; las pruebas lo apuntan a la API en proceso). */
  readonly fetchFn?: typeof fetch;
  readonly ahora?: () => number;
  /** Programa una tarea periodica y devuelve como cancelarla. Por omision `setInterval`; las pruebas pasan tiempo manual. */
  readonly programar?: (tarea: () => void, ms: number) => () => void;
  readonly limites?: LimitesLlamada;
  /** Cada cuanto se vuelcan los turnos nuevos al registrador (ms). */
  readonly volcadoTurnosMs?: number;
}

export interface ResumenAtencion {
  /** Resultado del registrador (`pedido_creado` | `escalado` | `abandonado`) o un motivo de no atencion. */
  readonly resultado: VozResultado | "dnis_desconocido" | "api_no_disponible";
  readonly costoMicroUsd: number;
  readonly conversationId: string | null;
  readonly orderId: string | null;
  readonly latenciasMs: readonly number[];
  readonly modoEntrada: string | null;
}

const programarPorDefecto = (tarea: () => void, ms: number): (() => void) => {
  const id = setInterval(tarea, ms);
  return () => clearInterval(id);
};

const CALL_ID_INVALIDO = /[^A-Za-z0-9._:-]/g;
const sanearCallId = (id: string): string => id.replace(CALL_ID_INVALIDO, "-").slice(0, 128) || "llamada";

/** Atiende la llamada hasta que termina. `senal` aborta (apagado del worker): se cuelga y la conversacion se cierra como `abandonado`. */
export async function atenderLlamada(tel: LlamadaTelefonica, deps: DepsAtencion, senal?: AbortSignal): Promise<ResumenAtencion> {
  const ahora = deps.ahora ?? (() => Date.now());
  const programar = deps.programar ?? programarPorDefecto;
  const callId = sanearCallId(tel.id);
  const ref = referenciaLlamada(callId);
  const log = (evento: string, campos: Record<string, unknown> = {}): void => eventoSinPII(deps.log, evento, { callRef: ref, ...campos });
  const iniciadaEn = ahora();

  const entrada: EntradaDnis | undefined = deps.config.dnis.get(normalizarNumero(tel.dnis) ?? "");
  if (!entrada) {
    log("dnis_desconocido");
    await tel.colgar();
    return { resultado: "dnis_desconocido", costoMicroUsd: 0, conversationId: null, orderId: null, latenciasMs: [], modoEntrada: null };
  }
  const { organizationId, propertyId } = entrada;
  const numerosPuente = new Set(deps.config.dnis.keys());
  const origen = resolverTelefonoLlamante({ sipFrom: tel.sipFrom, desviadaDesde: tel.desviadaDesde, entrada, numerosPuente });
  // Solo un telefono confiable viaja a la API (contexto, privacidad, token). Sin el, el agente lo pide y lo confirma (ver `confirmarTelefono` abajo).
  const telefono = origen.telefono;
  const telefonoPendiente = !origen.confiable;
  if (telefonoPendiente) log("telefono_no_confiable", { motivo: origen.motivo, desviada: origen.desviada });

  // Cuelgue del cliente: se aplica al controlador cuando exista y se recuerda para el cierre.
  let clienteColgo = false;
  let alColgarCliente: (() => void) | null = null;
  tel.alColgar(() => {
    clienteColgo = true;
    alColgarCliente?.();
  });

  const reproducirSolo = async (id: MensajeId): Promise<void> => {
    const a = deps.pregrabados.get(id);
    if (!a || clienteColgo) return;
    await tel.reproducir(a.muestras, a.hz);
  };

  // 1) Contexto. Sin el no se sabe si la sucursal esta habilitada ni con que instruccion atender: se dice el pregrabado de falla y se cuelga.
  let contexto: ContextoLlamada;
  try {
    contexto = await deps.api.contexto({ organizationId, propertyId, callerPhone: telefono });
  } catch (err) {
    log("contexto_fallo", { codigo: err instanceof ErrorApi ? String(err.estado ?? "red") : "error" });
    await reproducirSolo("proveedor_caido");
    await tel.colgar();
    return { resultado: "api_no_disponible", costoMicroUsd: 0, conversationId: null, orderId: null, latenciasMs: [], modoEntrada: null };
  }

  // 2) SEGUNDA OLA, en paralelo (antes eran viajes secuenciales a la API antes de que el agente pudiera saludar; la latencia de arranque era la suma):
  //    conversacion registrada (no fatal: si el registrador falla se atiende igual, solo sin historial), aviso de privacidad por voz (migracion 030: guion de apertura
  //    y evidencia de entrega; no fatal: si falla, el agente saluda sin el aviso y la llamada se atiende SIN grabar) y token de llamada (el secreto de la sucursal
  //    solo sirve para esto; con telefono no confiable NO se emite aun: lo emite `confirmarTelefono`). El token y el aviso se piden DESPUES del contexto, nunca
  //    antes: si el contexto falla no se deja evidencia de un aviso que no se dijo.
  let callToken: string | null = null;
  const emitirToken = async (callerPhone: string, telefonoDeclarado = false): Promise<void> => {
    callToken = await deps.api.pedirToken({ orgSlug: entrada.orgSlug, secreto: entrada.secreto, callId, callerPhone, branchSlug: entrada.branchSlug, ...(telefonoDeclarado ? { telefonoDeclarado: true } : {}) });
  };
  const codigoDe = (err: unknown): string => (err instanceof ErrorApi ? String(err.estado ?? "red") : "error");
  const [convR, avisoR, tokenR] = await Promise.allSettled([
    deps.api.iniciarConversacion({ organizationId, propertyId, externalId: callId, voiceId: contexto.voiceId, callerPhone: telefono, startedAt: new Date(iniciadaEn).toISOString() }),
    deps.api.privacidadApertura({ organizationId, callerPhone: telefono }),
    !telefonoPendiente && telefono !== null ? emitirToken(telefono) : Promise.resolve(),
  ]);
  let conversationId: string | null = null;
  if (convR.status === "fulfilled") conversationId = convR.value;
  else log("conversacion_no_registrada", { codigo: codigoDe(convR.reason) });
  let aviso: AperturaPrivacidad | null = null;
  if (avisoR.status === "fulfilled") aviso = avisoR.value;
  else log("apertura_privacidad_fallo", { codigo: codigoDe(avisoR.reason) });
  const modo = modoEntradaDeLlamada(entrada.modoEntrada, tel.desviadaDesde);

  const cerrarConversacion = async (resultado: VozResultado, orderId: string | null): Promise<void> => {
    if (!conversationId) return;
    try {
      await deps.api.cerrar({ organizationId, conversationId, resultado, orderId, endedAt: new Date(ahora()).toISOString() });
    } catch (err) {
      // Si falla, el barrido de llamadas huerfanas de la API cierra la conversacion mas tarde (no se duplica aqui).
      log("cierre_no_registrado", { codigo: err instanceof ErrorApi ? String(err.estado ?? "red") : "error" });
    }
  };

  const tope = resolverTopeMensualMicroUsd(deps.config.topeMensualPlataformaMicroUsd, entrada.topeMensualUsd);

  // Tareas NO criticas que ya no retrasan el saludo (corren en segundo plano y se esperan al terminar la llamada, para que ninguna se pierda ni quede colgando):
  //  - modo de entrada / franja del KPI (base sin migrar: 404/503 = "no disponible aun", no es una falla de la llamada);
  //  - aviso in-app al owner/admin cuando el gasto del mes llega al 80 % del tope y cuando lo alcanza (el servidor deduplica por organizacion y mes).
  const segundoPlano: Promise<void>[] = [];
  if (conversationId) {
    const id = conversationId;
    segundoPlano.push(
      deps.api.marcarModoEntrada({ organizationId, conversationId: id, modo, franja: franjaDeHora(contexto.horaLocal) }).catch((err: unknown) => log("modo_entrada_no_registrado", { codigo: codigoDe(err) })),
    );
  }
  if (tope !== null && contexto.gastoMesMicroUsd !== null && contexto.gastoMesMicroUsd * 100 >= tope * 80) {
    const nivel = contexto.gastoMesMicroUsd >= tope ? "alcanzado" : "80";
    segundoPlano.push(deps.api.avisarTopeMensual({ organizationId, propertyId, nivel, usadoMicroUsd: contexto.gastoMesMicroUsd, limiteMicroUsd: tope }).catch((err: unknown) => log("aviso_tope_no_enviado", { codigo: codigoDe(err) })));
  }

  if (tokenR.status === "rejected") {
    log("token_fallo", { codigo: codigoDe(tokenR.reason) });
    await reproducirSolo("proveedor_caido");
    await tel.colgar();
    await cerrarConversacion("escalado", null);
    await Promise.allSettled(segundoPlano);
    return { resultado: "api_no_disponible", costoMicroUsd: 0, conversationId, orderId: null, latenciasMs: [], modoEntrada: modo };
  }

  // 5) Controlador + escalera + puente.
  const limites = deps.limites ?? LIMITES_POR_DEFECTO;
  const escalera = deps.crearEscalera();
  let orderId: string | null = null;
  // El transporte se arma cuando hay token (de inmediato con caller ID confiable; tras `confirmarTelefono` si no).
  let transporteBase: TransporteTools | null = null;
  const armarTransporte = (): void => {
    transporteBase = transporteHttp({ baseUrl: deps.config.apiBaseUrl, orgSlug: entrada.orgSlug, callToken: callToken!, ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}) });
  };
  if (callToken !== null) armarTransporte();
  // OJO (hueco conocido, comportamiento heredado): el contexto de turno (`x-atiende-call-turn`) NO se reenvia a la API. Activarlo exige validar con una llamada
  // real que la transcripcion de entrada de Gemini llega ANTES de la herramienta; si llega despues, `confirmar_resumen` se rechazaria por "mismo turno".
  const transporte: TransporteTools = async (nombre, args, sig) => {
    if (!transporteBase) return { resultado: { error: "telefono_pendiente", mensaje: "Pida y confirme el teléfono del cliente y regístrelo con confirmar_telefono_llamante antes de usar otras herramientas." }, orderId: null };
    const salida = await transporteBase(nombre, args, sig);
    if (nombre === "crear_pedido" && salida.orderId) orderId = salida.orderId;
    return salida;
  };
  let sesionActual: VozSesionLlamada | null = null;
  const puente = new PuenteAudio({
    tel,
    ahora,
    eventos: {
      usuarioHabla: () => controlador.usuarioHabla(),
      silencio: (ms) => controlador.silencio(ms),
      dtmf: (d) => controlador.dtmf(d),
      tick: (s) => controlador.tick(s),
    },
    enviarASesion: (pcm) => sesionActual?.enviarAudio?.(pcm),
  });
  // Consentimiento de grabacion: la primera respuesta clara del cliente DESPUES de que el agente termino el aviso se manda al servidor, que la interpreta
  // (conservador: lo ambiguo es "no grabar"). Una respuesta ambigua repite la pregunta hasta REINTENTOS_CONSENTIMIENTO veces.
  const pideConsentimiento = aviso?.pideConsentimientoGrabacion === true && conversationId !== null;
  let consentimiento: "pendiente" | "otorgado" | "negado" | "no_disponible" = "pendiente";
  let consentimientoResuelto = !pideConsentimiento;
  let avisoDicho = false;
  let intentosConsentimiento = 0;
  let consultandoConsentimiento = false;
  const procesarConsentimiento = async (texto: string): Promise<void> => {
    if (consentimientoResuelto || consultandoConsentimiento || !avisoDicho || !conversationId) return;
    consultandoConsentimiento = true;
    try {
      const r = await deps.api.consentimientoGrabacion({ organizationId, conversationId, respuesta: texto });
      if (r.consentimiento === "pendiente") {
        intentosConsentimiento += 1;
        if (intentosConsentimiento >= REINTENTOS_CONSENTIMIENTO) consentimientoResuelto = true; // sin respuesta clara: se atiende sin grabar
        else (sesionActual as VozSesionLlamada | null)?.enviarTexto(`(El cliente no respondió con claridad a la pregunta de grabación. Repítala tal cual: «${r.respuestaSugerida}»)`);
        return;
      }
      consentimiento = r.consentimiento;
      consentimientoResuelto = true;
      log("consentimiento_resuelto", { resultado: r.consentimiento });
    } catch (err) {
      // Sin poder registrarlo, la llamada sigue y NO se graba.
      intentosConsentimiento = REINTENTOS_CONSENTIMIENTO;
      consentimientoResuelto = true;
      log("consentimiento_fallo", { codigo: err instanceof ErrorApi ? String(err.estado ?? "red") : "error" });
    } finally {
      consultandoConsentimiento = false;
    }
  };
  const abrirSesion: AbrirSesionLlamada = async (apertura, h) => {
    const sesion = await escalera.abrirSesion(apertura, {
      ...h,
      audioAgente: (pcm) => puente.audioAgente(pcm),
      agenteTermino: () => {
        avisoDicho = true;
        h.agenteTermino();
      },
      usuarioDijo: (texto) => {
        h.usuarioDijo?.(texto);
        void procesarConsentimiento(texto);
      },
      interrumpido: () => {
        puente.cortarAudio();
        h.interrumpido();
      },
    });
    sesionActual = sesion;
    return sesion;
  };
  // Telefono dictado por el cliente cuando el caller ID no sirve. UNA sola vez por llamada (cambiarlo despues dejaria enumerar clientes ajenos con
  // `buscar_cliente`), nunca un numero puente o de la sucursal, y la ultima palabra la tiene la API: el token se emite con ESE telefono canonico y marcado `telefono_declarado`: nadie verifico que sea del llamante, asi que la API no le devuelve nombre, direcciones ni pedidos de ese numero (Cliente 360 lo trata como cliente nuevo).
  const confirmarTelefono = async (args: Readonly<Record<string, unknown>>): Promise<unknown> => {
    if (callToken !== null) return { ok: true, ya_registrado: true, mensaje: "El teléfono ya quedó registrado; continúe con el pedido." };
    const crudo = typeof args.numero === "string" ? args.numero : "";
    const numero = crudo.length > 0 && crudo.length <= 40 ? canonicalizeMexicanPhone(crudo) : null;
    if (numero === null) return { error: "telefono_invalido", mensaje: "No son 10 dígitos válidos. Pídale al cliente que se lo repita completo." };
    const clave = normalizarNumero(numero);
    if (clave !== null && (numerosPuente.has(clave) || entrada.numerosSucursal.includes(clave))) return { error: "telefono_no_valido", mensaje: "Ese es un número del restaurante. Pídale al cliente su teléfono personal." };
    try {
      await emitirToken(numero, true);
    } catch (err) {
      log("token_fallo", { codigo: err instanceof ErrorApi ? String(err.estado ?? "red") : "error", tras: "confirmar_telefono" });
      return { error: "no_se_pudo_registrar", mensaje: "No se pudo registrar el teléfono. Intente una vez más o pase con una persona." };
    }
    armarTransporte();
    log("telefono_confirmado_por_cliente", { motivo: origen.motivo });
    return { ok: true, mensaje: "Teléfono registrado." };
  };
  const ejecutorBase = crearEjecutorTools({ transporte, timeoutMs: limites.toolTimeoutMs });
  const ejecutor: EjecutorTools = telefonoPendiente
    ? {
        definiciones: () => [...ejecutorBase.definiciones(), DEFINICION_CONFIRMAR_TELEFONO as unknown as ReturnType<EjecutorTools["definiciones"]>[number]],
        async ejecutar(nombre, args, contexto) {
          if (nombre !== TOOL_CONFIRMAR_TELEFONO) return ejecutorBase.ejecutar(nombre, args, contexto);
          const t0 = ahora();
          const resultado = await confirmarTelefono(args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {});
          const ok = typeof resultado === "object" && resultado !== null && !("error" in resultado);
          return { resultado, ok, timeout: false, orderId: null, latenciaMs: Math.max(0, ahora() - t0) };
        },
      }
    : ejecutorBase;
  const controlador = new ControladorLlamada({
    callId,
    propertyId,
    organizationId,
    abrirSesion,
    ejecutor,
    instruccion: telefonoPendiente ? `${contexto.instruccion}\n\n${INSTRUCCION_TELEFONO_NO_CONFIABLE}` : contexto.instruccion,
    voiceId: contexto.voiceId,
    limites,
    reproducir: async (id) => {
      const a = deps.pregrabados.get(id);
      if (!a) {
        log("pregrabado_faltante", { mensaje: id });
        return;
      }
      await puente.reproducirPregrabado(a);
    },
    cortarAudio: () => puente.cortarAudio(),
    log: deps.log,
    kpi: async (e) => {
      try {
        if (e.tipo === "tool_call") await deps.api.registrarEvento({ organizationId, propertyId, conversationId, tipo: "tool_call", herramienta: e.herramienta, latenciaMs: e.latenciaMs });
        else await deps.api.registrarEvento({ organizationId, propertyId, conversationId, tipo: "error_proveedor", proveedor: e.proveedor, codigo: e.codigo });
      } catch {
        /* el KPI es informativo: nunca rompe la llamada */
      }
    },
  });
  alColgarCliente = () => void controlador.clienteCuelga();
  if (clienteColgo) void controlador.clienteCuelga();
  const alAbortar = (): void => void controlador.clienteCuelga();
  senal?.addEventListener("abort", alAbortar, { once: true });

  // Volcado de turnos: todos menos el ultimo en el camino; el ultimo (con el costo total) al cerrar.
  let enviados = 0;
  let previoRol: TurnoRegistro["rol"] | null = null;
  let latenciasUsadas = 0;
  const volcarTurnos = async (final: boolean, costoFinalMicroUsd = 0): Promise<void> => {
    if (!conversationId) return;
    // Sin consentimiento claro la base no guarda turnos (migracion 030): no se intenta, para no marcarlos como enviados y perderlos.
    if (pideConsentimiento && consentimiento !== "otorgado") return;
    const turnos = controlador.transcripcion;
    const limite = final ? turnos.length : Math.max(0, turnos.length - 1);
    while (enviados < limite) {
      const t = turnos[enviados]!;
      const esRespuesta = t.rol === "agente" && previoRol === "cliente";
      const latenciaMs = esRespuesta ? puente.latenciasMs[latenciasUsadas] : undefined;
      const ultimo = enviados === turnos.length - 1;
      try {
        await deps.api.registrarTurno(organizationId, conversationId, { seq: enviados, rol: t.rol, texto: t.texto, latenciaMs: latenciaMs ?? null, costoMicroUsd: final && ultimo ? costoFinalMicroUsd : 0 });
      } catch {
        return; // se reintenta en el siguiente volcado (idempotente por seq)
      }
      if (esRespuesta) latenciasUsadas += 1;
      if (t.rol !== "herramienta") previoRol = t.rol;
      enviados += 1;
    }
  };

  const cancelarReloj = programar(() => puente.tickSegundo(), 1000);
  const cancelarVolcado = programar(() => void volcarTurnos(false), deps.volcadoTurnosMs ?? 15_000);

  let resultado: VozResultado = "abandonado";
  let costoMicroUsd = 0;
  try {
    const { iniciada } = await controlador.iniciar({ habilitado: contexto.habilitado, gastoMesMicroUsd: contexto.gastoMesMicroUsd, topeMensualMicroUsd: tope, horaLocal: contexto.horaLocal });
    if (iniciada) (sesionActual as VozSesionLlamada | null)?.enviarTexto(disparadorDeApertura(aviso));
    const fin = await controlador.terminada;
    resultado = fin.resultado;
    // La despedida o el pregrabado terminal tienen que sonar antes de colgar.
    await puente.vaciar();
  } finally {
    cancelarReloj();
    cancelarVolcado();
    senal?.removeEventListener("abort", alAbortar);
    puente.cerrar();
    await tel.colgar().catch(() => undefined);
  }

  // 6) Cierre: costo por escalon (en `core.usage_cost_event`), turnos, conversacion. La duracion y el p95 los calcula la base desde los turnos.
  const tramos = escalera.tramos();
  const eventos = eventosCostoLlamada({ vertical: "restaurantes", llamadaId: callId, organizationId, propertyId, ocurridoEn: new Date(iniciadaEn).toISOString(), tramos });
  costoMicroUsd = costoTotalMicroUsd(eventos);
  if (conversationId && tramos.length > 0) {
    try {
      await deps.api.registrarCosto({ organizationId, propertyId, conversationId, llamadaId: callId, ocurridoEn: new Date(iniciadaEn).toISOString(), tramos });
    } catch (err) {
      log("costo_no_registrado", { codigo: err instanceof ErrorApi ? String(err.estado ?? "red") : "error" });
    }
  }
  await volcarTurnos(true, costoMicroUsd);
  // Latencia de voz a voz de cada respuesta (B-36) como EVENTO operativo (sin texto): se mide aunque la llamada no se grabe.
  if (puente.latenciasMs.length > 0) {
    const ordenadas = [...puente.latenciasMs].sort((a, b) => a - b);
    const pct = (p: number): number => ordenadas[Math.min(ordenadas.length - 1, Math.max(0, Math.ceil(p * ordenadas.length) - 1))] ?? 0;
    log("latencia_p50", { ms: Math.round(pct(0.5)), intento: ordenadas.length });
    log("latencia_p95", { ms: Math.round(pct(0.95)), intento: ordenadas.length });
    await Promise.allSettled(puente.latenciasMs.map((ms) => deps.api.registrarEvento({ organizationId, propertyId, conversationId, tipo: "latencia_voz", latenciaMs: Math.round(ms) })));
  }
  await cerrarConversacion(resultado, orderId);
  await Promise.allSettled(segundoPlano);
  log("atencion_fin", { resultado, costoMicroUsd, propertyId, organizationId });
  return { resultado, costoMicroUsd, conversationId, orderId, latenciasMs: [...puente.latenciasMs], modoEntrada: modo };
}
