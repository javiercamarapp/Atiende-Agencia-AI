-- Superadmin SA-06: gestion de organizaciones -- doble control y contrato vigente.
--
-- 0025 ya entrega alta / suspender / reactivar / cambiar plan de cuenta con el patron
-- solicitar (motivo >= 20, vence a los 10 min) -> confirmar (un solo uso, solo el solicitante,
-- step-up en el API) y bitacora append-only (core.org_admin_action + core.superadmin_security_event).
-- Esta migracion completa SOLO lo que faltaba, usando el contrato por cliente de 0037 (SA-43):
--
--   A) Doble control para SUSPENDER una organizacion con contrato vigente: ademas del solicitante,
--      un SEGUNDO superadmin distinto debe aprobar antes de que el solicitante pueda confirmar.
--      Como una segunda persona necesita tiempo, esas solicitudes vencen a los 60 minutos (las
--      demas siguen en 10).
--   B) Cambio de plan de cuenta atado al contrato: una organizacion con contrato vigente no puede
--      pasar a cuenta de prueba (el contrato pactado exige cuenta activa; para bajarla primero se
--      enmienda o vence el contrato), y la solicitud/ejecucion registran el contrato y la VERSION
--      del contrato vigente (0037) para que quede constancia de bajo que condiciones se cambio.
--   C) La aprobacion queda en la bitacora de seguridad con el evento `org_action_approved`.
--   D) Defensa en profundidad de disponibilidad: solicitar marca como vencidas las solicitudes pendientes ya
--      caducadas de esa organizacion (con su evento). Antes, una solicitud caducada que su autor nunca
--      confirmaba ni cancelaba ocupaba el unico lugar de "pendiente" y bloqueaba la gestion de esa
--      organizacion para los demas superadmins.
--
-- Requiere: 0025 (core.org_admin_action, core.superadmin_security_event, core.superadmin_require_caller,
-- request/confirm_org_admin_action) y 0037 (core.customer_contract_version). La base que no tenga esta
-- migracion sigue funcionando como antes (el API cae a "no disponible" solo en la ruta nueva de aprobar).
--
-- Esta migracion NO borra datos, NO toca core.organization_billing ni Stripe, y NO cambia como
-- reactivar restaura el estado previo (sigue siendo la ultima suspension ejecutada).
--
-- Justificacion de seguridad (cada GRANT/policy/funcion trae su razon):
--   * Columnas nuevas de core.org_admin_action (requiere_doble_control, contrato_id, contrato_version,
--     aprobado_por, aprobado_en): la tabla conserva RLS habilitada SIN policy y REVOKE ALL a public,
--     anon y authenticated (0025); nadie escribe columnas directo, asi que NO hay GRANT a nivel
--     columna que otorgar. Nada se otorga a anon. Dos CHECK en la base: `aprobado_por` solo con
--     doble control y siempre distinto del solicitante (la regla de los cuatro ojos no depende de
--     TypeScript ni de la funcion).
--   * core.org_admin_action_guard (reemplazo): requiere_doble_control, contrato_id y contrato_version
--     pasan a inmutables junto con el resto; la aprobacion solo puede pasar de nula a un valor UNA vez
--     (no se reescribe) y un estado terminal sigue sin reabrirse.
--   * core.org_contrato_vigente: helper interno, security invoker con search_path fijo y REVOKE ALL a
--     public, anon y authenticated. Solo lo invocan, como DUEÑO, las funciones definer de abajo (que ya
--     validaron al superadmin); ningun rol de la aplicacion lee contratos por aqui.
--   * core.approve_org_admin_action: security definer, set search_path fijo, `revoke ... from public, anon`
--     y grant execute solo a `authenticated`. Exige core.superadmin_require_caller (auth.uid() =
--     p_caller_id y superadmin real, sin el rol `finanzas` de solo lectura), que el aprobador sea
--     DISTINTO del solicitante, accion pendiente, vigente y con doble control. La ruta del API ademas
--     exige step-up MFA.
--   * core.request_org_admin_action y core.confirm_org_admin_action (reemplazos, misma firma y mismos
--     GRANT que en 0025: solo authenticated, sin anon): confirmar re-evalua el contrato en el momento de
--     ejecutar (si la organizacion obtuvo un contrato vigente despues de la solicitud, exige una
--     solicitud nueva con doble control) y bloquea la ejecucion hasta que exista la aprobacion.

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Columnas y CHECK de la base
-- ═══════════════════════════════════════════════════════════════════════════
alter table core.org_admin_action
  add column requiere_doble_control boolean not null default false,
  add column contrato_id uuid,
  add column contrato_version integer,
  add column aprobado_por uuid references core.staff_user(id) on delete restrict,
  add column aprobado_en timestamptz;

alter table core.org_admin_action
  add constraint org_admin_action_aprobacion_chk check (
    (aprobado_por is null and aprobado_en is null)
    or (requiere_doble_control and aprobado_por is not null and aprobado_en is not null and aprobado_por <> creado_por)
  ),
  add constraint org_admin_action_contrato_chk check ((contrato_id is null) = (contrato_version is null));

-- La bitacora de seguridad acepta el evento nuevo.
alter table core.superadmin_security_event drop constraint superadmin_security_event_event_check;
alter table core.superadmin_security_event add constraint superadmin_security_event_event_check check (event in (
  'mfa_enroll_started', 'mfa_activated', 'mfa_verified', 'mfa_failed', 'mfa_locked', 'mfa_replay', 'mfa_reset',
  'switch_set',
  'org_action_requested', 'org_action_executed', 'org_action_cancelled', 'org_action_expired',
  'org_action_approved'
));

-- Inmutabilidad (reemplaza el guard de 0025): ademas de lo que ya no cambiaba, el doble control y el
-- contrato registrado no se reescriben, y la aprobacion se escribe una sola vez.
create or replace function core.org_admin_action_guard()
returns trigger language plpgsql set search_path = core, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'org_admin_action_append_only: DELETE no permitido' using errcode = '0A000';
  end if;
  if new.tipo <> old.tipo or new.organization_id is distinct from old.organization_id
     or new.payload <> old.payload or new.motivo <> old.motivo or new.creado_por <> old.creado_por
     or new.creado_en <> old.creado_en or new.vence_en <> old.vence_en
     or new.requiere_doble_control <> old.requiere_doble_control
     or new.contrato_id is distinct from old.contrato_id or new.contrato_version is distinct from old.contrato_version then
    raise exception 'org_admin_action_inmutable: solo cambian estado/aprobacion/confirmacion/resultado' using errcode = '0A000';
  end if;
  if old.estado <> 'pending' then
    raise exception 'org_admin_action_inmutable: un estado terminal no se modifica' using errcode = '0A000';
  end if;
  if (new.aprobado_por is distinct from old.aprobado_por or new.aprobado_en is distinct from old.aprobado_en) and old.aprobado_por is not null then
    raise exception 'org_admin_action_inmutable: la aprobacion no se reescribe' using errcode = '0A000';
  end if;
  return new;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Contrato vigente de una organizacion (insumo interno)
-- ═══════════════════════════════════════════════════════════════════════════
-- Un contrato esta vigente hoy (fecha de Mexico) si su primera version ya comenzo y su fin (el que dicta
-- la ULTIMA version) no paso. La version devuelta es la ultima ya en vigor (una enmienda con inicio
-- futuro todavia no cuenta). Cero filas = sin contrato vigente.
create or replace function core.org_contrato_vigente(p_organization_id uuid)
returns table (contract_id uuid, version integer)
language sql stable set search_path = core, pg_temp as $$
  select c.contract_id,
         (select max(v.version) from core.customer_contract_version v
           where v.contract_id = c.contract_id and v.vigente_desde <= (now() at time zone 'America/Mexico_City')::date)::integer
  from (
    select v.contract_id, min(v.vigente_desde) as desde, (array_agg(v.vigente_hasta order by v.version desc))[1] as hasta
    from core.customer_contract_version v
    where v.organization_id = p_organization_id
    group by v.contract_id
  ) c
  where c.desde <= (now() at time zone 'America/Mexico_City')::date
    and (c.hasta is null or c.hasta >= (now() at time zone 'America/Mexico_City')::date)
  order by c.desde desc
  limit 1;
$$;
revoke all on function core.org_contrato_vigente(uuid) from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- C) Solicitar (reemplazo de 0025): doble control y contrato
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.request_org_admin_action(p_caller_id uuid, p_tipo text, p_organization_id uuid, p_payload jsonb, p_motivo text)
returns core.org_admin_action language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_motivo text := btrim(coalesce(p_motivo, ''));
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_status text;
  v_row core.org_admin_action;
  v_contrato_id uuid;
  v_contrato_version integer;
  v_tiene_contrato boolean := false;
  v_doble boolean := false;
  v_vence interval := interval '10 minutes';
begin
  perform core.superadmin_require_caller(p_caller_id, 'request_org_admin_action');
  if char_length(v_motivo) < 20 then
    raise exception 'request_org_admin_action: motivo obligatorio (minimo 20 caracteres)' using errcode = '22023';
  end if;
  if p_tipo not in ('alta', 'suspender', 'reactivar', 'cambiar_plan') then
    raise exception 'request_org_admin_action: tipo invalido' using errcode = '22023';
  end if;

  if p_tipo = 'alta' then
    if p_organization_id is not null then
      raise exception 'request_org_admin_action: alta no recibe organization_id' using errcode = '22023';
    end if;
    if coalesce(v_payload->>'vertical', '') not in ('hoteles', 'restaurantes', 'rentas', 'licitaciones', 'citas', 'despachos')
       or char_length(btrim(coalesce(v_payload->>'name', ''))) not between 2 and 120
       or coalesce(v_payload->>'slug', '') !~ '^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$' then
      raise exception 'request_org_admin_action: alta requiere payload {vertical, name (2-120), slug valido}' using errcode = '22023';
    end if;
    if exists (select 1 from core.organization o where o.slug = v_payload->>'slug') then
      raise exception 'request_org_admin_action: el slug ya existe' using errcode = '23505';
    end if;
    v_payload := jsonb_build_object('vertical', v_payload->>'vertical', 'name', btrim(v_payload->>'name'), 'slug', v_payload->>'slug');
  else
    select o.status into v_status from core.organization o where o.id = p_organization_id;
    if not found then
      raise exception 'request_org_admin_action: la organizacion no existe' using errcode = 'P0002';
    end if;
    select c.contract_id, c.version into v_contrato_id, v_contrato_version from core.org_contrato_vigente(p_organization_id) c;
    v_tiene_contrato := found;
    if p_tipo = 'suspender' then
      if v_status = 'suspended' then
        raise exception 'request_org_admin_action: la organizacion ya esta suspendida' using errcode = '55006';
      end if;
      v_payload := '{}'::jsonb;
      -- Doble control: suspender con contrato vigente corta un servicio comprometido por contrato.
      if v_tiene_contrato then
        v_doble := true;
        v_vence := interval '60 minutes';
      end if;
    elsif p_tipo = 'reactivar' then
      if v_status <> 'suspended' then
        raise exception 'request_org_admin_action: la organizacion no esta suspendida' using errcode = '55006';
      end if;
      v_payload := '{}'::jsonb;
    else
      if coalesce(v_payload->>'plan', '') not in ('trial', 'active') then
        raise exception 'request_org_admin_action: cambiar_plan requiere payload {plan: trial|active}' using errcode = '22023';
      end if;
      if v_status = 'suspended' then
        raise exception 'request_org_admin_action: reactiva la organizacion antes de cambiar su plan' using errcode = '55006';
      end if;
      if v_status = v_payload->>'plan' then
        raise exception 'request_org_admin_action: la organizacion ya tiene ese plan' using errcode = '55006';
      end if;
      if v_payload->>'plan' = 'trial' and v_tiene_contrato then
        raise exception 'request_org_admin_action: una organizacion con contrato vigente no puede pasar a cuenta de prueba (enmienda o vence el contrato primero)' using errcode = '55006';
      end if;
      v_payload := jsonb_build_object('plan', v_payload->>'plan');
    end if;
  end if;

  -- Una solicitud pendiente que ya vencio no debe bloquear a la organizacion (el indice unico solo admite una
  -- pendiente): se marca vencida aqui, con su evento, en lugar de depender de que su autor la confirme o cancele.
  if p_organization_id is not null then
    for v_row in
      update core.org_admin_action a set estado = 'expired'
       where a.organization_id = p_organization_id and a.estado = 'pending' and a.vence_en <= now()
      returning a.*
    loop
      insert into core.superadmin_security_event (area, event, actor_user_id, organization_id, detail)
      values ('org', 'org_action_expired', p_caller_id, p_organization_id, jsonb_build_object('action_id', v_row.id, 'al_solicitar', true));
    end loop;
  end if;

  begin
    insert into core.org_admin_action (tipo, organization_id, payload, motivo, creado_por, vence_en, requiere_doble_control, contrato_id, contrato_version)
    values (p_tipo, p_organization_id, v_payload, v_motivo, p_caller_id, now() + v_vence, v_doble,
            case when v_tiene_contrato and p_tipo in ('suspender', 'cambiar_plan') then v_contrato_id end,
            case when v_tiene_contrato and p_tipo in ('suspender', 'cambiar_plan') then v_contrato_version end)
    returning * into v_row;
  exception when unique_violation then
    raise exception 'request_org_admin_action: ya hay una accion pendiente para esta organizacion' using errcode = '55006';
  end;
  insert into core.superadmin_security_event (area, event, actor_user_id, organization_id, detail)
  values ('org', 'org_action_requested', p_caller_id, p_organization_id,
          jsonb_build_object('action_id', v_row.id, 'tipo', p_tipo, 'motivo', v_motivo, 'doble_control', v_doble,
                             'contrato_id', v_row.contrato_id, 'contrato_version', v_row.contrato_version));
  return v_row;
end;
$$;
revoke all on function core.request_org_admin_action(uuid, text, uuid, jsonb, text) from public, anon;
grant execute on function core.request_org_admin_action(uuid, text, uuid, jsonb, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- D) Aprobar (nuevo): el segundo superadmin del doble control
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.approve_org_admin_action(p_caller_id uuid, p_action_id uuid)
returns core.org_admin_action language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v core.org_admin_action;
begin
  perform core.superadmin_require_caller(p_caller_id, 'approve_org_admin_action');
  select * into v from core.org_admin_action a where a.id = p_action_id for update;
  if not found then
    raise exception 'approve_org_admin_action: la accion no existe' using errcode = 'P0002';
  end if;
  if not v.requiere_doble_control then
    raise exception 'approve_org_admin_action: esta accion no requiere doble control' using errcode = '55006';
  end if;
  if v.creado_por = p_caller_id then
    raise exception 'approve_org_admin_action: el doble control exige a un segundo superadmin distinto de quien solicito la accion' using errcode = '42501';
  end if;
  if v.estado <> 'pending' then
    raise exception 'approve_org_admin_action: la accion ya no esta pendiente (estado %)', v.estado using errcode = '55006';
  end if;
  if v.vence_en <= now() then
    raise exception 'approve_org_admin_action: la accion ya vencio' using errcode = '55006';
  end if;
  if v.aprobado_por is not null then
    raise exception 'approve_org_admin_action: la accion ya fue aprobada' using errcode = '55006';
  end if;
  update core.org_admin_action set aprobado_por = p_caller_id, aprobado_en = now() where id = v.id returning * into v;
  insert into core.superadmin_security_event (area, event, actor_user_id, organization_id, detail)
  values ('org', 'org_action_approved', p_caller_id, v.organization_id,
          jsonb_build_object('action_id', v.id, 'tipo', v.tipo, 'solicitado_por', v.creado_por));
  return v;
end;
$$;
revoke all on function core.approve_org_admin_action(uuid, uuid) from public, anon;
grant execute on function core.approve_org_admin_action(uuid, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- E) Confirmar (reemplazo de 0025): exige la aprobacion y re-evalua el contrato
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.confirm_org_admin_action(p_caller_id uuid, p_action_id uuid)
returns core.org_admin_action language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v core.org_admin_action;
  v_status text;
  v_new_org uuid;
  v_previo text;
  v_resultado jsonb;
  v_contrato_id uuid;
  v_contrato_version integer;
  v_tiene_contrato boolean := false;
begin
  perform core.superadmin_require_caller(p_caller_id, 'confirm_org_admin_action');
  select * into v from core.org_admin_action a where a.id = p_action_id for update;
  if not found then
    raise exception 'confirm_org_admin_action: la accion no existe' using errcode = 'P0002';
  end if;
  if v.creado_por <> p_caller_id then
    raise exception 'confirm_org_admin_action: solo quien solicito la accion puede confirmarla' using errcode = '42501';
  end if;
  if v.estado <> 'pending' then
    raise exception 'confirm_org_admin_action: la accion ya no esta pendiente (estado %)', v.estado using errcode = '55006';
  end if;
  if v.vence_en <= now() then
    update core.org_admin_action set estado = 'expired' where id = v.id returning * into v;
    insert into core.superadmin_security_event (area, event, actor_user_id, organization_id, detail)
    values ('org', 'org_action_expired', p_caller_id, v.organization_id, jsonb_build_object('action_id', v.id));
    return v;
  end if;
  if v.requiere_doble_control and v.aprobado_por is null then
    raise exception 'confirm_org_admin_action: falta la aprobacion de un segundo superadmin (doble control)' using errcode = '55006';
  end if;

  if v.tipo = 'alta' then
    if exists (select 1 from core.organization o where o.slug = v.payload->>'slug') then
      raise exception 'confirm_org_admin_action: el slug ya existe' using errcode = '23505';
    end if;
    insert into core.organization (vertical, name, slug, status)
    values (v.payload->>'vertical', v.payload->>'name', v.payload->>'slug', 'trial')
    returning id into v_new_org;
    v_resultado := jsonb_build_object('organization_id', v_new_org, 'status', 'trial');
  else
    select o.status into v_status from core.organization o where o.id = v.organization_id for update;
    if not found then
      raise exception 'confirm_org_admin_action: la organizacion ya no existe' using errcode = 'P0002';
    end if;
    select c.contract_id, c.version into v_contrato_id, v_contrato_version from core.org_contrato_vigente(v.organization_id) c;
    v_tiene_contrato := found;
    if v.tipo = 'suspender' then
      if v_status = 'suspended' then
        raise exception 'confirm_org_admin_action: la organizacion ya esta suspendida' using errcode = '55006';
      end if;
      -- El mundo pudo cambiar: si ahora hay contrato vigente y la solicitud no pidio doble control, se rehace.
      if v_tiene_contrato and not v.requiere_doble_control then
        raise exception 'confirm_org_admin_action: la organizacion ya tiene un contrato vigente; crea una solicitud nueva (requiere doble control)' using errcode = '55006';
      end if;
      update core.organization set status = 'suspended' where id = v.organization_id;
      v_resultado := jsonb_build_object('status_previo', v_status, 'status', 'suspended', 'doble_control', v.requiere_doble_control,
                                        'aprobado_por', v.aprobado_por, 'contrato_id', v_contrato_id, 'contrato_version', v_contrato_version);
    elsif v.tipo = 'reactivar' then
      if v_status <> 'suspended' then
        raise exception 'confirm_org_admin_action: la organizacion ya no esta suspendida' using errcode = '55006';
      end if;
      -- Restaura el estado previo a la ULTIMA suspension ejecutada (trial|active).
      select a.resultado->>'status_previo' into v_previo
      from core.org_admin_action a
      where a.organization_id = v.organization_id and a.tipo = 'suspender' and a.estado = 'executed'
      order by a.confirmado_en desc nulls last limit 1;
      if v_previo is null or v_previo not in ('trial', 'active') then v_previo := 'active'; end if;
      update core.organization set status = v_previo where id = v.organization_id;
      v_resultado := jsonb_build_object('status_previo', 'suspended', 'status', v_previo);
    else
      if v_status = 'suspended' then
        raise exception 'confirm_org_admin_action: la organizacion esta suspendida' using errcode = '55006';
      end if;
      if v_status = v.payload->>'plan' then
        raise exception 'confirm_org_admin_action: la organizacion ya tiene ese plan' using errcode = '55006';
      end if;
      if v.payload->>'plan' = 'trial' and v_tiene_contrato then
        raise exception 'confirm_org_admin_action: una organizacion con contrato vigente no puede pasar a cuenta de prueba' using errcode = '55006';
      end if;
      update core.organization set status = v.payload->>'plan' where id = v.organization_id;
      v_resultado := jsonb_build_object('status_previo', v_status, 'status', v.payload->>'plan',
                                        'contrato_id', v_contrato_id, 'contrato_version', v_contrato_version);
    end if;
  end if;

  update core.org_admin_action
     set estado = 'executed', confirmado_por = p_caller_id, confirmado_en = now(), resultado = v_resultado
   where id = v.id returning * into v;
  insert into core.superadmin_security_event (area, event, actor_user_id, organization_id, detail)
  values ('org', 'org_action_executed', p_caller_id, coalesce(v.organization_id, v_new_org),
          jsonb_build_object('action_id', v.id, 'tipo', v.tipo, 'resultado', v_resultado));
  return v;
end;
$$;
revoke all on function core.confirm_org_admin_action(uuid, uuid) from public, anon;
grant execute on function core.confirm_org_admin_action(uuid, uuid) to authenticated;
