# Superadmin: MFA con step-up, interruptores y gestión de organizaciones

Migración: `packages/db/migrations/0025_superadmin_mfa_switches_orgs.sql` (espejo
`supabase/migrations/20240101000204_0025_superadmin_mfa_switches_orgs.sql`).
Verificación contra Postgres real: `scripts/verify-superadmin-mfa-switches-orgs/`
(corre solo en el gate de CI, que descubre todo `scripts/verify-*/`).

## 1. MFA TOTP y step-up

- Autenticador estándar (RFC 6238: SHA-1, 6 dígitos, 30 s, tolerancia ±1 paso).
  Implementado solo con `node:crypto` (`packages/core-auth/src/totp.ts`).
- El secreto se guarda **cifrado** (AES-256-GCM, `aad` = id del usuario) en
  `core.superadmin_mfa_factor`. Llave: `SUPERADMIN_MFA_ENCRYPTION_KEY`, o derivada de
  `JWT_SECRET` si falta (rotar `JWT_SECRET` entonces obliga a re-enrolar; por eso se
  recomienda la llave dedicada).
- Estado que no se confía al cliente vive en SQL: 5 códigos incorrectos seguidos
  bloquean 15 min; un paso TOTP ya usado (o anterior) se rechaza (`replay`).
- Las funciones que reciben el resultado de comparar el código
  (`superadmin_mfa_get_factor`, `_begin_enrollment`, `_record_attempt`) son
  **solo-sistema** (`auth.uid() is null`): el backend las llama en sesión de sistema
  después de autenticar al usuario con su JWT. Así un cliente con RPC directo no puede
  declarar "código correcto" ni reiniciar su contador.
- `POST /superadmin/mfa/verificar` emite un **token de step-up** (JWT, 5 min) atado al
  usuario y al access token (claim `ath`): un refresh de sesión obliga a re-verificar.
  Se envía en el header `x-stepup-token`.
- Acciones sensibles (lista explícita en `apps/api/src/superadmin-seguridad/step-up.ts`,
  `SENSITIVE_ROUTES`): iniciar impersonación, abrir break-glass, confirmar una acción
  sugerida, cambiar topes de gasto (organización y plataforma), crear checkout de
  suscripción, resetear MFA de otro superadmin, cambiar un interruptor, confirmar una
  gestión de organización.
- Política:

  | Situación | Acción sensible |
  |---|---|
  | superadmin con factor activo | exige `x-stepup-token` válido (403 `stepup_required`) |
  | sin factor, `SUPERADMIN_MFA_REQUIRED` apagada (default) | sin cambios: nada que hoy funcione se rompe antes de enrolar |
  | sin factor, `SUPERADMIN_MFA_REQUIRED=1` | 403 `mfa_enrollment_required` |
  | migración 0025 sin aplicar o repo sin cablear, `REQUIRED` apagada | sin cambios (camino previo) |
  | migración 0025 sin aplicar o repo sin cablear, `REQUIRED=1` | 503 (falla cerrado; no degrada en silencio) |

- Recuperación: otro superadmin restablece el factor (`POST /superadmin/mfa/reset`,
  motivo ≥ 20 caracteres, exige su propio step-up, nunca el propio). No hay códigos de
  recuperación (ver "Huecos conocidos" del PR).

## 2. Interruptores (kill switches)

- Tabla `core.platform_switch` (ausencia de fila = no detenido). Alcances: `global`
  (`llm`, `crons`), `agente` (rol LLM, p. ej. `restaurantes:whatsapp_agent`) y `cron`
  (path exacto de `vercel.json`). El `CHECK` de la base acota el formato; el catálogo
  real vive en `apps/api/src/platform-switches.ts` y un test lo cruza contra los roles
  registrados en el gateway y contra `vercel.json`.
- Efecto: el gateway LLM (`GatewayKillSwitch`) consulta antes de residencia, red y
  presupuesto y lanza `KillSwitchEngagedError`; `withHeartbeat` no ejecuta un cron
  detenido (200 `skipped: kill_switch`, latido `ok` con nota visible). El rol
  `*_escalated` cae junto con su rol base.
- El guard cachea 10 s: un cambio puede tardar hasta 10 s en otras instancias
  serverless (la instancia que recibe el `PUT` lo aplica de inmediato). Es **fail-open**
  si no puede leer la base (conserva el último estado conocido y lo registra): es un
  control operativo de pausa; los topes de gasto siguen fail-closed por su camino.

## 3. Gestión de organizaciones

- `alta`, `suspender`, `reactivar`, `cambiar_plan` en **dos pasos** (solicitar → confirmar,
  vence a los 10 min), motivo ≥ 20 caracteres, una sola acción pendiente por
  organización, solo el solicitante confirma/cancela, el SQL re-valida el estado al
  confirmar, y `core.org_admin_action` es la bitácora inmutable.
- `suspender` cambia `core.organization.status` a `suspended`: el **staff** de esa
  organización recibe 403 `organization_suspended` en `requirePropertyMembership` y
  `requireOrganizationMembership`. **No** detiene los canales públicos de cara al
  cliente final (WhatsApp entrante, checkout público), **no** toca Stripe ni
  `core.organization_billing`.
- "Plan" aquí es el **plan de cuenta** (`trial` ↔ `active`), no el de cobro. Un catálogo
  de planes pagados (`core.plan`, precio por vertical) es decisión de producto pendiente.
- `alta` crea la organización en `trial`; no crea al owner ni envía invitación (se usa el
  flujo de invitaciones existente).

## Orden de despliegue

1. Mergear el PR (el código nuevo es compatible con la base sin migrar: las rutas nuevas
   responden 503 honesto / lista vacía y las acciones sensibles existentes siguen igual).
2. Aplicar `0025` a la base (`supabase db push`, lo corre una persona). Sin esto, MFA,
   interruptores y gestión de organizaciones muestran "no disponible aún".
3. Cada superadmin enrola su autenticador en `/superadmin/seguridad`.
4. Opcional, **solo cuando todos enrolaron**: definir `SUPERADMIN_MFA_ENCRYPTION_KEY`
   (antes de enrolar, o re-enrolar después) y `SUPERADMIN_MFA_REQUIRED=1` en Vercel.
