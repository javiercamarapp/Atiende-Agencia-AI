-- Tercera migración del esquema `despachos.*` (Fase 6) — checklist de cierre
-- mensual (puerto de `b2b_ai/features/monthly_close/`, ver
-- domain-despachos/src/cierre-mensual/). Mismo patrón RLS que
-- 001_despachos_schema.sql (`core.has_property_access`).
--
-- Nota de numeración: la migración "002" de esta secuencia interna
-- (`002_despachos_migracion_catalogo_schema.sql`, Fase 5) NO existe en este
-- directorio — solo su copia derivada vive en
-- `supabase/migrations/20240101000037_002_despachos_migracion_catalogo_schema.sql`.
-- Es una inconsistencia preexistente (no introducida por esta fase, verificada
-- al construir esta migración): el archivo canónico nunca se agregó a
-- `packages/domain-despachos/migrations/` cuando se creó la Fase 5, solo su
-- espejo. Se documenta aquí en vez de corregirse en silencio — renumerar o
-- mover contenido histórico está fuera del alcance de esta fase y no fue
-- pedido; esta migración simplemente toma el siguiente número libre ("003")
-- para no chocar con el nombre ya usado por el espejo "002" en supabase/.
--
-- Alcance de Fase 6 (ver informe de auditoría de esta fase): esta tabla
-- persiste el ESTADO del período/checklist (para que el bloqueo de edición de
-- movimientos ya cerrados sea real entre requests) y las tareas de su
-- checklist. Las validaciones de balance (`validaciones.ts`, puerto de
-- `close_management/validation_engine.py`) son funciones puras sin estado —
-- no requieren tabla propia, se exponen como endpoint calculadora (mismo
-- criterio que declaraciones.ts/conciliacion.ts).

create table despachos.periodo_cierre (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  anio integer not null check (anio >= 2014 and anio <= 2099),
  mes integer not null check (mes >= 1 and mes <= 12),
  status text not null default 'open' check (status in ('open', 'closed', 'overdue')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by text,
  created_at timestamptz not null default now(),
  -- Esta fase no implementa reapertura (ver hallazgo de auditoría: tampoco
  -- existe en el origen Python) — un único período por (property, año, mes)
  -- es suficiente hoy; reabrir es un incremento futuro que requeriría relajar
  -- este unique (p.ej. añadiendo una columna de "intento" o borrando el
  -- período cerrado antes de reabrir).
  unique (property_id, anio, mes)
);

create table despachos.periodo_cierre_tarea (
  id uuid primary key default gen_random_uuid(),
  periodo_cierre_id uuid not null references despachos.periodo_cierre(id) on delete cascade,
  template_key text,
  title text not null,
  description text not null default '',
  category text not null check (category in ('cfdi', 'bank', 'nomina', 'declaracion', 'electronica', 'custom')),
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'blocked', 'done', 'skipped')),
  depends_on uuid[] not null default '{}',
  due_date date,
  auto_check_query text,
  required boolean not null default true,
  completed_at timestamptz,
  completed_by text
);
create index periodo_cierre_tarea_periodo_idx on despachos.periodo_cierre_tarea (periodo_cierre_id);

alter table despachos.periodo_cierre enable row level security;
alter table despachos.periodo_cierre_tarea enable row level security;

create policy "staff ve periodos de cierre de su property" on despachos.periodo_cierre for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff inserta periodos de cierre de su property" on despachos.periodo_cierre for insert
  with check (core.has_property_access(auth.uid(), property_id));
create policy "staff actualiza periodos de cierre de su property" on despachos.periodo_cierre for update
  using (core.has_property_access(auth.uid(), property_id)) with check (core.has_property_access(auth.uid(), property_id));

create policy "staff ve tareas de cierre de su property" on despachos.periodo_cierre_tarea for select
  using (exists (
    select 1 from despachos.periodo_cierre p
    where p.id = periodo_cierre_tarea.periodo_cierre_id and core.has_property_access(auth.uid(), p.property_id)
  ));
create policy "staff inserta tareas de cierre de su property" on despachos.periodo_cierre_tarea for insert
  with check (exists (
    select 1 from despachos.periodo_cierre p
    where p.id = periodo_cierre_tarea.periodo_cierre_id and core.has_property_access(auth.uid(), p.property_id)
  ));
create policy "staff actualiza tareas de cierre de su property" on despachos.periodo_cierre_tarea for update
  using (exists (
    select 1 from despachos.periodo_cierre p
    where p.id = periodo_cierre_tarea.periodo_cierre_id and core.has_property_access(auth.uid(), p.property_id)
  ))
  with check (exists (
    select 1 from despachos.periodo_cierre p
    where p.id = periodo_cierre_tarea.periodo_cierre_id and core.has_property_access(auth.uid(), p.property_id)
  ));

grant select, insert, update on despachos.periodo_cierre to authenticated;
grant select, insert, update on despachos.periodo_cierre_tarea to authenticated;
grant select, insert, update, delete on despachos.periodo_cierre to service_role;
grant select, insert, update, delete on despachos.periodo_cierre_tarea to service_role;
