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
  /** Token de acceso real de la Meta App de plataforma para ENVIAR mensajes de
   *  WhatsApp vía Graph API (`Authorization: Bearer`, ver
   *  @atiende/whatsapp-gateway::MetaGraphWhatsAppClient) — a diferencia de
   *  `whatsappVerifyToken`/`whatsappAppSecret` (verificación del webhook
   *  ENTRANTE), esta es la pieza que faltaba para el envío SALIENTE real. `null`
   *  cuando no está configurada (mismo criterio honesto que `googleOAuth`): la
   *  ruta `POST /internal/whatsapp/dispatch` responde 503 explícito, nunca finge
   *  un envío sin ella. */
  readonly whatsappAccessToken: string | null;
  /** Secreto compartido para rutas internas invocadas por un scheduler externo
   * (header `x-atiende-internal-secret`, análogo a CRON_SECRET del origen) — ver
   * diseño Fase 1 citas §0.4/§5.3: el recordatorio 24h de citas es el primer
   * consumidor real. */
  readonly internalSecret: string;
  readonly allowedOrigins: readonly string[];
  /**
   * Fase 3 citas §4/§9 — credenciales OAuth de PLATAFORMA para Google Calendar
   * (un solo proyecto OAuth de Google, compartido por todos los proveedores; el
   * refresh_token que sí es por-proveedor vive en `provider_calendar_accounts`,
   * ver diseño §3/§4). `null` cuando no están configuradas todavía (estado real de
   * este entorno de desarrollo, ver diseño §9) — las rutas de conexión responden
   * 503 en vez de fallar al arrancar, mismo criterio que el origen
   * (`google-calendar-factory.ts`: "if (!clientId || !clientSecret) return null").
   */
  readonly googleOAuth: { readonly clientId: string; readonly clientSecret: string; readonly redirectBaseUrl: string } | null;
  /** Secreto de firma DISTINTO al de staff (`jwtSecret`) para el JWT del portal de
   * propietario de rentas (Fase 3) -- ver diseño Fase 3 rentas §1.2/§3: defensa en
   * profundidad barata, un token de propietario nunca verifica bajo el secreto de
   * staff ni viceversa. */
  readonly rentasOwnerJwtSecret: string;
  readonly rentasOwnerAccessTokenTtlSeconds: number;
  readonly rentasOwnerRefreshTokenTtlSeconds: number;
  /** Directorio local donde `PostgresLicitacionesRepository` lee/escribe expedientes
   * (ZIP de propuesta, documentos) -- ver packages/domain-licitaciones/src/storage.ts.
   * NO forma parte del gap de sesión-por-request (no es RLS, es una ruta de
   * filesystem de proceso), así que no viaja por request como el resto de config de
   * licitaciones -- se resuelve una sola vez al armar `AppDeps`, igual que
   * `DATABASE_URL`. Default razonable para desarrollo/serverless efímero; en
   * producción real debe apuntar a un volumen persistente o reemplazarse por un
   * adaptador de storage con blob storage real (fuera de alcance de este cambio). */
  readonly licitacionesStorageDir: string;
  /**
   * Credenciales de los proveedores LLM directos que `production/llm-gateway.ts`
   * usa para construir el `LlmGateway` real compartido por los turn handlers de
   * WhatsApp (restaurantes/hoteles/citas) y `LlmRequirementExtractor`
   * (licitaciones) -- ver ese archivo para el detalle completo del wiring.
   * DELIBERADAMENTE opcionales (nunca `requireEnv`): si un proveedor no tiene
   * TANTO su API key COMO su modelo configurados, ese proveedor simplemente no
   * entra a la escalera -- nunca se inventa un modelo por defecto (adivinar un
   * id de modelo sería fingir una integración que nadie confirmó). Si NINGÚN
   * proveedor queda configurado, `buildProductionLlmGateway` devuelve
   * `undefined` y `production/deps.ts` cae en el mismo `notProductionReady`
   * explícito de siempre -- fail-closed, nunca silencioso.
   */
  readonly llmProviders: {
    /** Integración directa con la API de Anthropic (`providers/anthropic.ts`). */
    readonly anthropic: { readonly apiKey: string; readonly model: string } | null;
    /** Integración directa con la API de OpenAI (`providers/openai.ts`). */
    readonly openai: { readonly apiKey: string; readonly model: string } | null;
    /** Vía el agregador OpenRouter (`providers/openrouter.ts`) -- `countryOfResidence`
     * es `null` salvo que el operador confirme la ruta real del modelo pineado (ver
     * nota de RESIDENCIA en ese archivo); un `null` dejaría a OpenRouter fuera de
     * cualquier escalera con el gate de residencia activo, que es el comportamiento
     * seguro por defecto. */
    readonly openrouter: { readonly apiKey: string; readonly model: string; readonly countryOfResidence: string | null } | null;
  };
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
    whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? null,
    internalSecret: requireEnv("INTERNAL_SECRET"),
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean),
    googleOAuth:
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_OAUTH_REDIRECT_BASE_URL
        ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, redirectBaseUrl: process.env.GOOGLE_OAUTH_REDIRECT_BASE_URL }
        : null,
    rentasOwnerJwtSecret: requireEnv("RENTAS_OWNER_JWT_SECRET"),
    rentasOwnerAccessTokenTtlSeconds: Number(process.env.RENTAS_OWNER_ACCESS_TOKEN_TTL_SECONDS ?? 900),
    rentasOwnerRefreshTokenTtlSeconds: Number(process.env.RENTAS_OWNER_REFRESH_TOKEN_TTL_SECONDS ?? 60 * 60 * 24 * 30),
    licitacionesStorageDir: requireEnv("LICITACIONES_STORAGE_DIR", "/tmp/atiende-licitaciones-storage"),
    llmProviders: {
      anthropic:
        process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_MODEL
          ? { apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL }
          : null,
      openai:
        process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL
          ? { apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL }
          : null,
      openrouter:
        process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_MODEL
          ? { apiKey: process.env.OPENROUTER_API_KEY, model: process.env.OPENROUTER_MODEL, countryOfResidence: process.env.OPENROUTER_COUNTRY_OF_RESIDENCE ?? null }
          : null,
    },
  };
}
