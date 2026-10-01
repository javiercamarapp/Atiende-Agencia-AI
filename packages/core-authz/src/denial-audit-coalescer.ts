// DenialAuditCoalescer — pieza nueva de esta ronda (endurecimiento del
// registro de denegaciones de `requireAdminAccess`, ver comentario de
// cabecera de `admin-middleware.ts` para dónde se conecta).
//
// HALLAZGO REAL (revisión del PR #172, no-bloqueante): `requireAdminAccess`
// llamaba a `options.audit.record(entry)` en CADA request denegado, INCLUIDAS
// las respuestas 429 -- una vez que el rate-limiter de un actor+ruta ya se
// agotó, TODO intento siguiente sigue siendo `rate_limited` y sigue
// escribiendo una fila nueva. Contra un sink real
// (`apps/api/src/production/authz-audit-sink.ts::PersistentAuthzAuditSink`)
// eso es una transacción de sistema COMPLETA (`engine.withAppSession` ->
// BEGIN/set role/SAVEPOINT/count/INSERT/COMMIT) por cada request ya
// bloqueado -- amplificación de carga hacia la base exactamente
// proporcional al volumen de la ráfaga, sin aportar ninguna evidencia nueva
// (la bitácora ya sabe, desde la PRIMERA 429, que este actor+ruta está
// bloqueado).
//
// Arreglo: coalescer las 429 REPETIDAS del MISMO actor+ruta en una sola fila
// persistida por ventana, con el conteo de lo suprimido -- SIN tocar SQL
// (esto es independiente del tope defensivo de
// `core.record_authz_audit_denial`, que protege la CAPACIDAD de la tabla
// contra MUCHOS actores/rutas a la vez, no la amplificación de UN actor ya
// bloqueado insistiendo). Solo aplica a `reason === "rate_limited"` -- un 403
// (`insufficient_role`/`no_membership`) sigue auditándose SIEMPRE, sin
// coalescer: cada uno puede ser un actor/contexto distinto investigando algo
// distinto, y su volumen ya está acotado por el propio rate-limiter (agota
// el bucket y pasa a 429 antes de crecer sin límite).
export interface DenialAuditCoalesceDecision {
  /** `true` si esta denegación `rate_limited` para `key` debe persistirse
   *  ahora (primera vez en una ventana nueva). `false` si debe suprimirse
   *  (ya se persistió una reciente para la MISMA llave dentro de la
   *  ventana actual). */
  readonly persist: boolean;
  /** Cuántas denegaciones `rate_limited` de esta llave se suprimieron desde
   *  la última persistida (0 si `persist` es `true` y no había ventana
   *  previa) -- se adjunta a la fila que SÍ se persiste, para que quien
   *  investigue vea "esto se repitió N veces más". Solo llega a persistirse
   *  si una denegación NUEVA de la MISMA llave cierra la ventana: si el
   *  actor deja de insistir antes, el proceso se recicla, o la llave se
   *  desaloja por `maxKeys`, este conteo SÍ se pierde (ver el hueco conocido
   *  documentado en `InMemoryDenialAuditCoalescer`, abajo). */
  readonly suppressedSincePersist: number;
}

export interface DenialAuditCoalescer {
  shouldPersistRateLimited(key: string, nowMs: number): DenialAuditCoalesceDecision;
}

interface CoalesceWindow {
  windowStartMs: number;
  suppressed: number;
}

/**
 * Una ventana deslizante POR LLAVE (`actor+ruta`, reutiliza la misma llave
 * que el rate-limiter -- ver `admin-middleware.ts::rateLimitKey`): la
 * PRIMERA `rate_limited` de una llave dentro de una ventana se persiste
 * (`persist: true`); cualquier otra dentro de la MISMA ventana se suprime
 * (`persist: false`, solo incrementa el contador en memoria). Cuando por fin
 * llega una nueva denegación fuera de la ventana (o la primera vez que se ve
 * la llave), se abre una ventana nueva y se persiste con
 * `suppressedSincePersist` = lo acumulado en la ventana ANTERIOR.
 *
 * HUECO CONOCIDO (re-revisión, no bloqueante -- documentado con honestidad en
 * vez de la afirmación anterior de este comentario, que era falsa): el
 * conteo suprimido SÍ se puede perder para siempre, no solo "retrasar":
 *   - si el actor deja de insistir antes de que llegue una denegación nueva
 *     que cierre la ventana (no hay temporizador ni flush por expiración,
 *     solo se evalúa al ver la SIGUIENTE denegación de la MISMA llave);
 *   - si el proceso se recicla (serverless/redeploy) con la ventana abierta;
 *   - si la llave se desaloja por `maxKeys` (`evictOldest`, abajo) antes de
 *     que llegue esa siguiente denegación.
 * Efecto neto frente a la versión anterior de la bitácora (que persistía
 * TODAS las 429): una ráfaga que termina dentro de la ventana deja UNA fila
 * `rate_limited` sin contador de cuántas más hubo, en vez de una fila por
 * cada una. Mitigación recomendada y NO implementada esta ronda: volcar el
 * contador pendiente al expirar la ventana (p. ej. aprovechando cualquier
 * otra llamada a `shouldPersistRateLimited` para barrer ventanas vencidas de
 * otras llaves) -- requiere decidir a qué le esta ventana devuelta debe
 * escribirle una fila con qué `occurred_at`, fuera del alcance de esta
 * ronda.
 *
 * Puramente EN MEMORIA, por proceso -- mismo criterio que
 * `InMemoryRateLimiter` de este mismo paquete (rate-limiter.ts): es defensa
 * en profundidad de UN proceso de API, con techo de llaves simultáneas para
 * que un atacante con actorKeys/rutas sin fin no la haga crecer sin límite
 * -- ese mismo desalojo (`evictOldest`) también puede tirar el contador
 * pendiente de una llave ajena, sin test propio (ver huecos conocidos del PR).
 */
export class InMemoryDenialAuditCoalescer implements DenialAuditCoalescer {
  private readonly windows = new Map<string, CoalesceWindow>();
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(windowMs: number, maxKeys = 10_000) {
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  shouldPersistRateLimited(key: string, nowMs: number): DenialAuditCoalesceDecision {
    const existing = this.windows.get(key);
    if (!existing || nowMs - existing.windowStartMs >= this.windowMs) {
      const suppressedSincePersist = existing?.suppressed ?? 0;
      if (!existing && this.windows.size >= this.maxKeys) this.evictOldest();
      this.windows.set(key, { windowStartMs: nowMs, suppressed: 0 });
      return { persist: true, suppressedSincePersist };
    }
    existing.suppressed += 1;
    return { persist: false, suppressedSincePersist: existing.suppressed };
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, w] of this.windows) {
      if (w.windowStartMs < oldestAt) {
        oldestAt = w.windowStartMs;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.windows.delete(oldestKey);
  }
}
