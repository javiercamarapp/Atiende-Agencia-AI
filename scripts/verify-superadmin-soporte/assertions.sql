-- Escenarios de packages/db/migrations/0058_superadmin_soporte_entrar_clientes.sql contra Postgres REAL.
-- Cada bloque `do` LANZA si el resultado no es el esperado (ON_ERROR_STOP): terminar sin error = todo verificado.
\set ON_ERROR_STOP on
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000c9810', 'restaurantes', 'Org Soporte Sin Membresia', 'org-soporte-sin-membresia'),
  ('00000000-0000-0000-0000-0000000c9811', 'restaurantes', 'Org Soporte Con Membresia', 'org-soporte-con-membresia'),
  ('00000000-0000-0000-0000-0000000c9812', 'restaurantes', 'Org Soporte Con Otro Superadmin', 'org-soporte-con-otro-superadmin')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000c9800', 'soporte-sa1@example.com', 'Soporte SA1', 'seed'),
  ('00000000-0000-0000-0000-0000000c9801', 'soporte-sa2@example.com', 'Soporte SA2', 'seed'),
  ('00000000-0000-0000-0000-0000000c9802', 'soporte-normal@example.com', 'Soporte Normal', 'seed')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values
  ('00000000-0000-0000-0000-0000000c9800'), ('00000000-0000-0000-0000-0000000c9801')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000c9800', '00000000-0000-0000-0000-0000000c9811', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000c9801', '00000000-0000-0000-0000-0000000c9812', null, 'member', 'staff')
on conflict do nothing;

\echo '=== 1. anon no puede ejecutar start_support_session ==='
begin;
set local role anon;
do $$ begin
  begin
    perform core.start_support_session('00000000-0000-0000-0000-0000000c9800', '00000000-0000-0000-0000-0000000c9810', 'motivo de soporte valido');
    raise exception 'FALLO: anon pudo ejecutar';
  exception when insufficient_privilege then null; end;
end $$;
rollback;

\echo '=== 2. no superadmin, caller-binding, motivo corto y org inexistente -- rechazados con su SQLSTATE ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9802', true);
do $$ begin
  begin
    perform core.start_support_session('00000000-0000-0000-0000-0000000c9802', '00000000-0000-0000-0000-0000000c9810', 'motivo de soporte valido');
    raise exception 'FALLO: un staff normal abrio sesion';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9800', true);
do $$ begin
  begin
    perform core.start_support_session('00000000-0000-0000-0000-0000000c9801', '00000000-0000-0000-0000-0000000c9810', 'motivo de soporte valido');
    raise exception 'FALLO: caller binding';
  exception when insufficient_privilege then null; end;
  begin
    perform core.start_support_session('00000000-0000-0000-0000-0000000c9800', '00000000-0000-0000-0000-0000000c9810', 'corto');
    raise exception 'FALLO: motivo corto aceptado';
  exception when invalid_parameter_value then null; end;
  begin
    perform core.start_support_session('00000000-0000-0000-0000-0000000c9800', '00000000-0000-0000-0000-0000000c9899', 'motivo de soporte valido');
    raise exception 'FALLO: org inexistente aceptada';
  exception when no_data_found then null; end;
  begin
    perform core.start_support_session('00000000-0000-0000-0000-0000000c9800', '00000000-0000-0000-0000-0000000c9812', 'motivo de soporte valido');
    raise exception 'FALLO: org con otro superadmin aceptada';
  exception when insufficient_privilege then null; end;
end $$;
rollback;

\echo '=== 3. ciclo completo con org SIN membresia: start(10 chars, 60 min) -> grant -> state -> elevate -> revoke -> end ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9800', true);
create temp table t_sesion on commit drop as
  select id, started_at, expires_at from core.start_support_session('00000000-0000-0000-0000-0000000c9800', '00000000-0000-0000-0000-0000000c9810', 'diez cars!');
grant all on t_sesion to authenticated;
do $$
declare s record; g boolean; st record; n int; e core.impersonation_audit_log;
begin
  select * into s from t_sesion;
  if s.expires_at - s.started_at <> interval '60 minutes' then raise exception 'FALLO: duracion %', s.expires_at - s.started_at; end if;
  if not exists (select 1 from core.impersonation_audit_log where session_id = s.id and event_type = 'start' and detail ->> 'kind' = 'soporte') then
    raise exception 'FALLO: sin evento start de soporte en la bitacora';
  end if;
  -- una segunda sesion activa se rechaza
  begin
    perform core.start_support_session('00000000-0000-0000-0000-0000000c9800', '00000000-0000-0000-0000-0000000c9810', 'segunda sesion activa');
    raise exception 'FALLO: dos sesiones activas';
  exception when object_not_in_prerequisite_state then null; end;
  -- sin membresia previa: la concesion se crea; con ella el caller ve su membership
  g := core.grant_support_membership('00000000-0000-0000-0000-0000000c9800', s.id);
  if not g then raise exception 'FALLO: no concedio'; end if;
  if (select count(*) from core.membership where user_id = '00000000-0000-0000-0000-0000000c9800' and organization_id = '00000000-0000-0000-0000-0000000c9810') <> 1 then
    raise exception 'FALLO: no hay membresia temporal';
  end if;
  -- la tabla de concesiones NO es legible para authenticated
  begin
    perform 1 from core.support_membership_grant;
    raise exception 'FALLO: authenticated lee la tabla de concesiones';
  exception when insufficient_privilege then null; end;
  select * into st from core.get_support_session_state('00000000-0000-0000-0000-0000000c9800', s.id);
  if not (st.active and st.soporte and not st.elevated) then raise exception 'FALLO: estado inicial %', st; end if;
  -- elevacion: motivo corto rechazado, valida acepta, doble elevacion rechazada
  begin
    perform core.elevate_support_session('00000000-0000-0000-0000-0000000c9800', s.id, 'corto');
    raise exception 'FALLO: elevacion con motivo corto';
  exception when invalid_parameter_value then null; end;
  e := core.elevate_support_session('00000000-0000-0000-0000-0000000c9800', s.id, 'necesito corregir un dato');
  if e.event_type <> 'elevate' then raise exception 'FALLO: evento %', e.event_type; end if;
  begin
    perform core.elevate_support_session('00000000-0000-0000-0000-0000000c9800', s.id, 'otra vez elevando');
    raise exception 'FALLO: doble elevacion';
  exception when object_not_in_prerequisite_state then null; end;
  select * into st from core.get_support_session_state('00000000-0000-0000-0000-0000000c9800', s.id);
  if not st.elevated then raise exception 'FALLO: no figura elevada'; end if;
  -- salir: revoca la membresia temporal y cierra
  n := core.revoke_support_memberships('00000000-0000-0000-0000-0000000c9800', s.id);
  if n <> 1 then raise exception 'FALLO: revoco % concesiones', n; end if;
  if exists (select 1 from core.membership where user_id = '00000000-0000-0000-0000-0000000c9800' and organization_id = '00000000-0000-0000-0000-0000000c9810') then
    raise exception 'FALLO: la membresia temporal sigue viva';
  end if;
  perform core.end_impersonation_session('00000000-0000-0000-0000-0000000c9800', s.id);
  select * into st from core.get_support_session_state('00000000-0000-0000-0000-0000000c9800', s.id);
  if st.active then raise exception 'FALLO: sigue activa tras end'; end if;
  begin
    perform core.elevate_support_session('00000000-0000-0000-0000-0000000c9800', s.id, 'ya terminada la sesion');
    raise exception 'FALLO: elevo una sesion terminada';
  exception when object_not_in_prerequisite_state then null; end;
end $$;
rollback;

\echo '=== 4. org CON membresia real: grant devuelve false y revoke NUNCA la borra ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9800', true);
create temp table t_sesion2 on commit drop as
  select id from core.start_support_session('00000000-0000-0000-0000-0000000c9800', '00000000-0000-0000-0000-0000000c9811', 'org con membresia real');
grant all on t_sesion2 to authenticated;
do $$
declare s record;
begin
  select * into s from t_sesion2;
  if core.grant_support_membership('00000000-0000-0000-0000-0000000c9800', s.id) then raise exception 'FALLO: concedio sobre membresia real'; end if;
  if core.revoke_support_memberships('00000000-0000-0000-0000-0000000c9800', s.id) <> 0 then raise exception 'FALLO: revoco algo'; end if;
  if not exists (select 1 from core.membership where user_id = '00000000-0000-0000-0000-0000000c9800' and organization_id = '00000000-0000-0000-0000-0000000c9811') then
    raise exception 'FALLO: se borro una membresia real';
  end if;
end $$;
rollback;

\echo '=== 5. una sesion VENCIDA: el barrido perezoso revoca la concesion y no se puede elevar ==='
begin;
-- sesion + concesion sembradas como superusuario ya vencidas
insert into core.impersonation_session (id, actor_user_id, actor_email, organization_id, reason, started_at, expires_at) values
  ('00000000-0000-0000-0000-0000000c9830', '00000000-0000-0000-0000-0000000c9800', 'soporte-sa1@example.com', '00000000-0000-0000-0000-0000000c9810', 'sesion vencida de soporte', now() - interval '2 hours', now() - interval '1 hour');
insert into core.impersonation_audit_log (session_id, event_type, actor_user_id, actor_email, organization_id, reason, detail, occurred_at) values
  ('00000000-0000-0000-0000-0000000c9830', 'start', '00000000-0000-0000-0000-0000000c9800', 'soporte-sa1@example.com', '00000000-0000-0000-0000-0000000c9810', 'sesion vencida de soporte', '{"kind":"soporte"}', now() - interval '2 hours');
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000c9800', '00000000-0000-0000-0000-0000000c9810', null, 'owner', 'owner');
insert into core.support_membership_grant (session_id, user_id, organization_id) values
  ('00000000-0000-0000-0000-0000000c9830', '00000000-0000-0000-0000-0000000c9800', '00000000-0000-0000-0000-0000000c9810');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c9800', true);
do $$ begin
  begin
    perform core.elevate_support_session('00000000-0000-0000-0000-0000000c9800', '00000000-0000-0000-0000-0000000c9830', 'sesion ya vencida');
    raise exception 'FALLO: elevo una sesion vencida';
  exception when object_not_in_prerequisite_state then null; end;
  if core.revoke_support_memberships('00000000-0000-0000-0000-0000000c9800', null) <> 1 then raise exception 'FALLO: el barrido no revoco'; end if;
  if exists (select 1 from core.membership where user_id = '00000000-0000-0000-0000-0000000c9800' and organization_id = '00000000-0000-0000-0000-0000000c9810') then
    raise exception 'FALLO: la membresia vencida sigue viva';
  end if;
end $$;
rollback;

\echo '=== 6. bitacora sigue append-only: UPDATE/DELETE sobre el evento start de soporte -- bloqueados ==='
begin;
insert into core.impersonation_session (id, actor_user_id, actor_email, organization_id, reason, started_at, expires_at) values
  ('00000000-0000-0000-0000-0000000c9840', '00000000-0000-0000-0000-0000000c9800', 'soporte-sa1@example.com', '00000000-0000-0000-0000-0000000c9810', 'sesion para append only', now(), now() + interval '60 minutes');
insert into core.impersonation_audit_log (session_id, event_type, actor_user_id, actor_email, organization_id, reason, detail, occurred_at) values
  ('00000000-0000-0000-0000-0000000c9840', 'start', '00000000-0000-0000-0000-0000000c9800', 'soporte-sa1@example.com', '00000000-0000-0000-0000-0000000c9810', 'sesion para append only', '{"kind":"soporte"}', now());
do $$ begin
  begin
    update core.impersonation_audit_log set reason = 'alterado' where session_id = '00000000-0000-0000-0000-0000000c9840';
    raise exception 'FALLO: UPDATE permitido';
  exception when feature_not_supported then null; end;
  begin
    delete from core.impersonation_audit_log where session_id = '00000000-0000-0000-0000-0000000c9840';
    raise exception 'FALLO: DELETE permitido';
  exception when feature_not_supported then null; end;
end $$;
rollback;

\echo '=== TODO VERIFICADO ==='
