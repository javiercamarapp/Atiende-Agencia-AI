-- L-27 (licitaciones): post-adjudicacion estructurada -- garantias (cumplimiento, anticipo, vicios
-- ocultos), hitos con responsable, convenios modificatorios, plazos de firma/entrega de garantia y
-- bitacora append-only. Requiere: 001..034 (`licitaciones.contract`, helpers `can_access_org`/
-- `can_write_org`/`can_decide_org`).
--
-- Que agrega (todo acotado a la organizacion por RLS; sin `using (true)`; sin ningun GRANT a anon):
--   1. `contract_plazos`      -- fecha de notificacion del fallo, firma y dias de plazo (uno por contrato).
--   2. `contract_guarantee`   -- garantias con monto en CENTAVOS, afianzadora/poliza, vigencia y estado.
--   3. `contract_milestone`   -- hitos con responsable (staff de la MISMA organizacion) y fecha.
--   4. `contract_amendment`   -- convenios modificatorios: historial inmutable (sin UPDATE/DELETE).
--   5. `contract_post_award_log` -- bitacora append-only escrita SOLO por trigger definer.
--   6. `system_post_award_alert_candidates` -- lectura de SOLO sistema para el barrido de alertas.
--   7. `post_award_is_member` / `post_award_list_responsables` -- resuelven "staff de la organizacion"
--      sin dar al cliente lectura directa de `core.membership`.
--
-- Seguridad de cada pieza (la ejerce scripts/verify-licitaciones-post-adjudicacion/assertions.sql):
--   * Integridad entre tenants: llave foranea COMPUESTA (contract_id, organization_id) hacia
--     `licitaciones.contract (id, organization_id)`: una fila nunca cuelga de un contrato de otra
--     organizacion aunque el cliente mienta en `organization_id`.
--   * GRANT por COLUMNA: el cliente nunca fija `id`, `created_by` (default auth.uid() y check de RLS),
--     `numero` del convenio ni los sellos de tiempo; tras crearse una garantia no puede cambiar `tipo`,
--     contrato ni organizacion.
--   * Maquina de estados en trigger (SIN definer, corre como quien llama): una garantia final
--     (liberada/ejecutada) y un hito final (cumplido/cancelado) ya no se editan; liberar o ejecutar una
--     garantia exige can_decide_org (owner/admin/analyst), no solo roles de escritura.
--   * Convenios: solo DECISION (can_decide_org); sin UPDATE ni DELETE para nadie -> historial inmutable.
--     Un trigger asigna `numero` consecutivo (con candado) y guarda la fecha de fin anterior; otro aplica
--     la nueva fecha de fin a `contract.end_date` en la misma transaccion.
--   * Bitacora: authenticated solo tiene SELECT; la escribe el trigger definer con `set search_path`
--     fijo. No hay forma de falsearla ni borrarla desde el cliente.
--   * Funciones definer: `set search_path` fijo, `revoke all ... from public`, GRANT EXECUTE solo a
--     authenticated/service_role. `system_post_award_alert_candidates` exige auth.uid() is null.
--
-- Compatibilidad con la base sin migrar: el TypeScript captura 42P01/42703/42883 dentro de un SAVEPOINT
-- y responde "no disponible aun" (lecturas) o 503 (escrituras); nunca un 500. La migracion puede
-- aplicarse antes o despues del codigo.

-- Prerrequisito de las llaves foraneas compuestas (aditivo: `id` ya es llave primaria).
alter table licitaciones.contract add constraint contract_id_organization_uidx unique (id, organization_id);

-- ---------------------------------------------------------------------------
-- Helpers: "staff de la organizacion" sin lectura directa de core.membership
-- ---------------------------------------------------------------------------
-- Seguridad: definer porque `core.membership` no es legible para authenticated. Solo responde a una
-- sesion de staff (auth.uid() no nulo) que sea miembro de la organizacion consultada.
create or replace function licitaciones.post_award_is_member(p_organization_id uuid, p_user_id uuid)
returns boolean language sql stable security definer set search_path = core, licitaciones, pg_temp as $$
  select auth.uid() is not null
    and licitaciones.can_access_org(p_organization_id)
    and exists (select 1 from core.membership m where m.organization_id = p_organization_id and m.user_id = p_user_id)
$$;
revoke all on function licitaciones.post_award_is_member(uuid, uuid) from public, anon;
grant execute on function licitaciones.post_award_is_member(uuid, uuid) to authenticated, service_role;

-- Seguridad: lista el staff (id, nombre, rol; sin correo) SOLO a miembros de esa organizacion. Alimenta el
-- selector de responsable de un hito.
create or replace function licitaciones.post_award_list_responsables(p_organization_id uuid)
returns table (out_user_id uuid, out_nombre text, out_rol text)
language plpgsql stable security definer set search_path = core, licitaciones, pg_temp as $$
begin
  if auth.uid() is null or not licitaciones.can_access_org(p_organization_id) then
    raise exception 'post_award_list_responsables: solo miembros de la organizacion' using errcode = '42501';
  end if;
  return query
    select m.user_id, coalesce(nullif(btrim(s.full_name), ''), 'Sin nombre'), m.vertical_role::text
    from core.membership m
    join core.staff_user s on s.id = m.user_id
    where m.organization_id = p_organization_id
    order by 2, 1
    limit 200;
end;
$$;
revoke all on function licitaciones.post_award_list_responsables(uuid) from public, anon;
grant execute on function licitaciones.post_award_list_responsables(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1) contract_plazos: plazos de firma y de entrega de garantia
-- ---------------------------------------------------------------------------
-- Los dias son los que declara la organizacion (las bases/el fallo los fijan); el calculo de la fecha
-- limite en dias habiles con el calendario de L-22 vive en codigo (`post-adjudicacion.ts`).
create table licitaciones.contract_plazos (
  contract_id uuid primary key,
  organization_id uuid not null references core.organization(id) on delete cascade,
  fallo_notificado_en date check (fallo_notificado_en is null or fallo_notificado_en between date '2000-01-01' and date '2100-12-31'),
  plazo_firma_dias integer check (plazo_firma_dias is null or plazo_firma_dias between 1 and 90),
  firmado_en date check (firmado_en is null or firmado_en between date '2000-01-01' and date '2100-12-31'),
  plazo_garantia_dias integer check (plazo_garantia_dias is null or plazo_garantia_dias between 1 and 90),
  updated_by uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  foreign key (contract_id, organization_id) references licitaciones.contract (id, organization_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- 2) contract_guarantee
-- ---------------------------------------------------------------------------
create table licitaciones.contract_guarantee (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  contract_id uuid not null,
  tipo text not null check (tipo in ('cumplimiento', 'anticipo', 'vicios_ocultos')),
  -- Centavos (bigint), nunca punto flotante. Porcentaje del monto del contrato en puntos base (1 = 0.01%).
  monto_cents bigint not null check (monto_cents > 0 and monto_cents <= 100000000000000),
  porcentaje_bp integer check (porcentaje_bp is null or porcentaje_bp between 1 and 10000),
  afianzadora text check (afianzadora is null or char_length(btrim(afianzadora)) between 2 and 200),
  numero_poliza text check (numero_poliza is null or char_length(btrim(numero_poliza)) between 1 and 100),
  vigencia_desde date not null check (vigencia_desde between date '2000-01-01' and date '2100-12-31'),
  vigencia_hasta date not null check (vigencia_hasta between date '2000-01-01' and date '2100-12-31'),
  -- Fecha limite (calculada en dias habiles por el servidor o declarada) para entregar la garantia.
  fecha_limite_entrega date check (fecha_limite_entrega is null or fecha_limite_entrega between date '2000-01-01' and date '2100-12-31'),
  entregada_en date check (entregada_en is null or entregada_en between date '2000-01-01' and date '2100-12-31'),
  estado text not null default 'pendiente_entrega' check (estado in ('pendiente_entrega', 'entregada', 'liberada', 'ejecutada', 'vencida')),
  notas text check (notas is null or char_length(notas) <= 1000),
  created_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (vigencia_hasta >= vigencia_desde),
  -- Solo una garantia pendiente de entrega carece de fecha de entrega.
  check ((estado = 'pendiente_entrega') = (entregada_en is null)),
  foreign key (contract_id, organization_id) references licitaciones.contract (id, organization_id) on delete cascade
);
create index contract_guarantee_contract_idx on licitaciones.contract_guarantee (organization_id, contract_id);
create index contract_guarantee_alert_idx on licitaciones.contract_guarantee (organization_id, estado, vigencia_hasta);

-- Maquina de estados + topes. SIN `security definer`: corre con los privilegios de quien llama.
create or replace function licitaciones.contract_guarantee_guard()
returns trigger language plpgsql set search_path = licitaciones, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.estado not in ('pendiente_entrega', 'entregada') then
      raise exception 'una garantia nueva solo nace pendiente de entrega o entregada' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('licitaciones.contract_guarantee:' || new.contract_id::text, 0));
    if (select count(*) from licitaciones.contract_guarantee where contract_id = new.contract_id) >= 30 then
      raise exception 'maximo 30 garantias por contrato' using errcode = '54000';
    end if;
    new.updated_at := now();
    return new;
  end if;

  if old.estado in ('liberada', 'ejecutada') then
    raise exception 'la garantia ya esta % y no se edita', old.estado using errcode = '22023';
  end if;
  if new.estado is distinct from old.estado then
    if not (
      (old.estado = 'pendiente_entrega' and new.estado = 'entregada')
      or (old.estado = 'entregada' and new.estado in ('liberada', 'ejecutada', 'vencida'))
      or (old.estado = 'vencida' and new.estado in ('liberada', 'ejecutada'))
    ) then
      raise exception 'transicion de garantia invalida: % -> %', old.estado, new.estado using errcode = '22023';
    end if;
    -- Liberar o ejecutar una garantia es una decision (owner/admin/analyst), no una edicion.
    if new.estado in ('liberada', 'ejecutada') and not licitaciones.can_decide_org(new.organization_id) then
      raise exception 'liberar o ejecutar una garantia exige un rol de decision' using errcode = '42501';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger contract_guarantee_guard before insert or update on licitaciones.contract_guarantee
  for each row execute function licitaciones.contract_guarantee_guard();

-- ---------------------------------------------------------------------------
-- 3) contract_milestone
-- ---------------------------------------------------------------------------
create table licitaciones.contract_milestone (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  contract_id uuid not null,
  titulo text not null check (char_length(btrim(titulo)) between 3 and 200),
  descripcion text check (descripcion is null or char_length(descripcion) <= 1000),
  responsable_id uuid references core.staff_user(id) on delete set null,
  fecha_compromiso date not null check (fecha_compromiso between date '2000-01-01' and date '2100-12-31'),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'cumplido', 'cancelado')),
  cumplido_en date check (cumplido_en is null or cumplido_en between date '2000-01-01' and date '2100-12-31'),
  created_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((estado = 'cumplido') = (cumplido_en is not null)),
  foreign key (contract_id, organization_id) references licitaciones.contract (id, organization_id) on delete cascade
);
create index contract_milestone_contract_idx on licitaciones.contract_milestone (organization_id, contract_id);
create index contract_milestone_alert_idx on licitaciones.contract_milestone (organization_id, estado, fecha_compromiso);

create or replace function licitaciones.contract_milestone_guard()
returns trigger language plpgsql set search_path = licitaciones, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.estado <> 'pendiente' then
      raise exception 'un hito nuevo nace pendiente' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('licitaciones.contract_milestone:' || new.contract_id::text, 0));
    if (select count(*) from licitaciones.contract_milestone where contract_id = new.contract_id) >= 200 then
      raise exception 'maximo 200 hitos por contrato' using errcode = '54000';
    end if;
    new.updated_at := now();
    return new;
  end if;
  if old.estado <> 'pendiente' then
    raise exception 'el hito ya esta % y no se edita', old.estado using errcode = '22023';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger contract_milestone_guard before insert or update on licitaciones.contract_milestone
  for each row execute function licitaciones.contract_milestone_guard();

-- ---------------------------------------------------------------------------
-- 4) contract_amendment: convenios modificatorios (historial inmutable)
-- ---------------------------------------------------------------------------
create table licitaciones.contract_amendment (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  contract_id uuid not null,
  -- Consecutivo por contrato: lo asigna el trigger, nunca el cliente.
  numero integer not null,
  tipo text not null check (tipo in ('monto', 'plazo', 'monto_plazo')),
  -- Ajuste del monto en centavos (positivo = incremento, negativo = reduccion); nunca cero.
  monto_delta_cents bigint check (monto_delta_cents is null or (monto_delta_cents <> 0 and abs(monto_delta_cents) <= 100000000000000)),
  -- Fecha de fin de vigencia que deja el convenio y la que tenia el contrato antes (la fija el trigger).
  nueva_fecha_fin date check (nueva_fecha_fin is null or nueva_fecha_fin between date '2000-01-01' and date '2100-12-31'),
  fecha_fin_anterior date,
  fecha_firma date not null check (fecha_firma between date '2000-01-01' and date '2100-12-31'),
  motivo text not null check (char_length(btrim(motivo)) between 3 and 1000),
  created_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (contract_id, numero),
  check (
    (tipo = 'monto' and monto_delta_cents is not null and nueva_fecha_fin is null)
    or (tipo = 'plazo' and nueva_fecha_fin is not null and monto_delta_cents is null)
    or (tipo = 'monto_plazo' and monto_delta_cents is not null and nueva_fecha_fin is not null)
  ),
  foreign key (contract_id, organization_id) references licitaciones.contract (id, organization_id) on delete cascade
);
create index contract_amendment_contract_idx on licitaciones.contract_amendment (organization_id, contract_id, numero);

-- Sin `security definer`: el UPDATE de `contract.end_date` corre como quien llama y pasa por la RLS del
-- contrato (roles de escritura); el convenio ya exige un rol de decision, que es un subconjunto.
create or replace function licitaciones.contract_amendment_before_insert()
returns trigger language plpgsql set search_path = licitaciones, pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('licitaciones.contract_amendment:' || new.contract_id::text, 0));
  new.numero := coalesce((select max(a.numero) from licitaciones.contract_amendment a where a.contract_id = new.contract_id), 0) + 1;
  if new.numero > 50 then
    raise exception 'maximo 50 convenios por contrato' using errcode = '54000';
  end if;
  new.fecha_fin_anterior := (select c.end_date from licitaciones.contract c where c.id = new.contract_id);
  return new;
end;
$$;
create trigger contract_amendment_before_insert before insert on licitaciones.contract_amendment
  for each row execute function licitaciones.contract_amendment_before_insert();

create or replace function licitaciones.contract_amendment_after_insert()
returns trigger language plpgsql set search_path = licitaciones, pg_temp as $$
begin
  if new.nueva_fecha_fin is not null then
    update licitaciones.contract set end_date = new.nueva_fecha_fin, updated_at = now() where id = new.contract_id;
  end if;
  return new;
end;
$$;
create trigger contract_amendment_after_insert after insert on licitaciones.contract_amendment
  for each row execute function licitaciones.contract_amendment_after_insert();

-- ---------------------------------------------------------------------------
-- 5) contract_post_award_log: bitacora append-only
-- ---------------------------------------------------------------------------
create table licitaciones.contract_post_award_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  contract_id uuid not null,
  entidad text not null check (entidad in ('plazos', 'garantia', 'hito', 'convenio')),
  entidad_id uuid not null,
  accion text not null check (accion in ('crear', 'editar', 'cambio_estado')),
  -- Sin PII: solo estados y nombres de columnas modificadas.
  detalle jsonb not null default '{}'::jsonb,
  actor_id uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (contract_id, organization_id) references licitaciones.contract (id, organization_id) on delete cascade
);
create index contract_post_award_log_contract_idx on licitaciones.contract_post_award_log (organization_id, contract_id, created_at);

-- Seguridad: definer (escribe una tabla sin INSERT para authenticated) con `search_path` fijo. Los triggers
-- no son invocables como funciones; ademas se revoca EXECUTE de public.
create or replace function licitaciones.contract_post_award_log_trg()
returns trigger language plpgsql security definer set search_path = licitaciones, pg_temp as $$
declare
  v_entidad text := tg_argv[0];
  v_entidad_id uuid;
  v_accion text;
  v_campos jsonb := '[]'::jsonb;
  v_detalle jsonb;
begin
  v_entidad_id := case when v_entidad = 'plazos' then (to_jsonb(new)->>'contract_id')::uuid else (to_jsonb(new)->>'id')::uuid end;
  if tg_op = 'INSERT' then
    v_accion := 'crear';
    v_detalle := jsonb_strip_nulls(jsonb_build_object('estado', to_jsonb(new)->>'estado', 'tipo', to_jsonb(new)->>'tipo'));
  else
    select coalesce(jsonb_agg(k order by k), '[]'::jsonb) into v_campos
    from jsonb_object_keys(to_jsonb(new)) as k
    where (to_jsonb(new)->k) is distinct from (to_jsonb(old)->k) and k not in ('updated_at', 'updated_by');
    v_accion := case when (to_jsonb(new)->>'estado') is distinct from (to_jsonb(old)->>'estado') then 'cambio_estado' else 'editar' end;
    v_detalle := jsonb_strip_nulls(jsonb_build_object('estado', to_jsonb(new)->>'estado', 'estado_anterior', to_jsonb(old)->>'estado', 'campos', v_campos));
  end if;
  insert into licitaciones.contract_post_award_log (organization_id, contract_id, entidad, entidad_id, accion, detalle, actor_id)
  values (new.organization_id, new.contract_id, v_entidad, v_entidad_id, v_accion, v_detalle, auth.uid());
  return new;
end;
$$;
revoke all on function licitaciones.contract_post_award_log_trg() from public, anon, authenticated;

create trigger contract_plazos_log after insert or update on licitaciones.contract_plazos
  for each row execute function licitaciones.contract_post_award_log_trg('plazos');
create trigger contract_guarantee_log after insert or update on licitaciones.contract_guarantee
  for each row execute function licitaciones.contract_post_award_log_trg('garantia');
create trigger contract_milestone_log after insert or update on licitaciones.contract_milestone
  for each row execute function licitaciones.contract_post_award_log_trg('hito');
create trigger contract_amendment_log after insert on licitaciones.contract_amendment
  for each row execute function licitaciones.contract_post_award_log_trg('convenio');

-- Sello de plazos (sin definer): quien lo cambio y cuando lo fija el trigger, no el cliente.
create or replace function licitaciones.contract_plazos_sello()
returns trigger language plpgsql set search_path = licitaciones, pg_temp as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;
create trigger contract_plazos_sello before insert or update on licitaciones.contract_plazos
  for each row execute function licitaciones.contract_plazos_sello();

-- ---------------------------------------------------------------------------
-- RLS + GRANT
-- ---------------------------------------------------------------------------
alter table licitaciones.contract_plazos enable row level security;
alter table licitaciones.contract_guarantee enable row level security;
alter table licitaciones.contract_milestone enable row level security;
alter table licitaciones.contract_amendment enable row level security;
alter table licitaciones.contract_post_award_log enable row level security;

-- Lectura: cualquier miembro de la organizacion (el equipo entero ve garantias, hitos y convenios).
create policy "plazos: miembros leen" on licitaciones.contract_plazos for select using (licitaciones.can_access_org(organization_id));
create policy "garantias: miembros leen" on licitaciones.contract_guarantee for select using (licitaciones.can_access_org(organization_id));
create policy "hitos: miembros leen" on licitaciones.contract_milestone for select using (licitaciones.can_access_org(organization_id));
create policy "convenios: miembros leen" on licitaciones.contract_amendment for select using (licitaciones.can_access_org(organization_id));
create policy "bitacora post-adjudicacion: miembros leen" on licitaciones.contract_post_award_log for select using (licitaciones.can_access_org(organization_id));

-- Escritura: plazos, garantias e hitos con roles de escritura (liberar/ejecutar una garantia lo eleva el
-- trigger a rol de decision); convenios solo con rol de decision. `created_by = auth.uid()`: nadie firma
-- a nombre de otro.
create policy "plazos: escritura inserta" on licitaciones.contract_plazos for insert with check (licitaciones.can_write_org(organization_id));
create policy "plazos: escritura actualiza" on licitaciones.contract_plazos for update
  using (licitaciones.can_write_org(organization_id)) with check (licitaciones.can_write_org(organization_id));

create policy "garantias: escritura inserta" on licitaciones.contract_guarantee for insert
  with check (licitaciones.can_write_org(organization_id) and created_by = auth.uid());
create policy "garantias: escritura actualiza" on licitaciones.contract_guarantee for update
  using (licitaciones.can_write_org(organization_id)) with check (licitaciones.can_write_org(organization_id));

-- El responsable de un hito debe ser staff de la MISMA organizacion (al crear es obligatorio; al editar
-- puede quedar nulo si el staff fue dado de baja).
create policy "hitos: escritura inserta" on licitaciones.contract_milestone for insert
  with check (
    licitaciones.can_write_org(organization_id) and created_by = auth.uid()
    and responsable_id is not null and licitaciones.post_award_is_member(organization_id, responsable_id)
  );
create policy "hitos: escritura actualiza" on licitaciones.contract_milestone for update
  using (licitaciones.can_write_org(organization_id))
  with check (
    licitaciones.can_write_org(organization_id)
    and (responsable_id is null or licitaciones.post_award_is_member(organization_id, responsable_id))
  );

create policy "convenios: decision inserta" on licitaciones.contract_amendment for insert
  with check (licitaciones.can_decide_org(organization_id) and created_by = auth.uid());

revoke all on licitaciones.contract_plazos, licitaciones.contract_guarantee, licitaciones.contract_milestone,
  licitaciones.contract_amendment, licitaciones.contract_post_award_log from public, anon, authenticated;

grant select on licitaciones.contract_plazos, licitaciones.contract_guarantee, licitaciones.contract_milestone,
  licitaciones.contract_amendment, licitaciones.contract_post_award_log to authenticated;

grant insert (contract_id, organization_id, fallo_notificado_en, plazo_firma_dias, firmado_en, plazo_garantia_dias)
  on licitaciones.contract_plazos to authenticated;
grant update (fallo_notificado_en, plazo_firma_dias, firmado_en, plazo_garantia_dias)
  on licitaciones.contract_plazos to authenticated;

grant insert (organization_id, contract_id, tipo, monto_cents, porcentaje_bp, afianzadora, numero_poliza, vigencia_desde, vigencia_hasta, fecha_limite_entrega, entregada_en, estado, notas, created_by)
  on licitaciones.contract_guarantee to authenticated;
grant update (monto_cents, porcentaje_bp, afianzadora, numero_poliza, vigencia_desde, vigencia_hasta, fecha_limite_entrega, entregada_en, estado, notas)
  on licitaciones.contract_guarantee to authenticated;

grant insert (organization_id, contract_id, titulo, descripcion, responsable_id, fecha_compromiso, created_by)
  on licitaciones.contract_milestone to authenticated;
grant update (titulo, descripcion, responsable_id, fecha_compromiso, estado, cumplido_en)
  on licitaciones.contract_milestone to authenticated;

grant insert (organization_id, contract_id, tipo, monto_delta_cents, nueva_fecha_fin, fecha_firma, motivo, created_by)
  on licitaciones.contract_amendment to authenticated;

grant select, insert, update, delete on licitaciones.contract_plazos, licitaciones.contract_guarantee, licitaciones.contract_milestone to service_role;
grant select, insert on licitaciones.contract_amendment, licitaciones.contract_post_award_log to service_role;

-- ---------------------------------------------------------------------------
-- 6) Lectura de SOLO sistema para el barrido de alertas (cron existente, sin sesion de staff)
-- ---------------------------------------------------------------------------
-- Seguridad: definer porque el barrido corre sin `auth.uid()` y no pasaria la RLS; exige auth.uid() is null
-- (una sesion de staff no puede usarla para leer otra organizacion), `search_path` fijo, solo la
-- organizacion pedida, tope de 200 filas y SIN PII (ids, tipo y fecha; el id de la convocatoria arma el enlace).
create or replace function licitaciones.system_post_award_alert_candidates(p_organization_id uuid, p_hoy date, p_ventana_dias integer default 30)
returns table (out_tipo text, out_entidad_id uuid, out_contract_id uuid, out_tender_id uuid, out_fecha date)
language plpgsql stable security definer set search_path = licitaciones, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'system_post_award_alert_candidates es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if p_ventana_dias is null or p_ventana_dias < 1 or p_ventana_dias > 365 then
    raise exception 'p_ventana_dias fuera de rango (1..365)' using errcode = '22023';
  end if;
  return query
    select c.tipo, c.entidad_id, c.contract_id, k.tender_id, c.fecha from (
      select 'garantia_por_vencer'::text as tipo, g.id as entidad_id, g.contract_id, g.vigencia_hasta as fecha
        from licitaciones.contract_guarantee g
        where g.organization_id = p_organization_id and g.estado = 'entregada'
          and g.vigencia_hasta >= p_hoy and g.vigencia_hasta <= p_hoy + p_ventana_dias
      union all
      select 'garantia_no_entregada', g.id, g.contract_id, g.fecha_limite_entrega
        from licitaciones.contract_guarantee g
        where g.organization_id = p_organization_id and g.estado = 'pendiente_entrega'
          and g.fecha_limite_entrega is not null and g.fecha_limite_entrega < p_hoy
      union all
      select 'hito_vencido', m.id, m.contract_id, m.fecha_compromiso
        from licitaciones.contract_milestone m
        where m.organization_id = p_organization_id and m.estado = 'pendiente' and m.fecha_compromiso < p_hoy
    ) c
    join licitaciones.contract k on k.id = c.contract_id and k.organization_id = p_organization_id
    order by c.fecha, c.entidad_id
    limit 200;
end;
$$;
revoke all on function licitaciones.system_post_award_alert_candidates(uuid, date, integer) from public, anon;
grant execute on function licitaciones.system_post_award_alert_candidates(uuid, date, integer) to authenticated, service_role;
