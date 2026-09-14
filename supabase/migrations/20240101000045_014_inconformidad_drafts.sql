-- Fase 6 pieza 3 (REQ-053) — redactor de inconformidades. Genera un
-- BORRADOR estructurado (hechos/agravios/fundamentos/pruebas/plazo) a partir
-- de datos capturados por el usuario -- NUNCA se envía a ninguna autoridad
-- desde este sistema (ver `inconformidad.ts`/rutas HTTP, sin cliente HTTP
-- saliente). Cada generación es una fila NUEVA (versionado real, no edición
-- in-place) con `content_hash` -- el contenido es INMUTABLE tras crearse
-- (ver trigger abajo); la única mutación permitida es marcarlo como
-- "revisado" por un abogado humano (`status`/`reviewed_by`/`reviewed_at`).
-- Requiere: 001_licitaciones_schema.sql.

create table licitaciones.inconformidad_draft (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  tender_id uuid not null references licitaciones.tender(id) on delete cascade,
  version integer not null,
  status text not null default 'borrador' check (status in ('borrador', 'revisado')),
  content_hash text not null,
  hechos text[] not null,
  agravios text[] not null,
  pruebas text[] not null default '{}',
  -- Fundamentos legales citados (articulo/ley/jurisdicción/fecha DOF/texto), ver inconformidad.ts::buildFundamentos.
  fundamentos jsonb not null,
  fallo_notified_on date not null,
  bajo_tratados boolean not null default false,
  business_days integer not null,
  due_date date not null,
  legal_reference text not null,
  viability text not null check (viability in ('alta', 'media', 'baja')),
  viability_recommendation text not null,
  disclaimer text not null,
  reviewed_by uuid references core.staff_user(id) on delete set null,
  reviewed_at timestamptz,
  created_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, tender_id, version)
);
create index inconformidad_draft_tender_idx on licitaciones.inconformidad_draft (organization_id, tender_id, version);

-- ---------------------------------------------------------------------------
-- Inmutabilidad del CONTENIDO (defensa en profundidad, mismo espíritu que la
-- cadena de hashes de `licitaciones.approval_change`/`tender_audit_log`):
-- la aplicación solo debería emitir un UPDATE para marcar "revisado"
-- (status/reviewed_by/reviewed_at), nunca para tocar el contenido -- este
-- trigger lo hace IMPOSIBLE también si un bug futuro intentara editarlo.
-- ---------------------------------------------------------------------------
create or replace function licitaciones.protect_inconformidad_draft_content()
returns trigger language plpgsql as $$
begin
  if new.content_hash is distinct from old.content_hash
     or new.hechos is distinct from old.hechos
     or new.agravios is distinct from old.agravios
     or new.pruebas is distinct from old.pruebas
     or new.fundamentos is distinct from old.fundamentos
     or new.fallo_notified_on is distinct from old.fallo_notified_on
     or new.bajo_tratados is distinct from old.bajo_tratados
     or new.business_days is distinct from old.business_days
     or new.due_date is distinct from old.due_date
     or new.version is distinct from old.version
  then
    raise exception 'licitaciones.inconformidad_draft: el contenido es inmutable tras crearse -- genere una nueva versión en vez de editar (fila %).', old.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_inconformidad_draft_content on licitaciones.inconformidad_draft;
create trigger trg_protect_inconformidad_draft_content
  before update on licitaciones.inconformidad_draft
  for each row execute function licitaciones.protect_inconformidad_draft_content();

-- REQ-053: marcar un borrador como "revisado por abogado" exige
-- owner/admin/reviewer -- distinto (sin "analyst") de `can_decide_org`,
-- mismo criterio que `can_go_no_go_org` (migración 008): certificar la
-- revisión legal de un escrito es un rol distinto de decidir ir/no ir a una
-- licitación.
create or replace function licitaciones.can_review_inconformidad_org(_organization_id uuid)
returns boolean language sql stable security definer set search_path = core as $$
  select exists (
    select 1 from core.membership m
    where m.organization_id = _organization_id and m.user_id = auth.uid()
      and m.vertical_role in ('owner', 'admin', 'reviewer')
  )
$$;

alter table licitaciones.inconformidad_draft enable row level security;
create policy "org ve sus borradores de inconformidad" on licitaciones.inconformidad_draft for select using (licitaciones.can_access_org(organization_id));
create policy "escritura: roles de escritura generan borradores de inconformidad" on licitaciones.inconformidad_draft for insert with check (licitaciones.can_write_org(organization_id));
create policy "revisión: owner/admin/reviewer marcan un borrador como revisado" on licitaciones.inconformidad_draft for update
  using (licitaciones.can_review_inconformidad_org(organization_id)) with check (licitaciones.can_review_inconformidad_org(organization_id));

revoke all on licitaciones.inconformidad_draft from public, anon;
grant select, insert, update on licitaciones.inconformidad_draft to authenticated;
grant select, insert, update, delete on licitaciones.inconformidad_draft to service_role;
