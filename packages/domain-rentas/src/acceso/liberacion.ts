// Rn-04 -- corrida real de la liberación de instrucciones de acceso al huésped.
//
// Una transacción POR RESERVA (misma lección que checkin-reminders.ts, r4-fix-crons-
// transaccion-por-unidad): un error SQL real en una reserva deja ESA transacción
// abortada (25P02) y su ROLLBACK nunca toca las reservas ya entregadas. Dentro de la
// transacción de cada reserva se encadena: pedir la siguiente a la base (que decide
// ventana + pago + política), armar el correo, encolarlo en rentas.messaging_outbox
// (dedupe_key `acceso:<id>`) y marcar la liberación. Si encolar falla, TODO se revierte y
// la reserva queda pendiente para la siguiente corrida; mientras tanto se excluye de ESTA.
//
// Sin PII en logs: ningún `console.*` de este archivo recibe correo, nombre, dirección ni
// código; los errores se registran solo con el id de la reserva y el SQLSTATE/nombre.
import { isMigrationPendingError } from "@atiende/db";
import { correoAccesoHuesped } from "../emails/acceso-templates.ts";
import type { RentasRepository } from "../repository.ts";
import type { RentasAccesoRepository } from "./repository.ts";
import type { LiberacionPendiente } from "./tipos.ts";

export interface ContextoLiberacion {
  readonly acceso: RentasAccesoRepository;
  readonly rentas: Pick<RentasRepository, "enqueueMessagingOutbox">;
}

/** Ejecuta `fn` en UNA transacción propia (la ruta abre `withAppSession({ userId: null })`). */
export type WithLiberacionTx = <T>(fn: (ctx: ContextoLiberacion) => Promise<T>) => Promise<T>;

export interface ResumenLiberacionAcceso {
  /** `false`: la base aún no tiene la migración 025 (la corrida no hizo nada). */
  readonly disponible: boolean;
  readonly liberadas: number;
  readonly omitidasSinContacto: number;
  readonly omitidasSinInstrucciones: number;
  readonly errores: number;
  /** `true` si se alcanzó el tope por corrida (queda trabajo para la siguiente). */
  readonly truncada: boolean;
}

export const MAX_LIBERACIONES_POR_CORRIDA = 50;
export const EVENTO_OUTBOX_ACCESO = "reserva.acceso_huesped";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function formatearFechaCalendario(fecha: string): string {
  return new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${fecha}T00:00:00Z`));
}

function etiquetaError(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "error";
}

type Resultado = { tipo: "fin" } | { tipo: "error_acceso"; id: string } | { tipo: "liberada"; id: string } | { tipo: "sin_contacto"; id: string } | { tipo: "sin_instrucciones"; id: string };

async function procesarSiguiente(ctx: ContextoLiberacion, excluir: readonly string[], onCandidata: (id: string) => void): Promise<Resultado> {
  const cand: LiberacionPendiente | null = await ctx.acceso.siguienteLiberacion(excluir);
  if (!cand) return { tipo: "fin" };
  onCandidata(cand.ocupacionId);

  // Rn-29: el sobre cifrado no se pudo abrir (sin llave, llave invalida o sobre alterado). No se entrega nada; queda un
  // 'error_envio' sin contenido en la bitacora y la reserva sigue pendiente para la siguiente corrida.
  if (cand.errorAcceso) {
    await ctx.acceso.registrarEvento(cand.ocupacionId, "error_envio");
    return { tipo: "error_acceso", id: cand.ocupacionId };
  }

  if (!cand.tieneInstrucciones || !cand.direccionExacta) {
    await ctx.acceso.registrarEvento(cand.ocupacionId, "omitida_sin_instrucciones");
    return { tipo: "sin_instrucciones", id: cand.ocupacionId };
  }
  const contacto = cand.huespedContacto;
  if (!contacto || !EMAIL_RE.test(contacto)) {
    // Rn-P3-09: solo la PRIMERA omision de las ultimas 24 h avisa (el registro se topa a una por dia); el aviso en si se deduplica por reserva.
    const nueva = await ctx.acceso.registrarEvento(cand.ocupacionId, "omitida_sin_contacto");
    if (nueva) await ctx.acceso.avisarOmitidaSinContacto(cand.ocupacionId, cand.organizationId, cand.propertyId);
    return { tipo: "sin_contacto", id: cand.ocupacionId };
  }

  const correo = correoAccesoHuesped({
    huespedNombre: cand.huespedNombre ?? "Huésped",
    tenantNombre: cand.tenantNombre,
    unidadNombre: cand.unidadNombre,
    checkInTexto: formatearFechaCalendario(cand.checkIn),
    checkOutTexto: formatearFechaCalendario(cand.checkOut),
    direccionExacta: cand.direccionExacta,
    codigoAcceso: cand.codigoAcceso,
    instrucciones: cand.instrucciones,
  });
  await ctx.rentas.enqueueMessagingOutbox(cand.propertyId, cand.organizationId, "email", EVENTO_OUTBOX_ACCESO, `acceso:${cand.ocupacionId}`, { to: contacto, subject: correo.asunto, html: correo.html, text: correo.texto }); // SA-L-46: lo libera el cron N horas antes del check-in (proactivo): la lista de supresion SI lo bloquea.
  await ctx.acceso.marcarLiberada(cand.ocupacionId);
  return { tipo: "liberada", id: cand.ocupacionId };
}

export async function ejecutarLiberacionAcceso(withTx: WithLiberacionTx, opciones: { readonly maxPorCorrida?: number } = {}): Promise<ResumenLiberacionAcceso> {
  const max = opciones.maxPorCorrida ?? MAX_LIBERACIONES_POR_CORRIDA;
  const excluir: string[] = [];
  const r = { liberadas: 0, omitidasSinContacto: 0, omitidasSinInstrucciones: 0, errores: 0 };
  let truncada = true;

  for (let i = 0; i < max; i++) {
    let candidata: string | null = null;
    try {
      const res = await withTx((ctx) => procesarSiguiente(ctx, excluir, (id) => (candidata = id)));
      if (res.tipo === "fin") {
        truncada = false;
        break;
      }
      excluir.push(res.id);
      if (res.tipo === "error_acceso") r.errores += 1;
      else if (res.tipo === "liberada") r.liberadas += 1;
      else if (res.tipo === "sin_contacto") r.omitidasSinContacto += 1;
      else r.omitidasSinInstrucciones += 1;
    } catch (err) {
      if (isMigrationPendingError(err)) {
        // Base sin la migración 025: no hay nada que liberar todavía (nunca un 500).
        return { disponible: false, ...r, truncada: false };
      }
      r.errores += 1;
      console.error("acceso-huesped: error procesando reserva", candidata ?? "(sin candidata)", etiquetaError(err));
      if (candidata === null) {
        // Falló pedir la siguiente (sin candidata no hay a quién excluir): cortar para no ciclar.
        truncada = false;
        break;
      }
      excluir.push(candidata);
      // Dejar rastro (sin PII) en su propia transacción; si esto también falla, solo se loguea.
      try {
        const id = candidata as string;
        await withTx((ctx) => ctx.acceso.registrarEvento(id, "error_envio"));
      } catch (err2) {
        console.error("acceso-huesped: no se pudo registrar el error de envio", candidata, etiquetaError(err2));
      }
    }
  }
  return { disponible: true, ...r, truncada };
}
