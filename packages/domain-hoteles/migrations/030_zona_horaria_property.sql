-- FASE 3 (producto) — ZONA HORARIA POR NEGOCIO, parte hoteles: hasta esta migración
-- `hoteles.*` no tenía NINGUNA columna de zona horaria por property -- night-audit
-- (night-audit/engine.ts::DEFAULT_PROPERTY_TIMEZONE), el motor de recomendaciones de
-- tarifa (revenue-recommendations-cron.ts) y no-show (reservas.ts) calculaban "hoy"
-- SIEMPRE con `America/Mexico_City`, aunque la property real esté en Cancún, Los
-- Cabos, Tijuana o Puerto Vallarta. `@atiende/core-tenancy::resolverZonaHorariaNegocio`
-- (fecha-negocio.ts) ya es el ÚNICO punto de esta decisión -- su propio comentario de
-- cabecera documentaba este gap explícito ("hoteles ... NO tienen ninguna columna de
-- zona horaria todavía"). Esta migración solo agrega el dato; NO rediseña ese helper.
--
-- Mismo patrón que `rentas.property_config` (packages/domain-rentas/migrations/
-- 001_rentas_schema.sql, leída primero como plantilla) -- única diferencia
-- deliberada: aquí `timezone` es NULLABLE y SIN default en SQL (a diferencia de
-- `rentas.property_config.zona_horaria`, `not null`) -- el default de plataforma
-- (`America/Mexico_City`) ya vive en `resolverZonaHorariaNegocio()`, duplicarlo aquí
-- como `default` de columna crearía DOS lugares que decidir el default y podría
-- divergir con el tiempo. `hoteles.*` no tenía ninguna tabla de config por property
-- todavía (a diferencia de rentas) -- esta migración la crea, con SOLO la columna que
-- esta fase necesita (nunca se inventan columnas futuras sin uso real).
--
-- REGLA DURA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: mergear este PR despliega el
-- código de inmediato (Vercel) pero esta migración NO se aplica sola a la base real
-- (ver docs/DEPLOY.md) -- todo el código nuevo que lee esta tabla captura
-- SQLSTATE 42703/42P01 (columna/tabla inexistente) vía `runWithSavepointFallback` +
-- `isMigrationPendingError` (@atiende/db, mismo patrón que
-- `findPricingRule`/`hoteles.pricing_rule` de 029_rate_recommendation_engine.sql) y
-- cae al default de plataforma -- nunca un 500.
--
-- Requiere: 001_hoteles_schema.sql (core.property, core.staff_user),
-- 018_admin_catalogo_alta.sql (hoteles.can_manage_catalog(), reutilizado tal cual --
-- configurar la zona horaria de una property es la MISMA decisión administrativa que
-- configurar su catálogo: owner/gm, nunca frontdesk/housekeeping/fnb/accountant).

create table hoteles.property_config (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- IANA opcional -- NULL (el caso normal hasta que owner/gm la configure) significa
  -- "usa el default de plataforma", resuelto SIEMPRE vía
  -- `resolverZonaHorariaNegocio()`, nunca leído crudo por ningún caller. La
  -- validación de CONTENIDO real (que sea un timezone IANA existente) vive en la capa
  -- de aplicación (mismo criterio que `rentas.property_config.zona_horaria` y
  -- `citas/admin.ts::optionalTimeZone`) -- distintos motores Postgres pueden traer
  -- catálogos tzdata ligeramente distintos, este CHECK solo descarta basura obvia.
  timezone text check (timezone is null or (length(timezone) > 0 and length(timezone) <= 100)),
  updated_by uuid references core.staff_user(id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Trigger -- deriva/congela `organization_id` desde `core.property` (nunca confía en
-- lo que el llamador mande en esa columna, mismo criterio defensivo que
-- `hoteles.revenue_backtest_run_guard()`/`hoteles.revenue_engine_gate_transition_
-- guard()` de 011_revenue_engine_gate.sql) y sella `updated_by`/`updated_at` en cada
-- escritura -- el GRANT de columna de abajo ya deja `organization_id`/`property_id`
-- fuera del alcance de un UPDATE directo, este trigger es la segunda capa (defensa en
-- profundidad, no la única).
-- ---------------------------------------------------------------------------
create or replace function hoteles.property_config_guard()
returns trigger
language plpgsql
security definer
set search_path = core, hoteles
as $$
declare
  v_org uuid;
begin
  if TG_OP = 'INSERT' then
    select organization_id into v_org from core.property where id = new.property_id;
    if v_org is null then
      raise exception 'property_invalida: la property % no existe', new.property_id using errcode = '23503';
    end if;
    new.organization_id := v_org;
  else
    -- UPDATE: organization_id es inmutable una vez creada la fila (misma property,
    -- mismo tenant siempre) -- ignora cualquier valor que el llamador mande.
    new.organization_id := old.organization_id;
    new.property_id := old.property_id;
    new.created_at := old.created_at;
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

create trigger property_config_guard_trg
  before insert or update on hoteles.property_config
  for each row execute function hoteles.property_config_guard();

-- ---------------------------------------------------------------------------
-- RLS -- misma autoridad que el resto de hoteles.*: nunca un `tenant_id`/`hotel_staff`
-- propio, siempre `core.membership` vía `core.has_property_access`/
-- `hoteles.can_manage_catalog()` (ya existente desde 018_admin_catalogo_alta.sql).
-- ---------------------------------------------------------------------------
alter table hoteles.property_config enable row level security;

-- SELECT: cualquier rol de staff con acceso a la property puede ver su zona horaria
-- configurada (transparencia, mismo criterio que `revenue_engine_gate`) -- además
-- `auth.uid() is null` (sesión de SISTEMA: cron de night-audit/revenue-recommendations
-- de barrido, ver `apps/worker/src/jobs/hoteles/night-audit.ts` y
-- `apps/api/src/routes/verticals/hoteles/revenue-recommendations-cron.ts`) -- mismo
-- hallazgo real que `verify-hoteles-motor-tarifas` documentó para
-- `rate_recommendation`: sin esto, un `INSERT ... ON CONFLICT ... RETURNING` bajo
-- sesión de sistema fallaría en silencio (Postgres exige que la fila exista para la
-- sesión vía la policy de SELECT para poder incluirla en RETURNING), y el barrido
-- necesita LEER esta tabla (join en `listActiveHotelProperties`) bajo esa misma sesión.
create policy "property_config: staff con acceso o sistema lee la zona horaria" on hoteles.property_config for select
  using (auth.uid() is null or core.has_property_access(auth.uid(), property_id));

-- INSERT/UPDATE: configurar la zona horaria de una property es una decisión
-- ADMINISTRATIVA -- mismo nivel que catálogo (owner/gm), reutiliza
-- `hoteles.can_manage_catalog()` tal cual, sin duplicar su lógica.
create policy "property_config: owner/gm configura la zona horaria" on hoteles.property_config for insert
  with check (hoteles.can_manage_catalog(property_id));
create policy "property_config: owner/gm actualiza la zona horaria" on hoteles.property_config for update
  using (hoteles.can_manage_catalog(property_id)) with check (hoteles.can_manage_catalog(property_id));

revoke all on hoteles.property_config from public, anon;
-- GRANT a nivel COLUMNA (REGLAS DEL REPO): el upsert real de la aplicación
-- (`insert ... on conflict (property_id) do update set timezone = excluded.timezone`,
-- ver `PostgresHotelesRepository.upsertPropertyTimezone`) solo necesita escribir
-- `timezone` en el camino de UPDATE -- `organization_id`/`property_id`/`created_at`
-- los fija el trigger de arriba, nunca un UPDATE directo del cliente.
grant select, insert on hoteles.property_config to authenticated;
grant update (timezone) on hoteles.property_config to authenticated;
grant select, insert, update, delete on hoteles.property_config to service_role;
