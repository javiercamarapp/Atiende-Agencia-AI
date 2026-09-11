// Configuración leída de variables de entorno (mismo patrón que
// hoteles/apps/api/src/env.ts) — los paquetes de dominio/auth nunca leen
// `process.env` directamente, para quedar testeables sin variables globales.
export interface ApiEnv {
  readonly jwtSecret: string;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
  /** Secreto compartido para las Server Tools de ElevenLabs (header
   * `x-atiende-tool-secret`) — ver diseño Fase 1 §3. */
  readonly voiceToolSecret: string;
  readonly whatsappVerifyToken: string;
  readonly whatsappAppSecret: string;
  /** Secreto compartido para rutas internas invocadas por un scheduler externo
   * (header `x-atiende-internal-secret`, análogo a CRON_SECRET del origen) — ver
   * diseño Fase 1 citas §0.4/§5.3: el recordatorio 24h de citas es el primer
   * consumidor real. */
  readonly internalSecret: string;
  readonly allowedOrigins: readonly string[];
}

function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

export function loadApiEnv(): ApiEnv {
  return {
    jwtSecret: requireEnv("JWT_SECRET"),
    accessTokenTtlSeconds: Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 900),
    refreshTokenTtlSeconds: Number(process.env.REFRESH_TOKEN_TTL_SECONDS ?? 60 * 60 * 24 * 30),
    voiceToolSecret: requireEnv("VOICE_TOOL_SECRET"),
    whatsappVerifyToken: requireEnv("WHATSAPP_VERIFY_TOKEN"),
    whatsappAppSecret: requireEnv("WHATSAPP_APP_SECRET"),
    internalSecret: requireEnv("INTERNAL_SECRET"),
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean),
  };
}
