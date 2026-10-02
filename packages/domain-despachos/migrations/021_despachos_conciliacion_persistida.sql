-- D-35 + D-02 -- Conciliación bancaria PERSISTIDA (sesiones y matches) y sugerencias del nivel 4 (LLM) con aprobación humana.
--
-- Hasta la migración 020 la conciliación calculaba en memoria y no guardaba nada. Esta migración agrega:
--   * `despachos.conciliacion_sesion`     -- una corrida de conciliación de UN periodo (YYYY-MM) de UN cliente (property),
--                                            opcionalmente acotada a una cuenta bancaria. Estado abierta / cerrada.
--                                            Los movimientos NO se copian: son los de `despachos.estado_cuenta_movimiento`
--                                            (migración 015) cuya fecha cae en el periodo; el libro es de solo-anexar, así que
--                                            la sesión nunca ve cambiar su universo salvo por importaciones nuevas.
--   * `despachos.conciliacion_match`      -- par (movimiento bancario, CFDI) CONFIRMADO por una persona. nivel 1-4 (exacto, fuzzy,
--                                            multi-línea, IA) solo para origen motor / llm_aprobado; `manual` no lleva nivel ni
--                                            confianza. Deshacer NO borra: marca deshecho_por/en + motivo (historial íntegro).
--   * `despachos.conciliacion_sugerencia` -- propuesta del nivel 4 (LLM): queda `pendiente` hasta que una persona la apruebe
--                                            (crea el match) o la rechace. NUNCA se aplica sola.
--   * `despachos.invoice_conciliacion`    -- VISTA derivada: marca "conciliado" de un CFDI. Se eligió vista y no columna en
--                                            `despachos.invoice` porque la marca es consecuencia de los matches vigentes: una columna
--                                            se desincroniza al deshacer (dos escrituras que pueden divergir) y obligaría a
--                                            conceder UPDATE sobre la tabla de CFDI. La vista es security_invoker: aplica la RLS de
--                                            quien consulta, así que un staff solo ve la marca de CFDI de SUS clientes.
--
-- Seguridad (cada punto lo ejerce scripts/verify-despachos-conciliacion-persistida/assertions.sql):
--   1. Las 3 tablas: RLS habilitado, REVOKE de todo a public/anon/authenticated y SOLO `select` a `authenticated` con la policy
--      `core.has_property_access(auth.uid(), property_id)` -- justificación: el staff debe poder leer las sesiones, matches y
--      sugerencias de SUS clientes y nada más. NO hay INSERT/UPDATE/DELETE directos para `authenticated`: toda escritura pasa por
--      las funciones de abajo (validan rol, periodo cerrado, pertenencia y estado), por eso no se concede ningún GRANT de
--      escritura, ni siquiera por columna. Sin `using (true)` y sin ningún GRANT a anon. `service_role` conserva select/delete
--      para mantenimiento y atención de solicitudes de borrado (no inserta ni actualiza: nadie reescribe un historial).
--   2. Llaves foráneas COMPUESTAS (id, organization_id, property_id) hacia sesión, movimiento bancario y CFDI: impiden ligar un
--      match a un movimiento o factura de OTRA property u organización aunque se mienta en las columnas de tenant. Para poder
--      apuntar al movimiento de la 015 se agrega a `estado_cuenta_movimiento` un UNIQUE (id, organization_id, property_id): es
--      redundante con su PK (id ya es único), no cambia ningún dato ni permiso.
--   3. Índice único PARCIAL `conciliacion_match_movimiento_vigente_uk` (property_id, movimiento_id) where deshecho_en is null:
--      un movimiento tiene a lo más UN match vigente; al deshacer queda libre para conciliarse de nuevo. Es la defensa de
--      integridad ante dos confirmaciones simultáneas (la segunda falla con 23505, no duplica). Igual para sugerencias pendientes.
--   4. Funciones de escritura: `security definer`, `set search_path = despachos, pg_temp`, `revoke all ... from public, anon`,
--      EXECUTE solo a `authenticated`. Exigen `auth.uid()` no nulo y `despachos.cartera_puede_escribir(property)` (migración
--      018: acceso a la property + rol admin/contador en la organización de despachos DE ESA property). Un contador de otra
--      organización o un auditor/readonly recibe 42501. Confirmar, deshacer y aprobar rechazan con 55000 un movimiento cuya fecha
--      cae en un periodo con `despachos.periodo_cierre.status = 'closed'` (bloqueo del módulo cierre-mensual).
--      El rol del llamador NUNCA se toma de un argumento: sale de la sesión (auth.uid()).
--   5. La base NO re-ejecuta el motor de matching (vive en TypeScript): la ruta HTTP recalcula en el servidor y solo pasa a estas
--      funciones pares que el motor propuso o pares manuales; la función garantiza integridad (pertenencia al cliente y al
--      periodo, un solo match vigente, periodo abierto, sesión abierta) pero no es el filtro de "qué propuso el motor".
--   6. Una sugerencia del LLM guarda confianza y razón (texto del modelo, acotado a 500 caracteres) para sobrevivir a una
--      recarga; su aprobación crea el match con origen `llm_aprobado` en la MISMA transacción y registra quién aprobó.
--
-- Compatibilidad con la base sin migrar: el TypeScript que consume esto captura 42883/42P01/42703 dentro de SAVEPOINT
-- (runWithSavepointFallback) y responde "no disponible aún" (lista vacía + estado, o 503 en escrituras); nunca un 500.
-- Esta migración se puede aplicar antes o después del código.

alter table despachos.estado_cuenta_movimiento
  add constraint estado_cuenta_movimiento_id_tenant_uk unique (id, organization_id, property_id);

-- ---------------------------------------------------------------------------
-- Sesión de conciliación.
-- ---------------------------------------------------------------------------
create table despachos.conciliacion_sesion (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  periodo text not null check (periodo ~ '^20[1-9][0-9]-(0[1-9]|1[0-2])$'),
  cuenta text check (cuenta is null or (cuenta <> '' and char_length(cuenta) <= 34)),
  estado text not null default 'abierta' check (estado in ('abierta', 'cerrada')),
  creada_por uuid references core.staff_user(id) on delete set null,
  creada_en timestamptz not null default now(),
  cerrada_por uuid references core.staff_user(id) on delete set null,
  cerrada_en timestamptz,
  unique (id, organization_id, property_id),
  check ((estado = 'cerrada') = (cerrada_en is not null))
);
create index conciliacion_sesion_property_idx on despachos.conciliacion_sesion (property_id, periodo, creada_en desc);

-- ---------------------------------------------------------------------------
-- Matches confirmados.
-- ---------------------------------------------------------------------------
create table despachos.conciliacion_match (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  sesion_id uuid not null,
  movimiento_id uuid not null,
  invoice_id uuid not null,
  nivel smallint check (nivel is null or nivel between 1 and 4),
  confianza numeric(5, 2) check (confianza is null or confianza between 0 and 100),
  origen text not null check (origen in ('motor', 'llm_aprobado', 'manual')),
  confirmado_por uuid references core.staff_user(id) on delete set null,
  confirmado_en timestamptz not null default now(),
  deshecho_por uuid references core.staff_user(id) on delete set null,
  deshecho_en timestamptz,
  motivo_deshacer text check (motivo_deshacer is null or char_length(motivo_deshacer) between 3 and 500),
  foreign key (sesion_id, organization_id, property_id) references despachos.conciliacion_sesion (id, organization_id, property_id) on delete cascade,
  foreign key (movimiento_id, organization_id, property_id) references despachos.estado_cuenta_movimiento (id, organization_id, property_id) on delete cascade,
  foreign key (invoice_id, organization_id, property_id) references despachos.invoice (id, organization_id, property_id) on delete cascade,
  unique (id, organization_id, property_id),
  -- manual: sin nivel ni confianza; motor: nivel 1-3; llm_aprobado: nivel 4 y confianza.
  check ((origen = 'manual' and nivel is null and confianza is null)
      or (origen = 'motor' and nivel between 1 and 3 and confianza is not null)
      or (origen = 'llm_aprobado' and nivel = 4 and confianza is not null)),
  check ((deshecho_en is null) = (motivo_deshacer is null))
);
create unique index conciliacion_match_movimiento_vigente_uk on despachos.conciliacion_match (property_id, movimiento_id) where deshecho_en is null;
create index conciliacion_match_sesion_idx on despachos.conciliacion_match (sesion_id);
create index conciliacion_match_invoice_idx on despachos.conciliacion_match (property_id, invoice_id) where deshecho_en is null;

-- ---------------------------------------------------------------------------
-- Sugerencias del nivel 4 (LLM): pendientes hasta que una persona decide.
-- ---------------------------------------------------------------------------
create table despachos.conciliacion_sugerencia (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  sesion_id uuid not null,
  movimiento_id uuid not null,
  invoice_id uuid not null,
  confianza numeric(5, 2) not null check (confianza between 0 and 100),
  razon text not null default '' check (char_length(razon) <= 500),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'aprobada', 'rechazada')),
  match_id uuid,
  creada_por uuid references core.staff_user(id) on delete set null,
  creada_en timestamptz not null default now(),
  resuelta_por uuid references core.staff_user(id) on delete set null,
  resuelta_en timestamptz,
  foreign key (sesion_id, organization_id, property_id) references despachos.conciliacion_sesion (id, organization_id, property_id) on delete cascade,
  foreign key (movimiento_id, organization_id, property_id) references despachos.estado_cuenta_movimiento (id, organization_id, property_id) on delete cascade,
  foreign key (invoice_id, organization_id, property_id) references despachos.invoice (id, organization_id, property_id) on delete cascade,
  foreign key (match_id, organization_id, property_id) references despachos.conciliacion_match (id, organization_id, property_id),
  unique (id, organization_id, property_id),
  check ((estado = 'pendiente') = (resuelta_en is null)),
  check ((estado = 'aprobada') = (match_id is not null))
);
create unique index conciliacion_sugerencia_pendiente_uk on despachos.conciliacion_sugerencia (sesion_id, movimiento_id) where estado = 'pendiente';
create index conciliacion_sugerencia_sesion_idx on despachos.conciliacion_sugerencia (sesion_id, creada_en);

alter table despachos.conciliacion_sesion enable row level security;
alter table despachos.conciliacion_match enable row level security;
alter table despachos.conciliacion_sugerencia enable row level security;

create policy "staff ve sesiones de conciliacion de su property" on despachos.conciliacion_sesion for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff ve matches de conciliacion de su property" on despachos.conciliacion_match for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff ve sugerencias de conciliacion de su property" on despachos.conciliacion_sugerencia for select
  using (core.has_property_access(auth.uid(), property_id));

revoke all on despachos.conciliacion_sesion, despachos.conciliacion_match, despachos.conciliacion_sugerencia from public, anon, authenticated;
grant select on despachos.conciliacion_sesion, despachos.conciliacion_match, despachos.conciliacion_sugerencia to authenticated;
grant select, delete on despachos.conciliacion_sesion, despachos.conciliacion_match, despachos.conciliacion_sugerencia to service_role;

-- ---------------------------------------------------------------------------
-- Vista derivada: marca "conciliado" de un CFDI (solo matches vigentes). security_invoker = RLS de quien consulta.
-- ---------------------------------------------------------------------------
create view despachos.invoice_conciliacion with (security_invoker = on) as
  select m.property_id, m.invoice_id, count(*)::int as movimientos, max(m.confirmado_en) as conciliado_en
  from despachos.conciliacion_match m
  where m.deshecho_en is null
  group by m.property_id, m.invoice_id;
revoke all on despachos.invoice_conciliacion from public, anon, authenticated;
grant select on despachos.invoice_conciliacion to authenticated;

-- ---------------------------------------------------------------------------
-- Funciones de escritura.
-- ---------------------------------------------------------------------------

-- Crea la sesión de un periodo. Exige que existan movimientos guardados del periodo (si no, no hay nada que conciliar).
create or replace function despachos.conciliacion_sesion_crear(p_property_id uuid, p_periodo text, p_cuenta text)
returns table (out_sesion_id uuid, out_movimientos integer)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_desde date;
  v_hasta date;
  v_cuenta text := nullif(btrim(coalesce(p_cuenta, '')), '');
  v_n integer;
  v_id uuid;
begin
  if auth.uid() is null or p_property_id is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'conciliacion_sesion_crear: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id and p.vertical = 'despachos';
  if v_org is null then
    raise exception 'conciliacion_sesion_crear: la property no es de despachos' using errcode = '42501';
  end if;
  if p_periodo is null or p_periodo !~ '^20[1-9][0-9]-(0[1-9]|1[0-2])$' then
    raise exception 'conciliacion_sesion_crear: periodo con formato YYYY-MM' using errcode = '22023';
  end if;
  if v_cuenta is not null and char_length(v_cuenta) > 34 then
    raise exception 'conciliacion_sesion_crear: cuenta de hasta 34 caracteres' using errcode = '22023';
  end if;
  v_desde := (p_periodo || '-01')::date;
  v_hasta := (v_desde + interval '1 month')::date;
  select count(*)::int into v_n from despachos.estado_cuenta_movimiento mv
   where mv.property_id = p_property_id and mv.fecha >= v_desde and mv.fecha < v_hasta
     and (v_cuenta is null or mv.cuenta = v_cuenta);
  if v_n = 0 then
    raise exception 'conciliacion_sesion_crear: no hay movimientos guardados en el periodo %', p_periodo using errcode = 'P0002';
  end if;
  insert into despachos.conciliacion_sesion (organization_id, property_id, periodo, cuenta, creada_por)
  values (v_org, p_property_id, p_periodo, v_cuenta, auth.uid())
  returning id into v_id;
  return query select v_id, v_n;
end;
$$;

-- Núcleo interno: inserta UN match vigente validando pertenencia, periodo y estado. No se concede a nadie directo.
create or replace function despachos.conciliacion_match_insertar(
  p_sesion_id uuid, p_movimiento_id uuid, p_invoice_id uuid, p_nivel smallint, p_confianza numeric, p_origen text
)
returns uuid
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_prop uuid;
  v_periodo text;
  v_estado text;
  v_cuenta text;
  v_fecha date;
  v_mov_cuenta text;
  v_id uuid;
begin
  select s.organization_id, s.property_id, s.periodo, s.estado, s.cuenta into v_org, v_prop, v_periodo, v_estado, v_cuenta
    from despachos.conciliacion_sesion s where s.id = p_sesion_id;
  if not found or auth.uid() is null or not despachos.cartera_puede_escribir(v_prop) then
    raise exception 'conciliacion_match: sin permiso o sesión inexistente' using errcode = '42501';
  end if;
  if v_estado <> 'abierta' then
    raise exception 'conciliacion_match: la sesión está cerrada' using errcode = '22023';
  end if;
  if p_origen not in ('motor', 'llm_aprobado', 'manual') then
    raise exception 'conciliacion_match: origen inválido' using errcode = '22023';
  end if;
  select mv.fecha, mv.cuenta into v_fecha, v_mov_cuenta from despachos.estado_cuenta_movimiento mv
   where mv.id = p_movimiento_id and mv.property_id = v_prop;
  if v_fecha is null or to_char(v_fecha, 'YYYY-MM') <> v_periodo or (v_cuenta is not null and v_mov_cuenta is distinct from v_cuenta) then
    raise exception 'conciliacion_match: el movimiento no pertenece a la sesión' using errcode = '22023';
  end if;
  if not exists (select 1 from despachos.invoice i where i.id = p_invoice_id and i.property_id = v_prop) then
    raise exception 'conciliacion_match: el CFDI no pertenece al cliente' using errcode = '22023';
  end if;
  if exists (select 1 from despachos.periodo_cierre pc where pc.property_id = v_prop and pc.anio = extract(year from v_fecha)::int and pc.mes = extract(month from v_fecha)::int and pc.status = 'closed') then
    raise exception 'conciliacion_match: el periodo % está cerrado', v_periodo using errcode = '55000';
  end if;
  insert into despachos.conciliacion_match (organization_id, property_id, sesion_id, movimiento_id, invoice_id, nivel, confianza, origen, confirmado_por)
  values (v_org, v_prop, p_sesion_id, p_movimiento_id, p_invoice_id, p_nivel, p_confianza, p_origen, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

-- Confirma un lote de pares (todo o nada). Cada elemento: {movimiento_id, invoice_id, nivel, confianza, origen}.
create or replace function despachos.conciliacion_matches_confirmar(p_sesion_id uuid, p_matches jsonb)
returns table (out_match_id uuid, out_movimiento_id uuid, out_invoice_id uuid)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  r record;
  v_n integer;
  v_id uuid;
begin
  if auth.uid() is null or not exists (select 1 from despachos.conciliacion_sesion s where s.id = p_sesion_id and despachos.cartera_puede_escribir(s.property_id)) then
    raise exception 'conciliacion_matches_confirmar: sin permiso o sesión inexistente' using errcode = '42501';
  end if;
  if p_matches is null or jsonb_typeof(p_matches) <> 'array' then
    raise exception 'conciliacion_matches_confirmar: se espera un arreglo de pares' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_matches);
  if v_n < 1 or v_n > 200 then
    raise exception 'conciliacion_matches_confirmar: de 1 a 200 pares por solicitud' using errcode = '22023';
  end if;
  for r in
    select x.movimiento_id, x.invoice_id, x.nivel, x.confianza, x.origen
    from jsonb_to_recordset(p_matches) as x(movimiento_id uuid, invoice_id uuid, nivel smallint, confianza numeric, origen text)
  loop
    v_id := despachos.conciliacion_match_insertar(p_sesion_id, r.movimiento_id, r.invoice_id, r.nivel, r.confianza, r.origen);
    return query select v_id, r.movimiento_id, r.invoice_id;
  end loop;
end;
$$;

-- Deshace un match vigente (motivo obligatorio). IDEMPOTENTE: si ya estaba deshecho no cambia nada y lo informa.
create or replace function despachos.conciliacion_match_deshacer(p_property_id uuid, p_match_id uuid, p_motivo text)
returns table (out_ya_deshecho boolean)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_motivo text := btrim(coalesce(p_motivo, ''));
  v_deshecho timestamptz;
  v_fecha date;
begin
  if auth.uid() is null or p_property_id is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'conciliacion_match_deshacer: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  if char_length(v_motivo) < 3 or char_length(v_motivo) > 500 then
    raise exception 'conciliacion_match_deshacer: el motivo es obligatorio (3 a 500 caracteres)' using errcode = '22023';
  end if;
  select m.deshecho_en, mv.fecha into v_deshecho, v_fecha
    from despachos.conciliacion_match m join despachos.estado_cuenta_movimiento mv on mv.id = m.movimiento_id
   where m.id = p_match_id and m.property_id = p_property_id for update of m;
  if not found then
    raise exception 'conciliacion_match_deshacer: match no encontrado' using errcode = 'P0002';
  end if;
  if v_deshecho is not null then
    return query select true;
    return;
  end if;
  if exists (select 1 from despachos.periodo_cierre pc where pc.property_id = p_property_id and pc.anio = extract(year from v_fecha)::int and pc.mes = extract(month from v_fecha)::int and pc.status = 'closed') then
    raise exception 'conciliacion_match_deshacer: el periodo % está cerrado', to_char(v_fecha, 'YYYY-MM') using errcode = '55000';
  end if;
  update despachos.conciliacion_match set deshecho_por = auth.uid(), deshecho_en = now(), motivo_deshacer = v_motivo where id = p_match_id;
  return query select false;
end;
$$;

-- Cierra una sesión abierta (idempotente: cerrar una ya cerrada no cambia nada).
create or replace function despachos.conciliacion_sesion_cerrar(p_property_id uuid, p_sesion_id uuid)
returns table (out_ya_cerrada boolean)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_estado text;
begin
  if auth.uid() is null or p_property_id is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'conciliacion_sesion_cerrar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  select s.estado into v_estado from despachos.conciliacion_sesion s where s.id = p_sesion_id and s.property_id = p_property_id for update;
  if not found then
    raise exception 'conciliacion_sesion_cerrar: sesión no encontrada' using errcode = 'P0002';
  end if;
  if v_estado = 'cerrada' then
    return query select true;
    return;
  end if;
  update despachos.conciliacion_sesion set estado = 'cerrada', cerrada_por = auth.uid(), cerrada_en = now() where id = p_sesion_id;
  return query select false;
end;
$$;

-- Guarda las sugerencias del LLM como PENDIENTES (nunca crea un match). Una pendiente por movimiento: el resto se ignora.
create or replace function despachos.conciliacion_sugerencias_guardar(p_sesion_id uuid, p_sugerencias jsonb)
returns table (out_sugerencia_id uuid, out_movimiento_id uuid)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_prop uuid;
  v_estado text;
  v_n integer;
begin
  select s.organization_id, s.property_id, s.estado into v_org, v_prop, v_estado from despachos.conciliacion_sesion s where s.id = p_sesion_id;
  if not found or auth.uid() is null or not despachos.cartera_puede_escribir(v_prop) then
    raise exception 'conciliacion_sugerencias_guardar: sin permiso o sesión inexistente' using errcode = '42501';
  end if;
  if v_estado <> 'abierta' then
    raise exception 'conciliacion_sugerencias_guardar: la sesión está cerrada' using errcode = '22023';
  end if;
  if p_sugerencias is null or jsonb_typeof(p_sugerencias) <> 'array' then
    raise exception 'conciliacion_sugerencias_guardar: se espera un arreglo' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_sugerencias);
  if v_n > 100 then
    raise exception 'conciliacion_sugerencias_guardar: hasta 100 sugerencias por solicitud' using errcode = '54000';
  end if;
  return query
    insert into despachos.conciliacion_sugerencia (organization_id, property_id, sesion_id, movimiento_id, invoice_id, confianza, razon, creada_por)
    select v_org, v_prop, p_sesion_id, x.movimiento_id, x.invoice_id, least(100, greatest(0, x.confianza)), left(coalesce(x.razon, ''), 500), auth.uid()
      from jsonb_to_recordset(p_sugerencias) as x(movimiento_id uuid, invoice_id uuid, confianza numeric, razon text)
    on conflict (sesion_id, movimiento_id) where estado = 'pendiente' do nothing
    returning id, movimiento_id;
end;
$$;

-- Resuelve una sugerencia pendiente: aprobar = crea el match (origen llm_aprobado, nivel 4) en la misma transacción; rechazar = solo la marca.
create or replace function despachos.conciliacion_sugerencia_resolver(p_property_id uuid, p_sugerencia_id uuid, p_aprobar boolean)
returns table (out_estado text, out_match_id uuid)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_sesion uuid;
  v_mov uuid;
  v_inv uuid;
  v_conf numeric;
  v_estado text;
  v_match uuid;
begin
  if auth.uid() is null or p_property_id is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'conciliacion_sugerencia_resolver: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  if p_aprobar is null then
    raise exception 'conciliacion_sugerencia_resolver: indica si se aprueba o se rechaza' using errcode = '22023';
  end if;
  select g.sesion_id, g.movimiento_id, g.invoice_id, g.confianza, g.estado into v_sesion, v_mov, v_inv, v_conf, v_estado
    from despachos.conciliacion_sugerencia g where g.id = p_sugerencia_id and g.property_id = p_property_id for update;
  if not found then
    raise exception 'conciliacion_sugerencia_resolver: sugerencia no encontrada' using errcode = 'P0002';
  end if;
  if v_estado <> 'pendiente' then
    raise exception 'conciliacion_sugerencia_resolver: la sugerencia ya fue resuelta (%)', v_estado using errcode = '22023';
  end if;
  if p_aprobar then
    v_match := despachos.conciliacion_match_insertar(v_sesion, v_mov, v_inv, 4::smallint, v_conf, 'llm_aprobado');
    update despachos.conciliacion_sugerencia set estado = 'aprobada', match_id = v_match, resuelta_por = auth.uid(), resuelta_en = now() where id = p_sugerencia_id;
    return query select 'aprobada'::text, v_match;
  else
    update despachos.conciliacion_sugerencia set estado = 'rechazada', resuelta_por = auth.uid(), resuelta_en = now() where id = p_sugerencia_id;
    return query select 'rechazada'::text, null::uuid;
  end if;
end;
$$;

revoke all on function despachos.conciliacion_sesion_crear(uuid, text, text) from public, anon;
revoke all on function despachos.conciliacion_match_insertar(uuid, uuid, uuid, smallint, numeric, text) from public, anon, authenticated;
revoke all on function despachos.conciliacion_matches_confirmar(uuid, jsonb) from public, anon;
revoke all on function despachos.conciliacion_match_deshacer(uuid, uuid, text) from public, anon;
revoke all on function despachos.conciliacion_sesion_cerrar(uuid, uuid) from public, anon;
revoke all on function despachos.conciliacion_sugerencias_guardar(uuid, jsonb) from public, anon;
revoke all on function despachos.conciliacion_sugerencia_resolver(uuid, uuid, boolean) from public, anon;
grant execute on function despachos.conciliacion_sesion_crear(uuid, text, text) to authenticated;
grant execute on function despachos.conciliacion_matches_confirmar(uuid, jsonb) to authenticated;
grant execute on function despachos.conciliacion_match_deshacer(uuid, uuid, text) to authenticated;
grant execute on function despachos.conciliacion_sesion_cerrar(uuid, uuid) to authenticated;
grant execute on function despachos.conciliacion_sugerencias_guardar(uuid, jsonb) to authenticated;
grant execute on function despachos.conciliacion_sugerencia_resolver(uuid, uuid, boolean) to authenticated;
