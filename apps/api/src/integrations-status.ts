// Inventario ÚNICO y consultable de qué variables de entorno lee este backend, qué
// integración habilita cada una y si esa integración está configurada en el
// entorno actual. Fuente de verdad reutilizada por CUATRO consumidores (nunca la
// dupliques, actualiza SOLO aquí):
//
//   1. GET /superadmin/integraciones (routes/superadmin-integraciones.ts)
//   2. `npm run verify:env` (scripts/verify-env/verify-env.ts)
//   3. El test guard que impide que este inventario se desactualice
//      (apps/api/tests/env-inventory-guard.spec.ts) — recorre apps/ y packages/
//      buscando lecturas reales de `process.env`/`import.meta.env` y falla si
//      encuentra una variable que no está registrada en `KNOWN_ENV_VARS`.
//   4. docs/CREDENCIALES.md — mantenido a mano (es prosa para humanos), pero debe
//      coincidir con esta lista; si cambias algo aquí, actualiza también ese doc.
//
// REGLA DE ORO — nunca imprimas/registres/devuelvas un VALOR de estas variables.
// Todo lo que sale de este módulo son NOMBRES (de variable) y booleanos.
//
// Todas las funciones de aquí son PURAS: reciben un snapshot ya leído por el
// caller (nunca acceden a `process.env`/`import.meta.env` directamente) — así se
// pueden probar con fixtures arbitrarios, sin variables de entorno reales, y queda
// estructuralmente imposible que este archivo filtre un secreto por accidente (no
// tiene ningún camino de código que toque un valor real salvo para comparar con
// `undefined`/cadena vacía).

/** Snapshot de variables de entorno ya leído por el caller (p.ej. `process.env` en
 *  la ruta HTTP o en el script CLI) — un simple mapa nombre -> valor|undefined. */
export type EnvSnapshot = Readonly<Record<string, string | undefined>>;

export interface IntegrationDefinition {
  readonly id: string;
  readonly nombre: string;
  /** Qué funcionalidad real habilita esta integración (para mostrar en la UI/CLI). */
  readonly habilita: string;
  /** TODAS deben estar presentes (no vacías) para que `configurada` sea `true`. */
  readonly variables: readonly string[];
}

export interface IntegrationStatus {
  readonly id: string;
  readonly nombre: string;
  readonly configurada: boolean;
  /** Solo NOMBRES de las variables que faltan — nunca valores. */
  readonly faltantes: readonly string[];
  readonly habilita: string;
}

function isSet(env: EnvSnapshot, name: string): boolean {
  const value = env[name];
  return value !== undefined && value.trim() !== "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Catálogo de integraciones — un renglón por integración de docs/CREDENCIALES.md.
// Agrupa "secretos propios" (JWT/cron/etc., que Javier genera él mismo) igual que
// las credenciales de terceros: ambas son cosas que este backend LEE de env, la
// única diferencia es de dónde sale el valor (generado vs. copiado de un panel).
// ─────────────────────────────────────────────────────────────────────────────
export const INTEGRATIONS: readonly IntegrationDefinition[] = [
  // ---- secretos propios (obligatorios para arrancar la API, ver env.ts::requireEnv) ----
  {
    id: "auth-jwt-staff",
    nombre: "JWT de sesión de staff (secreto propio)",
    habilita: "Firma y verificación de access/refresh tokens de staff (routes/auth.ts). Sin esto, loadApiEnv() lanza y la API entera no arranca.",
    variables: ["JWT_SECRET"],
  },
  {
    id: "voice-tool-secret",
    nombre: "Server Tools de voz (secreto propio)",
    habilita:
      "Autentica llamadas ENTRANTES a las herramientas de voz (header x-atiende-tool-secret) de citas (el worker de `voice-core` ejecuta las herramientas contra /v1/citas/:orgSlug/voz/:herramienta) y de restaurantes (camino de compatibilidad y emisión del token por llamada). Hoteles NO lo usa: su secreto es por property (hoteles.voice_agent_config). Ninguna vertical requiere ya una API key de ElevenLabs (ver docs/CREDENCIALES.md). Sin esto, loadApiEnv() lanza y la API entera no arranca.",
    variables: ["VOICE_TOOL_SECRET"],
  },
  {
    id: "internal-cron-secret",
    nombre: "Rutas internas de scheduler (secreto propio)",
    habilita:
      "Autentica las ~17 rutas /internal/* que Vercel Cron invoca a diario (Authorization: Bearer $CRON_SECRET) o que se llaman a mano (header x-atiende-internal-secret). Sin esto, loadApiEnv() lanza y la API entera no arranca.",
    variables: ["INTERNAL_SECRET"],
  },
  {
    id: "rentas-owner-jwt",
    nombre: "JWT del portal de propietario de rentas (secreto propio)",
    habilita:
      "Firma/verificación de tokens del portal de propietario de rentas — secreto de firma DISTINTO al de staff a propósito (defensa en profundidad). Sin esto, loadApiEnv() lanza y la API entera no arranca.",
    variables: ["RENTAS_OWNER_JWT_SECRET"],
  },
  {
    id: "database",
    nombre: "Base de datos (Supabase Postgres)",
    habilita: "El motor Postgres completo (todas las rutas de negocio de las 6 verticales). Sin esto, buildProductionDeps() lanza al arrancar — no es un 503 por ruta, es el proceso entero.",
    variables: ["DATABASE_URL"],
  },

  // ---- WhatsApp / Meta ----
  {
    id: "whatsapp-meta",
    nombre: "WhatsApp / Meta",
    habilita:
      "Verificación del webhook ENTRANTE de WhatsApp (verify token + firma HMAC del app secret, citas/hoteles/restaurantes) y envío SALIENTE real vía Graph API (POST/GET /internal/whatsapp/dispatch). WHATSAPP_VERIFY_TOKEN/WHATSAPP_APP_SECRET son obligatorias para arrancar la API (requireEnv); WHATSAPP_ACCESS_TOKEN es opcional — sin ella, el dispatcher de salida queda sin configurar y esa ruta responde 503 explícito.",
    variables: ["WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_ACCESS_TOKEN"],
  },

  // ---- Licitaciones: WhatsApp (L-05) ----
  {
    id: "whatsapp-licitaciones",
    nombre: "WhatsApp de licitaciones",
    habilita:
      "Avisos de plazos y decisión go/no-go por botón de licitaciones (L-05): número remitente (`phone_number_id` de Meta) del webhook /v1/licitaciones/whatsapp/webhook y del envío por /internal/whatsapp/dispatch. Opcional: sin ella el webhook acusa recibo sin procesar y el envío de licitaciones se omite (sin error). Usa también WHATSAPP_VERIFY_TOKEN/WHATSAPP_APP_SECRET/WHATSAPP_ACCESS_TOKEN de arriba.",
    variables: ["LICITACIONES_WHATSAPP_PHONE_NUMBER_ID"],
  },

  // ---- Hoteles: bóveda de identidad (H-01) ----
  {
    id: "hoteles-boveda-identidad",
    nombre: "Hoteles — bóveda de identidad (llave de cifrado)",
    habilita:
      "Cifrado AES-256-GCM de los documentos de identidad de huéspedes de hoteles (routes/verticals/hoteles/identidad.ts). Opcional para arrancar: sin HOTELES_IDENTITY_KEY, capturar y revelar una identidad responde 503 explícito (nunca se guarda en claro) y la lista avisa llaveConfigurada:false. Perder la llave vuelve ilegibles las identidades ya capturadas.",
    variables: ["HOTELES_IDENTITY_KEY"],
  },

  // ---- Rentas: cifrado de las instrucciones de acceso al huésped (Rn-29) ----
  {
    id: "rentas-acceso-cifrado",
    nombre: "Rentas — cifrado del acceso al huésped (llave de cifrado)",
    habilita:
      "Cifrado AES-256-GCM en reposo de la dirección exacta, el código de acceso y las indicaciones de cada unidad (routes/verticals/rentas/acceso-huesped.ts, migración rentas 028). Opcional para arrancar: sin RENTAS_ACCESS_KEY, leer o guardar instrucciones responde 503 explícito 'no disponible: falta RENTAS_ACCESS_KEY' (nunca texto plano) y la liberación al huésped no entrega nada y queda como error del cron. Perder la llave vuelve ilegibles las instrucciones ya cifradas.",
    variables: ["RENTAS_ACCESS_KEY"],
  },

  // ---- Google ----
  {
    id: "google-staff-login",
    nombre: "Google OAuth — \"Iniciar sesión con Google\" de staff",
    habilita: "Login de staff vía Google (routes/auth-google.ts). Comparte credenciales con \"google-calendar-citas\" (un solo proyecto OAuth de Google para toda la plataforma).",
    variables: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT_BASE_URL"],
  },
  {
    id: "google-calendar-citas",
    nombre: "Google Calendar (citas)",
    habilita:
      "Sincronización real de citas con Google Calendar del proveedor (packages/domain-citas/src/google-calendar-factory.ts). Mismas 3 variables que \"google-staff-login\" arriba (mismo proyecto OAuth); sin ellas, el resolver de citas devuelve \"sin conectar\" de inmediato (nunca un error) y las rutas de conexión responden 503.",
    variables: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT_BASE_URL"],
  },

  // ---- Resend / correo ----
  {
    id: "resend-correo",
    nombre: "Resend (correo transaccional)",
    habilita:
      "Envío real de correo — drena el canal 'email' de messaging_outbox de citas/hoteles/restaurantes/despachos/licitaciones/rentas. Sin RESEND_API_KEY, ningún job se reclama (queda 'pending' intacto, cero intentos quemados, ver fix a2b); con la key configurada, cada job falla explícito si Resend lo rechaza (nunca se marca 'sent' sin que Resend lo haya aceptado de verdad).",
    variables: ["RESEND_API_KEY"],
  },

  // ---- Alertas salientes (PL-04) ----
  {
    id: "alertas-correo",
    nombre: "Alertas salientes por correo (Resend)",
    habilita:
      "Aviso por correo a los destinatarios de ALERTAS_EMAIL_DESTINATARIOS (lista separada por comas) cuando un cron falla o el resumen diario detecta una alerta critica de salud. Reusa RESEND_API_KEY. Piso por hora por tipo y destino (ALERTAS_LIMITE_POR_HORA, default 2) y datos sensibles redactados. Sin estas variables no se envia nada.",
    variables: ["RESEND_API_KEY", "ALERTAS_EMAIL_DESTINATARIOS"],
  },
  {
    id: "alertas-webhook",
    nombre: "Alertas salientes por webhook generico",
    habilita:
      "POST JSON a ALERTAS_WEBHOOK_URL (solo https, nunca hacia hosts privados), firmado con HMAC-SHA256 en X-Atiende-Signature si hay ALERTAS_WEBHOOK_SECRETO. Mismo piso por hora y redaccion que el canal de correo. Sin la URL no se envia nada.",
    variables: ["ALERTAS_WEBHOOK_URL"],
  },
  {
    id: "sentry",
    nombre: "Sentry (alertas, opcional)",
    habilita:
      "Evento a Sentry via su API HTTP de envelopes -- sin SDK ni dependencia nueva. Solo si SENTRY_DSN esta definido y es un DSN https valido; con piso por hora y datos sensibles redactados. Sin DSN queda apagado.",
    variables: ["SENTRY_DSN"],
  },

  // ---- Stripe ----
  {
    id: "stripe",
    nombre: "Stripe (suscripción SaaS de Atiende + cobro a huésped en hoteles)",
    habilita:
      "DOS productos de la MISMA cuenta de Stripe: (1) checkout/webhook de la suscripción SaaS de Atiende a sus organizaciones clientes (POST /billing/checkout, /billing/webhook) y (2) cobro con tarjeta al huésped de un folio de hoteles (PaymentIntents, hotelesPaymentsPort). STRIPE_SECRET_KEY habilita ambos; STRIPE_WEBHOOK_SECRET solo el webhook de (1).",
    variables: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
  },

  // ---- PACs de CFDI (hoteles) ----
  {
    id: "pac-finkok",
    nombre: "PAC de CFDI — Finkok",
    habilita:
      "Timbrado/cancelación/consulta real de CFDI 4.0 de hospedaje vía Finkok (uno de los 2 PAC de DualPacCfdiPort, ver apps/api/src/routes/verticals/hoteles/cfdi.ts). Los *_CSD_CERT_PATH/*_CSD_KEY_PATH son RUTAS de archivo (.cer/.key del Certificado de Sello Digital del SAT), no el contenido — el archivo debe existir en el filesystem del runtime.",
    variables: ["FINKOK_USERNAME", "FINKOK_PASSWORD", "FINKOK_CSD_CERT_PATH", "FINKOK_CSD_KEY_PATH", "FINKOK_CSD_PASSWORD", "FINKOK_WEBHOOK_SECRET"],
  },
  {
    id: "pac-sw-sapien",
    nombre: "PAC de CFDI — SW Sapien",
    habilita: "Mismo timbrado de CFDI de hospedaje que \"pac-finkok\", vía el segundo PAC (SW Sapien) de DualPacCfdiPort — basta con configurar UNO de los dos para timbrar de verdad.",
    variables: ["SW_API_TOKEN", "SW_CSD_CERT_PATH", "SW_CSD_KEY_PATH", "SW_CSD_PASSWORD", "SW_WEBHOOK_SECRET"],
  },

  // ---- Voz de restaurantes y hoteles (Gemini 3.8 Live; respaldo cascada OpenRouter) ----
  {
    id: "voz-gemini-live",
    nombre: "Voz de restaurantes y hoteles — Gemini 3.8 Live (preview del panel)",
    habilita:
      "Emisión de la sesión de preview de voz del panel (POST /v1/restaurantes/:propertyId/admin/voz/preview/sesion y POST /hoteles/:propertyId/voz/preview/sesion): GEMINI_API_KEY pide a Gemini un token efímero de un solo uso (la llave nunca sale del servidor) y VOICE_PREVIEW_TOKEN_SECRET (mínimo 16 caracteres, lo generas tú) firma el token propio ligado a organización+sucursal+sesión. Sin cualquiera de las dos, la ruta responde 503 \"voz no configurada\" (nunca un falso éxito); la configuración de voz y las conversaciones siguen disponibles. La escalera de voz de la plataforma (@atiende/voice-core) usa además OPENROUTER_API_KEY (la misma del texto, ver \"llm-openrouter\") para la cascada de respaldo STT -> LLM -> TTS cuando Gemini falla o no hay GEMINI_API_KEY; GET /hoteles/:propertyId/voz/estado muestra qué escalones tienen credencial.",
    variables: ["GEMINI_API_KEY", "VOICE_PREVIEW_TOKEN_SECRET"],
  },

  // ---- Proveedores LLM ----
  {
    id: "llm-openrouter",
    nombre: "Proveedor LLM — OpenRouter (primario y único por defecto)",
    habilita:
      "Entra a la escalera de LlmGateway (data-chat de las 6 verticales, turn handlers de WhatsApp, extractores, borradores y conciliación) con SOLO la llave: los modelos por rol salen de apps/api/src/production/llm-models.ts y LLM_MODELS_JSON (opcional, aparte) los sobreescribe sin redeploy de código. Ver docs/LLM-GATEWAY.md. Sin llave (y sin el proveedor legado de OpenAI), el Copiloto/data-chat responde en modo sin IA y los turn handlers quedan notProductionReady.",
    variables: ["OPENROUTER_API_KEY"],
  },
  {
    id: "llm-openai",
    nombre: "Proveedor LLM — OpenAI directo (LEGADO)",
    habilita: "Solo se usa si NO hay OPENROUTER_API_KEY: entra a la escalera con API key Y modelo configurados. El proveedor directo de Anthropic se retiró; los modelos Anthropic pasan por OpenRouter.",
    variables: ["OPENAI_API_KEY", "OPENAI_MODEL"],
  },

  // ---- Redis distribuido (Upstash) ----
  {
    id: "redis-ratelimit",
    nombre: "Rate limiting distribuido (Upstash Redis)",
    habilita:
      "Límites de tasa COMPARTIDOS entre instancias serverless (packages/core-ratelimit, sí está conectado — ver rateLimit() en varias rutas). Sin estas variables, cada instancia cuenta localmente en memoria (sigue protegiendo, pero no de forma global).",
    variables: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
  },
  {
    id: "redis-conversation-lock",
    nombre: "Lock distribuido de conversación de WhatsApp — citas (Upstash Redis)",
    habilita:
      "Candado distribuido para que 2 mensajes casi-simultáneos del mismo cliente del vertical de citas (packages/core-conversation::RedisLockStore, conectado en apps/api/src/production/deps.ts::citasConversationGuard vía createDefaultConversationGuard) NUNCA disparen 2 llamadas al LLM en paralelo entre instancias de Vercel Fluid Compute (costo doble, respuestas duplicadas). MISMAS variables que 'redis-ratelimit' — antes leía un par con nombre distinto (sin '_REST_') que nadie tenía configurado; unificado (fix/conversation-lock-upstash). Solo citas usa este lock: restaurantes/hoteles ya serializan su conversación con una lease atómica real en Postgres (claim_whatsapp_conversation), que protege entre instancias por sí sola sin necesitar Redis. Sin estas variables, citasConversationGuard degrada a un lock en memoria — sigue serializando DENTRO de una instancia, no entre instancias.",
    variables: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
  },

  // ---- Mensajería de partners de rentas (Airbnb/Vrbo/Booking.com) ----
  {
    id: "rentas-mensajeria-airbnb",
    nombre: "Mensajería de rentas — Airbnb",
    habilita:
      "Con la credencial presente, CanalMensajeriaPartnerPendiente.obtenerEstadoConexion() pasa de 'partner_pendiente' a 'sandbox' — PERO enviarMensajeAprobado() SIGUE lanzando siempre: no existe todavía ningún cliente HTTP real de la Messaging API de Airbnb en este monorepo. Configurar esta variable NO habilita el envío real todavía.",
    variables: ["AIRBNB_MESSAGING_API_TOKEN"],
  },
  {
    id: "rentas-mensajeria-vrbo",
    nombre: "Mensajería de rentas — Vrbo",
    habilita: "Mismo criterio y misma limitación que \"rentas-mensajeria-airbnb\" (canal Vrbo).",
    variables: ["VRBO_MESSAGING_API_TOKEN"],
  },
  {
    id: "rentas-mensajeria-booking",
    nombre: "Mensajería de rentas — Booking.com",
    habilita: "Mismo criterio y misma limitación que \"rentas-mensajeria-airbnb\" (canal Booking.com).",
    variables: ["BOOKING_MESSAGING_API_TOKEN"],
  },

  // ---- Licitaciones: agregador comercial de licitaciones (Fase 9, "API por pegar") ----
  {
    id: "licitaciones-aggregator",
    nombre: "Licitaciones — agregador comercial (API por pegar)",
    habilita:
      "Con AMBAS presentes, `connectors/aggregator.ts::createAggregatorConnector().discover()` deja de lanzar `SourceNotConfiguredError` (`source_run.state = 'not_configured'`) y empieza a paginar contra `${LICITACIONES_AGGREGATOR_BASE_URL}/tenders` con `Authorization: Bearer ${LICITACIONES_AGGREGATOR_API_KEY}`. Sin proveedor elegido todavía en este monorepo -- el contrato de entrada esperado (JSON paginado por cursor) está documentado en `AggregatorTenderItem`/`AggregatorPageResponse` (packages/domain-licitaciones/src/connectors/aggregator.ts); es la única vía realista a cobertura NACIONAL amplia de licitaciones (las fuentes OCDS estatales reales, `nl_ocds`/`cdmx_ocds`, cubren solo Nuevo León/CDMX -- ver README de la vertical).",
    variables: ["LICITACIONES_AGGREGATOR_API_KEY", "LICITACIONES_AGGREGATOR_BASE_URL"],
  },

  // ---- apps/web (Vite, build-time) ----
  {
    id: "web-supabase-realtime",
    nombre: "Supabase Realtime — panel de Agenda (citas)",
    habilita:
      "Actualización en vivo del panel de Agenda de citas (apps/web/src/verticals/citas/lib/realtime-client.ts). Sin ellas, el panel sigue funcionando con fetch manual (getRealtimeClient() devuelve null, no rompe nada). Nota: estas 2 variables las lee Vite en BUILD TIME del bundle de apps/web, no esta función de apps/api en cada request — el estado que se reporta aquí refleja el env del proyecto de Vercel al momento de este chequeo, que es el mismo que usará el próximo build.",
    variables: ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"],
  },
];

/**
 * Variables de entorno reales que este backend/frontend lee pero que NO son
 * "credenciales de una integración por pegar" — configuración operativa con
 * default razonable, o URLs de override solo usadas en tests. Registradas aquí
 * ÚNICAMENTE para que el test guard (apps/api/tests/env-inventory-guard.spec.ts)
 * las reconozca como "ya inventariadas" — no aparecen en `computeIntegrationsStatus`
 * porque no tiene sentido reportarlas como "faltante" (nunca bloquean nada).
 */
export const OPERATIONAL_ENV_VARS: readonly string[] = [
  "ACCESS_TOKEN_TTL_SECONDS",
  "REFRESH_TOKEN_TTL_SECONDS",
  "ALLOWED_ORIGINS",
  "APP_BASE_URL",
  // `http-security.ts::requestActor` -- opt-in explícito para confiar en un
  // header de IP de un proxy real (ej. Cloudflare) delante de Vercel. Sin
  // configurar en este despliegue a propósito (Vercel directo, sin proxy
  // confiable, ver docs/CREDENCIALES.md) -- nunca bloquea nada, solo cambia de
  // qué header se deriva el actor del rate-limit.
  "TRUSTED_PROXY_IP_HEADER",
  // `env.ts::breakerEnvName` -- entorno de despliegue que Vercel inyecta (`production`/`preview`/`development`);
  // prefija las claves del circuit breaker compartido (`cb:<entorno>:<modelo>`) para que preview no abra el
  // breaker de produccion. No es una credencial; sin el, cae a NODE_ENV y luego a `development`.
  "VERCEL_ENV",
  // `env.ts::voiceRequireCallToken` -- opt-in ("true") para que las tools de voz de restaurantes
  // exijan el token por llamada. Apagado por defecto; nunca bloquea el arranque.
  "VOICE_REQUIRE_CALL_TOKEN",
  // Sandbox público de marketing: opt-in literal true; sin organizaciones ni herramientas.
  "PUBLIC_DEMO_AGENTS_ENABLED",
  // R-27 -- plantillas HSM de WhatsApp declaradas aprobadas por Meta (lista separada por comas); vacia = todo
  // sale como texto libre. Opcional, nunca bloquea el arranque.
  "WHATSAPP_APPROVED_TEMPLATES",
  // MFA del superadmin (ver docs/CREDENCIALES.md): ambas son opcionales y nunca
  // bloquean el arranque.
  "SUPERADMIN_MFA_REQUIRED",
  "SUPERADMIN_MFA_ENCRYPTION_KEY",
  "RENTAS_OWNER_ACCESS_TOKEN_TTL_SECONDS",
  "RENTAS_OWNER_REFRESH_TOKEN_TTL_SECONDS",
  "RESEND_FROM_EMAIL",
  // PL-04 alertas salientes: opcionales, nunca bloquean el arranque (ver integraciones
  // "alertas-correo", "alertas-webhook" y "sentry" arriba).
  "ALERTAS_WEBHOOK_SECRETO",
  "ALERTAS_LIMITE_POR_HORA",
  // H-01 -- version de la llave de la boveda de identidad (default 1): metadato que se
  // escribe en cada sobre para la rotacion futura, nunca bloquea nada.
  "HOTELES_IDENTITY_KEY_VERSION",
  // Rn-29 -- version de la llave del cifrado del acceso de rentas (default 1): metadato por fila para la rotacion futura.
  "RENTAS_ACCESS_KEY_VERSION",
  // Rn-13 -- interruptor de la URL de exportación iCal por UUID (deprecada): "off" la apaga (410). Opcional, encendida por omisión, nunca bloquea el arranque.
  "RENTAS_ICAL_FEED_UUID_LEGACY",
  "OPENROUTER_COUNTRY_OF_RESIDENCE",
  // Gateway LLM: modelos por rol (JSON) y ZDR global; opcionales, ver docs/LLM-GATEWAY.md.
  "LLM_MODELS_JSON",
  "OPENROUTER_ZDR",
  // Overrides de test/desarrollo únicamente (apuntan a un servidor OAuth falso
  // local en tests/support/fakeGoogleOAuth.ts) — con default a las URLs reales
  // de Google si se dejan vacías, ver apps/api/src/env.ts.
  "GOOGLE_STAFF_AUTH_BASE_URL",
  "GOOGLE_STAFF_TOKEN_URL",
  "GOOGLE_STAFF_JWKS_URL",
  "GOOGLE_STAFF_ISSUER",
  // D-28 -- URL del CSV publico 69-B del SAT; opcional, con valor oficial por defecto (NO VERIFICADO), ver apps/api/src/env.ts.
  "EFOS_69B_URL",
  // apps/web (Vite) — tiene default de desarrollo razonable, nunca bloquea nada.
  "VITE_API_BASE_URL",
];

/** Unión de toda variable "conocida" por este inventario (integraciones +
 *  operativas) — usada por el test guard para decidir si una lectura de env
 *  encontrada en el código ya está documentada. */
export const KNOWN_ENV_VARS: ReadonlySet<string> = new Set([...INTEGRATIONS.flatMap((i) => i.variables), ...OPERATIONAL_ENV_VARS]);

/** Variables cuya ausencia hace que la API entera no arranque (`loadApiEnv()`/
 *  `buildProductionDeps()` lanzan) — usada por `verify:env` para decidir el código
 *  de salida. Lista corta y explícita a propósito (ver apps/api/src/env.ts::requireEnv
 *  y apps/api/src/production/deps.ts para la fuente real de cada una). */
export const STARTUP_REQUIRED_ENV_VARS: readonly string[] = ["JWT_SECRET", "VOICE_TOOL_SECRET", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET", "INTERNAL_SECRET", "RENTAS_OWNER_JWT_SECRET", "DATABASE_URL"];

/** Calcula el estado de cada integración a partir de un snapshot de env ya leído
 *  por el caller. Nunca lanza, nunca devuelve un valor — solo nombres y booleanos. */
export function computeIntegrationsStatus(env: EnvSnapshot): IntegrationStatus[] {
  return INTEGRATIONS.map((def) => {
    const faltantes = def.variables.filter((name) => !isSet(env, name));
    return { id: def.id, nombre: def.nombre, configurada: faltantes.length === 0, faltantes, habilita: def.habilita };
  });
}

/** Nombres (nunca valores) de las variables obligatorias para arrancar que faltan
 *  en `env`. Vacío = la API arranca sin problema (con respecto a env; sigue
 *  pudiendo fallar por otras razones, p.ej. DATABASE_URL apuntando a un host
 *  inalcanzable). */
export function missingStartupVars(env: EnvSnapshot): string[] {
  return STARTUP_REQUIRED_ENV_VARS.filter((name) => !isSet(env, name));
}
