-- Onboarding P0: toda organizacion que nace en prueba ('trial') nace con fecha de fin de prueba (14 dias); al vencer NO se apaga:
-- solo se avisa. El pago la activa sola.
--
-- Problema: core.organization.trial_ends_at (0046) solo se fijaba con SQL de soporte (docs/PLANES-TOPES.md). Ni el alta del superadmin
-- (core.confirm_org_admin_action tipo 'alta', 0038) ni el registro autoservicio de rentas (rentas.register_tenant_onboarding) lo fijan, asi
-- que una cuenta nueva no tenia avisos de fin de prueba ni banner con dias restantes. Tampoco habia camino automatico de 'trial' a
-- 'active': el webhook de Stripe no tocaba core.organization.status (solo la accion manual 'cambiar_plan' del superadmin, 0038).
--
-- Que agrega (ninguna funcion de alta se reemplaza):
--   A) core.organization_trial_ends_at_default() + trigger BEFORE INSERT en core.organization: si la fila nace con status 'trial' y SIN
--      trial_ends_at, la fija en now() + 14 dias. Un INSERT con su propia fecha la conserva; una fila que nace con otro estado
--      (p.ej. 'active': las demos sembradas y core.ensure_demo_access_for_superadmin) no recibe fecha. Sin backfill.
--   B) core.organization_trial_ends_at_on_activate() + trigger BEFORE UPDATE OF status: cuando una organizacion PASA a 'active' (la accion
--      'cambiar_plan' del superadmin o el pago, punto D) su trial_ends_at se borra: una cuenta con plan no conserva una fecha de prueba
--      vieja que dispare avisos o el banner. Los demas UPDATE no se tocan (soporte puede extender, acortar o quitar la fecha como hoy).
--   C) Avisos: core.trial_notice_log acepta dias_antes = 0 ("la prueba ya termino") y core.trial_notice_claim (0046) se reemplaza para
--      (1) reclamar ese aviso una vez por organizacion y fecha de fin cuando trial_ends_at ya paso (hasta 30 dias atras; una fecha mas vieja
--      no dispara nada), y (2) EXCLUIR las organizaciones demo (restaurantes.demo_organization, citas.demo_organization). Vencer la prueba
--      NO cambia status: la organizacion sigue operando (regla de @atiende/db `sqlOrgOperable`); suspender sigue siendo decision humana.
--   D) core.organization_activate_on_payment(p_organization_id): la llama el webhook de Stripe (sesion de sistema) cuando registra un pago
--      o una suscripcion activa. Solo 'trial' -> 'active' (y trial_ends_at := null). 'suspended' NUNCA se reactiva por un pago (la
--      suspension es decision del superadmin con doble control, 0038); 'active' no cambia.
--
-- Justificacion de seguridad:
--   * A y B: funciones de trigger (returns trigger: no invocables por RPC), `set search_path = core, pg_temp`, sin SQL dinamico; solo
--     escriben trial_ends_at de la MISMA fila. No son security definer: corren con los permisos de quien inserta/actualiza, que ya debia
--     poder hacerlo (las funciones definer de 0038 y de rentas). `revoke all ... from public` por higiene.
--   * C: core.trial_notice_claim conserva firma, security definer, search_path fijo, el candado de solo-sistema (auth.uid() is null) y sus
--     GRANT de 0046 (create or replace no los cambia; se repiten igual). El SQL dinamico solo lee dos tablas de marca demo con nombre
--     constante (sin entrada del usuario), protegido con to_regclass para una base sin esas migraciones de vertical. El CHECK nuevo de
--     trial_notice_log solo agrega el valor 0. Sin tablas, policies ni GRANT nuevos sobre tablas.
--   * D: security definer con search_path fijo y revoke de public/anon; SOLO-SISTEMA (auth.uid() is null, si no 42501): un usuario
--     autenticado no puede activarse a si mismo; la autoridad real es la firma HMAC del webhook ya verificada por la API. Solo escribe
--     status/trial_ends_at de la organizacion indicada y solo desde 'trial'. GRANT EXECUTE a authenticated porque la sesion de sistema de
--     la API corre con ese rol sin claim (mismo patron que core.trial_notice_claim).

-- A) fecha de fin al nacer en prueba
create or replace function core.organization_trial_ends_at_default()
returns trigger
language plpgsql
set search_path = core, pg_temp
as $$
begin
  if new.status = 'trial' and new.trial_ends_at is null then
    new.trial_ends_at := now() + interval '14 days';
  end if;
  return new;
end;
$$;
revoke all on function core.organization_trial_ends_at_default() from public;

drop trigger if exists organization_trial_ends_at_default on core.organization;
create trigger organization_trial_ends_at_default
  before insert on core.organization
  for each row execute function core.organization_trial_ends_at_default();

-- B) al pasar a 'active' se borra la fecha de prueba
create or replace function core.organization_trial_ends_at_on_activate()
returns trigger
language plpgsql
set search_path = core, pg_temp
as $$
begin
  if new.status = 'active' and old.status is distinct from 'active' then
    new.trial_ends_at := null;
  end if;
  return new;
end;
$$;
revoke all on function core.organization_trial_ends_at_on_activate() from public;

drop trigger if exists organization_trial_ends_at_on_activate on core.organization;
create trigger organization_trial_ends_at_on_activate
  before update of status on core.organization
  for each row execute function core.organization_trial_ends_at_on_activate();

-- C) aviso "la prueba termino" (dias_antes = 0) y exclusion de demos
alter table core.trial_notice_log drop constraint if exists trial_notice_log_dias_antes_check;
alter table core.trial_notice_log add constraint trial_notice_log_dias_antes_check check (dias_antes in (7, 3, 1, 0));

create or replace function core.trial_notice_claim(p_now timestamptz default now())
returns table (organization_id uuid, organization_name text, vertical text, slug text, dias_antes integer, trial_ends_at timestamptz, es_reintento boolean)
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_demos uuid[] := '{}';
  v_ids uuid[];
begin
  if auth.uid() is not null then
    raise exception 'trial_notice_claim: solo sesion de sistema' using errcode = '42501';
  end if;
  -- Organizaciones demo: nunca reciben avisos de prueba. Las tablas de marca son de migraciones de vertical; sin ellas, sin exclusion.
  if to_regclass('restaurantes.demo_organization') is not null then
    execute 'select coalesce(array_agg(d.organization_id), ''{}''::uuid[]) from restaurantes.demo_organization d' into v_ids;
    v_demos := v_demos || v_ids;
  end if;
  if to_regclass('citas.demo_organization') is not null then
    execute 'select coalesce(array_agg(d.organization_id), ''{}''::uuid[]) from citas.demo_organization d' into v_ids;
    v_demos := v_demos || v_ids;
  end if;
  return query
    with nuevos as (
      insert into core.trial_notice_log as l (organization_id, dias_antes, trial_ends_at, claimed_at)
      select o.id, d.dias::smallint, o.trial_ends_at, p_now
      from core.organization o
      cross join (values (7), (3), (1)) d(dias)
      where o.status = 'trial'
        and o.trial_ends_at is not null
        and o.trial_ends_at > p_now
        and ((o.trial_ends_at at time zone o.timezone)::date - (p_now at time zone o.timezone)::date) = d.dias
        and not (o.id = any(v_demos))
      union all
      select o.id, 0::smallint, o.trial_ends_at, p_now
      from core.organization o
      where o.status = 'trial'
        and o.trial_ends_at is not null
        and o.trial_ends_at <= p_now
        and o.trial_ends_at > p_now - interval '30 days'
        and not (o.id = any(v_demos))
      on conflict do nothing
      returning l.organization_id, l.dias_antes, l.trial_ends_at
    ), reintentos as (
      update core.trial_notice_log l
      set intentos = l.intentos + 1, claimed_at = p_now
      from core.organization o
      where o.id = l.organization_id
        and o.status = 'trial'
        and l.trial_ends_at = o.trial_ends_at
        and (l.trial_ends_at > p_now or (l.dias_antes = 0 and l.trial_ends_at > p_now - interval '30 days'))
        and l.correo_estado in ('pendiente', 'error', 'no_configurado')
        and l.intentos < 3
        and l.claimed_at < p_now - interval '30 minutes'
        and not (l.organization_id = any(v_demos))
        and not exists (select 1 from nuevos n where n.organization_id = l.organization_id and n.dias_antes = l.dias_antes)
      returning l.organization_id, l.dias_antes, l.trial_ends_at
    ), todos as (
      select n.organization_id, n.dias_antes, n.trial_ends_at, false as es_reintento from nuevos n
      union all
      select r.organization_id, r.dias_antes, r.trial_ends_at, true from reintentos r
    )
    select t.organization_id, o.name, o.vertical, o.slug, t.dias_antes::integer, t.trial_ends_at, t.es_reintento
    from todos t join core.organization o on o.id = t.organization_id;
end;
$$;
revoke all on function core.trial_notice_claim(timestamptz) from public, anon;
grant execute on function core.trial_notice_claim(timestamptz) to authenticated;

-- D) el pago activa la organizacion en prueba
create or replace function core.organization_activate_on_payment(p_organization_id uuid)
returns text
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_status text;
begin
  if auth.uid() is not null then
    raise exception 'organization_activate_on_payment: solo sesion de sistema' using errcode = '42501';
  end if;
  select o.status into v_status from core.organization o where o.id = p_organization_id for update;
  if not found then
    return 'no_existe';
  end if;
  if v_status = 'trial' then
    update core.organization set status = 'active', trial_ends_at = null where id = p_organization_id;
    return 'activada';
  elsif v_status = 'active' then
    return 'ya_activa';
  end if;
  return 'suspendida';
end;
$$;
revoke all on function core.organization_activate_on_payment(uuid) from public, anon;
grant execute on function core.organization_activate_on_payment(uuid) to authenticated;
