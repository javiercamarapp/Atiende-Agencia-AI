-- L-22 (licitaciones): calendario de dias inhabiles por organizacion y por convocatoria.
-- Requiere: 001..031 (`licitaciones.tender`, helpers `can_access_org`/`can_decide_org`).
--
-- Por que existe: el motor de dias habiles (`business-days.ts`) solo excluia sabados y domingos y
-- ninguna ruta le pasaba feriados, asi que el plazo de pago (art. 73 LAASSP) y el de inconformidad
-- (art. 95 LAASSP) se calculaban sin ningun dia inhabil. Los dias inhabiles OFICIALES de plataforma
-- (descanso obligatorio, art. 74 LFT, 2026-2027) viven en codigo (`dias-inhabiles.ts`), con prueba
-- que ata cada fecha a la regla de la ley; esta tabla guarda lo que DECLARA cada organizacion:
--   * dias para todas sus convocatorias (`tender_id` nulo), p. ej. un acuerdo publicado en el DOF;
--   * dias que publica la dependencia o entidad convocante para UNA contratacion (`tender_id`).
--
-- Que agrega (todo acotado a la organizacion por RLS, sin `using (true)`, sin ningun GRANT a anon):
--   1. `licitaciones.dia_inhabil`  -- tabla con RLS. Sin hard delete: quitar un dia es un soft
--      delete sellado (`eliminado_en`/`eliminado_por`) para conservar quien declaro y quien quito
--      cada dia (un plazo legal depende de ello).
--   2. `licitaciones.dia_inhabil_sello()` -- trigger (SIN security definer: corre como quien llama)
--      que fija `eliminado_en`/`eliminado_por` y rechaza reabrir un dia ya quitado.
--   3. `licitaciones.system_list_dias_inhabiles(uuid)` -- lectura de SOLO sistema para los barridos
--      de cron (recordatorios), que corren sin `auth.uid()` y por tanto no pasan la RLS.
--
-- Compatibilidad con la base sin migrar: el codigo TypeScript captura 42P01/42703/42883 dentro de un
-- SAVEPOINT y cae al calendario oficial de plataforma (los calculos de plazo nunca dejan de
-- funcionar). Orden de despliegue: esta migracion puede aplicarse antes o despues del codigo.

-- ---------------------------------------------------------------------------
-- 1) dia_inhabil
-- ---------------------------------------------------------------------------
create table licitaciones.dia_inhabil (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- Nulo = aplica a todas las convocatorias de la organizacion; informado = solo a esa convocatoria.
  tender_id uuid references licitaciones.tender(id) on delete cascade,
  fecha date not null check (fecha between date '2000-01-01' and date '2100-12-31'),
  nombre text not null check (char_length(btrim(nombre)) between 3 and 200),
  -- Dependencia o entidad que lo publica (texto libre) y referencia de la fuente (p. ej. numero de DOF).
  publicado_por text check (publicado_por is null or char_length(publicado_por) <= 200),
  fuente text check (fuente is null or char_length(fuente) <= 300),
  -- `por_validar` = la organizacion lo declaro pero nadie lo ha confirmado con fiscalista/abogado.
  -- Cuenta igual en el calculo (la organizacion lo declaro); la etiqueta solo informa.
  verificacion text not null default 'por_validar' check (verificacion in ('verificada', 'por_validar')),
  created_by uuid not null references core.staff_user(id) on delete restrict,
  created_at timestamptz not null default now(),
  eliminado_en timestamptz,
  eliminado_por uuid references core.staff_user(id) on delete set null,
  check (eliminado_por is null or eliminado_en is not null)
);
-- Un dia vigente por (organizacion, alcance, fecha): el alcance "toda la organizacion" usa un UUID
-- nulo como centinela para que dos filas sin convocatoria tambien choquen.
create unique index dia_inhabil_vigente_uidx
  on licitaciones.dia_inhabil (organization_id, coalesce(tender_id, '00000000-0000-0000-0000-000000000000'::uuid), fecha)
  where eliminado_en is null;
create index dia_inhabil_org_fecha_idx on licitaciones.dia_inhabil (organization_id, fecha) where eliminado_en is null;

alter table licitaciones.dia_inhabil enable row level security;

-- Lectura: cualquier miembro de la organizacion (los plazos los ve todo el equipo). Incluye los
-- ya quitados (historial); el codigo filtra `eliminado_en is null` para calcular.
create policy "org ve sus dias inhabiles" on licitaciones.dia_inhabil
  for select using (licitaciones.can_access_org(organization_id));

-- Declarar un dia inhabil cambia plazos LEGALES (pago, inconformidad): exige DECISION_ROLES
-- (owner/admin/analyst), no solo roles de escritura. WITH CHECK: `created_by = auth.uid()` (nadie
-- firma a nombre de otro), no nace ya quitado, y la convocatoria (si se indica) es de la MISMA
-- organizacion (sin esto un miembro podria colgar un dia de la convocatoria de otro tenant).
create policy "escritura: roles de decision declaran dias inhabiles" on licitaciones.dia_inhabil
  for insert with check (
    licitaciones.can_decide_org(organization_id)
    and created_by = auth.uid()
    and eliminado_en is null
    and eliminado_por is null
    and (tender_id is null or exists (
      select 1 from licitaciones.tender t
      where t.id = licitaciones.dia_inhabil.tender_id and t.organization_id = licitaciones.dia_inhabil.organization_id))
  );

-- Quitar = UPDATE de la unica columna `eliminado_en` (GRANT por columna abajo). USING exige que el
-- dia siga vigente: no se vuelve a quitar uno ya quitado ni se reabre.
create policy "escritura: roles de decision quitan dias inhabiles" on licitaciones.dia_inhabil
  for update using (licitaciones.can_decide_org(organization_id) and eliminado_en is null)
  with check (licitaciones.can_decide_org(organization_id));

-- 2) Sello del soft delete. Sin `security definer`: corre con los privilegios de quien llama, asi que
-- no amplia nada (la RLS y el GRANT por columna ya acotaron el UPDATE). `eliminado_por` NUNCA lo
-- decide el cliente: no tiene GRANT de columna y aqui se fija a `auth.uid()`.
create or replace function licitaciones.dia_inhabil_sello()
returns trigger language plpgsql set search_path = licitaciones, pg_temp as $$
begin
  if old.eliminado_en is not null then
    raise exception 'el dia inhabil ya fue quitado y no se reabre' using errcode = '22023';
  end if;
  new.eliminado_en := now();
  new.eliminado_por := auth.uid();
  return new;
end;
$$;
create trigger dia_inhabil_sello before update on licitaciones.dia_inhabil
  for each row execute function licitaciones.dia_inhabil_sello();

revoke all on licitaciones.dia_inhabil from public, anon;
grant select on licitaciones.dia_inhabil to authenticated;
-- GRANT por COLUMNA: el cliente declara fecha/nombre/fuente y NUNCA escribe los sellos
-- (`id`, `created_at`, `eliminado_por`) ni `verificacion` (siempre nace `por_validar` por default: solo
-- un rol de plataforma/service_role confirma un dia con fiscalista, el cliente no se autoverifica);
-- al actualizar solo puede tocar `eliminado_en` (quitar).
grant insert (organization_id, tender_id, fecha, nombre, publicado_por, fuente, created_by) on licitaciones.dia_inhabil to authenticated;
grant update (eliminado_en) on licitaciones.dia_inhabil to authenticated;
grant select, insert, update, delete on licitaciones.dia_inhabil to service_role;

-- ---------------------------------------------------------------------------
-- 3) Lectura de solo-sistema para los barridos de cron.
--
-- Por que `security definer`: el cron de recordatorios corre SIN usuario (`auth.uid()` nulo) y la
-- policy de lectura exige membresia, asi que veria 0 filas en silencio (mismo sintoma que motivo la
-- migracion 024). Guard `auth.uid() is null` (un usuario autenticado NO puede usarla para leer
-- dias de otra organizacion), `search_path` fijo, `revoke` de public. Solo devuelve dias de la
-- organizacion pedida y vigentes (sin PII: son fechas y nombres de feriado).
-- ---------------------------------------------------------------------------
create or replace function licitaciones.system_list_dias_inhabiles(p_organization_id uuid)
returns table (out_fecha text, out_tender_id uuid, out_nombre text, out_publicado_por text, out_fuente text, out_verificacion text)
language plpgsql stable security definer set search_path = licitaciones, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'system_list_dias_inhabiles es solo para la sesión de sistema' using errcode = '42501';
  end if;
  return query
    select d.fecha::text, d.tender_id, d.nombre, d.publicado_por, d.fuente, d.verificacion
    from licitaciones.dia_inhabil d
    where d.organization_id = p_organization_id and d.eliminado_en is null
    order by d.fecha;
end;
$$;
revoke all on function licitaciones.system_list_dias_inhabiles(uuid) from public, anon;
grant execute on function licitaciones.system_list_dias_inhabiles(uuid) to authenticated, service_role;
