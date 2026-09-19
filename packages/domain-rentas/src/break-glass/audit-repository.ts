// Puerto de la bitácora inmutable -- mismo patrón dual de adaptador que el resto de
// domain-rentas (ver ../repository.ts): un puerto TS explícito, un adaptador en
// memoria (tests determinísticos) y un adaptador de Postgres real (sobre las tablas de
// ../../migrations/012_break_glass_audit.sql).
//
// A diferencia de `ImpersonationAuditStore` (core-authz/impersonation/audit.ts), este
// puerto NO tiene `reserveToday`/dedupe: cada acceso de romper-cristal es un incidente
// propio que se registra siempre, nunca se colapsa con uno anterior del mismo día --
// ver cabecera de 012_break_glass_audit.sql para el porqué completo.
import type { BreakGlassAuditEntry, NewBreakGlassAuditEntry } from "./tipos.ts";

export interface BreakGlassAuditRepository {
  /** Persiste UNA fila de la bitácora y devuelve la fila completa, con lo que solo la
   *  base puede producir (`id`/`seq`/`hash`/`prevHash` -- ver el trigger de la
   *  migración). Debe lanzar si la escritura falla -- nunca devolver un valor
   *  "parcial" o silencioso; `leerDatosTenantBreakGlass` depende de que un `throw`
   *  aquí sea la única señal de fallo (ver BreakGlassAuditWriteFailedError). */
  record(entry: NewBreakGlassAuditEntry): Promise<BreakGlassAuditEntry>;
  /** Lista la bitácora del PROPIO actor, más reciente primero -- para la pantalla
   *  "/superadmin/break-glass" (sección "vista de la bitácora"). El adaptador de
   *  Postgres real no necesita ninguna función `security definer` nueva para esto:
   *  la policy de SELECT que `012_break_glass_audit.sql` ya otorgó
   *  (`actor_user_id = auth.uid()`) alcanza siempre que la sesión sea la del propio
   *  actor (mismo criterio que el resto de este puerto). */
  listForActor(actorUserId: string): Promise<readonly BreakGlassAuditEntry[]>;
}

/**
 * Implementación en memoria -- para tests y como referencia de la semántica exacta
 * que el adaptador real debe respetar (`seq` estrictamente creciente, cadena de hash
 * por organización). No es un mock de "siempre funciona": expone `fallarSiguiente()`
 * para que los tests de `leerDatosTenantBreakGlass` puedan ejercer el camino
 * fail-closed (escritura que falla -> ningún dato se entrega) sin depender de una base
 * real derribada a propósito.
 */
export class InMemoryBreakGlassAuditRepository implements BreakGlassAuditRepository {
  readonly entries: BreakGlassAuditEntry[] = [];
  private readonly chainHeadByOrg = new Map<string, string | null>();
  private nextSeq = 1;
  private forcedFailure: Error | null = null;

  /** La PRÓXIMA llamada a `record` lanza `error` en vez de escribir -- para probar el
   *  camino fail-closed. Se limpia sola tras dispararse una vez. */
  fallarSiguiente(error: Error): void {
    this.forcedFailure = error;
  }

  async record(entry: NewBreakGlassAuditEntry): Promise<BreakGlassAuditEntry> {
    if (this.forcedFailure) {
      const err = this.forcedFailure;
      this.forcedFailure = null;
      throw err;
    }

    const prevHash = this.chainHeadByOrg.get(entry.organizationId) ?? null;
    const seq = this.nextSeq++;
    // Mismo canonical string que el trigger SQL (rentas.break_glass_log_set_hash) --
    // no es una réplica criptográfica exacta (aquí no hay sha256 real, ver nota abajo),
    // solo necesita ser determinista y depender de `prevHash` para que los tests puedan
    // verificar que la cadena avanza y que alterar una fila "vieja" rompería la
    // siguiente -- la garantía CRIPTOGRÁFICA real vive en Postgres (el trigger), no
    // aquí (mismo criterio que InMemoryImpersonationAuditStore: "sirve como referencia
    // de la semántica, el adaptador real debe respetar el invariante").
    const hash = `${prevHash ?? "<genesis>"}:${seq}`;
    this.chainHeadByOrg.set(entry.organizationId, hash);

    const persisted: BreakGlassAuditEntry = {
      id: `bg-${seq}`,
      actorUserId: entry.actorUserId,
      actorEmail: entry.actorEmail,
      organizationId: entry.organizationId,
      reason: entry.reason,
      resourceType: entry.resourceType,
      resourceScope: entry.resourceScope,
      resultSummary: entry.resultSummary,
      occurredAtMs: entry.occurredAtMs,
      seq,
      prevHash,
      hash,
    };
    this.entries.push(persisted);
    return persisted;
  }

  async listForActor(actorUserId: string): Promise<readonly BreakGlassAuditEntry[]> {
    return this.entries.filter((e) => e.actorUserId === actorUserId).sort((a, b) => b.seq - a.seq);
  }
}
