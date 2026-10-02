-- L-30 / L-32 (licitaciones): re-tamizado KYC 69-B de la cartera cuando entra una edicion nueva de la
-- lista, y lectura de sistema de documentos de empresa por vencer para los avisos de la campana.
-- Requiere: 001..033 de licitaciones (kyc_party de la 031, company_document de la 001) y la 014 de despachos
-- (`despachos.efos_ingesta` / `despachos.efos_contribuyente`).
--
-- CARTERA (definicion): las FICHAS de la organizacion en `licitaciones.kyc_party` (proveedores y
-- competidores registrados con RFC). NO se usa la bitacora privada de consultas (`kyc_consulta`): consultar
-- un RFC una vez no es declararlo parte de la cartera, y re-tamizar la bitacora completa produciria alertas
-- sobre RFC que nadie sigue.
--
-- Que hace `licitaciones.system_retamizar_cartera_kyc()`: toma la edicion MAS RECIENTE de la lista 69-B,
-- evalua el semaforo (definitivo = rojo, presunto = ambar, resto = verde) de cada ficha de cada
-- organizacion activa de licitaciones y guarda UNA fila por (organizacion, RFC, rol, edicion). Marca
-- `empeoro` solo si el semaforo es PEOR que el de la evaluacion anterior de ese mismo RFC (edicion
-- anterior mas reciente). La primera evaluacion de un RFC es linea base: no alerta (no hay contra que
-- comparar; la ficha ya muestra su semaforo vigente en la pantalla de KYC). Idempotente: repetir la
-- corrida con la misma edicion y el mismo SHA no inserta nada y por tanto no devuelve filas; si el SAT
-- corrige una edicion (SHA distinto, `efos_ingestar_periodo` -> 'reemplazada') las filas de esa edicion se
-- reevaluan y se actualizan.
--
-- Seguridad:
--   * `kyc_retamizado`: RLS habilitado; policy de lectura solo para miembros de LA MISMA organizacion
--     (`can_access_org`, igual que las fichas); sin `using (true)`; REVOKE ALL a public/anon/authenticated y
--     GRANT SELECT solo a authenticated. Sin INSERT/UPDATE/DELETE para el cliente: el unico escritor es la
--     funcion de sistema, de modo que un usuario no puede falsear ni borrar el historial de re-tamizado.
--   * `system_retamizar_cartera_kyc`: security definer con `set search_path` fijo, revoke de public,
--     GRANT EXECUTE a authenticated (la sesion de sistema de la app corre bajo ese rol sin sub, mismo
--     precedente que `despachos.efos_ingestar_periodo` y las funciones `system_*` de la 025) y guard
--     `auth.uid() is null` o 42501: cualquier usuario con sub real es rechazado DENTRO. Definer porque lee
--     `despachos.efos_*` (sin ningun GRANT) y escribe `kyc_retamizado` (sin INSERT para el cliente).
--     Lock asesor global: dos corridas concurrentes no duplican ni cruzan evaluaciones.
--   * `system_count_company_documents_expiring`: solo-sistema (mismo guard), solo lectura, devuelve un
--     ENTERO por organizacion (sin nombres ni contenido de documentos); definer porque el barrido de
--     sistema no pasa por la policy `can_access_org` de `company_document`.
--
-- Compatibilidad con la base sin migrar: el TypeScript que consume estas funciones corre cada llamada en
-- SAVEPOINT y degrada a "no disponible aun" ante 42883/42P01/42703. Orden de despliegue: la migracion puede
-- aplicarse antes o despues del codigo.

create table licitaciones.kyc_retamizado (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  rfc text not null check (rfc ~ '^[A-ZÑ&]{3,4}[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])[A-Z0-9]{2}[0-9A]$'),
  rol text not null check (rol in ('proveedor', 'competidor')),
  periodo text not null check (periodo ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  situacion text check (situacion is null or situacion in ('presunto', 'desvirtuado', 'definitivo', 'sentencia_favorable')),
  semaforo text not null check (semaforo in ('verde', 'ambar', 'rojo')),
  -- true = el semaforo es peor que el de la evaluacion anterior de este RFC (nunca en la linea base).
  empeoro boolean not null default false,
  fuente_sha256 text not null,
  evaluado_en timestamptz not null default now(),
  unique (organization_id, rfc, rol, periodo)
);
create index licitaciones_kyc_retamizado_org_idx on licitaciones.kyc_retamizado (organization_id, periodo desc);

alter table licitaciones.kyc_retamizado enable row level security;
-- Seguridad: miembros de la organizacion leen SU historial; ninguna otra organizacion lo ve.
create policy "kyc_retamizado: miembros de la org lo leen" on licitaciones.kyc_retamizado
  for select using (licitaciones.can_access_org(organization_id));
revoke all on licitaciones.kyc_retamizado from public, anon, authenticated;
grant select on licitaciones.kyc_retamizado to authenticated;

create or replace function licitaciones.system_retamizar_cartera_kyc()
returns table (
  out_organization_id uuid,
  out_periodo text,
  out_evaluadas integer,
  out_empeoradas integer,
  out_proveedores_empeorados integer
)
language plpgsql
security definer
set search_path = licitaciones, despachos, core, pg_temp
as $$
declare
  v_periodo text;
  v_sha text;
begin
  if auth.uid() is not null then
    raise exception 'system_retamizar_cartera_kyc es solo para la sesion de sistema' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('licitaciones.kyc_retamizado', 0));

  select i.periodo, i.fuente_sha256 into v_periodo, v_sha
    from despachos.efos_ingesta i
    order by i.periodo desc
    limit 1;
  if v_periodo is null then
    return; -- nunca se ingirio la lista: nada que evaluar (no es un error)
  end if;

  return query
    with evaluadas as (
      insert into licitaciones.kyc_retamizado as k (organization_id, rfc, rol, periodo, situacion, semaforo, empeoro, fuente_sha256)
      select p.organization_id, p.rfc, p.rol, v_periodo, c.situacion,
             case c.situacion when 'definitivo' then 'rojo' when 'presunto' then 'ambar' else 'verde' end,
             coalesce(
               (case c.situacion when 'definitivo' then 2 when 'presunto' then 1 else 0 end)
                 > (case prev.semaforo when 'rojo' then 2 when 'ambar' then 1 else 0 end),
               false
             ) and prev.semaforo is not null,
             v_sha
        from licitaciones.kyc_party p
        join core.organization o on o.id = p.organization_id and o.vertical = 'licitaciones' and o.status = 'active'
        left join despachos.efos_contribuyente c on c.rfc = p.rfc and c.periodo = v_periodo
        left join lateral (
          select r.semaforo
            from licitaciones.kyc_retamizado r
           where r.organization_id = p.organization_id and r.rfc = p.rfc and r.rol = p.rol and r.periodo < v_periodo
           order by r.periodo desc
           limit 1
        ) prev on true
      on conflict (organization_id, rfc, rol, periodo) do update
        set situacion = excluded.situacion,
            semaforo = excluded.semaforo,
            empeoro = excluded.empeoro,
            fuente_sha256 = excluded.fuente_sha256,
            evaluado_en = now()
        where k.fuente_sha256 is distinct from excluded.fuente_sha256
      returning k.organization_id as e_org, k.rol as e_rol, k.empeoro as e_empeoro
    )
    select e.e_org, v_periodo, count(*)::integer,
           (count(*) filter (where e.e_empeoro))::integer,
           (count(*) filter (where e.e_empeoro and e.e_rol = 'proveedor'))::integer
      from evaluadas e
     group by e.e_org;
end;
$$;
revoke all on function licitaciones.system_retamizar_cartera_kyc() from public;
grant execute on function licitaciones.system_retamizar_cartera_kyc() to authenticated;

create or replace function licitaciones.system_count_company_documents_expiring(p_organization_id uuid, p_today date, p_days integer)
returns integer
language plpgsql
stable
security definer
set search_path = licitaciones, pg_temp
as $$
declare
  v_count integer;
begin
  if auth.uid() is not null then
    raise exception 'system_count_company_documents_expiring es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if p_organization_id is null or p_today is null or p_days is null or p_days < 1 or p_days > 365 then
    raise exception 'system_count_company_documents_expiring: parametros invalidos' using errcode = '22023';
  end if;
  select count(*)::integer into v_count
    from licitaciones.company_document d
   where d.organization_id = p_organization_id
     and d.approval_status = 'aprobado'
     and d.expires_at is not null
     and d.expires_at >= p_today
     and d.expires_at <= p_today + p_days;
  return v_count;
end;
$$;
revoke all on function licitaciones.system_count_company_documents_expiring(uuid, date, integer) from public;
grant execute on function licitaciones.system_count_company_documents_expiring(uuid, date, integer) to authenticated;
