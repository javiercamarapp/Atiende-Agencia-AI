-- L-04 (licitaciones): sala de guerra por convocatoria + preguntas de la junta
-- de aclaraciones. Requiere: 001..028 (tablas `licitaciones.tender`,
-- `requirement_item`, `go_no_go_decision`, helpers `can_access_org`/
-- `can_write_org`/`can_decide_org`/`can_go_no_go_org`).
--
-- Que agrega (todo acotado a la organizacion por RLS, sin `using (true)`, sin
-- ningun GRANT a anon):
--   1. `war_room_item`    -- tablero de preparacion: requisitos, tareas y riesgos
--                            con responsable, fecha limite y estado.
--   2. `war_room_entry`   -- bitacora APPEND-ONLY de decisiones y comentarios.
--   3. `junta_aclaraciones` -- fecha limite de envio de preguntas y fecha de la
--                            junta de aclaraciones, por convocatoria.
--   4. `junta_question`   -- preguntas para la junta: borrador -> aprobada ->
--                            enviada -> respondida (o descartada), con la
--                            respuesta del acta ligada a la pregunta.
--   5. `junta_question_reminder` -- recordatorio persistido de la fecha limite
--                            de envio (mismo patron que `tender_deadline_reminder`,
--                            migracion 017), escrito SOLO por el barrido de
--                            sistema via `system_record_junta_question_reminders`.
--
-- Esta migracion NO envia nada a ningun portal: "enviada" es un estado que un
-- humano registra a mano cuando ya presento la pregunta por el canal oficial.
--
-- Compatibilidad con la base sin migrar: el codigo TypeScript que consume estas
-- tablas captura 42P01/42703/42883 dentro de un SAVEPOINT y degrada a "no
-- disponible aun" (ver `sala-guerra-repository.ts`). Orden de despliegue: esta
-- migracion puede aplicarse antes o despues del codigo.

-- ---------------------------------------------------------------------------
-- 0) Helper: pertenencia de un usuario a la organizacion del que llama.
--
-- Por que `security definer`: `core.membership` no es legible por filas ajenas
-- bajo RLS; la policy de `war_room_item` necesita comprobar que el
-- RESPONSABLE asignado pertenece a la misma organizacion (si no, un miembro
-- podria asignar tareas a un usuario de otro tenant). Se acota: solo responde
-- `true` si quien llama tambien es miembro de esa organizacion (nunca sirve de
-- oraculo para sondear membresias de organizaciones ajenas). `search_path` fijo.
-- ---------------------------------------------------------------------------
create or replace function licitaciones.org_has_member(_organization_id uuid, _user_id uuid)
returns boolean language sql stable security definer set search_path = core, pg_temp as $$
  select exists (
    select 1 from core.membership caller
    where caller.organization_id = _organization_id and caller.user_id = auth.uid()
  ) and exists (
    select 1 from core.membership m
    where m.organization_id = _organization_id and m.user_id = _user_id
  )
$$;
revoke all on function licitaciones.org_has_member(uuid, uuid) from public, anon;
grant execute on function licitaciones.org_has_member(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1) war_room_item -- tablero de preparacion.
-- ---------------------------------------------------------------------------
create table licitaciones.war_room_item (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  tender_id uuid not null references licitaciones.tender(id) on delete cascade,
  kind text not null check (kind in ('requisito', 'tarea', 'riesgo')),
  title text not null check (char_length(btrim(title)) between 3 and 300),
  description text check (description is null or char_length(description) <= 4000),
  status text not null default 'pendiente' check (status in ('pendiente', 'en_curso', 'listo', 'bloqueado', 'descartado')),
  -- Solo los riesgos llevan severidad.
  severity text check (severity in ('baja', 'media', 'alta', 'critica')),
  responsible_user_id uuid references core.staff_user(id) on delete set null,
  due_at timestamptz,
  -- Vinculo opcional al requisito extraido de las bases (checklist de requisitos).
  requirement_item_id uuid references licitaciones.requirement_item(id) on delete set null,
  created_by uuid not null references core.staff_user(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_by uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  check (kind = 'riesgo' or severity is null),
  check (completed_at is null or status = 'listo')
);
create index war_room_item_tender_idx on licitaciones.war_room_item (organization_id, tender_id, kind, created_at);
create index war_room_item_due_idx on licitaciones.war_room_item (tender_id, due_at) where due_at is not null;
-- Importar el checklist desde los requisitos de las bases es idempotente: un
-- requisito aparece una sola vez en el tablero de su convocatoria.
create unique index war_room_item_requirement_uidx on licitaciones.war_room_item (tender_id, requirement_item_id) where requirement_item_id is not null;

alter table licitaciones.war_room_item enable row level security;

create policy "org ve el tablero de su sala de guerra" on licitaciones.war_room_item
  for select using (licitaciones.can_access_org(organization_id));

-- Escritura: roles de escritura. El WITH CHECK ata la fila a SU organizacion
-- (la convocatoria y el requisito deben ser de la misma organizacion, el
-- responsable debe ser miembro de ella) y fuerza `created_by = auth.uid()`
-- (nadie firma una fila a nombre de otro).
create policy "escritura: roles de escritura crean items de la sala de guerra" on licitaciones.war_room_item
  for insert with check (
    licitaciones.can_write_org(organization_id)
    and created_by = auth.uid()
    and exists (select 1 from licitaciones.tender t where t.id = licitaciones.war_room_item.tender_id and t.organization_id = licitaciones.war_room_item.organization_id)
    and (responsible_user_id is null or licitaciones.org_has_member(organization_id, responsible_user_id))
    and (requirement_item_id is null or exists (
      select 1 from licitaciones.requirement_item r
      where r.id = licitaciones.war_room_item.requirement_item_id
        and r.tender_id = licitaciones.war_room_item.tender_id
        and r.organization_id = licitaciones.war_room_item.organization_id))
  );
create policy "escritura: roles de escritura actualizan items de la sala de guerra" on licitaciones.war_room_item
  for update using (licitaciones.can_write_org(organization_id))
  with check (
    licitaciones.can_write_org(organization_id)
    and (responsible_user_id is null or licitaciones.org_has_member(organization_id, responsible_user_id))
  );

-- Los campos de sello (`updated_by`, `updated_at`, `completed_at`) los fija este
-- trigger: ningun cliente puede falsificar quien/cuando cerro un item.
create or replace function licitaciones.touch_war_room_item()
returns trigger language plpgsql set search_path = licitaciones, pg_temp as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if new.status = 'listo' then
    new.completed_at := case when old.status = 'listo' then old.completed_at else now() end;
  else
    new.completed_at := null;
  end if;
  return new;
end;
$$;
create trigger war_room_item_touch before update on licitaciones.war_room_item
  for each row execute function licitaciones.touch_war_room_item();

revoke all on licitaciones.war_room_item from public, anon;
grant select on licitaciones.war_room_item to authenticated;
-- GRANT por COLUMNA: el cliente NUNCA escribe organization_id/tender_id/kind
-- al actualizar, ni los sellos (`created_at`, `updated_*`, `completed_at`).
grant insert (organization_id, tender_id, kind, title, description, severity, responsible_user_id, due_at, requirement_item_id, created_by) on licitaciones.war_room_item to authenticated;
grant update (title, description, status, severity, responsible_user_id, due_at) on licitaciones.war_room_item to authenticated;
grant select, insert, update, delete on licitaciones.war_room_item to service_role;

-- ---------------------------------------------------------------------------
-- 2) war_room_entry -- bitacora append-only de decisiones y comentarios.
-- ---------------------------------------------------------------------------
create table licitaciones.war_room_entry (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  tender_id uuid not null references licitaciones.tender(id) on delete cascade,
  item_id uuid references licitaciones.war_room_item(id) on delete set null,
  entry_kind text not null check (entry_kind in ('decision', 'comentario', 'evento')),
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  author_id uuid not null references core.staff_user(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index war_room_entry_tender_idx on licitaciones.war_room_entry (organization_id, tender_id, created_at desc);

alter table licitaciones.war_room_entry enable row level security;

create policy "org ve la bitacora de su sala de guerra" on licitaciones.war_room_entry
  for select using (licitaciones.can_access_org(organization_id));

-- Insert: roles de escritura comentan/registran eventos; una DECISION exige los
-- roles de go/no-go (owner/admin/analyst/reviewer), igual que decidir go/no-go
-- (migracion 008). Autor forzado a `auth.uid()`; el item, si se indica, debe ser
-- de la MISMA convocatoria y organizacion.
create policy "escritura: roles de escritura anotan en la bitacora de la sala de guerra" on licitaciones.war_room_entry
  for insert with check (
    licitaciones.can_write_org(organization_id)
    and author_id = auth.uid()
    and (entry_kind <> 'decision' or licitaciones.can_go_no_go_org(organization_id))
    and exists (select 1 from licitaciones.tender t where t.id = licitaciones.war_room_entry.tender_id and t.organization_id = licitaciones.war_room_entry.organization_id)
    and (item_id is null or exists (
      select 1 from licitaciones.war_room_item i
      where i.id = licitaciones.war_room_entry.item_id
        and i.tender_id = licitaciones.war_room_entry.tender_id
        and i.organization_id = licitaciones.war_room_entry.organization_id))
  );
-- Sin UPDATE ni DELETE (ni policy ni GRANT): una decision registrada es un hecho
-- historico; corregirla se hace con una anotacion nueva.

revoke all on licitaciones.war_room_entry from public, anon;
grant select on licitaciones.war_room_entry to authenticated;
grant insert (organization_id, tender_id, item_id, entry_kind, body, author_id) on licitaciones.war_room_entry to authenticated;
grant select, insert, update, delete on licitaciones.war_room_entry to service_role;

-- ---------------------------------------------------------------------------
-- 3) junta_aclaraciones -- fechas de la junta de aclaraciones por convocatoria.
-- ---------------------------------------------------------------------------
create table licitaciones.junta_aclaraciones (
  tender_id uuid primary key references licitaciones.tender(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- Fecha/hora limite para ENVIAR preguntas, tal como la fijan las bases. La
  -- captura un humano: este sistema no la deduce ni la inventa.
  questions_deadline_at timestamptz,
  meeting_at timestamptz,
  -- Folio o referencia del acta de la junta (texto libre, sin URL obligatoria).
  acta_reference text check (acta_reference is null or char_length(acta_reference) <= 300),
  updated_by uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (questions_deadline_at is null or meeting_at is null or questions_deadline_at <= meeting_at)
);
create index junta_aclaraciones_org_idx on licitaciones.junta_aclaraciones (organization_id);

alter table licitaciones.junta_aclaraciones enable row level security;
create policy "org ve las fechas de junta de aclaraciones" on licitaciones.junta_aclaraciones
  for select using (licitaciones.can_access_org(organization_id));
create policy "escritura: roles de escritura registran fechas de junta de aclaraciones" on licitaciones.junta_aclaraciones
  for insert with check (
    licitaciones.can_write_org(organization_id)
    and updated_by = auth.uid()
    and exists (select 1 from licitaciones.tender t where t.id = licitaciones.junta_aclaraciones.tender_id and t.organization_id = licitaciones.junta_aclaraciones.organization_id)
  );
create policy "escritura: roles de escritura actualizan fechas de junta de aclaraciones" on licitaciones.junta_aclaraciones
  for update using (licitaciones.can_write_org(organization_id))
  with check (licitaciones.can_write_org(organization_id) and updated_by = auth.uid());

revoke all on licitaciones.junta_aclaraciones from public, anon;
grant select on licitaciones.junta_aclaraciones to authenticated;
grant insert (tender_id, organization_id, questions_deadline_at, meeting_at, acta_reference, updated_by) on licitaciones.junta_aclaraciones to authenticated;
grant update (questions_deadline_at, meeting_at, acta_reference, updated_by, updated_at) on licitaciones.junta_aclaraciones to authenticated;
grant select, insert, update, delete on licitaciones.junta_aclaraciones to service_role;

-- ---------------------------------------------------------------------------
-- 4) junta_question -- preguntas para la junta de aclaraciones.
-- ---------------------------------------------------------------------------
create table licitaciones.junta_question (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  tender_id uuid not null references licitaciones.tender(id) on delete cascade,
  question_text text not null check (char_length(btrim(question_text)) between 10 and 2000),
  -- Numeral o clausula de las bases a la que se refiere (opcional).
  base_reference text check (base_reference is null or char_length(base_reference) <= 200),
  topic text not null default 'otro' check (topic in ('administrativo', 'legal', 'tecnico', 'economico', 'otro')),
  priority text not null default 'media' check (priority in ('alta', 'media', 'baja')),
  -- Huella normalizada del texto para deduplicar (la calcula la aplicacion; es
  -- ayuda de UX, no una frontera de seguridad).
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 200),
  origin text not null default 'manual' check (origin in ('manual', 'agente')),
  -- Datos que el asistente declaro que le faltaron (nunca se inventan).
  draft_missing_data text[] not null default '{}',
  status text not null default 'borrador' check (status in ('borrador', 'aprobada', 'enviada', 'respondida', 'descartada')),
  created_by uuid not null references core.staff_user(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_by uuid references core.staff_user(id) on delete set null,
  approved_at timestamptz,
  sent_at timestamptz,
  sent_by uuid references core.staff_user(id) on delete set null,
  -- Folio/acuse del envio, registrado a mano por quien presento la pregunta.
  sent_reference text check (sent_reference is null or char_length(sent_reference) <= 300),
  answer_text text check (answer_text is null or char_length(answer_text) <= 6000),
  -- Vinculo a la respuesta del acta (folio, numeral o pagina del acta).
  answer_acta_reference text check (answer_acta_reference is null or char_length(answer_acta_reference) <= 300),
  answered_at timestamptz,
  answered_by uuid references core.staff_user(id) on delete set null,
  discard_reason text check (discard_reason is null or char_length(discard_reason) <= 500),
  check (status <> 'descartada' or char_length(btrim(coalesce(discard_reason, ''))) > 0),
  check (status not in ('aprobada', 'enviada', 'respondida') or approved_at is not null),
  check (status not in ('enviada', 'respondida') or sent_at is not null),
  check (status <> 'respondida' or char_length(btrim(coalesce(answer_text, ''))) > 0)
);
create index junta_question_tender_idx on licitaciones.junta_question (organization_id, tender_id, status);
-- Una pregunta equivalente viva por convocatoria: las descartadas no cuentan.
create unique index junta_question_dedupe_uidx on licitaciones.junta_question (tender_id, dedupe_key) where status <> 'descartada';

alter table licitaciones.junta_question enable row level security;
create policy "org ve las preguntas de junta de aclaraciones" on licitaciones.junta_question
  for select using (licitaciones.can_access_org(organization_id));
-- Insert: siempre nace como borrador (no hay GRANT sobre `status`), con autor
-- forzado y convocatoria de su organizacion.
create policy "escritura: roles de escritura capturan preguntas de junta" on licitaciones.junta_question
  for insert with check (
    licitaciones.can_write_org(organization_id)
    and created_by = auth.uid()
    and exists (select 1 from licitaciones.tender t where t.id = licitaciones.junta_question.tender_id and t.organization_id = licitaciones.junta_question.organization_id)
  );
create policy "escritura: roles de escritura actualizan preguntas de junta" on licitaciones.junta_question
  for update using (licitaciones.can_write_org(organization_id))
  with check (licitaciones.can_write_org(organization_id));

-- Maquina de estados y sellos en la propia base (defensa en profundidad: la API
-- valida lo mismo, pero ningun cliente con acceso directo puede saltarse la
-- aprobacion ni falsificar quien aprobo/envio/registro la respuesta).
--   borrador -> aprobada | descartada
--   aprobada -> borrador | enviada | descartada
--   enviada  -> respondida | descartada
--   descartada -> borrador
--   respondida: terminal
-- Aprobar exige rol de decision (owner/admin/analyst), como aprobar un
-- expediente (`can_decide_org`). El texto queda congelado una vez aprobada/enviada.
create or replace function licitaciones.enforce_junta_question_transition()
returns trigger language plpgsql set search_path = licitaciones, pg_temp as $$
declare
  v_uid uuid := auth.uid();
begin
  if new.organization_id is distinct from old.organization_id
     or new.tender_id is distinct from old.tender_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.origin is distinct from old.origin then
    raise exception 'junta_question: organizacion, convocatoria, autor y origen son inmutables' using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if not (
      (old.status = 'borrador' and new.status in ('aprobada', 'descartada'))
      or (old.status = 'aprobada' and new.status in ('borrador', 'enviada', 'descartada'))
      or (old.status = 'enviada' and new.status in ('respondida', 'descartada'))
      or (old.status = 'descartada' and new.status = 'borrador')
    ) then
      raise exception 'junta_question: transicion % -> % no permitida', old.status, new.status using errcode = '23514';
    end if;
  end if;

  -- Una vez aprobada o enviada el texto no se edita: para cambiarlo hay que
  -- devolverla a borrador (lo que invalida la aprobacion).
  if old.status in ('aprobada', 'enviada', 'respondida') and new.status = old.status
     and (new.question_text is distinct from old.question_text
          or new.base_reference is distinct from old.base_reference
          or new.topic is distinct from old.topic) then
    raise exception 'junta_question: el texto de una pregunta % no se edita', old.status using errcode = '23514';
  end if;

  if new.status = 'aprobada' and old.status is distinct from 'aprobada' then
    if v_uid is not null and not licitaciones.can_decide_org(new.organization_id) then
      raise exception 'junta_question: aprobar una pregunta exige rol de decision' using errcode = '42501';
    end if;
    new.approved_by := v_uid;
    new.approved_at := now();
  elsif new.status = 'borrador' and old.status is distinct from 'borrador' then
    new.approved_by := null;
    new.approved_at := null;
    new.discard_reason := null;
  end if;

  if new.status = 'enviada' and old.status is distinct from 'enviada' then
    new.sent_at := now();
    new.sent_by := v_uid;
  end if;
  if new.status = 'respondida' and old.status is distinct from 'respondida' then
    new.answered_at := now();
    new.answered_by := v_uid;
  end if;

  new.updated_at := now();
  return new;
end;
$$;
create trigger junta_question_transition before update on licitaciones.junta_question
  for each row execute function licitaciones.enforce_junta_question_transition();

revoke all on licitaciones.junta_question from public, anon;
grant select on licitaciones.junta_question to authenticated;
-- GRANT por COLUMNA: sin `status` en el INSERT (siempre borrador) y sin los
-- sellos de aprobacion/envio/respuesta en el UPDATE (los fija el trigger).
grant insert (organization_id, tender_id, question_text, base_reference, topic, priority, dedupe_key, origin, draft_missing_data, created_by) on licitaciones.junta_question to authenticated;
grant update (question_text, base_reference, topic, priority, dedupe_key, draft_missing_data, status, sent_reference, answer_text, answer_acta_reference, discard_reason) on licitaciones.junta_question to authenticated;
grant select, insert, update, delete on licitaciones.junta_question to service_role;

-- ---------------------------------------------------------------------------
-- 5) junta_question_reminder -- recordatorio de la fecha limite de envio.
-- ---------------------------------------------------------------------------
create table licitaciones.junta_question_reminder (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  tender_id uuid not null references licitaciones.tender(id) on delete cascade,
  questions_deadline_at timestamptz not null,
  -- Fecha calendario (UTC) del limite: clave de dedupe, mismo criterio que
  -- `tender_deadline_reminder.deadline_date` (migracion 017).
  deadline_date date not null,
  days_remaining integer not null,
  pending_count integer not null check (pending_count >= 1),
  message text not null,
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid references core.staff_user(id) on delete set null,
  unique (tender_id, deadline_date)
);
create index junta_question_reminder_org_idx on licitaciones.junta_question_reminder (organization_id, created_at desc);

alter table licitaciones.junta_question_reminder enable row level security;
create policy "org ve sus recordatorios de preguntas de junta" on licitaciones.junta_question_reminder
  for select using (licitaciones.can_access_org(organization_id));
create policy "escritura: roles de escritura reconocen recordatorios de junta" on licitaciones.junta_question_reminder
  for update using (licitaciones.can_write_org(organization_id))
  with check (licitaciones.can_write_org(organization_id) and (acknowledged_by is null or acknowledged_by = auth.uid()));
-- Sin policy de INSERT para `authenticated`: solo la funcion de sistema inserta.

revoke all on licitaciones.junta_question_reminder from public, anon;
grant select on licitaciones.junta_question_reminder to authenticated;
grant update (acknowledged_at, acknowledged_by) on licitaciones.junta_question_reminder to authenticated;
grant select, insert, update, delete on licitaciones.junta_question_reminder to service_role;

-- Funcion de SOLO-SISTEMA (barrido de recordatorios del worker, sesion con
-- `auth.uid()` NULL): misma razon que las funciones `system_*` de la migracion
-- 024 -- bajo sesion de sistema las policies de `can_access_org`/`can_write_org`
-- (que exigen una membresia real) devuelven 0 filas en silencio. `security
-- definer` con `search_path` fijo y guard explicito `auth.uid() is null`.
-- Crea (una vez por convocatoria y dia calendario de vencimiento) un
-- recordatorio por cada convocatoria cuyo limite de preguntas cae dentro de la
-- ventana y que aun tenga preguntas sin enviar (borrador/aprobada).
create or replace function licitaciones.system_record_junta_question_reminders(
  p_organization_id uuid,
  p_now timestamptz,
  p_window_end timestamptz
)
returns table (
  out_id uuid,
  out_tender_id uuid,
  out_questions_deadline_at text,
  out_days_remaining integer,
  out_pending_count integer,
  out_message text,
  out_created_at text
)
language plpgsql security definer set search_path = licitaciones, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'system_record_junta_question_reminders es solo para la sesion de sistema' using errcode = '42501';
  end if;

  return query
    with candidates as (
      select j.tender_id,
             t.title,
             j.questions_deadline_at,
             (j.questions_deadline_at at time zone 'UTC')::date as deadline_date,
             ceil(extract(epoch from (j.questions_deadline_at - p_now)) / 86400.0)::integer as days_remaining,
             (select count(*) from licitaciones.junta_question q
               where q.tender_id = j.tender_id and q.organization_id = p_organization_id and q.status in ('borrador', 'aprobada'))::integer as pending_count
      from licitaciones.junta_aclaraciones j
      join licitaciones.tender t on t.id = j.tender_id and t.organization_id = j.organization_id
      where j.organization_id = p_organization_id
        and j.questions_deadline_at is not null
        and j.questions_deadline_at > p_now
        and j.questions_deadline_at <= p_window_end
        and t.status not in ('cancelled', 'lost', 'won', 'submitted')
    )
    insert into licitaciones.junta_question_reminder
      (organization_id, tender_id, questions_deadline_at, deadline_date, days_remaining, pending_count, message)
    select p_organization_id, c.tender_id, c.questions_deadline_at, c.deadline_date, c.days_remaining, c.pending_count,
           'El plazo para enviar preguntas a la junta de aclaraciones de "' || c.title || '" vence el ' || c.questions_deadline_at::text
             || '; hay ' || c.pending_count::text || ' pregunta(s) sin enviar.'
    from candidates c
    where c.pending_count >= 1
    on conflict (tender_id, deadline_date) do nothing
    returning id, tender_id, questions_deadline_at::text, days_remaining, pending_count, message, created_at::text;
end;
$$;
revoke all on function licitaciones.system_record_junta_question_reminders(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function licitaciones.system_record_junta_question_reminders(uuid, timestamptz, timestamptz) to authenticated, service_role;
