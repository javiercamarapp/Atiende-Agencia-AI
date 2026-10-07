// Configuración leída de variables de entorno (mismo patrón que
// hoteles/apps/api/src/env.ts) — los paquetes de dominio/auth nunca leen
// `process.env` directamente, para quedar testeables sin variables globales.
export interface ApiEnv {
  readonly jwtSecret: string;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
  /** Secreto compartido de plataforma para las Server Tools de voz (header `x-atiende-tool-secret`): las de citas
   * (worker de `voice-core`, ya sin ElevenLabs) y, en restaurantes, solo el camino de compatibilidad y la emisión del token por llamada (docs/VOZ-PM.md). */
  readonly voiceToolSecret: string;
  /** Endurecimiento de voz (restaurantes): `true` = las herramientas de voz SOLO aceptan el token por
   * llamada; los secretos (global legado o por sucursal) quedan limitados a emitir ese token. Opcional:
   * ausente/false conserva el camino legado para no romper integraciones existentes. */
  readonly voiceRequireCallToken?: boolean;
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
  /** R-27: nombres de las plantillas HSM de WhatsApp que el operador declaro APROBADAS por Meta
   *  (`WHATSAPP_APPROVED_TEMPLATES`, lista separada por comas). Solo esas se envian como `type: "template"`;
   *  vacia/ausente = todo sale como texto libre (comportamiento anterior). OPCIONAL: ningun fixture la exige. */
  readonly whatsappApprovedTemplates?: readonly string[];
  /** L-05: `phone_number_id` de Meta del numero remitente de licitaciones (avisos y botones go/no-go). Sin esto el webhook de licitaciones acusa recibo sin procesar y el envio se omite. OPCIONAL: ningun fixture lo exige. */
  readonly licitacionesWhatsappPhoneNumberId?: string | null;
  /** H-01 -- llave AES-256-GCM (32 bytes en base64) de la boveda de identidad de hoteles
   *  (`HOTELES_IDENTITY_KEY`). `null` cuando no esta configurada: captura/revelacion de
   *  identidad responden 503 explicito, NUNCA se guarda un documento sin cifrar. */
  readonly hotelesIdentityKey: string | null;
  /** Version de la llave de arriba (`HOTELES_IDENTITY_KEY_VERSION`, default 1); se guarda
   *  en cada sobre para la rotacion futura. */
  readonly hotelesIdentityKeyVersion: number;
  /** Rn-29 -- llave AES-256-GCM (32 bytes en base64) del cifrado en reposo de las instrucciones de acceso al huesped de rentas
   *  (`RENTAS_ACCESS_KEY`). `null` cuando no esta configurada: leer/escribir instrucciones y la liberacion al huesped responden
   *  "no disponible: falta RENTAS_ACCESS_KEY" (503 / error de cron sin contenido), NUNCA un 500 ni texto plano. */
  readonly rentasAccessKey: string | null;
  /** Version de la llave de arriba (`RENTAS_ACCESS_KEY_VERSION`, default 1); se guarda en cada fila para la rotacion futura. */
  readonly rentasAccessKeyVersion: number;
  /** D-28 -- URL del CSV publico "Listado completo 69-B" del SAT para el cron mensual (`EFOS_69B_URL`). Vacia = valor oficial por defecto, marcado NO VERIFICADO en `HttpEfos69bSource`. OPCIONAL: ningun fixture la exige. */
  readonly efos69bUrl?: string;
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
  /**
   * "Sign in with Google" para staff (`routes/auth-google.ts`) -- REUTILIZA las
   * mismas credenciales de `googleOAuth` de arriba (un solo proyecto OAuth de
   * Google para toda la plataforma, mismo criterio ya documentado ahí), pero con
   * su PROPIA `redirectUri` (`/auth/google/callback`, distinta del callback de
   * Calendar en `/v1/citas/google-calendar/oauth-callback` -- ambas se registran
   * como URIs de redirección válidas del MISMO cliente OAuth en Google Cloud
   * Console, Google permite varias por cliente). Las 4 URLs de Google
   * (`authBaseUrl`/`tokenUrl`/`jwksUrl`/`issuer`) son configurables (no
   * constantes hardcodeadas en la ruta) por el mismo motivo que ya documenta
   * hoteles (`apps/api/src/lib/googleOAuth.ts` de ese repo): las pruebas de
   * integración las apuntan a un servidor OAuth FALSO local (ver
   * `tests/support/fakeGoogleOAuth.ts`), nunca a la red real.
   */
  readonly googleStaffAuth: { readonly authBaseUrl: string; readonly tokenUrl: string; readonly jwksUrl: string; readonly issuer: string };
  /**
   * Fase 6 §3 citas — credenciales de plataforma para el dispatcher real de
   * correo (Resend, ver domain-citas/src/email-dispatch.ts::sendEmailOutboxJob).
   * `apiKey: null` cuando no está configurada todavía (estado real de este
   * entorno de desarrollo) — fail-closed explícito: sin ella, cada job de correo
   * falla al enviarse (nunca finge éxito), mismo criterio honesto que
   * `googleOAuth` de arriba.
   */
  readonly resend: { readonly apiKey: string | null; readonly from: string };
  /** Hallazgo de auditoría (rubro 1/20, "puertos stub devuelven 500 tras
   * confirmar en base de datos"): `hotelesPaymentsPort` (cobro con tarjeta al
   * huésped de un folio) nunca tuvo un adaptador real -- solo
   * `InMemoryPaymentsPort` (doble de prueba). Distinto del riel de Stripe de
   * `packages/billing` (esa es la SUSCRIPCIÓN de Atiende a sus clientes, ver
   * el comentario de cabecera de `domain-hoteles/src/payments-port.ts`): este
   * es el cobro directo al huésped final vía PaymentIntents con un
   * `paymentMethodToken` opaco ya tokenizado del lado del cliente (nunca un
   * PAN crudo llega a este servidor). `secretKey: null` cuando no está
   * configurada todavía -- fail-closed explícito, mismo criterio que
   * `resend`/`googleOAuth` de arriba: sin ella, `hotelesPaymentsPort` sigue
   * siendo `notProductionReady` (503 honesto), nunca finge un cobro exitoso. */
  /** `webhookSecret` (`whsec_...`) es un secreto DISTINTO de `secretKey` --
   * Stripe lo emite por separado, uno por endpoint de webhook configurado en el
   * dashboard (Developers -> Webhooks), y NO se rota junto con `secretKey`.
   * Usado por `POST /billing/webhook` (`apps/api/src/routes/billing.ts`) vía
   * `@atiende/billing::verificarFirmaWebhookStripe` -- `null` = webhook sin
   * configurar en este entorno, la ruta responde 503 honesto (mismo criterio
   * que `secretKey` de arriba), NUNCA procesa un evento sin firma verificada. */
  readonly stripe: { readonly secretKey: string | null; readonly webhookSecret: string | null };
  /** Hallazgo de auditoría (invitación de staff sin canal de envío real) —
   * origen público real de la app (`apps/web`) para armar el enlace de
   * activación que va DENTRO del correo de invitación (`/aceptar-invitacion?
   * token=...`, ver apps/web/src/App.tsx). Default razonable de este entorno
   * de desarrollo (mismo dominio `.ai` que ya usa `resend.from` arriba) —
   * ninguna ruta lo requiere (`requireEnv`) porque el correo sigue siendo
   * best-effort: un `appBaseUrl` de desarrollo nunca debe tumbar la creación
   * real de la invitación (ver admin-staff.ts). */
  readonly appBaseUrl: string;
  /** Secreto de firma DISTINTO al de staff (`jwtSecret`) para el JWT del portal de
   * propietario de rentas (Fase 3) -- ver diseño Fase 3 rentas §1.2/§3: defensa en
   * profundidad barata, un token de propietario nunca verifica bajo el secreto de
   * staff ni viceversa. */
  readonly rentasOwnerJwtSecret: string;
  /** MFA obligatoria del superadmin: con `true`, las acciones sensibles exigen un
   *  step-up verificado AUNQUE el superadmin no haya enrolado todavia (en ese caso
   *  responden 403 `mfa_enrollment_required`) y fallan cerrado si la migracion de
   *  MFA no esta aplicada. Sin ella (default), el step-up solo se exige a quien ya
   *  tiene un factor activo -- ningun flujo actual se rompe antes de enrolar.
   *  OPCIONAL: los fixtures de tests no necesitan declararla. */
  readonly superadminMfaRequired?: boolean;
  /** `true` en el ambiente de PRODUCCION (`VERCEL_ENV=production`, o `NODE_ENV=production` si no hay `VERCEL_ENV`). Con el, el step-up
   *  de las acciones sensibles FALLA CERRADO (503) si falta el puerto de 2FA o su migracion, en vez de dejar pasar. OPCIONAL: ausente
   *  = desarrollo/pruebas (se conserva el comportamiento anterior: sin 2FA disponible no se exige nada). */
  readonly production?: boolean;
  /** Material de llave para cifrar el secreto TOTP en reposo (>= 16 caracteres).
   *  Sin ella se deriva de `jwtSecret` (HKDF con etiqueta propia) -- rotar
   *  JWT_SECRET entonces invalida los factores enrolados (hay que re-enrolar), por
   *  eso se recomienda una llave dedicada. OPCIONAL. */
  readonly mfaEncryptionKey?: string;
  readonly rentasOwnerAccessTokenTtlSeconds: number;
  readonly rentasOwnerRefreshTokenTtlSeconds: number;
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
  /**
   * Backend propio de voz de restaurantes (migración 025). DELIBERADAMENTE opcionales y `?`
   * (nunca `requireEnv`): sin `GEMINI_API_KEY` el adaptador de Gemini no emite sesiones y las
   * rutas de preview responden 503 "voz no configurada"; sin `VOICE_PREVIEW_TOKEN_SECRET` (mínimo
   * 16 caracteres) tampoco se firma el token efímero de preview. Nunca se inventa un valor.
   */
  readonly geminiApiKey?: string | null;
  readonly voicePreviewTokenSecret?: string | null;
  readonly llmProviders: {
    /** PROVEEDOR PRIMARIO Y UNICO POR DEFECTO: OpenRouter (`providers/openrouter.ts`). Basta la llave:
     * los modelos por rol salen de la tabla versionada de `production/llm-models.ts` (defaults
     * seguros) y `modelsJson` (variable LLM_MODELS_JSON) los sobreescribe sin redeploy de codigo.
     * `countryOfResidence` es `null` salvo que el operador confirme la ruta real (ver nota de
     * RESIDENCIA en el proveedor); `zdr` activa `provider.zdr` en todas las rutas (requiere habilitar
     * Zero Data Retention en la cuenta de OpenRouter). `sharedBreaker` es el Redis de Upstash para
     * compartir el circuit breaker entre instancias (null = breaker en memoria por instancia). */
    readonly openrouter: {
      readonly apiKey: string;
      readonly countryOfResidence: string | null;
      readonly modelsJson: string | null;
      readonly zdr: boolean;
      readonly sharedBreaker: { readonly url: string; readonly token: string } | null;
      /** Entorno de despliegue (`production`, `preview`, `development`...) que prefija las claves del
       * breaker compartido (`cb:<entorno>:<proveedor>`) para que preview/desarrollo no abran el breaker
       * de produccion cuando comparten el mismo Redis. Opcional: sin el, claves `cb:<proveedor>`. */
      readonly breakerEnv?: string;
    } | null;
    /** LEGADO: integracion directa con OpenAI (`providers/openai.ts`). Solo se usa si NO hay llave de
     * OpenRouter. El proveedor directo de Anthropic se retiro: los modelos Anthropic pasan por
     * OpenRouter (docs/LLM-GATEWAY.md). */
    readonly openai: { readonly apiKey: string; readonly model: string } | null;
  };
}

function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

/** Nombre de entorno apto para una clave de Redis (minusculas, [a-z0-9_-]); `development` si falta. */
export function breakerEnvName(raw: string | undefined): string {
  const clean = (raw ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return clean.length > 0 ? clean.slice(0, 32) : "development";
}

export function loadApiEnv(): ApiEnv {
  return {
    jwtSecret: requireEnv("JWT_SECRET"),
    production: (process.env.VERCEL_ENV || process.env.NODE_ENV) === "production",
    superadminMfaRequired: ["1", "true"].includes((process.env.SUPERADMIN_MFA_REQUIRED ?? "").toLowerCase()),
    mfaEncryptionKey: process.env.SUPERADMIN_MFA_ENCRYPTION_KEY || undefined,
    accessTokenTtlSeconds: Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 900),
    refreshTokenTtlSeconds: Number(process.env.REFRESH_TOKEN_TTL_SECONDS ?? 60 * 60 * 24 * 30),
    voiceToolSecret: requireEnv("VOICE_TOOL_SECRET"),
    voiceRequireCallToken: process.env.VOICE_REQUIRE_CALL_TOKEN === "true",
    whatsappVerifyToken: requireEnv("WHATSAPP_VERIFY_TOKEN"),
    whatsappAppSecret: requireEnv("WHATSAPP_APP_SECRET"),
    whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? null,
    whatsappApprovedTemplates: (process.env.WHATSAPP_APPROVED_TEMPLATES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    licitacionesWhatsappPhoneNumberId: process.env.LICITACIONES_WHATSAPP_PHONE_NUMBER_ID || null,
    hotelesIdentityKey: process.env.HOTELES_IDENTITY_KEY ?? null,
    hotelesIdentityKeyVersion: Number(process.env.HOTELES_IDENTITY_KEY_VERSION ?? 1),
    rentasAccessKey: process.env.RENTAS_ACCESS_KEY ?? null,
    rentasAccessKeyVersion: Number(process.env.RENTAS_ACCESS_KEY_VERSION ?? 1),
    efos69bUrl: process.env.EFOS_69B_URL || undefined,
    internalSecret: requireEnv("INTERNAL_SECRET"),
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean),
    googleOAuth:
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_OAUTH_REDIRECT_BASE_URL
        ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, redirectBaseUrl: process.env.GOOGLE_OAUTH_REDIRECT_BASE_URL }
        : null,
    googleStaffAuth: {
      authBaseUrl: process.env.GOOGLE_STAFF_AUTH_BASE_URL ?? "https://accounts.google.com",
      tokenUrl: process.env.GOOGLE_STAFF_TOKEN_URL ?? "https://oauth2.googleapis.com/token",
      jwksUrl: process.env.GOOGLE_STAFF_JWKS_URL ?? "https://www.googleapis.com/oauth2/v3/certs",
      issuer: process.env.GOOGLE_STAFF_ISSUER ?? "https://accounts.google.com",
    },
    resend: { apiKey: process.env.RESEND_API_KEY ?? null, from: process.env.RESEND_FROM_EMAIL ?? "atiende <notificaciones@atiende.ai>" },
    stripe: { secretKey: process.env.STRIPE_SECRET_KEY ?? null, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? null },
    appBaseUrl: (process.env.APP_BASE_URL ?? "https://app.atiende.ai").replace(/\/+$/, ""),
    rentasOwnerJwtSecret: requireEnv("RENTAS_OWNER_JWT_SECRET"),
    rentasOwnerAccessTokenTtlSeconds: Number(process.env.RENTAS_OWNER_ACCESS_TOKEN_TTL_SECONDS ?? 900),
    rentasOwnerRefreshTokenTtlSeconds: Number(process.env.RENTAS_OWNER_REFRESH_TOKEN_TTL_SECONDS ?? 60 * 60 * 24 * 30),
    geminiApiKey: process.env.GEMINI_API_KEY || null,
    voicePreviewTokenSecret: process.env.VOICE_PREVIEW_TOKEN_SECRET || null,
    llmProviders: {
      openrouter: process.env.OPENROUTER_API_KEY
        ? {
            apiKey: process.env.OPENROUTER_API_KEY,
            countryOfResidence: process.env.OPENROUTER_COUNTRY_OF_RESIDENCE ?? null,
            modelsJson: process.env.LLM_MODELS_JSON || null,
            zdr: ["1", "true"].includes((process.env.OPENROUTER_ZDR ?? "").toLowerCase()),
            sharedBreaker:
              process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
                ? { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN }
                : null,
            breakerEnv: breakerEnvName(process.env.VERCEL_ENV || process.env.NODE_ENV),
          }
        : null,
      openai:
        process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL
          ? { apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL }
          : null,
    },
  };
}
