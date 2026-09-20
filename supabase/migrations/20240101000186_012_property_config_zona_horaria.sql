-- FASE 3 (producto) — zona horaria por negocio, parte despachos (3 de 4; las otras
-- 3 partes cubren citas+rentas ya construido, hoteles y licitaciones -- ver el
-- comentario de cabecera de `packages/core-tenancy/src/fecha-negocio.ts::
-- resolverZonaHorariaNegocio`, el ÚNICO punto de esta decisión, ya construido).
--
-- Gap real verificado antes de escribir esta migración: `despachos` no tenía NINGUNA
-- columna de zona horaria (a diferencia de `citas.property_config.timezone`/
-- `rentas.property_config.zona_horaria`, ya conectados) — `vencimientos.ts`/
-- `cobranza.ts`/`cierre-mensual.ts` ya usan `hoyFechaNegocio()` (el helper
-- compartido de core-tenancy que corrigió el bug real de "día UTC del servidor" vs.
-- "día de calendario del negocio"), pero SIEMPRE con el default de plataforma
-- (`America/Mexico_City`) — ningún caller pasaba una zona real todavía porque
-- ninguna existía en el esquema.
--
-- Tabla NUEVA (`despachos.property_config`), no una columna en `despachos.
-- tenant_profile` (001_despachos_schema.sql, perfil fiscal por ORGANIZACIÓN: RFC/
-- razón social del despacho mismo) -- verificado con `grep -rn "requirePropertyMembership"
-- apps/api/src/routes/verticals/despachos`: TODAS las rutas de vencimientos/cobranza/
-- cierre-mensual son property-scoped (un despacho puede operar varios contribuyentes/
-- clientes, cada uno su propia property, ver `admin-client.ts::resolveActivePropertyId`
-- y su hallazgo de auditoría "un despacho solo puede operar UN contribuyente") — la
-- zona horaria relevante para "hoy" de un vencimiento/cuenta por cobrar es la del
-- CONTRIBUYENTE (property), no la del despacho que lo atiende. Mismo criterio EXACTO
-- que `citas.property_config` (001_citas_schema.sql): property_id primary key,
-- organization_id de respaldo para poder filtrar/auditar por organización sin JOIN.
--
-- `zona_horaria` NULLABLE, SIN default forzado en SQL (mandato explícito de esta
-- fase) — el default real de "sin configurar todavía" lo decide
-- `resolverZonaHorariaNegocio()` (cae a `ZONA_HORARIA_NEGOCIO_DEFAULT`), nunca esta
-- migración. Sin `check` de formato IANA: la validación de que sea un timezone IANA
-- real vive en la capa de aplicación (`apps/api/.../despachos/configuracion.ts`,
-- mismo criterio EXACTO que `citas/admin.ts::optionalTimeZone`) ANTES de escribir la
-- fila -- un `check` en SQL solo podría validar el FORMATO del string (regex), nunca
-- si el nombre existe de verdad en la base de datos IANA (eso solo lo sabe
-- `Intl.DateTimeFormat` en tiempo de ejecución).
--
-- RLS -- mismo patrón EXACTO que el resto de `despachos.*` (001_despachos_schema.sql):
-- autoridad SIEMPRE `core.has_property_access`, nunca aislamiento a mano. A
-- diferencia de `citas.property_config` (001_citas_schema.sql, policy "for all" sin
-- distinguir rol -- corregido después en migración 015 para acotar por sucursal, y
-- documentado en 016 como "sin GRANT de escritura, sin caso de uso real todavía"):
-- aquí la policy de escritura (insert/update) YA filtra `vertical_role = 'admin'`
-- (el único rol "owner" real de despachos, ver `roles.ts::ADMIN_ROLES`/
-- `PLATFORM_ROLE_BY_VERTICAL_ROLE`) desde el día uno -- mismo criterio que
-- `restaurantes.whatsapp_channel_config`/`known_zone`
-- (migrations/021_restaurantes_config_editable_y_search_path_fix.sql, leído primero
-- como plantilla): configuración de negocio (vs. catálogo/operación del día a día)
-- es más sensible y menos frecuente, reservada al techo real de la organización. La
-- capa TS (`assertVerticalRole(ADMIN_ROLES)` en `configuracion.ts`) es defensa en
-- profundidad / mejor mensaje de error -- RLS real es la autoridad, mismo principio
-- que el resto del repo.
create table despachos.property_config (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  zona_horaria text check (zona_horaria is null or zona_horaria <> ''),
  updated_at timestamptz not null default now()
);

alter table despachos.property_config enable row level security;

-- Lectura: cualquier staff con acceso a esa property (auditor/readonly incluidos --
-- es lectura de configuración ya persistida, mismo criterio que
-- `VER_VENCIMIENTOS_ROLES`/`VER_CIERRE_MENSUAL_ROLES` de `roles.ts`).
create policy "staff ve la configuracion de su property" on despachos.property_config for select
  using (core.has_property_access(auth.uid(), property_id));

-- Escritura: SOLO `admin` (el único "owner" real de despachos) -- ver comentario de
-- cabecera. `core.has_property_access` primero (nunca confiar el `with check` a
-- `core.membership` solo por organización, que dejaría escribir la config de UNA
-- property a un staff sin acceso a ELLA si su membership tuviera
-- `property_ids` acotado a otras sucursales -- mismo hallazgo que ya corrigió
-- `citas` migración 015 para `property_config`, aplicado aquí desde el día uno en
-- vez de repetir esa regresión).
create policy "admin gestiona la configuracion de su property" on despachos.property_config for insert
  with check (
    core.has_property_access(auth.uid(), property_id)
    and exists (select 1 from core.membership m where m.organization_id = property_config.organization_id and m.user_id = auth.uid() and m.vertical_role = 'admin')
  );
create policy "admin actualiza la configuracion de su property" on despachos.property_config for update
  using (
    core.has_property_access(auth.uid(), property_id)
    and exists (select 1 from core.membership m where m.organization_id = property_config.organization_id and m.user_id = auth.uid() and m.vertical_role = 'admin')
  )
  with check (
    core.has_property_access(auth.uid(), property_id)
    and exists (select 1 from core.membership m where m.organization_id = property_config.organization_id and m.user_id = auth.uid() and m.vertical_role = 'admin')
  );

revoke all on despachos.property_config from public, anon;
grant select, insert, update on despachos.property_config to authenticated;
grant select, insert, update, delete on despachos.property_config to service_role;
