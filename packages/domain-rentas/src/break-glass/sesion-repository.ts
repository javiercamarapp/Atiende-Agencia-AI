// Puerto de la ventana de acceso -- mismo patrón dual de adaptador que
// ./audit-repository.ts: un puerto TS explícito, un adaptador en memoria (tests
// determinísticos) y un adaptador de Postgres real (sobre
// rentas.break_glass_session, ver ../../migrations/018_break_glass_wiring.sql).
import type { BreakGlassSession, NewBreakGlassSessionInput } from "./tipos.ts";

export interface BreakGlassSessionRepository {
  /** Abre una ventana nueva -- el llamador (sesion.ts::abrirAccesoBreakGlass) ya
   *  validó motivo/duración antes de llegar aquí; este método persiste tal cual.
   *  Debe lanzar si la organización no existe (mismo contrato que la función SQL). */
  open(input: NewBreakGlassSessionInput): Promise<BreakGlassSession>;
  /** Todas las ventanas (activas E históricas) del propio actor -- nunca de otro
   *  superadmin, ni siquiera para uno real (mismo criterio de "cada superadmin ve
   *  SU propio historial" que ya rige break_glass_access_log). */
  listForActor(actorUserId: string): Promise<readonly BreakGlassSession[]>;
  /** Cierra una ventana propia y aún abierta. Debe lanzar `BreakGlassSessionNotFoundError`
   *  (o dejar que el llamador lo traduzca) si `sessionId` no existe, es de otro
   *  actor, o ya está cerrada -- nunca cerrar en silencio "0 filas afectadas". */
  close(actorUserId: string, sessionId: string): Promise<BreakGlassSession>;
}

/**
 * Implementación en memoria -- para tests. No simula el CHECK de duración máxima
 * ni la existencia de la organización (eso es responsabilidad de `sesion.ts` en
 * esta capa; el adaptador de Postgres real además lo hace cumplir con el CHECK/la
 * validación de la función SQL, ver postgres-sesion-repository.ts).
 */
export class InMemoryBreakGlassSessionRepository implements BreakGlassSessionRepository {
  readonly sessions: BreakGlassSession[] = [];
  private nextSeq = 1;

  async open(input: NewBreakGlassSessionInput): Promise<BreakGlassSession> {
    const nowMs = Date.now();
    const session: BreakGlassSession = {
      id: `bgs-${this.nextSeq++}`,
      actorUserId: input.actor.userId,
      actorEmail: input.actor.email ?? null,
      organizationId: input.organizationId,
      reason: input.reason,
      openedAtMs: nowMs,
      expiresAtMs: nowMs + input.durationMinutes * 60_000,
      closedAtMs: null,
      closedBy: null,
    };
    this.sessions.push(session);
    return session;
  }

  async listForActor(actorUserId: string): Promise<readonly BreakGlassSession[]> {
    return this.sessions.filter((s) => s.actorUserId === actorUserId).sort((a, b) => b.openedAtMs - a.openedAtMs);
  }

  async close(actorUserId: string, sessionId: string): Promise<BreakGlassSession> {
    const idx = this.sessions.findIndex((s) => s.id === sessionId && s.actorUserId === actorUserId && s.closedAtMs === null);
    if (idx === -1) {
      throw new Error(`InMemoryBreakGlassSessionRepository.close: sesión ${sessionId} no encontrada, ajena, o ya cerrada`);
    }
    const closed: BreakGlassSession = { ...this.sessions[idx]!, closedAtMs: Date.now(), closedBy: actorUserId };
    this.sessions[idx] = closed;
    return closed;
  }
}
