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

  | Situación | Acción sensible | Cualquier otra ruta `/superadmin/*` |
  |---|---|---|
  | superadmin con factor activo | exige `x-stepup-token` válido (403 `stepup_required`) | responde normal |
  | sin factor, MFA **no** obligatoria | sin cambios | sin cambios |
  | sin factor (o solo pendiente), MFA obligatoria | 403 `mfa_enrollment_required` | 403 `mfa_enrollment_required`, salvo `GET /superadmin/mfa/estado`, `POST /superadmin/mfa/enrolar` y `POST /superadmin/mfa/verificar` |
  | migración 0025 sin aplicar o repo sin cablear, MFA no obligatoria | sin cambios (camino previo) | sin cambios |
  | migración 0025 sin aplicar o repo sin cablear, MFA obligatoria | 503 (falla cerrado) | 503 (falla cerrado) |

- **Cuándo es obligatoria** (`resolverMfaObligatoria`, `apps/api/src/env.ts`):
  `SUPERADMIN_MFA_REQUIRED=1`/`true` la activa y `0`/`false` la apaga en cualquier ambiente.
  **Sin la variable es obligatoria en producción** (`VERCEL_ENV=production`) y opcional en
  previews, desarrollo y pruebas.
- La compuerta de enrolamiento es `mfaEnrollmentGate` (`apps/api/src/superadmin-seguridad/step-up.ts`),
  montada en `routes/superadmin.ts` después de la zona CFO y antes del step-up. Enrolar no
  reemplaza un factor activo (la función SQL lo rechaza), así que las tres rutas exentas no
  sirven para cambiar el TOTP de quien ya enroló.
- La web (`SuperAdminShell`) consulta el estado y, mientras falte enrolar, manda a
  `/superadmin/seguridad` desde cualquier página.

### Enrolar sin quedarse fuera (procedimiento)

1. Antes del despliegue que la vuelve obligatoria: cada superadmin entra a
   `/superadmin/seguridad`, enrola su autenticador y lo activa con el primer código. Comprobar
   en la base que todos los superadmins tengan factor `active` (conteo, sin PII).
2. Si un superadmin no alcanzó a enrolar: la compuerta le deja ver Seguridad, enrolar y
   activar; con eso queda dentro. No hace falta apagar nada.
3. Si alguien pierde el dispositivo: otro superadmin con factor activo hace
   `POST /superadmin/mfa/reset` (con su propio step-up) y la persona vuelve al paso 2.
4. **Escape de emergencia** (todos los superadmins sin acceso a su TOTP, o la llave de cifrado
   cambió): poner `SUPERADMIN_MFA_REQUIRED=0` en Vercel (Production) y redesplegar. Vuelve el
   camino anterior: sin factor no se exige nada; con factor activo, el step-up se sigue pidiendo
   en lo sensible. El factor ilegible lo restablece otro superadmin, o una persona con acceso a la
   base, de forma auditada. Al terminar, quitar la variable (o ponerla en `1`).

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
4. Recomendado: definir `SUPERADMIN_MFA_ENCRYPTION_KEY` (antes de enrolar, o re-enrolar
   después). Desde el PR de MFA obligatoria, producción la exige sin configurar nada
   (ver "Enrolar sin quedarse fuera").
