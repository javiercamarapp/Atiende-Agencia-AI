-- Rn-02 (P1) -- conflictos de calendario con estado (abierto / resuelto / ignorado con
-- motivo), bitácora de cada decisión y una acción de resolución segura.
--
-- Contexto. La migración 024 dejó que el staff marcara un conflicto como resuelto con un
-- UPDATE directo de (resuelto_en, resuelto_por). Eso tiene tres huecos: (a) no hay forma de
-- distinguir "se corrigió el doble reserva" de "se acepta el solape a sabiendas" (ignorar), ni
-- de dejar el motivo; (b) no queda una bitácora de la decisión (solo el último actor); (c) se
-- puede marcar "resuelto" un conflicto cuyas dos reservas SIGUEN ocupando las mismas noches.
--
-- Esta migración es aditiva salvo por un REVOKE puntual (ver 2). El código TypeScript que la
-- usa cae al camino anterior (UPDATE directo de 024, sin ignorar ni bitácora) si la base
-- todavía no la tiene (SQLSTATE 42883/42P01/42703).
--
-- Requiere: 001, 021 (convención: el actor SIEMPRE sale de auth.uid()) y 024.

-- ---------------------------------------------------------------------------
-- 1) Estado y motivo en rentas.conflicto_calendario.
-- ---------------------------------------------------------------------------
-- Estado derivado: abierto = resuelto_en is null; cerrado = resuelto_en is not null y
-- `resolucion` dice cómo se cerró. Se conservan resuelto_en/resuelto_por (024) como "cuándo
-- y quién" de la decisión.
alter table rentas.conflicto_calendario
  add column resolucion text,
  add column motivo_resolucion text;

-- Los conflictos ya resueltos con 024 quedan como 'resuelto' (sin motivo).
update rentas.conflicto_calendario set resolucion = 'resuelto' where resuelto_en is not null and resolucion is null;

alter table rentas.conflicto_calendario
  add constraint conflicto_calendario_resolucion_valida check (resolucion is null or resolucion in ('resuelto', 'ignorado')),
  -- abierto <=> sin resolución: no hay un estado a medias.
  add constraint conflicto_calendario_resolucion_coherente check ((resuelto_en is null) = (resolucion is null)),
  -- ignorar exige un motivo real (3 a 500 caracteres sin contar espacios de los extremos).
  add constraint conflicto_calendario_ignorado_con_motivo check (resolucion is distinct from 'ignorado' or char_length(btrim(coalesce(motivo_resolucion, ''))) between 3 and 500),
  add constraint conflicto_calendario_motivo_acotado check (motivo_resolucion is null or char_length(motivo_resolucion) <= 500);

-- ---------------------------------------------------------------------------
-- 2) Cerrar la vía directa: resolver SOLO vía rentas.resolver_conflicto_calendario.
-- ---------------------------------------------------------------------------
-- Justificación de seguridad: con el UPDATE directo de 024 un cliente con su JWT podía cerrar
-- un conflicto sin dejar bitácora, sin motivo y sin la verificación de la regla "resuelto exige
-- que el solape ya no exista". Se revoca el GRANT por columna y se elimina la policy: ninguna
-- columna de rentas.conflicto_calendario es escribible por `authenticated` desde ahora (solo
-- conserva select + insert de 001, y el insert lo usa el propio flujo de reservas/bloqueos).
drop policy "staff resuelve conflictos de su property" on rentas.conflicto_calendario;
revoke update (resuelto_en, resuelto_por) on rentas.conflicto_calendario from authenticated;

-- ---------------------------------------------------------------------------
-- 3) Bitácora de decisiones sobre conflictos (append-only).
-- ---------------------------------------------------------------------------
create table rentas.conflicto_calendario_bitacora (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  conflicto_id uuid not null references rentas.conflicto_calendario(id) on delete cascade,
  accion text not null check (accion in ('resuelto', 'ignorado')),
  motivo text check (motivo is null or char_length(motivo) <= 500),
  -- `on delete restrict`: una decisión sin saber quién la tomó no tiene valor (mismo criterio
  -- que rentas.audit_log, 021). El actor sale SIEMPRE de auth.uid(), nunca de un parámetro.
  actor_user_id uuid not null references core.staff_user(id) on delete restrict,
  creado_en timestamptz not null default now(),
  constraint conflicto_bitacora_ignorado_con_motivo check (accion <> 'ignorado' or char_length(btrim(coalesce(motivo, ''))) between 3 and 500)
);
create index conflicto_calendario_bitacora_conflicto_idx on rentas.conflicto_calendario_bitacora (conflicto_id, creado_en);
create index conflicto_calendario_bitacora_property_idx on rentas.conflicto_calendario_bitacora (property_id, creado_en desc);

alter table rentas.conflicto_calendario_bitacora enable row level security;

-- Justificación de seguridad (RLS): lectura solo para staff con acceso a la property (misma
-- autoridad que el resto de rentas.*). Sin policy de INSERT/UPDATE/DELETE para `authenticated`
-- (deny-by-default): la bitácora solo se escribe desde rentas.resolver_conflicto_calendario.
create policy "staff ve la bitacora de conflictos de su property" on rentas.conflicto_calendario_bitacora for select
  using (core.has_property_access(auth.uid(), property_id));

-- Solo SELECT para ambos roles: `service_role` tiene bypassrls, así que un GRANT de escritura
-- sería una vía directa con actor arbitrario que ningún caller usa. La función definer de
-- abajo escribe con los privilegios de su dueño y no necesita GRANT sobre la tabla.
revoke all on rentas.conflicto_calendario_bitacora from public, anon, authenticated, service_role;
grant select on rentas.conflicto_calendario_bitacora to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) Acción de resolución segura.
-- ---------------------------------------------------------------------------
-- rentas.resolver_conflicto_calendario(property, conflicto, accion, motivo):
--   - 'ignorado': acepta el solape a sabiendas; exige motivo de 3 a 500 caracteres.
--   - 'resuelto': exige que el solape YA NO exista (alguna de las dos ocupaciones está
--     cancelada o sus rangos ya no se cruzan). Un conflicto cuyas dos ocupaciones siguen
--     ocupando las mismas noches no puede marcarse "resuelto" (usar 'ignorado' con motivo).
--     El motivo es opcional (nota).
-- Nunca cancela, mueve ni edita una reserva: solo cierra el aviso (el sistema no decide por
-- el staff, REQ-000 del origen).
--
-- Justificación de seguridad (security definer): escribe la bitácora, que `authenticated` no
-- puede escribir. Guardas, en orden:
--   * auth.uid() is not null (42501): la sesión de sistema NO resuelve; es una decisión humana.
--   * vertical_role de escritura de sync/calendario (42501): espejo SQL de
--     SYNC_CALENDARIO_ESCRITURA_ROLES; defensa en profundidad frente a un cliente con JWT
--     propio que se salte la API.
--   * core.has_property_access sobre la property DEL conflicto, y el conflicto debe pertenecer
--     a p_property_id: un conflicto ajeno, inexistente o ya cerrado da el mismo P0002 (no se
--     revela su existencia entre tenants).
--   * for update serializa dos decisiones simultáneas: la segunda ve el conflicto ya cerrado.
-- search_path fijo (pg_catalog primero, pg_temp al final), EXECUTE revocado a public y anon.
-- Códigos: 42501 sin permiso, 22023 argumento inválido, P0002 no encontrado/ya cerrado,
-- 55000 el solape sigue vigente.
create function rentas.resolver_conflicto_calendario(p_property_id uuid, p_conflicto_id uuid, p_accion text, p_motivo text default null)
returns text
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_conflicto rentas.conflicto_calendario%rowtype;
  v_motivo text := nullif(btrim(coalesce(p_motivo, '')), '');
begin
  if v_uid is null then
    raise exception 'rentas.resolver_conflicto_calendario: solo staff autenticado; la sesion de sistema no resuelve conflictos.' using errcode = '42501';
  end if;
  if p_accion is null or p_accion not in ('resuelto', 'ignorado') then
    raise exception 'rentas.resolver_conflicto_calendario: accion invalida (se esperaba resuelto o ignorado).' using errcode = '22023';
  end if;
  if v_motivo is not null and char_length(v_motivo) > 500 then
    raise exception 'rentas.resolver_conflicto_calendario: el motivo excede 500 caracteres.' using errcode = '22023';
  end if;
  if p_accion = 'ignorado' and (v_motivo is null or char_length(v_motivo) < 3) then
    raise exception 'rentas.resolver_conflicto_calendario: ignorar un conflicto exige un motivo de al menos 3 caracteres.' using errcode = '22023';
  end if;

  select c.* into v_conflicto
  from rentas.conflicto_calendario c
  where c.id = p_conflicto_id and c.property_id = p_property_id and c.resuelto_en is null
    and core.has_property_access(v_uid, c.property_id)
  for update;
  if not found then
    raise exception 'rentas.resolver_conflicto_calendario: conflicto no encontrado en esta property o ya cerrado.' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from core.membership m
    where m.user_id = v_uid and m.organization_id = v_conflicto.organization_id
      and m.vertical_role in ('admin_gestora', 'operador:acceso_total', 'operador:calendario_mensajeria')
      and (m.property_ids is null or v_conflicto.property_id = any(m.property_ids))
  ) then
    raise exception 'rentas.resolver_conflicto_calendario: tu rol no puede resolver conflictos de calendario.' using errcode = '42501';
  end if;

  if p_accion = 'resuelto' and v_conflicto.ocupacion_b_id is not null and exists (
    select 1
    from rentas.ocupacion a
    join rentas.ocupacion b on b.id = v_conflicto.ocupacion_b_id
    where a.id = v_conflicto.ocupacion_a_id and a.estado <> 'cancelado' and b.estado <> 'cancelado' and a.rango && b.rango
  ) then
    raise exception 'rentas.resolver_conflicto_calendario: las dos ocupaciones siguen cruzadas; cancela una o ignora el conflicto con un motivo.' using errcode = '55000';
  end if;

  update rentas.conflicto_calendario
  set resuelto_en = now(), resuelto_por = v_uid, resolucion = p_accion, motivo_resolucion = v_motivo
  where id = v_conflicto.id;

  insert into rentas.conflicto_calendario_bitacora (organization_id, property_id, conflicto_id, accion, motivo, actor_user_id)
  values (v_conflicto.organization_id, v_conflicto.property_id, v_conflicto.id, p_accion, v_motivo, v_uid);

  return p_accion;
end;
$$;

revoke all on function rentas.resolver_conflicto_calendario(uuid, uuid, text, text) from public, anon;
grant execute on function rentas.resolver_conflicto_calendario(uuid, uuid, text, text) to authenticated;
