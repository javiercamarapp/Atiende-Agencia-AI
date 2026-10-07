-- Huella cruzada entre fuentes (paridad3 L-P3-14 / REQ-152): la misma convocatoria que llega por dos fuentes (NL-OCDS y un agregador)
-- ya no se duplica. Prefijo de supabase/migrations: 20240101000344 (interno licitaciones 037).
-- Requiere: 001/007 (licitaciones.tender), 024 (system_ingest_tender), 002 (can_access_org / can_write_org).
--
-- Defecto (disponibilidad/consistencia): `on conflict (organization_id, source, external_id)` solo deduplica DENTRO de una fuente. El
-- mismo procedimiento publicado por dos fuentes creaba dos convocatorias (y dos juegos de avisos, versiones y recordatorios).
--
-- Que agrega:
--   1) licitaciones.tender.procedure_number y .cross_source_fingerprint (+ indice parcial por organizacion).
--   2) licitaciones.tender_norm_text / tender_fingerprint: huella = sha256(procedimiento | convocante | fecha de presentacion en hora de
--      Mexico), con el texto normalizado (NFC, sin diacriticos, MAYUSCULAS, espacios colapsados). Si falta cualquiera de los tres datos la
--      huella es NULL: sin dato suficiente NO se deduplica (preferimos un duplicado visible a una fusion falsa).
--   3) trigger tender_set_fingerprint: la huella SIEMPRE la calcula la base (cualquier valor que mande un cliente se sobrescribe). En altas
--      manuales sin procedure_number, el folio (external_id) es el numero de procedimiento: es el campo "Folio / numero de referencia" de la
--      pantalla de alta.
--   4) backfill de procedure_number/huella para las convocatorias manuales existentes. Las de otras fuentes NO tienen numero de procedimiento
--      guardado: quedan sin huella (no se inventa) hasta que su fuente lo entregue en la siguiente ingesta.
--   5) licitaciones.tender_alt_source: las fuentes ADICIONALES de una convocatoria y los conflictos de campos detectados. La fuente primaria
--      sigue siendo tender.source/external_id; `sources[]` = primaria + estas filas.
--   6) licitaciones.system_ingest_tender_dedupe: ingesta de solo-sistema que busca primero por huella y, si existe otra fuente, ENLAZA en vez
--      de crear; los campos de la fuente nueva que difieren se registran como conflictos y NO sobrescriben la convocatoria en silencio.
--
-- Seguridad (cada objeto):
--   * tender_norm_text / tender_fingerprint: funciones puras (sin acceso a tablas), `security invoker`, search_path fijo, revoke de public;
--     grant a authenticated (las ejecuta el trigger con los privilegios de quien escribe) y service_role.
--   * tender_alt_source: RLS habilitada; UNICA policy = select con licitaciones.can_access_org (un miembro ve solo las de su organizacion).
--     Sin policies ni GRANT de insert/update/delete a authenticated: solo la funcion de sistema (definer) y service_role escriben. Sin GRANT a anon.
--   * system_ingest_tender_dedupe: security definer con search_path fijo, revoke de public, grant a authenticated Y guard
--     `auth.uid() is null` (solo la sesion de sistema; un staff autenticado recibe 42501), igual que system_ingest_tender (024). Rechaza
--     source = 'manual' y valida que la fila enlazada sea de la MISMA organizacion (cross-tenant imposible: toda busqueda filtra por
--     p_organization_id). Un advisory lock transaccional por (organizacion, huella) serializa dos fuentes que llegan a la vez.

-- ---------------------------------------------------------------------------
-- 1) Columnas e indice
-- ---------------------------------------------------------------------------
alter table licitaciones.tender add column if not exists procedure_number text;
alter table licitaciones.tender add column if not exists cross_source_fingerprint text;
create index if not exists tender_cross_source_fingerprint_idx
  on licitaciones.tender (organization_id, cross_source_fingerprint)
  where cross_source_fingerprint is not null;

-- ---------------------------------------------------------------------------
-- 2) Normalizacion y huella
-- ---------------------------------------------------------------------------
create or replace function licitaciones.tender_norm_text(p_text text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select nullif(
    btrim(regexp_replace(upper(regexp_replace(normalize(normalize(coalesce(p_text, ''), NFC), NFD), '[̀-ͯ]', '', 'g')), '\s+', ' ', 'g')),
    ''
  );
$$;

create or replace function licitaciones.tender_fingerprint(p_procedure_number text, p_contracting_body text, p_submission_deadline timestamptz)
returns text
language sql
stable
set search_path = pg_catalog
as $$
  select case
    when licitaciones.tender_norm_text(p_procedure_number) is null
      or licitaciones.tender_norm_text(p_contracting_body) is null
      or p_submission_deadline is null then null
    else encode(
      sha256(convert_to(
        licitaciones.tender_norm_text(p_procedure_number) || '|' ||
        licitaciones.tender_norm_text(p_contracting_body) || '|' ||
        to_char(p_submission_deadline at time zone 'America/Mexico_City', 'YYYY-MM-DD'),
        'UTF8')),
      'hex')
  end;
$$;

revoke execute on function licitaciones.tender_norm_text(text) from public;
revoke execute on function licitaciones.tender_fingerprint(text, text, timestamptz) from public;
grant execute on function licitaciones.tender_norm_text(text) to authenticated, service_role;
grant execute on function licitaciones.tender_fingerprint(text, text, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) Trigger: la huella siempre la calcula la base
-- ---------------------------------------------------------------------------
create or replace function licitaciones.tender_set_fingerprint()
returns trigger
language plpgsql
set search_path = pg_catalog, licitaciones
as $$
begin
  if new.source = 'manual' and new.procedure_number is null and new.external_id is not null then
    new.procedure_number := new.external_id;
  end if;
  new.cross_source_fingerprint := licitaciones.tender_fingerprint(new.procedure_number, new.contracting_body, new.submission_deadline);
  return new;
end;
$$;

revoke execute on function licitaciones.tender_set_fingerprint() from public;

drop trigger if exists tender_set_fingerprint on licitaciones.tender;
create trigger tender_set_fingerprint
  before insert or update on licitaciones.tender
  for each row execute function licitaciones.tender_set_fingerprint();

-- ---------------------------------------------------------------------------
-- 4) Backfill (dispara el trigger, que calcula la huella)
-- ---------------------------------------------------------------------------
update licitaciones.tender
   set procedure_number = external_id
 where source = 'manual' and external_id is not null and procedure_number is null;

-- ---------------------------------------------------------------------------
-- 5) Fuentes adicionales y conflictos
-- ---------------------------------------------------------------------------
create table if not exists licitaciones.tender_alt_source (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  tender_id uuid not null references licitaciones.tender(id) on delete cascade,
  source text not null,
  external_id text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- [{field, current, alternative}]: lo que esta fuente dice distinto de la convocatoria (que conserva el valor de la fuente primaria).
  conflicts jsonb not null default '[]'::jsonb,
  constraint tender_alt_source_conflicts_array check (jsonb_typeof(conflicts) = 'array'),
  unique (organization_id, source, external_id)
);
create index if not exists tender_alt_source_tender_idx on licitaciones.tender_alt_source (organization_id, tender_id);

alter table licitaciones.tender_alt_source enable row level security;
drop policy if exists "org ve las fuentes adicionales de sus convocatorias" on licitaciones.tender_alt_source;
create policy "org ve las fuentes adicionales de sus convocatorias" on licitaciones.tender_alt_source
  for select using (licitaciones.can_access_org(organization_id));

revoke all on licitaciones.tender_alt_source from public, anon;
grant select on licitaciones.tender_alt_source to authenticated;
grant select, insert, update, delete on licitaciones.tender_alt_source to service_role;

-- ---------------------------------------------------------------------------
-- 6) Ingesta de sistema con deduplicacion por huella
-- ---------------------------------------------------------------------------
create or replace function licitaciones.system_ingest_tender_dedupe(
  p_organization_id uuid,
  p_title text,
  p_submission_deadline timestamptz,
  p_source text,
  p_external_id text,
  p_contracting_body text,
  p_cpv_codes text[],
  p_budget_amount numeric,
  p_currency text,
  p_state text,
  p_procedure_type_raw text,
  p_procedure_number text
)
returns table (
  out_id uuid,
  out_organization_id uuid,
  out_title text,
  out_submission_deadline text,
  out_updated_at text,
  out_source text,
  out_external_id text,
  out_contracting_body text,
  out_cpv_codes text[],
  out_budget_amount text,
  out_currency text,
  out_state text,
  out_procedure_type_raw text,
  out_status text,
  out_inserted boolean,
  out_linked boolean,
  out_conflicts integer
)
language plpgsql security definer set search_path = pg_catalog, licitaciones as $$
declare
  v_fp text;
  v_tender licitaciones.tender%rowtype;
  v_alt licitaciones.tender_alt_source%rowtype;
  v_conflicts jsonb;
  v_inserted boolean := false;
  v_linked boolean := false;
begin
  if auth.uid() is not null then
    raise exception 'system_ingest_tender_dedupe es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_source = 'manual' then
    raise exception 'system_ingest_tender_dedupe: "source" no puede ser "manual" -- ese camino de escritura es upsertTenderManual(), nunca este.';
  end if;
  if p_external_id is null or btrim(p_external_id) = '' then
    raise exception 'system_ingest_tender_dedupe: external_id es obligatorio (clave natural de la fuente).';
  end if;

  v_fp := licitaciones.tender_fingerprint(p_procedure_number, p_contracting_body, p_submission_deadline);
  -- Serializa dos fuentes que traen el mismo procedimiento a la vez (evita crear dos convocatorias en carrera).
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || coalesce(v_fp, p_source || ':' || p_external_id), 0));

  -- (a) Ya existe como fuente PRIMARIA de una convocatoria: actualiza igual que antes.
  select * into v_tender from licitaciones.tender
   where organization_id = p_organization_id and source = p_source and external_id = p_external_id;
  if found then
    update licitaciones.tender set
      title = p_title,
      submission_deadline = p_submission_deadline,
      contracting_body = p_contracting_body,
      cpv_codes = p_cpv_codes,
      budget_amount = p_budget_amount,
      currency = p_currency,
      state = p_state,
      procedure_type_raw = p_procedure_type_raw,
      procedure_number = coalesce(p_procedure_number, procedure_number),
      updated_at = now()
     where id = v_tender.id
     returning * into v_tender;
  else
    -- (b) Ya esta enlazada como fuente ADICIONAL: refresca `last_seen_at` y recalcula sus conflictos; no toca la convocatoria.
    select * into v_alt from licitaciones.tender_alt_source
     where organization_id = p_organization_id and source = p_source and external_id = p_external_id;
    if found then
      select * into v_tender from licitaciones.tender where id = v_alt.tender_id and organization_id = p_organization_id;
      v_linked := true;
    elsif v_fp is not null then
      -- (c) Otra fuente ya trajo este mismo procedimiento (misma huella): enlaza en vez de crear.
      select * into v_tender from licitaciones.tender
       where organization_id = p_organization_id and cross_source_fingerprint = v_fp and source <> p_source
       order by created_at asc, id asc limit 1;
      if found then
        v_linked := true;
      end if;
    end if;

    if v_linked then
      select coalesce(jsonb_agg(jsonb_build_object('field', x.f, 'current', x.c, 'alternative', x.a)), '[]'::jsonb) into v_conflicts
        from (values
          ('title', to_jsonb(licitaciones.tender_norm_text(v_tender.title)), to_jsonb(licitaciones.tender_norm_text(p_title))),
          ('contracting_body', to_jsonb(licitaciones.tender_norm_text(v_tender.contracting_body)), to_jsonb(licitaciones.tender_norm_text(p_contracting_body))),
          ('submission_deadline', to_jsonb(v_tender.submission_deadline), to_jsonb(p_submission_deadline)),
          ('budget_amount', to_jsonb(v_tender.budget_amount), to_jsonb(p_budget_amount)),
          ('currency', to_jsonb(v_tender.currency), to_jsonb(p_currency)),
          ('state', to_jsonb(licitaciones.tender_norm_text(v_tender.state)), to_jsonb(licitaciones.tender_norm_text(p_state))),
          ('procedure_type_raw', to_jsonb(licitaciones.tender_norm_text(v_tender.procedure_type_raw)), to_jsonb(licitaciones.tender_norm_text(p_procedure_type_raw))),
          ('cpv_codes', to_jsonb(v_tender.cpv_codes), to_jsonb(p_cpv_codes))
        ) as x(f, c, a)
       where x.c is distinct from x.a;
      insert into licitaciones.tender_alt_source (organization_id, tender_id, source, external_id, conflicts)
        values (p_organization_id, v_tender.id, p_source, p_external_id, v_conflicts)
        on conflict (organization_id, source, external_id)
        do update set last_seen_at = now(), conflicts = excluded.conflicts;
    else
      -- (d) Convocatoria nueva.
      insert into licitaciones.tender
        (organization_id, title, submission_deadline, source, external_id, contracting_body, cpv_codes, budget_amount, currency, state, procedure_type_raw, procedure_number, created_by)
      values
        (p_organization_id, p_title, p_submission_deadline, p_source, p_external_id, p_contracting_body, p_cpv_codes, p_budget_amount, p_currency, p_state, p_procedure_type_raw, p_procedure_number, null)
      returning * into v_tender;
      v_inserted := true;
    end if;
  end if;

  return query select
    v_tender.id, v_tender.organization_id, v_tender.title, v_tender.submission_deadline::text, v_tender.updated_at::text,
    v_tender.source, v_tender.external_id, v_tender.contracting_body, v_tender.cpv_codes, v_tender.budget_amount::text,
    v_tender.currency, v_tender.state, v_tender.procedure_type_raw, v_tender.status,
    v_inserted, v_linked, case when v_linked then jsonb_array_length(coalesce(v_conflicts, '[]'::jsonb)) else 0 end;
end;
$$;

revoke execute on function licitaciones.system_ingest_tender_dedupe(uuid, text, timestamptz, text, text, text, text[], numeric, text, text, text, text) from public;
grant execute on function licitaciones.system_ingest_tender_dedupe(uuid, text, timestamptz, text, text, text, text[], numeric, text, text, text, text) to authenticated;
