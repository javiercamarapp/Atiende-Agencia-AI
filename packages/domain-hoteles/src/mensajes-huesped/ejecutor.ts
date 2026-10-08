// H-P3-03 -- corrida real de los mensajes automaticos al huesped (cron /internal/hoteles/mensajes-huesped y disparo post-commit tras una
// decision del staff). Para cada candidato (un evento derivado del estado real de un hold, una reserva o una entrada de lista de espera):
// decide el canal (WhatsApp con plantilla HSM aprobada o texto libre dentro de las 24 h de Meta, correo, o "no enviado" con su motivo) y
// lo ENCOLA en messaging_outbox junto con su marca de idempotencia, en UNA transaccion POR candidato (un error SQL real en uno deja ABORTADA
// solo esa transaccion y su ROLLBACK nunca toca los ya emitidos). El envio real lo hacen los despachadores existentes (WhatsApp y Resend),
// que aplican ademas la supresion de plataforma y la cuota del plan.
//
// Idempotente: la marca (propiedad, referencia, evento) hace que dos corridas -- o dos instancias a la vez -- dejen UN solo mensaje.
// Los eventos proactivos respetan la ventana de envio de agent_guardrail (si no, quedan para la siguiente corrida, dentro de su gracia de
// 24 h); los transaccionales (respuesta a algo que el huesped hizo) salen en cuanto hay canal.
//
// Sin PII en logs: los `console.*` de este archivo solo reciben ids y el SQLSTATE/nombre del error.
import { isMigrationPendingError } from "@atiende/db";
import { withinSendWindow } from "../agentes/guardrails.ts";
import { decidirCanal, normalizarCorreo, normalizarTelefonoWhatsapp } from "./canal.ts";
import { armarParametrosPlantilla, type PlantillaParaEncolar } from "./plantillas.ts";
import type { EmitirMensajeEntrada, MensajesHuespedSistemaRepository } from "./repository.ts";
import { componerMensaje, valoresDelCandidato } from "./textos.ts";
import {
  MAX_MENSAJES_POR_CORRIDA,
  VENTANA_SERVICIO_SEGURA_MS,
  esEventoTransaccional,
  type CandidatoMensajeHuesped,
  type ResumenMensajesHuesped,
} from "./tipos.ts";

export interface ContextoMensajesHuesped {
  readonly repo: MensajesHuespedSistemaRepository;
  /** Lista de supresion de plataforma (`true` = NO contactar). FAIL-CLOSED: si no puede verificarse debe LANZAR (el candidato se reintenta en la siguiente corrida). */
  readonly esSuprimido: (tipo: "telefono" | "correo", valor: string) => Promise<boolean>;
}

/** Ejecuta `fn` en UNA transaccion propia (la ruta abre `withAppSession({ userId: null })`). */
export type WithMensajesHuespedTx = <T>(fn: (ctx: ContextoMensajesHuesped) => Promise<T>) => Promise<T>;

export interface OpcionesMensajesHuesped {
  readonly ahora?: Date;
  readonly maxPorCorrida?: number;
  /** Acota la corrida a una propiedad (y a una referencia): disparo inmediato tras una decision del staff. */
  readonly propertyId?: string;
  readonly refId?: string;
  /** `APP_BASE_URL`: arma el enlace del aviso de privacidad. */
  readonly appBaseUrl: string;
  /** Hay token de Meta en la plataforma. Sin el, nada sale por WhatsApp (sale por correo o queda "no enviado"). */
  readonly credencialMeta: boolean;
  /** Propiedades con mensajes que NO pudieron salir (sin contacto, sin plantilla...): aviso in-app al staff. Best-effort. */
  readonly alNoEnviados?: (propiedades: readonly { readonly organizationId: string; readonly propertyId: string; readonly cantidad: number }[]) => Promise<void>;
}

type Resultado = { readonly tipo: "encolado"; readonly canal: "whatsapp" | "email" } | { readonly tipo: "no_enviado" } | { readonly tipo: "diferido" } | { readonly tipo: "ya_procesado" };

function etiquetaError(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "error";
}

function dentroDeVentanaServicio(ultimaEntradaEn: string | null, ahora: Date): boolean {
  if (ultimaEntradaEn === null) return false;
  const t = Date.parse(ultimaEntradaEn);
  return Number.isFinite(t) && ahora.getTime() - t >= 0 && ahora.getTime() - t < VENTANA_SERVICIO_SEGURA_MS;
}

async function procesarCandidato(ctx: ContextoMensajesHuesped, inicial: CandidatoMensajeHuesped, ahora: Date, o: OpcionesMensajesHuesped): Promise<Resultado> {
  // Revalida con el estado ACTUAL (otra corrida pudo emitirlo, o el hold pudo cambiar entre listar y emitir) y toma datos frescos.
  const frescos = await ctx.repo.listarCandidatos(ahora, 1, { propertyId: inicial.propertyId, refId: inicial.refId });
  const c = frescos.find((x) => x.evento === inicial.evento && x.refId === inicial.refId);
  if (!c) return { tipo: "ya_procesado" };

  const transaccional = esEventoTransaccional(c.evento);
  if (!transaccional && !withinSendWindow(ahora, c.zonaHoraria, c.ventanaInicio, c.ventanaFin)) return { tipo: "diferido" };

  const telefono = normalizarTelefonoWhatsapp(c.telefono);
  const correo = normalizarCorreo(c.correo);
  const whatsappListo = o.credencialMeta && c.whatsappHabilitado && c.phoneNumberId !== null && c.phoneNumberId !== "";
  const telefonoSuprimido = telefono !== null ? await ctx.esSuprimido("telefono", telefono) : false;
  const correoSuprimido = correo !== null && !transaccional ? await ctx.esSuprimido("correo", correo) : false;
  const dentroVentana = whatsappListo && telefono !== null && !telefonoSuprimido && dentroDeVentanaServicio(c.ultimaEntradaEn, ahora);

  const valores = valoresDelCandidato(c, { appBaseUrl: o.appBaseUrl });
  let plantilla: PlantillaParaEncolar | null = null;
  // La plantilla solo se consulta si WhatsApp es viable y no estamos dentro de la ventana de 24 h (ahi sale texto libre).
  if (whatsappListo && telefono !== null && !telefonoSuprimido && !dentroVentana) {
    const aprobada = await ctx.repo.resolverPlantilla(c.organizationId, c.evento);
    if (aprobada) {
      const params = armarParametrosPlantilla(aprobada.variables, valores);
      if (params) plantilla = { name: aprobada.name, language: aprobada.language, params };
    }
  }

  const decision = decidirCanal({ telefono, correo, whatsappListo, dentroVentanaServicio: dentroVentana, plantilla, telefonoSuprimido, correoSuprimido, transaccional });
  const base = { propertyId: c.propertyId, evento: c.evento, refTipo: c.refTipo, refId: c.refId } as const;

  let entrada: EmitirMensajeEntrada;
  if (decision.canal === null) {
    entrada = { ...base, canal: null, motivo: decision.motivo, eventType: null, dedupeKey: null, payload: null };
  } else {
    const msg = componerMensaje(c.evento, valores);
    const eventType = `mh.${c.evento}`;
    if (decision.canal === "whatsapp") {
      const payload: Record<string, unknown> = { to: telefono, phone_number_id: c.phoneNumberId, body: msg.texto, transaccional };
      if (decision.modo === "plantilla") payload.template = { name: decision.plantilla.name, language: decision.plantilla.language, params: decision.plantilla.params };
      entrada = { ...base, canal: "whatsapp", motivo: null, eventType, dedupeKey: `mh:${c.evento}:${c.refId}:whatsapp`, payload };
    } else {
      // reserva.confirmada: el correo transaccional de la reserva (guest-email-notifications) ya cubre este canal: se marca, no se duplica.
      const payload = c.evento === "reserva.confirmada" ? null : { to: correo, subject: msg.asunto, html: msg.html, text: msg.texto, transaccional };
      entrada = { ...base, canal: "email", motivo: null, eventType, dedupeKey: `mh:${c.evento}:${c.refId}:email`, payload };
    }
  }

  const id = await ctx.repo.emitir(entrada);
  if (id === null) return { tipo: "ya_procesado" };
  return entrada.canal === null ? { tipo: "no_enviado" } : { tipo: "encolado", canal: entrada.canal };
}

export async function ejecutarMensajesHuesped(withTx: WithMensajesHuespedTx, o: OpcionesMensajesHuesped): Promise<ResumenMensajesHuesped> {
  const ahora = o.ahora ?? new Date();
  const max = o.maxPorCorrida ?? MAX_MENSAJES_POR_CORRIDA;
  const r = { candidatos: 0, encolados: 0, porWhatsapp: 0, porCorreo: 0, noEnviados: 0, diferidos: 0, yaProcesados: 0, errores: 0 };

  let candidatos: readonly CandidatoMensajeHuesped[];
  try {
    candidatos = await withTx((ctx) => ctx.repo.listarCandidatos(ahora, max, { ...(o.propertyId ? { propertyId: o.propertyId } : {}), ...(o.refId ? { refId: o.refId } : {}) }));
  } catch (err) {
    // Base sin la migracion 046: no hay nada que enviar todavia (nunca un 500).
    if (isMigrationPendingError(err)) return { disponible: false, ...r, truncada: false };
    throw err;
  }
  r.candidatos = candidatos.length;

  const sinEnviar = new Map<string, { organizationId: string; propertyId: string; cantidad: number }>();
  for (const c of candidatos) {
    try {
      const res = await withTx((ctx) => procesarCandidato(ctx, c, ahora, o));
      if (res.tipo === "encolado") {
        r.encolados += 1;
        if (res.canal === "whatsapp") r.porWhatsapp += 1;
        else r.porCorreo += 1;
      } else if (res.tipo === "no_enviado") {
        r.noEnviados += 1;
        const previo = sinEnviar.get(c.propertyId);
        if (previo) previo.cantidad += 1;
        else sinEnviar.set(c.propertyId, { organizationId: c.organizationId, propertyId: c.propertyId, cantidad: 1 });
      } else if (res.tipo === "diferido") r.diferidos += 1;
      else r.yaProcesados += 1;
    } catch (err) {
      r.errores += 1;
      console.error("mensajes-huesped: error procesando candidato", c.refId, c.evento, etiquetaError(err));
    }
  }

  if (o.alNoEnviados && sinEnviar.size > 0) {
    try {
      await o.alNoEnviados([...sinEnviar.values()]);
    } catch (err) {
      console.error("mensajes-huesped: aviso in-app de mensajes no enviados fallo", etiquetaError(err));
    }
  }
  return { disponible: true, ...r, truncada: candidatos.length >= max };
}
