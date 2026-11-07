-- ds3 «Guía»: progreso del recorrido guiado POR PERSONA (paso actual, modo, visto/omitido/descartado, terminado), para que el
-- recorrido se retome en otro equipo o navegador. Solo guarda lo NO derivable de los datos: «Primeros pasos» se sigue calculando
-- con datos reales (packages/domain-restaurantes/src/onboarding.ts, core.onboarding_evento); aqui nunca se guarda un «hecho».
--
-- Que agrega (aditivo, schema core):
--   A) core.onboarding_progreso: una fila por (persona, organizacion o plataforma, pista). `pista` = «<vertical>.<rol>» o «superadmin».
--   B) core.guardar_onboarding_progreso(...): UNICO camino de escritura (upsert de la fila propia).
--   C) Lectura: RLS de SELECT a la propia fila (user_id = auth.uid()).
--
-- Justificacion de seguridad:
--   * Tabla con RLS. GRANT SELECT a authenticated con policy `user_id = auth.uid()`: nadie lee el progreso de otra persona (ni otro
--     miembro de su organizacion, ni otra organizacion). Sin GRANT de INSERT/UPDATE/DELETE a nadie (ni a anon): la unica escritura
--     es la funcion B. Sin datos personales: ids de paso del recorrido y banderas.
--   * B: security definer, `set search_path = core, pg_temp`, `revoke all from public, anon`, execute solo a authenticated.
--       - Exige sesion de persona (auth.uid() no nulo, si no 42501): el sistema no tiene recorrido. El dueño de la fila es SIEMPRE
--         auth.uid(), nunca un parametro.
--       - Con organizacion (por slug): la persona debe ser miembro de ESA organizacion (si no, 42501) y la pista debe empezar con la
--         vertical de la organizacion (22023). Sin organizacion: solo la pista «superadmin» y solo para un superadmin de plataforma
--         (core.is_platform_superadmin, si no 42501).
--       - Formato acotado (22023): pista, modo y paso con lista/expresion cerrada; el paso mide a lo sumo 80.
--
-- Rollback (no se aplica a produccion con este PR; si hiciera falta revertir tras aplicarla):
--   drop function if exists core.guardar_onboarding_progreso(text, text, text, text, boolean, boolean, boolean, boolean, boolean);
--   drop table if exists core.onboarding_progreso;
-- El codigo nuevo tolera la base sin esta migracion (42P01/42883 -> la guia sigue con el progreso del navegador).

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Tabla
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists core.onboarding_progreso (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null,
  organization_id uuid references core.organization(id) on delete cascade,
  pista           text not null check (pista ~ '^[a-z]{3,20}(\.[a-z_]{2,20})?$'),
  modo            text check (modo in ('corto', 'completo')),
  paso            text check (paso is null or (length(paso) <= 80 and paso ~ '^[a-z0-9._:-]+$')),
  visto           boolean not null default false,
  omitido         boolean not null default false,
  descartado      boolean not null default false,
  activo          boolean not null default false,
  terminado_en    timestamptz,
  updated_at      timestamptz not null default now()
);
create unique index if not exists onboarding_progreso_unico
  on core.onboarding_progreso (user_id, coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), pista);

alter table core.onboarding_progreso enable row level security;

-- Lectura: solo la propia fila.
drop policy if exists onboarding_progreso_select_propio on core.onboarding_progreso;
create policy onboarding_progreso_select_propio on core.onboarding_progreso
  for select to authenticated
  using (user_id = auth.uid());
revoke all on core.onboarding_progreso from public, anon, authenticated;
grant select on core.onboarding_progreso to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Escritura (unico camino)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.guardar_onboarding_progreso(
  p_org_slug text,
  p_pista text,
  p_modo text,
  p_paso text,
  p_visto boolean,
  p_omitido boolean,
  p_descartado boolean,
  p_activo boolean,
  p_terminado boolean
)
returns timestamptz
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_vertical text;
  v_ahora timestamptz := now();
begin
  if v_uid is null then
    raise exception 'guardar_onboarding_progreso: requiere la sesion de una persona' using errcode = '42501';
  end if;
  if p_pista is null or p_pista !~ '^[a-z]{3,20}(\.[a-z_]{2,20})?$' then
    raise exception 'guardar_onboarding_progreso: pista invalida' using errcode = '22023';
  end if;
  if p_modo is not null and p_modo not in ('corto', 'completo') then
    raise exception 'guardar_onboarding_progreso: modo invalido' using errcode = '22023';
  end if;
  if p_paso is not null and (length(p_paso) > 80 or p_paso !~ '^[a-z0-9._:-]+$') then
    raise exception 'guardar_onboarding_progreso: paso invalido' using errcode = '22023';
  end if;

  if p_org_slug is null then
    if p_pista <> 'superadmin' then
      raise exception 'guardar_onboarding_progreso: sin organizacion solo existe la pista superadmin' using errcode = '22023';
    end if;
    if not core.is_platform_superadmin(v_uid) then
      raise exception 'guardar_onboarding_progreso: solo superadmin de plataforma' using errcode = '42501';
    end if;
  else
    select o.id, o.vertical into v_org, v_vertical from core.organization o where o.slug = p_org_slug;
    if v_org is null or not exists (select 1 from core.membership m where m.organization_id = v_org and m.user_id = v_uid) then
      -- Misma respuesta para «no existe» y «no eres miembro»: no se revela que otra organizacion existe.
      raise exception 'guardar_onboarding_progreso: no eres miembro de la organizacion' using errcode = '42501';
    end if;
    if split_part(p_pista, '.', 1) is distinct from v_vertical then
      raise exception 'guardar_onboarding_progreso: la pista no corresponde a la vertical' using errcode = '22023';
    end if;
  end if;

  insert into core.onboarding_progreso as g (user_id, organization_id, pista, modo, paso, visto, omitido, descartado, activo, terminado_en, updated_at)
  values (v_uid, v_org, p_pista, p_modo, p_paso, coalesce(p_visto, false), coalesce(p_omitido, false), coalesce(p_descartado, false),
          coalesce(p_activo, false), case when p_terminado then v_ahora end, v_ahora)
  on conflict (user_id, coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), pista) do update set
    modo = excluded.modo,
    paso = excluded.paso,
    visto = excluded.visto,
    omitido = excluded.omitido,
    descartado = excluded.descartado,
    activo = excluded.activo,
    -- «Terminado» es un hito: una vez puesto no se borra al repetir el recorrido.
    terminado_en = coalesce(g.terminado_en, excluded.terminado_en),
    updated_at = v_ahora;
  return v_ahora;
end;
$$;
revoke all on function core.guardar_onboarding_progreso(text, text, text, text, boolean, boolean, boolean, boolean, boolean) from public, anon;
grant execute on function core.guardar_onboarding_progreso(text, text, text, text, boolean, boolean, boolean, boolean, boolean) to authenticated;
