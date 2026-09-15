-- Hallazgo de auditoría (severidad CRÍTICA, "el onboarding self-serve de rentas está
-- bloqueado en producción"): `POST /rentas/onboarding/registro`
-- (`apps/api/src/routes/verticals/rentas/onboarding.ts`, Fase 11) ya existía completo
-- del lado de aplicación (validación real en `onboarding/captura.ts`, SQL real y
-- correcto en `onboarding/postgres-repository.ts`) pero `apps/api/src/production/
-- rentas-onboarding-repository.ts` lo conectaba a `notProductionReady` COMPLETO:
-- `core.organization`/`core.property`/`core.staff_user`/`core.membership` NUNCA
-- otorgan insert/update/delete a `authenticated` (solo a `service_role`, que este
-- monorepo no aprovisiona todavía -- `ManagedPostgresEngine.admin` es el MISMO rol de
-- mínimo privilegio que `withAppSession`), y `rentas.organization_perfil`/
-- `rentas.property_config`/`rentas.owner`/`rentas.owner_organization`/`rentas.unidad`
-- tienen la misma restricción (solo `select` para `authenticated`, migración 001).
--
-- Mismo criterio EXACTO que `core.accept_staff_invite`
-- (`packages/db/migrations/0002_staff_invite_schema.sql`) -- ya documentado como "la
-- solución real conocida" en el comentario de cabecera de
-- `packages/domain-rentas/src/onboarding/repository.ts` -- una función `security
-- definer` que corre con el privilegio del DUEÑO de la función, no con el de
-- `authenticated` sin `auth.uid()` que la invoca (el registro ocurre ANTES de que
-- exista cualquier sesión, mismo momento que aceptar una invitación). Se resuelve
-- como UNA sola función en el schema `rentas` (no dos, una en `core` y otra en
-- `rentas`) a propósito: casi todo lo que escribe es específico de este vertical
-- (`rentas.organization_perfil`/`property_config`/`owner`/`owner_organization`/
-- `unidad`), y las 4 tablas de `core` que también toca (organization/property/
-- staff_user/membership) son simples INSERTs de alta de un tenant NUEVO desde cero --
-- nunca lee ni modifica una fila de OTRO tenant ya existente, así que no hay ninguna
-- policy de `core` que este SECURITY DEFINER esté sorteando de forma insegura (a
-- diferencia de `core.list_org_members_by_vertical_role`, que sí necesita reponer un
-- chequeo de autorización porque LEE datos de un tenant ya existente).
--
-- Autorización: NINGUNA verificación de `auth.uid()` -- por diseño, igual que
-- `core.accept_staff_invite`: quien llama todavía no tiene identidad (sesión de
-- sistema, `engine.withAppSession({userId: null}, ...)`, ver onboarding.ts). La única
-- superficie de abuso real sería que alguien reutilizara esta función para escribir
-- sobre un tenant EXISTENTE -- imposible por construcción: cada llamada SIEMPRE crea
-- una `core.organization` nueva (la propia función deriva su `id`) y todo lo demás
-- cuelga de ESE id recién creado, nunca de uno que el caller pase por parámetro.
--
-- Resolución de colisión de slug: MISMO algoritmo que
-- `onboarding/postgres-repository.ts::crearOrganizacionConSlugLibre` (reintento con
-- sufijo numérico incremental, hasta 20 intentos), ahora dentro de la función para
-- que todo el registro sea una sola llamada atómica -- el adaptador TS
-- (`postgres-repository.ts`, actualizado en la misma rama) deja de necesitar su
-- propio bucle de reintento ni `esViolacionUnicidadDeColumna`.
--
-- Unidades iniciales (`p_unidades jsonb`, hallazgo "ni siquiera tiene pantalla --
-- organización + property + unidades"): antes de este cambio, `packages/domain-rentas`
-- no tenía NINGÚN método para dar de alta una `rentas.unidad` (solo `findUnidad`,
-- `rentas.unidad` nunca tuvo policy/GRANT de insert para `authenticated`) -- una
-- property sin al menos una unidad es inútil (todo el calendario/pricing/mensajería
-- cuelga de `unidad_id`). Se exige al menos 1 en `p_unidades` (mismo criterio "nunca
-- a medias" que el resto de esta función). `jsonb_to_recordset` -- mismo mecanismo ya
-- usado por otras funciones `security definer` de este monorepo para aceptar un
-- array de tamaño variable como un solo parámetro (ver
-- `licitaciones.company_capability` bulk writes) -- MÁS SIMPLE que exponer una nueva
-- función `rentas.crear_unidad` de escritura fuera de este flujo: hoy la ÚNICA forma
-- de dar de alta una unidad self-serve sigue siendo durante el registro del tenant;
-- agregar unidades después de este flujo (un panel de "propiedades y unidades") queda
-- fuera de este hallazgo puntual, documentado aquí para quien lo retome.
create or replace function rentas.register_tenant_onboarding(
  p_org_nombre text,
  p_org_slug_propuesto text,
  p_org_tipo text,
  p_property_nombre text,
  p_zona_horaria text,
  p_moneda text,
  p_admin_correo text,
  p_admin_password_hash text,
  p_admin_nombre_completo text,
  p_owner_nombre text,
  p_owner_email text,
  p_unidades jsonb
)
returns table (
  organization_id uuid,
  property_id uuid,
  staff_id uuid,
  slug text,
  unidad_ids uuid[]
)
language plpgsql
security definer
set search_path = core, rentas, pg_temp
as $$
declare
  v_org_id uuid;
  v_property_id uuid;
  v_staff_id uuid;
  v_owner_id uuid;
  v_slug text;
  v_intento int := 1;
  v_unidad_ids uuid[];
begin
  if p_org_nombre is null or length(trim(p_org_nombre)) = 0 then
    raise exception 'organizacion.nombre requerido' using errcode = 'P0001';
  end if;
  if p_org_slug_propuesto is null or length(trim(p_org_slug_propuesto)) = 0 then
    raise exception 'organizacion.slugPropuesto requerido' using errcode = 'P0001';
  end if;
  if p_admin_correo is null or length(trim(p_admin_correo)) = 0 then
    raise exception 'admin.correo requerido' using errcode = 'P0001';
  end if;
  if p_admin_password_hash is null or length(p_admin_password_hash) = 0 then
    raise exception 'admin.passwordHash requerido' using errcode = 'P0001';
  end if;
  if p_unidades is null or jsonb_typeof(p_unidades) <> 'array' or jsonb_array_length(p_unidades) = 0 then
    raise exception 'se requiere al menos una unidad (primerasUnidades)' using errcode = 'P0001';
  end if;

  -- Reintenta con un sufijo numérico incremental si el slug candidato ya existe --
  -- nunca falla el registro completo por un choque de slug (mismo criterio que
  -- documenta onboarding/repository.ts).
  loop
    v_slug := case when v_intento = 1 then p_org_slug_propuesto else p_org_slug_propuesto || '-' || v_intento::text end;
    begin
      insert into core.organization (vertical, name, slug, status)
      values ('rentas', p_org_nombre, v_slug, 'trial')
      returning id into v_org_id;
      exit;
    exception when unique_violation then
      v_intento := v_intento + 1;
      if v_intento > 20 then
        raise exception 'no se pudo derivar un slug libre a partir de "%" tras 20 intentos', p_org_slug_propuesto using errcode = 'P0003';
      end if;
    end;
  end loop;

  insert into core.property (organization_id, name, status)
  values (v_org_id, p_property_nombre, 'active')
  returning id into v_property_id;

  begin
    insert into core.staff_user (email, password_hash, full_name, created_via, email_verified_at)
    values (p_admin_correo, p_admin_password_hash, p_admin_nombre_completo, 'registro_autoservicio', null)
    returning id into v_staff_id;
  exception when unique_violation then
    raise exception 'ya existe una cuenta registrada con el correo "%"', p_admin_correo using errcode = 'P0002';
  end;

  insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role)
  values (v_staff_id, v_org_id, null, 'owner', 'admin_gestora');

  insert into rentas.organization_perfil (organization_id, tipo)
  values (v_org_id, coalesce(p_org_tipo, 'anfitrion'));

  insert into rentas.property_config (property_id, organization_id, zona_horaria, moneda)
  values (v_property_id, v_org_id, p_zona_horaria, coalesce(p_moneda, 'MXN'));

  if p_owner_nombre is not null and length(trim(p_owner_nombre)) > 0 then
    insert into rentas.owner (name, email) values (p_owner_nombre, p_owner_email) returning id into v_owner_id;
    insert into rentas.owner_organization (owner_id, organization_id) values (v_owner_id, v_org_id);
  end if;

  -- Un `insert ... returning` NO puede ser una subquery de FROM directa en Postgres
  -- (solo válido como CTE de una sentencia, o top-level) -- `with ... as (insert ...
  -- returning id) select array_agg(id) from ...` es la forma correcta.
  with unidades_insertadas as (
    insert into rentas.unidad (organization_id, property_id, owner_id, name, duracion_minima_noches)
    select v_org_id, v_property_id, v_owner_id, u.nombre, coalesce(u.duracion_minima_noches, 1)
    from jsonb_to_recordset(p_unidades) as u(nombre text, duracion_minima_noches integer)
    returning id
  )
  select coalesce(array_agg(id), array[]::uuid[]) into v_unidad_ids from unidades_insertadas;

  return query select v_org_id, v_property_id, v_staff_id, v_slug, v_unidad_ids;
end;
$$;

revoke all on function rentas.register_tenant_onboarding(text,text,text,text,text,text,text,text,text,text,text,jsonb) from public;
-- Mismo rol que login/accept-invite corren bajo `ManagedPostgresEngine.withAppSession`
-- (siempre `set local role authenticated`, con o sin `auth.uid()` real) -- el registro
-- ocurre en sesión de sistema (`userId: null`), nunca `anon` (este monorepo no usa ese
-- rol).
grant execute on function rentas.register_tenant_onboarding(text,text,text,text,text,text,text,text,text,text,text,jsonb) to authenticated;
