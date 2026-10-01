// Piso por hora para alertas salientes: maximo N envios por (tipo de alerta, destino) en una
// ventana deslizante de 1 hora. Evita que un cron que falla cada minuto convierta el buzon del
// superadmin (o un webhook/Sentry) en una tormenta de mensajes identicos.
//
// Reusa @atiende/core-ratelimit: con UPSTASH_REDIS_REST_URL/TOKEN el conteo es GLOBAL entre
// instancias serverless; SIN Redis es por proceso (cada instancia de Vercel cuenta aparte),
// asi que el piso real es "N por hora POR INSTANCIA" -- documentado, nunca presentado como
// global. Si Redis esta configurado pero falla, se degrada a memoria (fail-open): para una
// alerta es preferible un duplicado a perder el aviso.
import { createHash } from "node:crypto";
import { DistributedRateLimiter } from "@atiende/core-ratelimit";

export const VENTANA_ALERTAS_MS = 60 * 60 * 1000;
export const LIMITE_POR_HORA_POR_DEFECTO = 2;
export const LIMITE_POR_HORA_MAXIMO = 60;

export interface LimitadorAlertas {
  /** true si ESTE envio cabe en el piso de la hora para (tipo, destino). Consume cupo. */
  permitir(tipo: string, destino: string): Promise<boolean>;
}

/** Normaliza el limite configurado: entero entre 1 y LIMITE_POR_HORA_MAXIMO; cualquier valor
 *  invalido cae al default (nunca 0: un 0 silenciaria TODAS las alertas por un typo). */
export function normalizarLimitePorHora(valor: unknown): number {
  const n = typeof valor === "string" ? Number.parseInt(valor, 10) : typeof valor === "number" ? Math.trunc(valor) : Number.NaN;
  if (!Number.isFinite(n) || n < 1) return LIMITE_POR_HORA_POR_DEFECTO;
  return Math.min(n, LIMITE_POR_HORA_MAXIMO);
}

/** El destino (correo, URL de webhook) NUNCA va en claro a la llave de Redis: se hashea. */
export function llaveLimite(tipo: string, destino: string): string {
  const h = createHash("sha256").update(destino).digest("hex").slice(0, 16);
  return `alerta:${tipo.slice(0, 80)}:${h}`;
}

export function crearLimitadorAlertas(opts: { limitePorHora?: number; limiter?: Pick<DistributedRateLimiter, "check"> } = {}): LimitadorAlertas {
  const limite = normalizarLimitePorHora(opts.limitePorHora);
  const limiter = opts.limiter ?? new DistributedRateLimiter({ keyPrefix: "alertas:" });
  return {
    async permitir(tipo, destino) {
      try {
        const r = await limiter.check(llaveLimite(tipo, destino), limite, VENTANA_ALERTAS_MS, { failClosed: false });
        return r.allowed;
      } catch {
        // El limitador jamas debe tragarse una alerta por un fallo propio.
        return true;
      }
    },
  };
}
