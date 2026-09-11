-- Idempotencia vertical-scoped — mismo patrón que
-- hoteles.idempotency_key/restaurantes.create_order_idempotent (ver diseño
-- Fase 1 §3.3): NUNCA la tabla `idempotency_keys` a nivel de organización
-- completa que tenía el origen (GUC-scoped) — cada vertical mantiene la
-- suya, en su propio esquema. Scopes reales usados por las 3 rutas Hono:
-- 'checklist.run' | 'proposal.economic.generate' | 'package.assemble' |
-- 'submission.declare'.
create table licitaciones.idempotency_key (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  scope text not null check (length(scope) between 1 and 60),
  key text not null check (length(key) between 1 and 200),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  response jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  unique (organization_id, scope, key)
);
create index idempotency_key_org_scope_idx on licitaciones.idempotency_key (organization_id, scope);

alter table licitaciones.idempotency_key enable row level security;

create policy "org ve sus llaves de idempotencia" on licitaciones.idempotency_key for select
  using (exists (select 1 from core.membership m where m.organization_id = idempotency_key.organization_id and m.user_id = auth.uid()));
create policy "org inserta llaves de idempotencia" on licitaciones.idempotency_key for insert
  with check (exists (select 1 from core.membership m where m.organization_id = idempotency_key.organization_id and m.user_id = auth.uid()));
create policy "org actualiza llaves de idempotencia" on licitaciones.idempotency_key for update
  using (exists (select 1 from core.membership m where m.organization_id = idempotency_key.organization_id and m.user_id = auth.uid()))
  with check (exists (select 1 from core.membership m where m.organization_id = idempotency_key.organization_id and m.user_id = auth.uid()));

revoke all on licitaciones.idempotency_key from public, anon;
grant select, insert, update on licitaciones.idempotency_key to authenticated;
grant select, insert, update, delete on licitaciones.idempotency_key to service_role;
