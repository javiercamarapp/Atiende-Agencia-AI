// Logger estructurado mínimo real — hallazgo de auditoría (observabilidad, rubro
// 13/14/16): `requestId()` (@atiende/core-auth) existía pero nunca se montaba en el
// pipeline real (ver `./app.ts`), y los logs estructurados que rondas anteriores ya
// agregaron (`console.error(JSON.stringify({...}))` en varias rutas) nunca incluían
// ese id — imposible correlacionar, en un agregador de logs real, todas las líneas
// que pertenecen a UN MISMO request HTTP.
//
// Esta pieza es deliberadamente pequeña: NO es un framework de logging (nada de
// niveles configurables, transports, sampling). Es un solo helper —
// `logEvent(c, level, evento, campos)` — que:
//   1. Lee `c.get("requestId")` del contexto de Hono (poblado por `requestId()`,
//      montado global en `app.ts`) y lo agrega SIEMPRE como campo `requestId`.
//   2. Emite una sola línea JSON por `console.error`/`console.warn`/`console.log`
//      según `level` — mismo transporte que ya usan todos los call sites que esto
//      reemplaza (Vercel/cualquier host serverless captura stdout/stderr como logs
//      estructurados sin más infraestructura que instalar).
// Reemplazar esto por un logger real (pino/winston + un sink externo) es una
// decisión de infraestructura legítima y futura, no un requisito para que la
// correlación por-request funcione hoy: un agregador de logs que ingiera stdout ya
// puede agrupar por el campo `requestId` de cada línea.
type LogLevel = "info" | "warn" | "error";

/** Duck-type deliberado, NO `Pick<Context, "get">` de Hono: `Context<Env>.get` es
 * un método GENÉRICO cuya firma exacta depende del `Env` con el que se tipó cada
 * `new Hono<...>()` (`CoreAuthHonoEnv` en algunas rutas, el `BlankEnv` por defecto
 * en las rutas internas/de sistema que no pasan por `authMiddleware`) — dos
 * instanciaciones de ese genérico NO son estructuralmente asignables entre sí
 * (`Get<BlankEnv>` no es `Get<{Variables: ...}>`), así que `Pick<Context, "get">`
 * rechaza la mitad de los call sites reales de este archivo. Lo único que
 * `logEvent` necesita de verdad es poder leer `c.get("requestId")` — cualquier
 * `Context` de Hono, tipado con cualquier Env, lo cumple en tiempo de ejecución. */
interface LoggableContext {
  get(key: "requestId"): unknown;
}

export function logEvent(c: LoggableContext, level: LogLevel, evento: string, campos: Record<string, unknown> = {}): void {
  const requestId = (c.get("requestId") as string | undefined) ?? null;
  const linea = JSON.stringify({ ts: new Date().toISOString(), level, evento, requestId, ...campos });
  if (level === "error") console.error(linea);
  else if (level === "warn") console.warn(linea);
  else console.log(linea);
}
