-- Hallazgo de auditoría (severidad CRÍTICA, inventario "flujos de sistema
-- bloqueados en escritura" -- ver `scripts/verify-flujos-sistema/README.md`,
-- sección "Pendiente para un segundo PR", punto 1, el de mayor prioridad):
-- `restaurantes.whatsapp_channel_config` (`...000031_001_restaurantes_
-- schema.sql`) trae `alter table ... enable row level security` pero NUNCA
-- recibió ninguna policy NI ningún GRANT a `authenticated` desde la Fase 1 --
-- a diferencia de `hoteles.whatsapp_channel_config`, que sí los recibió en su
-- propia Fase 2 (`...000013_004_voz_whatsapp_fase2.sql`). RLS habilitado +
-- cero policies = deny-all para TODO rol no-superusuario, así que esto nunca
-- fue solo un bug de sesión de sistema: ni siquiera un staff autenticado real
-- de la organización dueña puede leer hoy la configuración de su propio canal
-- de WhatsApp.
--
-- Verificado leyendo la cadena de llamadas TypeScript real (nunca por
-- adivinanza) + contra Postgres real (`scripts/verify-flujos-sistema-2/`, ver
-- su README):
--   * `apps/api/src/routes/verticals/restaurantes/whatsapp.ts` (webhook
--     entrante de Meta Cloud API, `deps.engine.withAppSession({ userId: null
--     })`) -> `repo.resolveOrganizationByPhoneNumberId(phoneNumberId)`
--     (`packages/domain-restaurantes/src/postgres-repository.ts`) -> `select
--     organization_id from restaurantes.whatsapp_channel_config where
--     phone_number_id = $1;` -- bloqueado (RLS deny-all, sin policy).
--   * `packages/domain-restaurantes/src/order-notifications.ts` (encolar el
--     WhatsApp SALIENTE al cliente cuando cambia el estado de un pedido --
--     invocado tanto desde `admin-orders.ts`, staff autenticado, como desde
--     `public.ts`, checkout sin sesión de staff, sesión de sistema) ->
--     `repo.resolveActiveWhatsAppPhoneNumberId(organizationId)` -> `select
--     phone_number_id from restaurantes.whatsapp_channel_config where
--     organization_id = $1;` -- bloqueado, mismo motivo.
--
-- Impacto de producto: el canal de WhatsApp completo de restaurantes queda
-- inerte en silencio para CUALQUIER rol -- el webhook entrante responde 200
-- sin procesar nada ("número no configurado", Meta nunca reintenta) y ningún
-- pedido dispara notificación saliente por WhatsApp al cliente, sin que
-- exista ningún camino (ni siquiera manual, vía staff autenticado) para leer
-- o confirmar la configuración hoy.
--
-- Decisión de diseño: escape hatch `auth.uid() is null or <regla de
-- staff>` en una policy de SELECT nueva -- NUNCA función `security definer`.
-- Columnas de la tabla: `organization_id`, `phone_number_id`, `created_at`
-- (`...000031_001_restaurantes_schema.sql:187-191`) -- ningún secreto/token
-- (a diferencia de `hoteles.voice_agent_config`, que sí trae
-- `tool_webhook_secret` y por eso el PR anterior usó función `security
-- definer` ahí, nunca escape hatch). Mismo perfil de riesgo que
-- `hoteles.whatsapp_channel_config` (catálogo de enrutamiento sin
-- PII/credenciales, `property_id`/`organization_id`/`phone_number_id`/
-- `enabled`) y que `core.organization`/`core.property` -- se replica
-- exactamente el mismo modelo que ya usa `hoteles.whatsapp_channel_config`
-- (`...000013_004_voz_whatsapp_fase2.sql:308-309`, y su propio escape hatch
-- en `...000139_022_hoteles_sistema_voz_whatsapp_escritura.sql`): policy de
-- SELECT única, con `auth.uid() is null or <regla de staff>`. La regla de
-- staff usa `exists (select 1 from core.membership ...)` -- el mismo
-- patrón EXACTO que ya usan las demás policies de esta tabla/vertical
-- (`"staff gestiona categorías de su organización"`,
-- `...000031_001_restaurantes_schema.sql:229`) en vez de
-- `core.has_property_access` -- restaurantes particiona esta config por
-- ORGANIZACIÓN (`organization_id primary key`, sin `property_id` -- un solo
-- número de WhatsApp por organización, no por sucursal, a diferencia de
-- hoteles), nunca por property.
--
-- Alcance deliberado: solo SELECT. La tabla sigue sin ninguna policy de
-- insert/update/delete para `authenticated` (gestión de este catálogo --
-- conectar/rotar el número de WhatsApp de una organización -- sigue fuera de
-- fase, sin ruta HTTP que la exponga hoy; sin cambio de este commit).
--
-- Orden de despliegue: sin dependencia de código nuevo -- esta migración por
-- sí sola desbloquea `resolveOrganizationByPhoneNumberId`/
-- `resolveActiveWhatsAppPhoneNumberId`, ambos ya existentes desde antes de
-- este commit (`packages/domain-restaurantes/src/postgres-repository.ts`,
-- sin cambios de TypeScript en este commit). Segura de aplicar en cualquier
-- momento: antes de esta migración esas 2 lecturas ya fallaban en silencio
-- (0 filas por RLS deny-all), nunca lanzaban -- el estado resultante nunca es
-- peor que el bug ya documentado aquí.
drop policy if exists "staff ve la config de whatsapp de su organización" on restaurantes.whatsapp_channel_config;
create policy "staff ve la config de whatsapp de su organización" on restaurantes.whatsapp_channel_config for select
  using (
    auth.uid() is null
    or exists (
      select 1 from core.membership m
      where m.organization_id = whatsapp_channel_config.organization_id and m.user_id = auth.uid()
    )
  );

grant select on restaurantes.whatsapp_channel_config to authenticated;
