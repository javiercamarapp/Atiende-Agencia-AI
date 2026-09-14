-- Fase 11 restaurantes — promociones/marketing: esquema + motor real de código de
-- descuento (ver domain-restaurantes/src/promotions.ts para el porqué completo de
-- este gap). Gap real verificado contra el original
-- (restaurantes/supabase/migrations/20251204004242_remix_migration_from_pg_dump.sql):
-- `public.promos` ahí es SOLO un banner de marketing informativo
-- (title/description/image_url/discount_text libre/is_active/display_order) sin
-- ninguna aplicación real a un pedido -- `public.orders` del origen no tiene
-- columna de descuento/promo_id, y `discount_text` ("2x1", "20% off") nunca se
-- calcula, solo se muestra (confirmado también en
-- supabase/functions/_shared/whatsapp-agent-core.ts del origen: el agente solo
-- MENCIONA la promo, nunca la aplica). El vertical fusionado no tenía NINGUNA
-- tabla ni endpoint de promociones antes de esta migración.
--
-- Esta migración va deliberadamente más allá del banner del origen: agrega el
-- motor real de código de descuento (porcentaje/fijo, vigencia por
-- fecha/hora/día de semana, límite de usos) que el gap auditado pedía — documentado
-- aquí explícitamente como diseño NUEVO, nunca presentado como port de una regla de
-- negocio verificada (el original no tiene ninguna regla de combinabilidad/límite de
-- usos que verificar). Requiere: 001_restaurantes_schema.sql ya aplicada (schema
-- restaurantes, core.organization).

create table restaurantes.promotions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- Siempre en mayúsculas (normalizado en la capa de aplicación, ver
  -- promotions.ts::normalizePromotionCode) -- único por organización, nunca global
  -- (dos restaurantes distintos pueden tener ambos un código "BIENVENIDA10").
  code text not null check (code ~ '^[A-Z0-9_-]{3,40}$'),
  name text not null,
  description text,
  type text not null check (type in ('percentage', 'fixed')),
  -- Porcentaje (1-100) si type='percentage', pesos (>0) si type='fixed'.
  value numeric(10, 2) not null check (value > 0),
  min_order_total numeric(10, 2) check (min_order_total is null or min_order_total >= 0),
  starts_at timestamptz,
  ends_at timestamptz,
  -- 0=domingo..6=sábado (mismo criterio que Date#getDay() de JS, ver
  -- promotions.ts::assertPromotionApplicable) -- null = todos los días.
  days_of_week smallint[] check (days_of_week is null or days_of_week <@ array[0,1,2,3,4,5,6]::smallint[]),
  start_time time,
  end_time time,
  -- Límite total de usos reales, organization-wide -- null = ilimitado.
  max_uses integer check (max_uses is null or max_uses > 0),
  times_used integer not null default 0 check (times_used >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at >= starts_at),
  check (type <> 'percentage' or value <= 100),
  unique (organization_id, code)
);
create index promotions_org_active_idx on restaurantes.promotions(organization_id, is_active);

alter table restaurantes.promotions enable row level security;

-- El checkout público/de sistema (create-order, ver apps/api/.../restaurantes/
-- public.ts, abierto vía TenancyEngine.withAppSession({userId:null}), sin
-- membership real) necesita poder RESOLVER un código por su texto exacto para
-- aplicarlo al total -- mismo criterio de lectura pública ya establecido para el
-- catálogo ("cualquiera puede ver productos", ver migrations/001). Solo expone
-- promociones ACTIVAS: una promoción desactivada nunca es resoluble por un
-- caller público (aunque sí lo sea para el staff, ver policy de abajo).
create policy "cualquiera puede ver promociones activas" on restaurantes.promotions for select
  using (is_active = true);

-- Staff ve TODAS las promociones de su organización (activas e inactivas -- el
-- panel de administración necesita poder listar/reactivar una desactivada).
create policy "staff ve promociones de su organización" on restaurantes.promotions for select
  using (exists (select 1 from core.membership m where m.organization_id = promotions.organization_id and m.user_id = auth.uid()));

-- Alta/edición/activación real -- mismo alcance MANAGER_ROLES (owner/admin/staff,
-- ver domain-restaurantes/src/roles.ts) que ya gestiona catálogo/sucursales.
create policy "staff gestiona promociones de su organización" on restaurantes.promotions for all
  using (exists (select 1 from core.membership m where m.organization_id = promotions.organization_id and m.user_id = auth.uid()))
  with check (exists (select 1 from core.membership m where m.organization_id = promotions.organization_id and m.user_id = auth.uid()));

grant select on restaurantes.promotions to anon, authenticated;
grant insert, update, delete on restaurantes.promotions to authenticated;
grant select, insert, update, delete on restaurantes.promotions to service_role;

-- Incremento atómico de `times_used`, llamado DESPUÉS de crear un pedido con
-- promoción aplicada (ver orders.ts::createOrder) -- mismo patrón SECURITY DEFINER
-- que `restaurantes.create_order_idempotent` (migrations/003): el UPDATE...WHERE
-- re-verifica `is_active`/`max_uses` en la propia base de datos en el momento
-- exacto del incremento, así dos pedidos casi-simultáneos con el mismo código
-- NUNCA rebasan `max_uses` -- la validación ya hecha en memoria (promotions.ts)
-- minutos/segundos antes nunca es la única defensa real contra esa carrera.
-- Devuelve null (nunca lanza) si la promoción ya no calificaba en ese instante
-- exacto -- el pedido YA se creó de todos modos, el caller lo trata best-effort.
create or replace function restaurantes.increment_promotion_uses(
  p_organization_id uuid,
  p_promotion_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = restaurantes
as $$
declare
  v_promotion restaurantes.promotions;
begin
  update restaurantes.promotions
  set times_used = times_used + 1, updated_at = now()
  where id = p_promotion_id
    and organization_id = p_organization_id
    and is_active = true
    and (max_uses is null or times_used < max_uses)
  returning * into v_promotion;

  if v_promotion.id is null then return null; end if;
  return to_jsonb(v_promotion);
end;
$$;

revoke all on function restaurantes.increment_promotion_uses(uuid, uuid) from public, anon;
grant execute on function restaurantes.increment_promotion_uses(uuid, uuid) to authenticated, service_role;
