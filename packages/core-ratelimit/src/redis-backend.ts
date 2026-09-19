// ─────────────────────────────────────────────────────────────────────────────
// attemptRedisIncrement — backend distribuido (Upstash Redis, REST + Lua).
// La pieza que hace que el límite sea real entre MÚLTIPLES instancias
// serverless: sin esto, cada instancia de Vercel/Lambda cuenta en su propio
// Map y el techo real de un endpoint es N × instancias abiertas, no N.
//
// Portado de: ~/proyecto-origen/src/lib/ratelimit.ts — `SCRIPT_INCR_CON_TTL` +
// `intentarRedis` (líneas 158-213 al momento de portar, 11-sep-2026, HEAD de
// proyecto-origen en ese commit: 6a2cdec "fix(tests): barrido completo de
// date-rot..."). Mismo script Lua, mismo criterio de timeout y de "nunca
// lanza", mismo formato de comando REST.
//
// ── POR QUÉ EVAL Y NO UN PIPELINE DE INCR + EXPIRE (razón portada) ──────────
// La documentación de Upstash es explícita: "pipeline execution is not
// atomic — other clients' commands can interleave". Un pipeline de dos
// comandos deja la misma ventana de carrera que este módulo existe para
// cerrar: dos instancias podrían leer el mismo INCR intermedio. Un script Lua
// vía EVAL SÍ es atómico — Redis lo ejecuta entero sin soltar el hilo.
//
// El script incrementa y, SOLO en el primer incremento (`n == 1`), pone el
// TTL. Sin el "solo la primera vez": cada request dentro de la ventana
// volvería a poner PEXPIRE, la ventana se alargaría con cada petición y una
// llave con tráfico continuo NUNCA caducaría — un bloqueo permanente
// disfrazado de límite de tasa.
//
// ── VENTANA FIJA, NO DESLIZANTE (diferencia real con InMemoryWindowStore) ──
// Cuenta por ventana fija (un contador que nace en el primer hit y caduca
// `windowMs` después): más barato —un solo EVAL, sin guardar cada
// timestamp— pero admite hasta 2× el límite pegado al borde de dos ventanas
// consecutivas. Aceptable a propósito, igual que en el original: esto
// protege contra abuso y ráfagas, no factura nada.
//
// ── POR QUÉ REST CRUDO Y NO EL SDK `@upstash/redis` ──────────────────────────
// Es la decisión que se está PORTANDO, no una preferencia nueva: el proyecto
// origen la tomó porque cuatro rutas y un HMAC no justifican una dependencia con su
// propio agente HTTP (mismo criterio que usó ahí para Stripe).
//
// Nota para quien lea esto junto a
// `packages/core-conversation/src/lock/redis-lock-store.ts`: ANTES de
// fix/conversation-lock-upstash ese paquete traía el SDK `@upstash/redis` (portado
// de un origen distinto, atiende.ai) y leía un par de variables con OTRO nombre
// (`UPSTASH_REDIS_URL`/`UPSTASH_REDIS_TOKEN`, sin `_REST_`) — dos clientes, dos
// convenciones de nombre, para el MISMO Redis de Upstash. Se unificó: ahora
// `RedisLockStore` también habla REST crudo por `fetch` con el MISMO patrón de
// este archivo (comando como array JSON, `AbortSignal.timeout`, nunca lanza) y
// lee las MISMAS `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` — un solo
// cliente Upstash, una sola credencial, en todo el monorepo.
//
// Lo que NO se portó de la fuente: `redisConfigurado`, `avisarBackend`,
// `categoria`, `clientIp`, `bodyExcede` y el aviso de arranque por instancia
// fría — son utilidades de app (logging con el logger propio del proyecto origen,
// medición de body por content-length) fuera del alcance de "rate limiting
// distribuido con Redis+Lua". La responsabilidad de logging/observabilidad
// de ESTE paquete vive en `rate-limiter.ts` vía el callback `onEvent`, para
// no imponerle a este paquete un logger concreto que el monorepo aún no
// tiene un equivalente de `@/lib/logger` compartido.
// ─────────────────────────────────────────────────────────────────────────────

export const SCRIPT_INCR_WITH_TTL = `
local n = redis.call("INCR", KEYS[1])
if n == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return n
`;

export interface AttemptRedisIncrementParams {
  url: string;
  token: string;
  /** Llave YA namespaced — este módulo no aplica prefijo, eso es responsabilidad
   *  del caller (`DistributedRateLimiter`). */
  key: string;
  windowMs: number;
  timeoutMs: number;
}

/**
 * Un intento contra Redis. `null` = no se pudo saber (red caída, timeout,
 * respuesta no-2xx, forma de respuesta inesperada) — NUNCA LANZA: el caller
 * decide qué hacer con un `null` (fail-open acotado vs. fail-closed, ver
 * `rate-limiter.ts` y `endpoint-policy.ts`). Este helper solo mide.
 *
 * Devuelve el CONTEO tras el INCR (no un booleano) para que el caller decida
 * `conteo <= limit` — mismo contrato que `intentarRedis` original, que
 * devolvía `json.result <= limit` directamente; aquí se deja la comparación
 * al caller porque el caller es quien conoce `limit`.
 */
export async function attemptRedisIncrement(
  params: AttemptRedisIncrementParams,
): Promise<number | null> {
  const { url, token, key, windowMs, timeoutMs } = params;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      // Comando crudo como array JSON — la forma que la REST API de Upstash
      // documenta para no reescribir cada verbo como un path distinto.
      body: JSON.stringify(['EVAL', SCRIPT_INCR_WITH_TTL, 1, key, windowMs]),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as { result?: number; error?: string };
    if (!res.ok || typeof json.result !== 'number') return null;
    return json.result;
  } catch {
    // Timeout (AbortError) o red caída: mismo tratamiento, es "no se pudo saber".
    return null;
  }
}
