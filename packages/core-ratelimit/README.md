# @atiende/core-ratelimit

Rate limiting **distribuido** (Redis + Lua) para cualquier endpoint del monorepo, con
fail-open/fail-closed **explícito por endpoint** — no un default único para todo el sistema.

## Por qué existe: el problema que un `Map` por instancia no resuelve

En serverless (Vercel/Lambda), cada instancia concurrente de una función arranca con su
propio estado en memoria. Un límite implementado con un `Map` local no es "N intentos": es
"N × instancias que el llamador (o un atacante) consiga abrir en paralelo". Este paquete
resuelve eso con un contador **en Redis**, incrementado atómicamente vía un script Lua
(`EVAL`), para que el límite sea real sin importar cuántas instancias lo evalúen a la vez.

## De dónde viene el código (portado, no reinventado)

Todo el algoritmo central de este paquete es un port directo de
`~/likida.ai/src/lib/ratelimit.ts` (y su suite `ratelimit_redis.test.ts`), tal como estaban
el 11-sep-2026 (HEAD de ese repo en el commit `6a2cdec`, "fix(tests): barrido completo de
date-rot..."). Mapa de qué vino de dónde:

| Este paquete | Portado de (Likida) | Qué cambió |
|---|---|---|
| `src/redis-backend.ts` (`attemptRedisIncrement`, `SCRIPT_INCR_WITH_TTL`) | `intentarRedis`, `SCRIPT_INCR_CON_TTL` | Nombres en inglés; recibe `url`/`token`/`timeoutMs` por parámetro en vez de leer `process.env` directo — el algoritmo (EVAL, INCR + PEXPIRE solo en `n==1`, nunca lanza) es idéntico. |
| `src/memory-window.ts` (`InMemoryWindowStore`) | `buckets` / `limiteLocal` / `podar` | Clase con estado propio en vez de `Map` de módulo (así cada `DistributedRateLimiter` — o cada test — tiene su propio estado aislado). Mismo algoritmo de sliding window y mismo criterio de poda (por caducidad primero, luego por antigüedad — ver el comentario original sobre el bug que corrigió esa poda). |
| `src/rate-limiter.ts` (`DistributedRateLimiter.check`, `rateLimit()`) | `rateLimit()` | Misma decisión (Redis sano → conteo del servidor; sin credenciales → memoria; con credenciales pero avería → fail-open/closed). La fuente de la decisión fail-open/closed cambia: Likida usa una sola env var global (`RATELIMIT_REDIS_FALLA_CERRADO`) + opción por-llamada; aquí se generaliza a una **tabla por categoría de endpoint** (ver abajo) porque este monorepo sirve varios dominios de riesgo muy distinto, no ~4 endpoints de un solo producto. |
| `src/endpoint-policy.ts` (`ENDPOINT_POLICIES`, `resolvePolicy`) | *(nuevo — no existe equivalente en Likida)* | Generalización explícita de la env var única de Likida a una tabla, requerida por este monorepo multi-dominio. |

Lo que **no** se portó (fuera de alcance de "rate limiting distribuido"): `redisConfigurado`
(aviso de arranque), `avisarBackend`, `categoria` (derivación de categoría desde la llave
para logs), `clientIp`, `bodyExcede`. Son utilidades de app atadas al logger propio de
Likida (`@/lib/logger`) y a Next.js/`Request`; este paquete es agnóstico de framework y deja
la observabilidad al callback `onEvent` (ver más abajo) para no imponer una dependencia de
logging que este monorepo todavía no tiene un equivalente compartido.

## Cuándo usar este paquete vs. `packages/core-authz/src/rate-limiter.ts`

> **Nota sobre el estado real de este repo (11-sep-2026):** al escribir este paquete,
> `packages/core-authz/src/rate-limiter.ts` **no existe todavía** en `atiende-fusion` — se
> verificó con `git log --all` y `find` sobre el árbol completo, sin resultados. La consigna
> de esta tarea lo describía como ya integrado (portado de hoteles, in-memory, fail-closed
> para `/admin`); si esa integración llega en otro momento, la tabla de abajo sigue siendo
> la guía correcta para decidir cuál usar. No se fabricó ese archivo aquí — hacerlo habría
> sido inventar una pieza que esta tarea no pidió construir.

| | `core-authz/rate-limiter.ts` (si/cuando exista) | `core-ratelimit` (este paquete) |
|---|---|---|
| Backend | En memoria, por instancia | Redis (distribuido) + memoria como fallback |
| Alcance del límite | Por instancia — no es global entre instancias serverless | Global entre instancias mientras Redis esté sano |
| Fail mode ante avería del backend | Fail-**closed** fijo (su propio backend es local: si el proceso vive, el backend vive) | Fail-open **o** fail-closed, **por categoría de endpoint** (tabla explícita, ver abajo) |
| Caso de uso previsto | Guardrail simple y local para superficies internas de bajo volumen (`/admin`) donde un `Map` por instancia ya es suficiente y no vale la pena la dependencia de Redis | Cualquier endpoint público o de alto volumen donde el límite real debe sostenerse sin importar cuántas instancias lo sirvan |

**Regla práctica:** si el endpoint necesita que el límite sea el mismo sin importar qué
instancia serverless lo atienda, usa `core-ratelimit`. Si es una superficie interna donde
"por instancia" ya es aceptable y se prefiere cero dependencias externas, usa el limitador
in-memory. No son duplicados: resuelven el mismo problema general (limitar tasa) con
garantías distintas, para superficies distintas.

## Uso

```ts
import { rateLimit } from '@atiende/core-ratelimit';

// API simple: usa UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN del entorno.
const permitido = await rateLimit(`login:${ip}`, 10, 5 * 60_000, { category: 'auth:login' });
if (!permitido) return respond(429);
```

```ts
import { DistributedRateLimiter } from '@atiende/core-ratelimit';

// Para credenciales explícitas, prefijo propio, o inyección en tests.
const limiter = new DistributedRateLimiter({
  redisUrl: env.UPSTASH_REDIS_REST_URL,
  redisToken: env.UPSTASH_REDIS_REST_TOKEN,
  keyPrefix: 'atiende:rl:',
  onEvent: (e) => logger.warn('ratelimit', e), // nunca recibe la llave completa, solo category
});

const outcome = await limiter.check(`cfdi:timbrar:${tenantId}`, 30, 60_000, { category: 'mcp:cfdi' });
// outcome: { allowed: boolean, backend: 'redis' | 'memory', degraded: boolean }
```

`category` resuelve la política fail-open/closed de la tabla de abajo. `failClosed`
explícito por-llamada siempre gana sobre la tabla, para el caso excepcional que la
categoría no cubre.

## Tabla: qué endpoint falla ABIERTO vs. CERRADO si Redis no contesta

Ver `src/endpoint-policy.ts` (`ENDPOINT_POLICIES`) — es la fuente de verdad, cada fila trae
su razón documentada inline. Resumen:

| Categoría | Modo | Por qué |
|---|---|---|
| `auth:login` | **Cerrado** | Superficie no autenticada de fuerza bruta. |
| `auth:password-reset` | **Cerrado** | Abrir sin freno es spam de correo/SMS a terceros. |
| `auth:token-issue` | **Cerrado** | Emisión de tokens — es la puerta, no un endpoint conveniente. |
| `mcp:locks` | **Cerrado** | Controla cerraduras físicas reales. |
| `mcp:cfdi` | **Cerrado** | Timbra ante el PAC — costo monetario y riesgo de duplicados ante el SAT. |
| `billing:charge` | **Cerrado** | Dispara cargos/cobros — dinero real moviéndose. |
| `admin` | **Cerrado** | Superficie de operador con privilegios elevados. |
| `agent:gateway` | Abierto (acotado) | `agent-core/gateway` ya tiene `budget.ts` + `circuit-breaker.ts` como guardrail primario. |
| `mcp:pms` | Abierto (acotado) | Tenant autenticado; la capa de datos/locks sostiene la integridad real. |
| `mcp:channel-manager` | Abierto (acotado) | Tenant autenticado; el proveedor externo (OTA) trae su propio rate limit. |
| `mcp:scheduling` | Abierto (acotado) | Mismo criterio que `mcp:pms`. |
| `mcp:pos` | Abierto (acotado) | Mismo criterio que `mcp:pms`. |
| `conversation:inbound-webhook` | Abierto (acotado)¹ | Tenant/canal autenticado — pero ver la nota ¹. |
| *(sin categoría / categoría no listada)* | **Cerrado** | Default seguro — una categoría nueva se cataloga aquí, nunca se asume abierta. |

¹ **"Abierto" en esta tabla nunca significa "sin límite"** — degrada al backend en memoria
de la instancia, que sigue imponiendo el mismo tope. Para un webhook entrante en
particular, además, "negar" no debe significar "descartar en silencio": el handler real
debe responder con un código que provoque reintento (p. ej. 429), igual que la nota de
Likida sobre su propio webhook de WhatsApp.

Para añadir una categoría nueva: agrégala a `ENDPOINT_POLICIES` con su `reason`. No dejes
que un endpoint nuevo dependa del default — el default es la red de seguridad, no la
decisión.

## Qué garantizan los tests

- `tests/redis-backend-concurrency.spec.ts` — el límite se respeta bajo concurrencia
  **real** (`Promise.all` sin await intermedio, hasta con dos instancias de
  `DistributedRateLimiter` independientes compartiendo solo el Redis falso — el escenario
  que un `Map` por instancia no puede cerrar).
- `tests/fail-open-closed.spec.ts` — Redis configurado pero fallando (red caída, timeout,
  respuesta de error): categoría cerrada niega y nunca lanza; categoría abierta degrada a
  memoria SIN dejar el límite en cero; `failClosed` explícito por-llamada gana sobre la
  categoría; ninguna llave completa llega jamás al callback `onEvent`.
- `tests/memory-window.spec.ts` — el backend local es sliding window real, no ventana fija.
- `tests/endpoint-policy.spec.ts` — toda fila de la tabla trae razón documentada; categoría
  desconocida cae cerrada.
