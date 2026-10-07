// Revalidacion de un aviso pendiente contra el estado ACTUAL de su cita, justo antes de entregarlo.
//
// Un recordatorio puede quedar encolado (Meta caido, backoff, horario de envio) y la cita cancelarse o cerrarse mientras tanto: entregarlo
// despues le llega al paciente como "confirma tu cita" con botones Confirmar/Cancelar/Reagendar sobre una cita que ya no existe. La unica
// referencia que ese aviso lleva es el id de la cita (en los botones de WhatsApp o en `appointment_id` del correo): aqui se vuelve a leer su estado.
//
// FAIL-OPEN a proposito: si la lectura falla o la cita no aparece, el aviso se entrega como siempre; solo un estado INACTIVO explicito lo frena.
//
// LIMITACION CONOCIDA (hueco abierto, QA-citas-R1-automatizacion-02): la lectura usa `findAppointmentForOrganization`, un SELECT plano sobre
// `citas.appointments` cuya unica policy de lectura es de staff (`auth.uid()` con membresia). Los dos despachadores corren en sesion de SISTEMA
// (`auth.uid()` nulo), asi que contra Postgres real la lectura devuelve 0 filas, `cita` queda en null y esta funcion devuelve true (se entrega).
// Solo frena de verdad con un repositorio sin RLS (pruebas en memoria) o una sesion con membresia. Cerrarlo requiere una funcion `security
// definer` de solo-sistema (`auth.uid() is null`, `set search_path`, revoke de public) y su verify, es decir SQL con prefijo de migracion.
import type { CitasRepository } from "./repository.ts";
import type { MessagingOutboxRow } from "./repository.ts";
import { parseAppointmentButtonId } from "./whatsapp/appointment-button-ids.ts";

const ESTADOS_INACTIVOS: ReadonlySet<string> = new Set(["cancelled", "completed", "no_show"]);

/** `false` solo si la cita existe y esta cancelada, completada o marcada como inasistencia. Nunca lanza; la lectura corre bajo su SAVEPOINT. */
export async function citaSigueActiva(repo: CitasRepository, organizationId: string, appointmentId: string): Promise<boolean> {
  try {
    const cita = await repo.runWithRowSavepoint(() => repo.findAppointmentForOrganization(organizationId, appointmentId));
    return !cita || !ESTADOS_INACTIVOS.has(cita.status);
  } catch (err) {
    console.error("cita-activa: no se pudo revalidar la cita, el aviso sigue su curso:", err instanceof Error ? err.constructor.name : "error");
    return true;
  }
}

/** Id de la cita a la que se refieren los botones Confirmar/Cancelar/Reagendar de un recordatorio de WhatsApp, o null si el mensaje no los lleva. */
export function citaDeBotonesDelRecordatorio(payload: unknown): string | null {
  const botones = (payload as { buttons?: unknown } | null)?.buttons;
  if (!Array.isArray(botones)) return null;
  for (const b of botones) {
    const id = (b as { id?: unknown } | null)?.id;
    const parsed = typeof id === "string" ? parseAppointmentButtonId(id) : null;
    if (parsed) return parsed.appointmentId;
  }
  return null;
}

export interface ResultadoFiltroRecordatorios {
  readonly entregables: readonly MessagingOutboxRow[];
  /** Ids de las filas descartadas porque su cita ya no esta activa. */
  readonly descartados: readonly string[];
}

/** Separa los mensajes de WhatsApp reclamados en entregables y descartados (recordatorios de una cita que ya no esta activa). */
export async function filtrarRecordatoriosDeCitasInactivas(repo: CitasRepository, items: readonly MessagingOutboxRow[]): Promise<ResultadoFiltroRecordatorios> {
  const entregables: MessagingOutboxRow[] = [];
  const descartados: string[] = [];
  for (const item of items) {
    const citaId = citaDeBotonesDelRecordatorio(item.payload);
    if (citaId && item.organizationId && !(await citaSigueActiva(repo, item.organizationId, citaId))) {
      descartados.push(item.id);
      continue;
    }
    entregables.push(item);
  }
  return { entregables, descartados };
}
