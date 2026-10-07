-- 040: perfil de empresa COMPLETO (REQ-141) y procedencia por campo (REQ-142).
-- Requiere: 002 (can_access_org/can_write_org/can_decide_org), 009/021 (company_signer), 036 (aprobacion de datos de empresa).
--
-- Problema que cierra (L-P3-03/04): el perfil de empresa solo tenia documentos, tarifas, capacidades, experiencia y firmantes. No habia
-- perfil general, productos y servicios, ubicaciones, restricciones ni socios, asi que no se podia estratificar MIPyME (REQ-109), detectar
-- interposita persona (REQ-111) ni saber si el firmante tiene poder vigente el dia de la presentacion (REQ-145). Y `company_signer`
-- permitia UN solo firmante por cargo y no tenia vigencia del poder.
--
-- Que agrega:
--   1. Cinco tablas nuevas: `company_profile` (una por organizacion), `company_product_service`, `company_location`, `company_restriction`
--      y `company_stakeholder` (socios y representantes). Misma forma de aprobacion que la 036 (`approval_status`, `proposed_by`,
--      `approved_by`, `approved_at`) y el mismo trigger `company_data_proponer`: nacen pendientes, editar un dato aprobado lo regresa a
--      pendiente en la misma sentencia y `proposed_by` lo fija la base con `auth.uid()`.
--   2. `company_signer`: quita el unico `(organization_id, role)` (varios firmantes por cargo) y agrega vigencia del poder
--      (`valid_from`/`valid_until`), referencia al documento de identidad o poder (`identity_doc_id`, validada contra la MISMA organizacion por
--      trigger) y limites de actuacion (`action_limits`, texto).
--   3. `field_provenance` (REQ-142): quien capturo cada dato y cuando. SOLO la escribe `licitaciones.record_field_provenance` (security
--      definer). `authenticated` no tiene INSERT/UPDATE/DELETE: una fila insertada por SQL directo (o por mantenimiento) nunca tiene
--      procedencia y, para las entidades que la exigen, el dato queda bloqueado en el expediente y no evaluable en el matching.
--   4. `decide_company_item` (036) se redefine para aceptar los cinco tipos nuevos (mismos roles que el resto: owner/admin/analyst, autor
--      distinto del aprobador, transicion atomica y condicional) y `company_data_audit.kind` admite los tipos nuevos.
--   5. `requirement_fulfillment_mapping.kind` admite los datos nuevos (perfil, socios, restricciones, ubicaciones, productos) para que un
--      requisito del expediente se redacte desde ellos y, sin procedencia, quede bloqueado.
--   6. `system_count_signer_powers_expiring`: solo sistema, cuenta firmantes aprobados y autorizados cuyo poder vence en la ventana (alimenta el
--      aviso in-app "poder de firmante por vencer" desde el barrido existente; un entero, sin nombres).
--
-- Justificacion de cada GRANT/policy/funcion:
--   * GRANT select de las tablas nuevas a authenticated + policy `can_access_org`: la pantalla de Datos de empresa las lee; cada organizacion
--     solo ve las suyas. Nada para anon.
--   * GRANT insert/update POR COLUMNA: solo las columnas de DATO que escriben las rutas reales; `approval_status`, `proposed_by`,
--     `approved_by` y `approved_at` quedan fuera (el unico camino a aprobado/rechazado es `decide_company_item`). Policies de escritura con
--     `can_write_org`.
--   * GRANT delete en producto, ubicacion, restriccion y socio: dar de baja un elemento equivocado. Producto y ubicacion con `can_write_org`;
--     restriccion y socio con `can_decide_org` (borrar una restriccion o un socio cambia la elegibilidad y la deteccion de interposita
--     persona: lo decide quien tiene rol de decision; la API ademas deja renglon en la bitacora de escrituras con el antes). El perfil general
--     no se borra y los firmantes no tienen DELETE (se desautorizan: queda el rastro).
--   * `record_field_provenance`: SECURITY DEFINER, search_path fijo, REVOKE de public/anon. Exige `auth.uid() = p_caller_id`, rol de escritura
--     en la organizacion y que el registro EXISTA en esa organizacion (no se crea procedencia de datos ajenos ni inexistentes). Upsert por
--     (organizacion, entidad, id, campo): la ultima captura gana y `owner_user_id` es siempre el llamador.
--   * `system_count_signer_powers_expiring`: solo-sistema (`auth.uid() is null`), definer porque el barrido de sistema no pasa por la policy de
--     `company_signer`; devuelve un entero.
--
-- Datos existentes: ninguno cambia. Las tablas nuevas nacen vacias; los firmantes existentes quedan con vigencia NULL (sin vigencia capturada:
-- el codigo conserva su comportamiento anterior para ellos) y el hash del perfil no cambia por migrar.
--
-- Compatibilidad con la base sin migrar: el TypeScript detecta las tablas/columnas/funciones faltantes (42P01/42703/42883) dentro de un
-- SAVEPOINT y responde vacio honesto ("no disponible aun"), nunca un 500. ORDEN DE DESPLIEGUE: primero el codigo, despues esta migracion.

-- ---------------------------------------------------------------------------
-- 1. Tablas nuevas
-- ---------------------------------------------------------------------------
create table licitaciones.company_profile (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references core.organization(id) on delete cascade,
  legal_name text not null check (char_length(btrim(legal_name)) between 1 and 300),
  tax_id text not null check (tax_id ~ '^[A-ZÑ&]{3,4}[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])[A-Z0-9]{2}[0-9A]$'),
  trade_name text check (trade_name is null or char_length(btrim(trade_name)) between 1 and 300),
  sector text check (sector is null or sector in ('industria', 'comercio', 'servicios')),
  founded_year integer check (founded_year is null or founded_year between 1800 and 2200),
  employee_count integer check (employee_count is null or employee_count >= 0),
  annual_sales_cents bigint check (annual_sales_cents is null or annual_sales_cents >= 0),
  website text check (website is null or (website ~ '^https?://' and char_length(website) <= 300)),
  approval_status text not null default 'pendiente_aprobacion' check (approval_status in ('aprobado', 'pendiente_aprobacion', 'rechazado')),
  proposed_by uuid references core.staff_user(id) on delete set null,
  approved_by uuid references core.staff_user(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

create table licitaciones.company_product_service (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  kind text not null check (kind in ('producto', 'servicio')),
  name text not null check (char_length(btrim(name)) between 1 and 300),
  description text check (description is null or char_length(description) <= 2000),
  classifier_code text check (classifier_code is null or char_length(btrim(classifier_code)) between 1 and 40),
  approval_status text not null default 'pendiente_aprobacion' check (approval_status in ('aprobado', 'pendiente_aprobacion', 'rechazado')),
  proposed_by uuid references core.staff_user(id) on delete set null,
  approved_by uuid references core.staff_user(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now()
);
create index company_product_service_org_idx on licitaciones.company_product_service (organization_id);

create table licitaciones.company_location (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  kind text not null check (kind in ('matriz', 'sucursal', 'bodega', 'planta')),
  name text not null check (char_length(btrim(name)) between 1 and 300),
  state text not null check (char_length(btrim(state)) between 1 and 100),
  municipality text check (municipality is null or char_length(btrim(municipality)) between 1 and 150),
  address text check (address is null or char_length(address) <= 400),
  approval_status text not null default 'pendiente_aprobacion' check (approval_status in ('aprobado', 'pendiente_aprobacion', 'rechazado')),
  proposed_by uuid references core.staff_user(id) on delete set null,
  approved_by uuid references core.staff_user(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now()
);
create index company_location_org_idx on licitaciones.company_location (organization_id);

create table licitaciones.company_restriction (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  kind text not null check (kind in ('inhabilitacion', 'sancion', 'conflicto_interes', 'otra')),
  description text not null check (char_length(btrim(description)) between 1 and 1000),
  valid_from date not null,
  valid_until date check (valid_until is null or valid_until >= valid_from),
  approval_status text not null default 'pendiente_aprobacion' check (approval_status in ('aprobado', 'pendiente_aprobacion', 'rechazado')),
  proposed_by uuid references core.staff_user(id) on delete set null,
  approved_by uuid references core.staff_user(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now()
);
create index company_restriction_org_idx on licitaciones.company_restriction (organization_id);

create table licitaciones.company_stakeholder (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  kind text not null check (kind in ('socio', 'representante')),
  full_name text not null check (char_length(btrim(full_name)) between 1 and 300),
  rfc text check (rfc is null or rfc ~ '^[A-ZÑ&]{3,4}[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])[A-Z0-9]{2}[0-9A]$'),
  -- Porcentaje con dos decimales (REQ-141). Solo los socios participan; un representante no tiene porcentaje.
  participation_pct numeric(5, 2) check (participation_pct is null or (participation_pct >= 0 and participation_pct <= 100)),
  approval_status text not null default 'pendiente_aprobacion' check (approval_status in ('aprobado', 'pendiente_aprobacion', 'rechazado')),
  proposed_by uuid references core.staff_user(id) on delete set null,
  approved_by uuid references core.staff_user(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  check (kind = 'socio' or participation_pct is null)
);
create index company_stakeholder_org_idx on licitaciones.company_stakeholder (organization_id);

-- Mismo trigger de la 036 (SIN security definer: corre como quien llama).
create trigger company_profile_proponer before insert or update on licitaciones.company_profile
  for each row execute function licitaciones.company_data_proponer();
create trigger company_product_service_proponer before insert or update on licitaciones.company_product_service
  for each row execute function licitaciones.company_data_proponer();
create trigger company_location_proponer before insert or update on licitaciones.company_location
  for each row execute function licitaciones.company_data_proponer();
create trigger company_restriction_proponer before insert or update on licitaciones.company_restriction
  for each row execute function licitaciones.company_data_proponer();
create trigger company_stakeholder_proponer before insert or update on licitaciones.company_stakeholder
  for each row execute function licitaciones.company_data_proponer();

alter table licitaciones.company_profile enable row level security;
alter table licitaciones.company_product_service enable row level security;
alter table licitaciones.company_location enable row level security;
alter table licitaciones.company_restriction enable row level security;
alter table licitaciones.company_stakeholder enable row level security;

create policy "org ve su perfil de empresa" on licitaciones.company_profile for select using (licitaciones.can_access_org(organization_id));
create policy "org ve sus productos y servicios" on licitaciones.company_product_service for select using (licitaciones.can_access_org(organization_id));
create policy "org ve sus ubicaciones" on licitaciones.company_location for select using (licitaciones.can_access_org(organization_id));
create policy "org ve sus restricciones" on licitaciones.company_restriction for select using (licitaciones.can_access_org(organization_id));
create policy "org ve sus socios y representantes" on licitaciones.company_stakeholder for select using (licitaciones.can_access_org(organization_id));

create policy "escritura: roles de escritura registran el perfil" on licitaciones.company_profile for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura actualizan el perfil" on licitaciones.company_profile for update using (licitaciones.can_write_org(organization_id)) with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura registran productos" on licitaciones.company_product_service for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura actualizan productos" on licitaciones.company_product_service for update using (licitaciones.can_write_org(organization_id)) with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura dan de baja productos" on licitaciones.company_product_service for delete using (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura registran ubicaciones" on licitaciones.company_location for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura actualizan ubicaciones" on licitaciones.company_location for update using (licitaciones.can_write_org(organization_id)) with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura dan de baja ubicaciones" on licitaciones.company_location for delete using (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura registran restricciones" on licitaciones.company_restriction for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura actualizan restricciones" on licitaciones.company_restriction for update using (licitaciones.can_write_org(organization_id)) with check (licitaciones.can_write_org(organization_id));
create policy "decision: roles de decision dan de baja restricciones" on licitaciones.company_restriction for delete using (licitaciones.can_decide_org(organization_id));
create policy "escritura: roles de escritura registran socios" on licitaciones.company_stakeholder for insert with check (licitaciones.can_write_org(organization_id));
create policy "escritura: roles de escritura actualizan socios" on licitaciones.company_stakeholder for update using (licitaciones.can_write_org(organization_id)) with check (licitaciones.can_write_org(organization_id));
create policy "decision: roles de decision dan de baja socios" on licitaciones.company_stakeholder for delete using (licitaciones.can_decide_org(organization_id));

revoke all on licitaciones.company_profile, licitaciones.company_product_service, licitaciones.company_location, licitaciones.company_restriction, licitaciones.company_stakeholder from public, anon;
grant select on licitaciones.company_profile, licitaciones.company_product_service, licitaciones.company_location, licitaciones.company_restriction, licitaciones.company_stakeholder to authenticated;
grant insert (organization_id, legal_name, tax_id, trade_name, sector, founded_year, employee_count, annual_sales_cents, website) on licitaciones.company_profile to authenticated;
grant update (legal_name, tax_id, trade_name, sector, founded_year, employee_count, annual_sales_cents, website) on licitaciones.company_profile to authenticated;
grant insert (organization_id, kind, name, description, classifier_code) on licitaciones.company_product_service to authenticated;
grant update (kind, name, description, classifier_code) on licitaciones.company_product_service to authenticated;
grant insert (organization_id, kind, name, state, municipality, address) on licitaciones.company_location to authenticated;
grant update (kind, name, state, municipality, address) on licitaciones.company_location to authenticated;
grant insert (organization_id, kind, description, valid_from, valid_until) on licitaciones.company_restriction to authenticated;
grant update (kind, description, valid_from, valid_until) on licitaciones.company_restriction to authenticated;
grant insert (organization_id, kind, full_name, rfc, participation_pct) on licitaciones.company_stakeholder to authenticated;
grant update (kind, full_name, rfc, participation_pct) on licitaciones.company_stakeholder to authenticated;
grant delete on licitaciones.company_product_service, licitaciones.company_location, licitaciones.company_restriction, licitaciones.company_stakeholder to authenticated;
grant select, insert, update, delete on licitaciones.company_profile, licitaciones.company_product_service, licitaciones.company_location, licitaciones.company_restriction, licitaciones.company_stakeholder to service_role;

-- ---------------------------------------------------------------------------
-- 2. Firmantes: varios por cargo, vigencia del poder, documento de identidad y limites
-- ---------------------------------------------------------------------------
do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'licitaciones.company_signer'::regclass and contype = 'u' loop
    execute format('alter table licitaciones.company_signer drop constraint %I', c);
  end loop;
end $$;

alter table licitaciones.company_signer
  add column valid_from date,
  add column valid_until date,
  add column identity_doc_id uuid references licitaciones.company_document(id) on delete set null,
  add column action_limits text check (action_limits is null or char_length(action_limits) <= 1000),
  add constraint company_signer_vigencia_check check (valid_until is null or valid_from is null or valid_until >= valid_from);
create index company_signer_org_role_idx on licitaciones.company_signer (organization_id, role);

-- El documento de identidad/poder debe ser de la MISMA organizacion (el FK solo prueba que exista). Corre como quien llama: la RLS de
-- `company_document` oculta los documentos ajenos, asi que uno de otra organizacion cuenta como inexistente.
create or replace function licitaciones.company_signer_check_identity_doc()
returns trigger language plpgsql set search_path = pg_catalog, licitaciones as $$
begin
  if new.identity_doc_id is not null
     and not exists (select 1 from licitaciones.company_document d where d.id = new.identity_doc_id and d.organization_id = new.organization_id) then
    raise exception 'company_signer: el documento de identidad o poder no existe en esta organizacion' using errcode = '23503';
  end if;
  return new;
end;
$$;
revoke all on function licitaciones.company_signer_check_identity_doc() from public, anon;
create trigger company_signer_identity_doc_check before insert or update on licitaciones.company_signer
  for each row execute function licitaciones.company_signer_check_identity_doc();

grant insert (valid_from, valid_until, identity_doc_id, action_limits) on licitaciones.company_signer to authenticated;
grant update (valid_from, valid_until, identity_doc_id, action_limits) on licitaciones.company_signer to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Procedencia por campo (REQ-142)
-- ---------------------------------------------------------------------------
create table licitaciones.field_provenance (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  entity text not null check (entity in ('profile', 'product', 'location', 'restriction', 'stakeholder', 'signer', 'rate', 'document', 'capability', 'experience')),
  entity_id uuid not null,
  -- Nombre del campo o '*' = el registro completo.
  field text not null default '*' check (char_length(field) between 1 and 80),
  owner_user_id uuid references core.staff_user(id) on delete set null,
  source text not null check (source in ('manual', 'importado', 'asistente')),
  captured_at timestamptz not null default now(),
  unique (organization_id, entity, entity_id, field)
);
create index field_provenance_org_idx on licitaciones.field_provenance (organization_id, entity, entity_id);

alter table licitaciones.field_provenance enable row level security;
create policy "org ve la procedencia de sus datos" on licitaciones.field_provenance for select using (licitaciones.can_access_org(organization_id));
revoke all on licitaciones.field_provenance from public, anon;
grant select on licitaciones.field_provenance to authenticated;
grant select, insert, update, delete on licitaciones.field_provenance to service_role;

create or replace function licitaciones.record_field_provenance(
  p_caller_id uuid,
  p_organization_id uuid,
  p_entity text,
  p_entity_id uuid,
  p_fields text[],
  p_source text
) returns integer
language plpgsql security definer set search_path = pg_catalog, licitaciones, core as $$
declare
  v_table text;
  v_exists boolean;
  v_field text;
  v_count integer := 0;
begin
  if auth.uid() is null or auth.uid() is distinct from p_caller_id then
    raise exception 'record_field_provenance: el llamador no coincide con la sesion' using errcode = '42501';
  end if;
  if not licitaciones.can_write_org(p_organization_id) then
    raise exception 'record_field_provenance: rol sin permiso de escritura' using errcode = '42501';
  end if;
  v_table := case p_entity
    when 'profile' then 'company_profile'
    when 'product' then 'company_product_service'
    when 'location' then 'company_location'
    when 'restriction' then 'company_restriction'
    when 'stakeholder' then 'company_stakeholder'
    when 'signer' then 'company_signer'
    when 'rate' then 'approved_rate'
    when 'document' then 'company_document'
    when 'capability' then 'company_capability'
    when 'experience' then 'company_experience'
  end;
  if v_table is null or p_source is null or p_source not in ('manual', 'importado', 'asistente') then
    raise exception 'record_field_provenance: entidad o fuente invalida' using errcode = '22023';
  end if;
  if coalesce(array_length(p_fields, 1), 0) > 40 then
    raise exception 'record_field_provenance: demasiados campos' using errcode = '22023';
  end if;
  execute format('select exists (select 1 from licitaciones.%I where id = $1 and organization_id = $2)', v_table)
    into v_exists using p_entity_id, p_organization_id;
  if not v_exists then
    raise exception 'record_field_provenance: el registro no existe en la organizacion' using errcode = 'P0002';
  end if;

  foreach v_field in array (array['*']::text[] || coalesce(p_fields, '{}'::text[])) loop
    if v_field is null or char_length(v_field) not between 1 and 80 then
      raise exception 'record_field_provenance: nombre de campo invalido' using errcode = '22023';
    end if;
    insert into licitaciones.field_provenance (organization_id, entity, entity_id, field, owner_user_id, source, captured_at)
    values (p_organization_id, p_entity, p_entity_id, v_field, p_caller_id, p_source, now())
    on conflict (organization_id, entity, entity_id, field)
    do update set owner_user_id = excluded.owner_user_id, source = excluded.source, captured_at = excluded.captured_at;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function licitaciones.record_field_provenance(uuid, uuid, text, uuid, text[], text) from public, anon;
grant execute on function licitaciones.record_field_provenance(uuid, uuid, text, uuid, text[], text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Aprobacion de los tipos nuevos (redefine la funcion de la 036) y bitacora
-- ---------------------------------------------------------------------------
alter table licitaciones.company_data_audit drop constraint if exists company_data_audit_kind_check;
alter table licitaciones.company_data_audit
  add constraint company_data_audit_kind_check check (kind in ('rate', 'document', 'capability', 'experience', 'signer', 'profile', 'product', 'location', 'restriction', 'stakeholder'));

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
    when 'profile' then 'company_profile'
    when 'product' then 'company_product_service'
    when 'location' then 'company_location'
    when 'restriction' then 'company_restriction'
    when 'stakeholder' then 'company_stakeholder'
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

-- ---------------------------------------------------------------------------
-- 5. Aviso "poder de firmante por vencer" (solo sistema, un entero)
-- ---------------------------------------------------------------------------
create or replace function licitaciones.system_count_signer_powers_expiring(p_organization_id uuid, p_today date, p_days integer)
returns integer
language plpgsql
stable
security definer
set search_path = licitaciones, pg_temp
as $$
declare
  v_count integer;
begin
  if auth.uid() is not null then
    raise exception 'system_count_signer_powers_expiring es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if p_organization_id is null or p_today is null or p_days is null or p_days < 1 or p_days > 365 then
    raise exception 'system_count_signer_powers_expiring: parametros invalidos' using errcode = '22023';
  end if;
  select count(*)::integer into v_count
    from licitaciones.company_signer s
   where s.organization_id = p_organization_id
     and s.approval_status = 'aprobado'
     and s.authorized
     and s.valid_until is not null
     and s.valid_until >= p_today
     and s.valid_until <= p_today + p_days;
  return v_count;
end;
$$;
revoke all on function licitaciones.system_count_signer_powers_expiring(uuid, date, integer) from public, anon;
grant execute on function licitaciones.system_count_signer_powers_expiring(uuid, date, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Mapeos de cumplimiento hacia los datos nuevos del perfil
-- ---------------------------------------------------------------------------
-- Un requisito del expediente puede redactarse desde el perfil general, los socios, las restricciones, las ubicaciones o los productos y
-- servicios. Solo se amplia la lista cerrada de `kind`; las policies y los GRANT de la tabla no cambian (006).
alter table licitaciones.requirement_fulfillment_mapping drop constraint if exists requirement_fulfillment_mapping_kind_check;
alter table licitaciones.requirement_fulfillment_mapping
  add constraint requirement_fulfillment_mapping_kind_check
  check (kind in ('capability', 'experience', 'document', 'signer', 'profile', 'stakeholders', 'restrictions', 'locations', 'products'));
