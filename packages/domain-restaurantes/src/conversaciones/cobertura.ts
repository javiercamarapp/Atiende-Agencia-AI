// Cobertura por turnos y escalacion de un handoff pendiente. Funciones PURAS: el reloj y la zona
// horaria del negocio entran como parametros (nunca el del proceso: Vercel corre en UTC).
import { estaAbiertoAhora } from "../horarios.ts";
import type { TurnoPersonal } from "./types.ts";

/** Minutos sin que nadie tome una conversacion pendiente antes de avisar al respaldo / a administracion. */
export const ESCALACION_RESPALDO_MIN = 5;
export const ESCALACION_ADMIN_MIN = 10;

export interface GuardiaItem {
  readonly userId: string;
  readonly nombre: string | null;
  readonly turnoId: string;
  readonly turnoNombre: string;
  readonly orden: number;
}

export interface Cobertura {
  readonly turnosVigentes: readonly TurnoPersonal[];
  /** Personal de guardia ahora, ordenado por `orden` (principal primero). */
  readonly guardia: readonly GuardiaItem[];
  /** `true` si ningun turno vigente tiene miembros: nadie contesta. */
  readonly sinCobertura: boolean;
}

/** Turnos vigentes en `ahora` (un turno que cruza la medianoche cuenta hasta su hora de termino). */
export function turnosVigentes(turnos: readonly TurnoPersonal[], ahora: Date, zonaHoraria?: string | null): readonly TurnoPersonal[] {
  return turnos.filter((t) => estaAbiertoAhora([{ dias: t.dias, abre: t.inicia, cierra: t.termina }], ahora, zonaHoraria).abierto);
}

export function calcularCobertura(turnos: readonly TurnoPersonal[], ahora: Date, zonaHoraria?: string | null): Cobertura {
  const vigentes = turnosVigentes(turnos, ahora, zonaHoraria);
  const vistos = new Set<string>();
  const guardia: GuardiaItem[] = [];
  for (const t of vigentes) {
    for (const m of t.miembros) {
      if (vistos.has(m.userId)) continue;
      vistos.add(m.userId);
      guardia.push({ userId: m.userId, nombre: m.nombre, turnoId: t.id, turnoNombre: t.nombre, orden: m.orden });
    }
  }
  guardia.sort((a, b) => a.orden - b.orden || (a.nombre ?? "").localeCompare(b.nombre ?? ""));
  return { turnosVigentes: vigentes, guardia, sinCobertura: guardia.length === 0 };
}

export type NivelEscalacion = 0 | 1 | 2;

export interface Escalacion {
  /** 0 = avisar al principal de guardia; 1 = sumar al respaldo; 2 = sumar a administracion (owner/admin). */
  readonly nivel: NivelEscalacion;
  readonly minutosEspera: number;
  readonly sinCobertura: boolean;
  /** Personal a quien le toca ser avisado en este nivel. */
  readonly destinatarios: readonly GuardiaItem[];
  readonly avisarAdministracion: boolean;
}

/**
 * Escalacion de una toma PENDIENTE: la espera cuenta desde `solicitadaAt`. Sin personal de guardia
 * se salta directo a administracion (nadie va a contestar). Una toma que no esta pendiente no escala.
 */
export function calcularEscalacion(
  handoff: { readonly estado: string; readonly solicitadaAt: string | null },
  cobertura: Cobertura,
  ahora: Date,
): Escalacion | null {
  if (handoff.estado !== "pendiente" || !handoff.solicitadaAt) return null;
  const minutos = Math.max(0, Math.floor((ahora.getTime() - new Date(handoff.solicitadaAt).getTime()) / 60000));
  let nivel: NivelEscalacion = minutos >= ESCALACION_ADMIN_MIN ? 2 : minutos >= ESCALACION_RESPALDO_MIN ? 1 : 0;
  if (cobertura.sinCobertura) nivel = 2;
  const principales = cobertura.guardia.filter((g) => g.orden === 1);
  const destinatarios = nivel === 0 ? (principales.length > 0 ? principales : cobertura.guardia.slice(0, 1)) : cobertura.guardia;
  return { nivel, minutosEspera: minutos, sinCobertura: cobertura.sinCobertura, destinatarios, avisarAdministracion: nivel === 2 };
}
