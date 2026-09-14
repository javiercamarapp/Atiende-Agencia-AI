-- Fase 6 pieza 4 (REQ-054) — autopsia del fallo: informe estructurado
-- comparando la propuesta propia contra el fallo (motivo de desechamiento,
-- puntos/criterios, precio propio vs. ganador cuando el fallo es público).
-- REQ-054 explícito: "sin inventar datos ausentes -> 'no disponible'" -- por
-- eso `disqualification_reason`/`winner_name` NO son NOT NULL con default
-- vacío: la aplicación escribe literalmente la constante `NO_DISPONIBLE`
-- (`fallo-autopsy.ts::normalizeOrNoDisponible`) cuando el dato no se
-- capturó, en vez de dejar la columna NULL/"" ambigua.
-- Requiere: 001_licitaciones_schema.sql.

create table licitaciones.fallo_autopsy (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  tender_id uuid not null references licitaciones.tender(id) on delete cascade,
  own_proposal_status text not null default 'desconocido' check (own_proposal_status in ('ganadora', 'desechada', 'no_presentada', 'desconocido')),
  disqualification_reason text not null,
  own_score numeric(10, 2),
  winner_score numeric(10, 2),
  own_price numeric(14, 2),
  winner_price numeric(14, 2),
  winner_name text not null,
  criteria_comparison jsonb not null default '[]'::jsonb,
  created_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now()
);
create index fallo_autopsy_tender_idx on licitaciones.fallo_autopsy (organization_id, tender_id);

-- `company_lessons_learned`: lecciones registradas y vinculadas al PERFIL
-- DE EMPRESA (org-wide, no solo a la convocatoria puntual) -- consultables
-- sin filtrar por tender.
create table licitaciones.company_lesson_learned (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  fallo_autopsy_id uuid not null references licitaciones.fallo_autopsy(id) on delete cascade,
  tender_id uuid not null references licitaciones.tender(id) on delete cascade,
  lesson_text text not null,
  created_at timestamptz not null default now()
);
create index company_lesson_learned_org_idx on licitaciones.company_lesson_learned (organization_id, created_at);

alter table licitaciones.fallo_autopsy enable row level security;
create policy "org ve sus autopsias del fallo" on licitaciones.fallo_autopsy for select using (licitaciones.can_access_org(organization_id));
create policy "escritura: roles de escritura registran autopsias del fallo" on licitaciones.fallo_autopsy for insert with check (licitaciones.can_write_org(organization_id));

revoke all on licitaciones.fallo_autopsy from public, anon;
grant select, insert on licitaciones.fallo_autopsy to authenticated;
grant select, insert, update, delete on licitaciones.fallo_autopsy to service_role;

alter table licitaciones.company_lesson_learned enable row level security;
create policy "org ve sus lecciones aprendidas" on licitaciones.company_lesson_learned for select using (licitaciones.can_access_org(organization_id));
create policy "escritura: roles de escritura registran lecciones aprendidas" on licitaciones.company_lesson_learned for insert with check (licitaciones.can_write_org(organization_id));

revoke all on licitaciones.company_lesson_learned from public, anon;
grant select, insert on licitaciones.company_lesson_learned to authenticated;
grant select, insert, update, delete on licitaciones.company_lesson_learned to service_role;
