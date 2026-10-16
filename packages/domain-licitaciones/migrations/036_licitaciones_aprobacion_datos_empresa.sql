-- 036: aprobacion real de los datos de empresa (tarifas, documentos, capacidades, experiencia, firmantes).
-- Requiere: 001/009 (tablas), 002 (can_access_org/can_write_org), 019/021 (grants previos).
--
-- Problema que cierra (REQ-044/064, REQ-162; regresiones WI-04, DB-03 y AE-08 del suelto): hasta ahora cualquier
-- rol de escritura (incluido `writer`) podia poner `approval_status = 'aprobado'` en sus propias tarifas, documentos,
-- capacidades y experiencia, y editar un dato YA aprobado conservaba la aprobacion.
--
-- Que agrega:
--   1. Columnas `proposed_by`, `approved_by`, `approved_at` en las cinco tablas, y `approval_status` en
--      `company_signer` (hasta hoy un firmante solo tenia el booleano `authorized`). Los firmantes ya existentes se
--      respaldan como 'aprobado' (eran utilizables antes de esta migracion; asi el hash del perfil no cambia por migrar).
--   2. Triggers BEFORE INSERT/UPDATE (SIN security definer: corren como quien llama):
--        - INSERT: `proposed_by := auth.uid()` (nadie puede declararse "autor" de otra persona).
--        - UPDATE que cambia un dato (cualquier columna distinta de estado/autoria): el registro vuelve a
--          'pendiente_aprobacion' EN LA MISMA SENTENCIA, se limpian `approved_by`/`approved_at` y `proposed_by`
--          pasa a quien edito. Es la regla DB-03 aplicada en la base, no solo en la capa de aplicacion.
--   3. GRANT A NIVEL COLUMNA: `authenticated` conserva SELECT de tabla, pero INSERT/UPDATE solo sobre las columnas de
--      DATO que las rutas reales escriben. `approval_status`, `proposed_by`, `approved_by` y `approved_at` quedan
--      fuera: ningun cliente puede fijarlas por SQL directo; el unico camino a 'aprobado'/'rechazado' es (4).
--   4. `licitaciones.decide_company_item(...)`: SECURITY DEFINER con search_path fijo y REVOKE de public/anon.
--      Exige `auth.uid() = p_caller_id`, membresia del llamador en la organizacion con rol de decision
--      (tarifas: owner/admin; el resto: owner/admin/analyst), que el llamador NO sea quien propuso o edito por ultima
--      vez el registro (autor distinto del aprobador) y hace la transicion de forma ATOMICA y condicional
--      (`where approval_status = 'pendiente_aprobacion'`): dos decisiones simultaneas sobre el mismo registro
--      producen exactamente un 'ok' y un 'conflict'. Registra un renglon en la bitacora (5).
--   5. `licitaciones.company_data_audit`: bitacora append-only de decisiones. RLS: lectura a miembros de la
--      organizacion; sin policy ni GRANT de escritura para `authenticated` (solo la escribe la funcion de (4)).
--
-- Justificacion de cada GRANT/policy/funcion:
--   * GRANT select a authenticated en company_data_audit: la pantalla de Datos de empresa muestra quien decidio; la
--     policy limita a la propia organizacion (`can_access_org`). Nada para anon.
--   * GRANT insert/update por columna: ver (3); es el minimo que las funciones reales de repositorio escriben.
--   * GRANT execute de decide_company_item a authenticated: la funcion valida identidad, rol y organizacion por si
--     misma; no hay `using (true)`.
--
-- Datos existentes: los registros aprobados antes de esta migracion conservan su estado, con `proposed_by` NULL
-- (no se sabe quien los propuso: la regla autor-distinto-de-aprobador no puede aplicarse a ellos, y se documenta).
--
-- Compatibilidad con la base sin migrar: el codigo TypeScript detecta las columnas/funcion faltantes (42703/42883)
-- dentro de un SAVEPOINT y sigue con el comportamiento anterior. ORDEN DE DESPLIEGUE: primero el codigo, despues
-- esta migracion (el codigo viejo escribe `approval_status` y, tras los grants por columna, recibiria 42501).

alter table licitaciones.approved_rate
  add column proposed_by uuid references core.staff_user(id) on delete set null,
  add column approved_by uuid references core.staff_user(id) on delete set null,
  add column approved_at timestamptz;
alter table licitaciones.company_document
  add column proposed_by uuid references core.staff_user(id) on delete set null,
  add column approved_by uuid references core.staff_user(id) on delete set null,
  add column approved_at timestamptz;
alter table licitaciones.company_capability
  add column proposed_by uuid references core.staff_user(id) on delete set null,
  add column approved_by uuid references core.staff_user(id) on delete set null,
  add column approved_at timestamptz;
alter table licitaciones.company_experience
  add column proposed_by uuid references core.staff_user(id) on delete set null,
  add column approved_by uuid references core.staff_user(id) on delete set null,
  add column approved_at timestamptz;
alter table licitaciones.company_signer
  add column approval_status text not null default 'pendiente_aprobacion' check (approval_status in ('aprobado', 'pendiente_aprobacion', 'rechazado')),
  add column proposed_by uuid references core.staff_user(id) on delete set null,
  add column approved_by uuid references core.staff_user(id) on delete set null,
  add column approved_at timestamptz;

-- Respaldo de los firmantes existentes (corre ANTES de crear los triggers: no hay nada que "invalidar").
update licitaciones.company_signer set approval_status = 'aprobado';

create or replace function licitaciones.company_data_proponer()
returns trigger language plpgsql set search_path = pg_catalog, licitaciones as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.proposed_by := auth.uid();
    end if;
    return new;
  end if;
  -- UPDATE: solo reacciona a un cambio de DATO (las columnas de estado/autoria no cuentan).
  if (to_jsonb(new) - array['approval_status', 'proposed_by', 'approved_by', 'approved_at'])
     is distinct from (to_jsonb(old) - array['approval_status', 'proposed_by', 'approved_by', 'approved_at']) then
    new.approval_status := 'pendiente_aprobacion';
    new.approved_by := null;
    new.approved_at := null;
    if auth.uid() is not null then
      new.proposed_by := auth.uid();
    end if;
  end if;
  return new;
end;
$$;

revoke all on function licitaciones.company_data_proponer() from public, anon;

create trigger approved_rate_proponer before insert or update on licitaciones.approved_rate
  for each row execute function licitaciones.company_data_proponer();
create trigger company_document_proponer before insert or update on licitaciones.company_document
  for each row execute function licitaciones.company_data_proponer();
create trigger company_capability_proponer before insert or update on licitaciones.company_capability
  for each row execute function licitaciones.company_data_proponer();
create trigger company_experience_proponer before insert or update on licitaciones.company_experience
  for each row execute function licitaciones.company_data_proponer();
create trigger company_signer_proponer before insert or update on licitaciones.company_signer
  for each row execute function licitaciones.company_data_proponer();

-- GRANT por columna (ver cabecera, punto 3). Se revoca el INSERT/UPDATE de tabla de 019/021 y se vuelve a otorgar
-- solo sobre las columnas de dato; el SELECT de tabla no cambia. service_role conserva todo (sembrado/mantenimiento).
revoke insert, update on licitaciones.approved_rate, licitaciones.company_document, licitaciones.company_capability,
  licitaciones.company_experience, licitaciones.company_signer from authenticated;

grant insert (organization_id, concept, unit_price, valid_from, valid_until) on licitaciones.approved_rate to authenticated;
grant update (unit_price, valid_from, valid_until) on licitaciones.approved_rate to authenticated;
grant insert (organization_id, document_type, label, expires_at) on licitaciones.company_document to authenticated;
grant update (label, expires_at) on licitaciones.company_document to authenticated;
grant insert (organization_id, name, description, evidence_doc_id) on licitaciones.company_capability to authenticated;
grant update (description, evidence_doc_id) on licitaciones.company_capability to authenticated;
grant insert (organization_id, description, evidence_doc_id) on licitaciones.company_experience to authenticated;
grant update (description, evidence_doc_id) on licitaciones.company_experience to authenticated;
grant insert (organization_id, name, role, authorized) on licitaciones.company_signer to authenticated;
grant update (name, authorized) on licitaciones.company_signer to authenticated;

-- Bitacora append-only de decisiones sobre datos de empresa.
create table licitaciones.company_data_audit (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  kind text not null check (kind in ('rate', 'document', 'capability', 'experience', 'signer')),
  item_id uuid not null,
  decision text not null check (decision in ('aprobado', 'rechazado')),
  actor_id uuid not null references core.staff_user(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index company_data_audit_item_idx on licitaciones.company_data_audit (organization_id, kind, item_id, created_at desc);

alter table licitaciones.company_data_audit enable row level security;
create policy "org ve la bitacora de datos de empresa" on licitaciones.company_data_audit for select using (licitaciones.can_access_org(organization_id));

revoke all on licitaciones.company_data_audit from public, anon;
grant select on licitaciones.company_data_audit to authenticated;
grant select, insert, update, delete on licitaciones.company_data_audit to service_role;

create or replace function licitaciones.decide_company_item(
  p_caller_id uuid,
  p_organization_id uuid,
  p_kind text,
  p_item_id uuid,
  p_decision text
) returns text
language plpgsql security definer set search_path = pg_catalog, licitaciones, core as $$
declare
  v_role text;
  v_table text;
  v_updated uuid;
  v_status text;
  v_proposed_by uuid;
begin
  if auth.uid() is null or auth.uid() is distinct from p_caller_id then
    raise exception 'decide_company_item: el llamador no coincide con la sesion' using errcode = '42501';
  end if;
  if p_decision not in ('aprobado', 'rechazado') then
    raise exception 'decide_company_item: decision invalida' using errcode = '22023';
  end if;
  v_table := case p_kind
    when 'rate' then 'approved_rate'
    when 'document' then 'company_document'
    when 'capability' then 'company_capability'
    when 'experience' then 'company_experience'
    when 'signer' then 'company_signer'
  end;
  if v_table is null then
    raise exception 'decide_company_item: tipo invalido' using errcode = '22023';
  end if;

  select m.vertical_role into v_role from core.membership m
   where m.user_id = p_caller_id and m.organization_id = p_organization_id;
  if v_role is null
     or (p_kind = 'rate' and v_role not in ('owner', 'admin'))
     or (p_kind <> 'rate' and v_role not in ('owner', 'admin', 'analyst')) then
    raise exception 'decide_company_item: rol sin permiso de decision' using errcode = '42501';
  end if;

  -- Transicion atomica y condicional: bajo concurrencia la segunda sentencia espera el candado de fila, vuelve a
  -- evaluar `approval_status = 'pendiente_aprobacion'` y no encuentra fila -> se clasifica abajo como 'conflict'.
  execute format(
    'update licitaciones.%I set approval_status = $1, approved_by = $2, approved_at = now()
      where id = $3 and organization_id = $4 and approval_status = ''pendiente_aprobacion''
        and (proposed_by is null or proposed_by <> $2)
      returning id', v_table)
    into v_updated using p_decision, p_caller_id, p_item_id, p_organization_id;

  if v_updated is null then
    execute format('select approval_status, proposed_by from licitaciones.%I where id = $1 and organization_id = $2', v_table)
      into v_status, v_proposed_by using p_item_id, p_organization_id;
    if v_status is null then
      return 'not_found';
    end if;
    if v_status = 'pendiente_aprobacion' and v_proposed_by = p_caller_id then
      return 'autor';
    end if;
    return 'conflict';
  end if;

  insert into licitaciones.company_data_audit (organization_id, kind, item_id, decision, actor_id)
  values (p_organization_id, p_kind, p_item_id, p_decision, p_caller_id);
  return 'ok';
end;
$$;

revoke all on function licitaciones.decide_company_item(uuid, uuid, text, uuid, text) from public, anon;
grant execute on function licitaciones.decide_company_item(uuid, uuid, text, uuid, text) to authenticated;
