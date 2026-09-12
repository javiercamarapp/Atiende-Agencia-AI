-- Fase 3 — Matching/Scoring y Go/No-Go, pieza 2: decisiones Go/No-Go (§7 del
-- diseño). Requiere: 007_matching_profile.sql (columna `licitaciones.tender.status`
-- que esta migración empieza a escribir).

create table licitaciones.go_no_go_decision (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  tender_id uuid not null references licitaciones.tender(id) on delete cascade,
  decision text not null check (decision in ('go', 'no_go')),
  -- Nunca una decisión sin motivo explícito, mismo criterio que el origen
  -- (go-no-go.schemas.ts::reasons.min(1)).
  reasons text[] not null check (array_length(reasons, 1) >= 1),
  -- Snapshot INMUTABLE del `MatchResult` vigente en el momento exacto de
  -- decidir -- nunca se recalcula retroactivamente ni se acepta uno que el
  -- cliente proponga (mismo principio que `inputs_hash` en
  -- `licitaciones.approval`: nada de lo que decide "aprobado"/"go" viene del
  -- request).
  match_score numeric not null,
  match_eligibility_status text not null check (match_eligibility_status in ('cumple', 'no_cumple', 'no_evaluable')),
  match_inputs_hash text not null,
  decided_by uuid not null references core.staff_user(id) on delete restrict,
  decided_at timestamptz not null default now()
);
create index go_no_go_tender_idx on licitaciones.go_no_go_decision (tender_id, decided_at desc);

-- Roles de decisión (§7 del diseño, GO_NO_GO_ROLES = DECISION_ROLES + reviewer):
-- distinto de `can_decide_org` (que es exactamente DECISION_ROLES, sin
-- reviewer) -- ver domain-licitaciones/src/roles.ts::GO_NO_GO_ROLES, que esta
-- función replica sin reinventar el conjunto.
create or replace function licitaciones.can_go_no_go_org(_organization_id uuid)
returns boolean language sql stable security definer set search_path = core as $$
  select exists (
    select 1 from core.membership m
    where m.organization_id = _organization_id and m.user_id = auth.uid()
      and m.vertical_role in ('owner', 'admin', 'analyst', 'reviewer')
  )
$$;

alter table licitaciones.go_no_go_decision enable row level security;

-- Lectura: cualquier miembro de la organización -- decidir es privilegiado,
-- *ver* la decisión no (mismo criterio que el origen).
create policy "org ve sus decisiones go/no-go" on licitaciones.go_no_go_decision for select using (licitaciones.can_access_org(organization_id));

-- Decisión: INSERT restringido a GO_NO_GO_ROLES -- writer/viewer nunca
-- deciden, sin importar el estado de la aplicación (enforcement doble,
-- aplicación + RLS, mismo criterio que el origen). No hay UPDATE/DELETE: una
-- decisión registrada es un hecho histórico inmutable -- reabrir un "no_go"
-- se hace con una NUEVA fila "go", nunca editando la anterior.
create policy "decisión: roles go/no-go registran su decisión" on licitaciones.go_no_go_decision for insert with check (licitaciones.can_go_no_go_org(organization_id));

revoke all on licitaciones.go_no_go_decision from public, anon;
grant select on licitaciones.go_no_go_decision to authenticated;
grant insert on licitaciones.go_no_go_decision to authenticated;
grant select, insert, update, delete on licitaciones.go_no_go_decision to service_role;
