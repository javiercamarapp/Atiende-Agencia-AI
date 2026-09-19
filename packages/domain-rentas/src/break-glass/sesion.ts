// Orquestador de la ventana de acceso -- mismo espíritu que acceso.ts, pero para
// abrir/listar/cerrar en vez de leer datos de tenant. Valida ANTES de tocar el
// repositorio (fail-closed, mismo criterio que validarRazonBreakGlass): sin
// motivo/duración válidos, ni siquiera se intenta abrir.
import { BreakGlassDurationInvalidError, BreakGlassOrganizationRequiredError, BreakGlassSessionNotFoundError } from "./errors.ts";
import { validarRazonBreakGlass } from "./acceso.ts";
import { BREAK_GLASS_MAX_DURATION_MINUTES, BREAK_GLASS_MIN_DURATION_MINUTES, esSesionBreakGlassActiva } from "./tipos.ts";
import type { BreakGlassSession, NewBreakGlassSessionInput, SuperadminActor } from "./tipos.ts";
import type { BreakGlassSessionRepository } from "./sesion-repository.ts";

/**
 * Valida la duración pedida (minutos, entero) de un acceso de romper-cristal.
 * Lanza `BreakGlassDurationInvalidError` si no es un entero, o cae fuera de
 * `[BREAK_GLASS_MIN_DURATION_MINUTES, BREAK_GLASS_MAX_DURATION_MINUTES]`.
 */
export function validarDuracionBreakGlass(durationMinutes: number): number {
  if (!Number.isInteger(durationMinutes) || durationMinutes < BREAK_GLASS_MIN_DURATION_MINUTES || durationMinutes > BREAK_GLASS_MAX_DURATION_MINUTES) {
    throw new BreakGlassDurationInvalidError(BREAK_GLASS_MIN_DURATION_MINUTES, BREAK_GLASS_MAX_DURATION_MINUTES);
  }
  return durationMinutes;
}

/**
 * Abre una ventana de acceso de emergencia nueva -- motivo y duración validados
 * ANTES de tocar el repositorio (fail-closed). `organizationId` vacío se rechaza
 * con el MISMO error que `leerDatosTenantBreakGlass` (nunca se abre una ventana
 * que no apunta a ningún tenant).
 */
export async function abrirAccesoBreakGlass(
  sessionRepo: BreakGlassSessionRepository,
  input: NewBreakGlassSessionInput,
): Promise<BreakGlassSession> {
  if (!input.organizationId) throw new BreakGlassOrganizationRequiredError();
  const reason = validarRazonBreakGlass(input.reason);
  const durationMinutes = validarDuracionBreakGlass(input.durationMinutes);

  return sessionRepo.open({ ...input, reason, durationMinutes });
}

/** Lista TODAS las ventanas (activas e históricas) del propio actor, más
 *  recientes primero -- el repositorio ya filtra por actor (nunca por otro
 *  superadmin), este orquestador solo delega. */
export async function listarAccesosBreakGlass(
  sessionRepo: BreakGlassSessionRepository,
  actor: SuperadminActor,
): Promise<readonly BreakGlassSession[]> {
  return sessionRepo.listForActor(actor.userId);
}

/**
 * Cierra manualmente una ventana propia y todavía abierta. Traduce cualquier
 * fallo del repositorio (sesión inexistente/ajena/ya cerrada -- cada adaptador
 * decide cómo señalarlo, ver InMemoryBreakGlassSessionRepository/
 * PostgresBreakGlassSessionRepository) a `BreakGlassSessionNotFoundError`, para
 * que `apps/api` tenga un único tipo que traducir a 404 sin importar el
 * adaptador.
 */
export async function cerrarAccesoBreakGlass(
  sessionRepo: BreakGlassSessionRepository,
  actor: SuperadminActor,
  sessionId: string,
): Promise<BreakGlassSession> {
  try {
    return await sessionRepo.close(actor.userId, sessionId);
  } catch {
    throw new BreakGlassSessionNotFoundError();
  }
}

/**
 * Busca, entre las ventanas del actor, una vigente (sin cerrar, sin vencer) para
 * `organizationId` -- el chequeo que `apps/api` corre ANTES de intentar una
 * lectura de tenant, para responder 403 con un mensaje claro en vez de delegar
 * el rechazo íntegro a la función SQL (que igual lo exige de nuevo,
 * defensa-en-profundidad -- ver rentas.list_reservas_for_break_glass).
 */
export async function obtenerAccesoActivoBreakGlass(
  sessionRepo: BreakGlassSessionRepository,
  actorUserId: string,
  organizationId: string,
  nowMs: number = Date.now(),
): Promise<BreakGlassSession | null> {
  const sesiones = await sessionRepo.listForActor(actorUserId);
  return sesiones.find((s) => s.organizationId === organizationId && esSesionBreakGlassActiva(s, nowMs)) ?? null;
}
