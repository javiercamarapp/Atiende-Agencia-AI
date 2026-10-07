-- paridad3 licitaciones autopiloto (L-P3-08/09/11): lo que necesita la sesion de SISTEMA (cron de descubrimiento, auth.uid() nulo)
-- para que un dia tipico de licitaciones corra solo hasta que haga falta una decision humana.
--
-- Contexto de seguridad (mismo diagnostico que `024_licitaciones_sistema_ingesta_escritura.sql`): bajo la sesion de sistema las
-- policies `licitaciones.can_access_org`/`can_write_org` (exigen `core.membership.user_id = auth.uid()`) devuelven SIEMPRE false,
-- asi que ni la lectura ni la escritura de las tablas de la vertical funcionan. En vez de abrir ninguna policy se usa el patron
-- ya establecido en esta vertical: funciones `security definer` de SOLO sistema (`auth.uid() is null`, si no 42501), con
-- `search_path` fijo, `revoke ... from public` y sin ningun GRANT a anon.
--
-- Que agrega:
--   1) `system_latest_tender_version` / `system_record_ingested_tender_version` (L-P3-08): el vigilante de cambios de la ingesta
--      automatica. Registra la version de la convocatoria cuando una fuente cambia plazo, monto, bases o documentos, invalida
--      las aprobaciones que cubrian ese cambio (misma cascada que `recordTenderVersion`) y deja la notificacion de cambio de
--      convocatoria. Idempotente: el mismo hash no hace nada (REQ-154).
--   2) `tenant_config.new_match_min_score` (L-P3-09): umbral por organizacion del aviso de "nuevo match" (null = solo elegibles).
--   3) `new_match_notice` + `system_get_new_match_context` + `system_record_new_match` (L-P3-09): dedupe por organizacion y
--      convocatoria, fuente de la lista "mejores N" de la campana y del resumen semanal. Sin PII: solo ids, puntuacion y bandera.
--   4) `expediente_auditoria` (L-P3-11): ultimo estado del checklist de integridad por propuesta para detectar la transicion
--      "con bloqueos" -> "sin bloqueos". Lo escribe el staff autenticado desde el punto de escritura (nunca el sistema).
--
-- Compatibilidad con la base sin migrar: TODO el codigo TypeScript que llama a esto captura 42883/42P01/42703 dentro de un
-- SAVEPOINT y degrada al comportamiento anterior (la ingesta sigue guardando la convocatoria; solo no versiona ni avisa).
--
-- Orden de despliegue: aplicar esta migracion ANTES o DESPUES del codigo es seguro (el codigo degrada). Para que el vigilante y
-- el nuevo match funcionen, la migracion debe estar aplicada.

-- ---------------------------------------------------------------------------
-- 1) Vigilante de cambios en la ingesta automatica.
-- ---------------------------------------------------------------------------

-- Lectura de la ULTIMA version de una convocatoria bajo la sesion de sistema. Justificacion: la tabla tender_version solo se lee
-- por `can_access_org` (staff). Solo expone version/hash/snapshot de UNA convocatoria que pertenezca a la organizacion pedida
-- (cross-tenant: una convocatoria ajena devuelve cero filas). Sin PII: el snapshot son campos de bases de la convocatoria.
create or replace function licitaciones.system_latest_tender_version(p_organization_id uuid, p_tender_id uuid)
returns table (out_version integer, out_hash text, out_snapshot jsonb)
language plpgsql stable security definer set search_path = licitaciones as $$
begin
  if auth.uid() is not null then
    raise exception 'system_latest_tender_version es solo para la sesion de sistema' using errcode = '42501';
  end if;
  return query
    select v.version, v.hash, v.snapshot
    from licitaciones.tender_version v
    where v.organization_id = p_organization_id and v.tender_id = p_tender_id
    order by v.version desc
    limit 1;
end;
$$;

revoke all on function licitaciones.system_latest_tender_version(uuid, uuid) from public, anon;
grant execute on function licitaciones.system_latest_tender_version(uuid, uuid) to authenticated;

-- Registro de una version de convocatoria descubierta por un conector (NUNCA por un humano: no escribe tender_audit_log, que
-- exige un actor staff). Una sola transaccion: version + (opcional) cascada de invalidacion + (opcional) notificacion de cambio.
--   p_notify=false -> version "linea base" silenciosa (primera captura, o solo aparecieron los documentos por primera vez).
--   p_cascade      -> arreglo jsonb [{scope, scopeRef, reason}] de cambios a aplicar sobre la propuesta abierta (si existe).
-- Defensa: la convocatoria debe pertenecer a la organizacion (si no, 42501); el bloqueo `for update` serializa corridas
-- concurrentes sobre la misma convocatoria, y el hash repetido responde `out_created=false` sin escribir nada.
create or replace function licitaciones.system_record_ingested_tender_version(
  p_organization_id uuid,
  p_tender_id uuid,
  p_hash text,
  p_snapshot jsonb,
  p_diff jsonb,
  p_notify boolean,
  p_reason text,
  p_changed_field_names text[],
  p_affected_section_keys text[],
  p_notified_roles text[],
  p_cascade jsonb
)
returns table (out_version integer, out_created boolean, out_notification_id uuid, out_invalidated_approval_ids uuid[], out_invalidated_approver_ids uuid[])
language plpgsql security definer set search_path = licitaciones as $$
declare
  v_latest_version integer;
  v_latest_hash text;
  v_next integer;
  v_inserted integer;
  v_notification uuid := null;
  v_proposal uuid;
  v_change jsonb;
  v_ids uuid[];
  v_all_ids uuid[] := '{}';
  v_approvers uuid[] := '{}';
begin
  if auth.uid() is not null then
    raise exception 'system_record_ingested_tender_version es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if p_hash is null or length(p_hash) < 16 then
    raise exception 'system_record_ingested_tender_version: hash invalido' using errcode = '22023';
  end if;

  perform 1 from licitaciones.tender t where t.id = p_tender_id and t.organization_id = p_organization_id for update;
  if not found then
    raise exception 'system_record_ingested_tender_version: la convocatoria no pertenece a la organizacion' using errcode = '42501';
  end if;

  select v.version, v.hash into v_latest_version, v_latest_hash
  from licitaciones.tender_version v
  where v.organization_id = p_organization_id and v.tender_id = p_tender_id
  order by v.version desc limit 1;

  if v_latest_hash is not null and v_latest_hash = p_hash then
    return query select v_latest_version, false, null::uuid, '{}'::uuid[], '{}'::uuid[];
    return;
  end if;

  v_next := coalesce(v_latest_version, 0) + 1;
  insert into licitaciones.tender_version (organization_id, tender_id, version, hash, snapshot, diff)
  values (p_organization_id, p_tender_id, v_next, p_hash, p_snapshot, p_diff)
  on conflict (tender_id, version) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return query select v_next, false, null::uuid, '{}'::uuid[], '{}'::uuid[];
    return;
  end if;

  if p_notify and p_cascade is not null and jsonb_typeof(p_cascade) = 'array' then
    select p.id into v_proposal from licitaciones.proposal p where p.organization_id = p_organization_id and p.tender_id = p_tender_id;
    if v_proposal is not null then
      for v_change in select * from jsonb_array_elements(p_cascade) loop
        -- Aprobaciones vigentes que cubren el alcance del cambio: la del propio alcance y la del expediente (arbol de 2 niveles).
        select coalesce(array_agg(a.id), '{}') into v_ids
        from licitaciones.approval a
        where a.organization_id = p_organization_id and a.proposal_id = v_proposal and a.status = 'vigente'
          and a.scope_ref = any (case when v_change->>'scopeRef' = 'expediente' then array['expediente'] else array['expediente', v_change->>'scopeRef'] end);
        if array_length(v_ids, 1) is not null then
          update licitaciones.approval set status = 'invalidada', invalidated_at = now(), invalidated_reason = v_change->>'reason' where id = any (v_ids);
          select coalesce(array_agg(distinct a.approver_id), '{}') || v_approvers into v_approvers from licitaciones.approval a where a.id = any (v_ids);
          v_all_ids := v_all_ids || v_ids;
        end if;
        insert into licitaciones.approval_change (organization_id, proposal_id, scope, scope_ref, reason, invalidated_approval_ids)
        values (p_organization_id, v_proposal, v_change->>'scope', v_change->>'scopeRef', v_change->>'reason', v_ids);
      end loop;
    end if;
  end if;

  if p_notify then
    insert into licitaciones.tender_change_notification (organization_id, tender_id, tender_version, reason, changed_field_names, affected_section_keys, notified_roles)
    values (p_organization_id, p_tender_id, v_next, p_reason, coalesce(p_changed_field_names, '{}'), coalesce(p_affected_section_keys, '{}'), coalesce(p_notified_roles, '{}'))
    returning id into v_notification;
  end if;

  return query select v_next, true, v_notification, v_all_ids, (select coalesce(array_agg(distinct x), '{}') from unnest(v_approvers) x);
end;
$$;

revoke all on function licitaciones.system_record_ingested_tender_version(uuid, uuid, text, jsonb, jsonb, boolean, text, text[], text[], text[], jsonb) from public, anon;
grant execute on function licitaciones.system_record_ingested_tender_version(uuid, uuid, text, jsonb, jsonb, boolean, text, text[], text[], text[], jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Umbral de "nuevo match" por organizacion (null = solo las convocatorias elegibles).
--    Escritura SOLO a nivel columna y SOLO owner/admin (policy ya existente de tenant_config).
-- ---------------------------------------------------------------------------
alter table licitaciones.tenant_config
  add column if not exists new_match_min_score integer;
alter table licitaciones.tenant_config
  drop constraint if exists tenant_config_new_match_min_score_check;
alter table licitaciones.tenant_config
  add constraint tenant_config_new_match_min_score_check check (new_match_min_score is null or (new_match_min_score between 0 and 100));

grant insert (new_match_min_score) on licitaciones.tenant_config to authenticated;
grant update (new_match_min_score) on licitaciones.tenant_config to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Nuevo match: dedupe por (organizacion, convocatoria) y lista de la campana / resumen semanal.
-- ---------------------------------------------------------------------------
create table if not exists licitaciones.new_match_notice (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  tender_id uuid not null references licitaciones.tender(id) on delete cascade,
  score integer not null check (score between 0 and 100),
  eligible boolean not null,
  created_at timestamptz not null default now(),
  constraint new_match_notice_unica unique (organization_id, tender_id)
);
create index if not exists new_match_notice_org_idx on licitaciones.new_match_notice (organization_id, created_at desc);

alter table licitaciones.new_match_notice enable row level security;
-- Lectura: cualquier miembro de la organizacion (solo ids, puntuacion y bandera; sin PII). Sin policy de escritura: solo las
-- funciones de sistema de abajo (definer) la escriben; un usuario autenticado NO puede insertar, editar ni borrar.
create policy "org ve sus nuevos matches" on licitaciones.new_match_notice for select using (licitaciones.can_access_org(organization_id));

revoke all on licitaciones.new_match_notice from public, anon;
grant select on licitaciones.new_match_notice to authenticated;
grant select, insert, update, delete on licitaciones.new_match_notice to service_role;

-- Contexto de matching de una organizacion para la sesion de sistema: umbral + perfil (puede no existir). Solo lectura de la
-- propia organizacion pedida; devuelve una fila siempre (perfil vacio si no hay), y cero filas si la organizacion no es de
-- licitaciones o esta inactiva (defensa en profundidad: el cron ya itera solo organizaciones activas).
create or replace function licitaciones.system_get_new_match_context(p_organization_id uuid)
returns table (
  out_min_score integer,
  out_has_profile boolean,
  out_keywords text[],
  out_excluded_keywords text[],
  out_classifier_codes text[],
  out_entities text[],
  out_states text[],
  out_budget_min text,
  out_budget_max text
)
language plpgsql stable security definer set search_path = licitaciones as $$
begin
  if auth.uid() is not null then
    raise exception 'system_get_new_match_context es solo para la sesion de sistema' using errcode = '42501';
  end if;
  return query
    select c.new_match_min_score,
           (mp.organization_id is not null),
           coalesce(mp.keywords, '{}'), coalesce(mp.excluded_keywords, '{}'), coalesce(mp.classifier_codes, '{}'),
           coalesce(mp.entities, '{}'), coalesce(mp.states, '{}'), mp.budget_min::text, mp.budget_max::text
    from core.organization o
    left join licitaciones.tenant_config c on c.organization_id = o.id
    left join licitaciones.matching_profile mp on mp.organization_id = o.id
    where o.id = p_organization_id and o.vertical = 'licitaciones' and o.status = 'active';
end;
$$;

revoke all on function licitaciones.system_get_new_match_context(uuid) from public, anon;
grant execute on function licitaciones.system_get_new_match_context(uuid) to authenticated;

-- Registro idempotente de un nuevo match: devuelve true solo la primera vez que se registra (organizacion, convocatoria).
-- La convocatoria debe pertenecer a la organizacion (si no, 42501: nadie puede sembrar avisos en otro tenant).
create or replace function licitaciones.system_record_new_match(p_organization_id uuid, p_tender_id uuid, p_score integer, p_eligible boolean)
returns boolean
language plpgsql security definer set search_path = licitaciones as $$
declare
  v_inserted integer;
begin
  if auth.uid() is not null then
    raise exception 'system_record_new_match es solo para la sesion de sistema' using errcode = '42501';
  end if;
  perform 1 from licitaciones.tender t where t.id = p_tender_id and t.organization_id = p_organization_id;
  if not found then
    raise exception 'system_record_new_match: la convocatoria no pertenece a la organizacion' using errcode = '42501';
  end if;
  insert into licitaciones.new_match_notice (organization_id, tender_id, score, eligible)
  values (p_organization_id, p_tender_id, greatest(0, least(100, p_score)), p_eligible)
  on conflict (organization_id, tender_id) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted > 0;
end;
$$;

revoke all on function licitaciones.system_record_new_match(uuid, uuid, integer, boolean) from public, anon;
grant execute on function licitaciones.system_record_new_match(uuid, uuid, integer, boolean) to authenticated;

-- Mejores N matches recientes de una organizacion para el resumen semanal (sesion de sistema). Devuelve el titulo de la convocatoria
-- (dato de negocio de la propia organizacion, NO PII) solo para el CORREO a owner/admin de esa misma organizacion; la campana nunca lo
-- lleva. El join exige que la convocatoria pertenezca a la organizacion pedida (cross-tenant: cero filas).
create or replace function licitaciones.system_list_new_matches(p_organization_id uuid, p_since timestamptz, p_limit integer)
returns table (out_tender_id uuid, out_score integer, out_eligible boolean, out_created_at text, out_title text)
language plpgsql stable security definer set search_path = licitaciones as $$
begin
  if auth.uid() is not null then
    raise exception 'system_list_new_matches es solo para la sesion de sistema' using errcode = '42501';
  end if;
  return query
    select n.tender_id, n.score, n.eligible, n.created_at::text, t.title
    from licitaciones.new_match_notice n
    join licitaciones.tender t on t.id = n.tender_id and t.organization_id = n.organization_id
    where n.organization_id = p_organization_id and n.created_at >= p_since
    order by n.score desc, n.created_at desc
    limit greatest(1, least(coalesce(p_limit, 10), 50));
end;
$$;

revoke all on function licitaciones.system_list_new_matches(uuid, timestamptz, integer) from public, anon;
grant execute on function licitaciones.system_list_new_matches(uuid, timestamptz, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Auditor determinista del expediente: ultimo estado del checklist por propuesta.
--    Lo escribe el staff autenticado (roles de escritura) en el punto donde cambia un insumo; nunca el sistema.
-- ---------------------------------------------------------------------------
create table if not exists licitaciones.expediente_auditoria (
  proposal_id uuid primary key references licitaciones.proposal(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  tender_id uuid not null references licitaciones.tender(id) on delete cascade,
  estado text not null check (estado in ('con_bloqueos', 'sin_bloqueos')),
  bloqueos integer not null check (bloqueos >= 0),
  inputs_hash text not null,
  revisado_en timestamptz not null default now()
);
create index if not exists expediente_auditoria_org_idx on licitaciones.expediente_auditoria (organization_id, revisado_en desc);

alter table licitaciones.expediente_auditoria enable row level security;
create policy "org ve la auditoria de sus expedientes" on licitaciones.expediente_auditoria for select using (licitaciones.can_access_org(organization_id));
create policy "escritura: roles de escritura registran la auditoria del expediente" on licitaciones.expediente_auditoria for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura actualizan la auditoria del expediente" on licitaciones.expediente_auditoria for update using (licitaciones.can_write_org(organization_id)) with check (licitaciones.can_write_org(organization_id));

revoke all on licitaciones.expediente_auditoria from public, anon;
grant select on licitaciones.expediente_auditoria to authenticated;
-- Nivel columna: las funciones reales solo escriben estas columnas (la llave y el tenant no cambian en un update).
grant insert (proposal_id, organization_id, tender_id, estado, bloqueos, inputs_hash, revisado_en) on licitaciones.expediente_auditoria to authenticated;
grant update (estado, bloqueos, inputs_hash, revisado_en) on licitaciones.expediente_auditoria to authenticated;
grant select, insert, update, delete on licitaciones.expediente_auditoria to service_role;
