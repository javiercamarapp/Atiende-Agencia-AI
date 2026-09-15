-- Fase 3 rentas -- resuelve el gap de privilegio documentado en
-- `src/owner-portal/postgres-repository.ts`/`src/owner-portal/repository.ts` y en
-- `apps/api/src/production/rentas-owner-portal-repository.ts`: los 3 métodos de
-- escritura/lectura de credencial (`findOwnerCredentialByEmail`/`createPortalInvite`/
-- `consumePortalInvite`) tocan `rentas.owner_credential`, que la migración 006 NUNCA
-- otorga en SELECT/INSERT/UPDATE a `authenticated` -- solo a `service_role`, que este
-- monorepo no aprovisiona todavía (`ManagedPostgresEngine.admin` es el MISMO rol de
-- mínimo privilegio que `withAppSession`, ver comentario de cabecera de
-- `packages/db/src/managed-postgres-engine.ts`).
--
-- Mismo criterio EXACTO que `core.accept_staff_invite`
-- (`packages/db/migrations/0002_staff_invite_schema.sql`): en vez de esperar una pieza
-- de infraestructura de conexión que no existe (`service_role` real), se resuelve con
-- 3 funciones `security definer` -- corren con el privilegio del DUEÑO de la función
-- (quien aplica esta migración), nunca con el de `authenticated`, y cada una hace SU
-- PROPIA verificación de autorización antes de tocar `owner_credential` (nunca confían
-- en que la capa TS ya validó todo, mismo principio de "defensa en profundidad, nunca
-- la única capa" del resto del monorepo):
--
--   1. `rentas.find_owner_credential_by_email(email)` -- sin verificación de sesión
--      adicional (se llama ANTES de que exista una sesión de propietario, exactamente
--      igual que `core.accept_staff_invite` se llama antes de que exista una sesión de
--      staff): solo expone lo mínimo para validar login (mismo shape que ya devolvía
--      `PostgresRentasOwnerPortalRepository.findOwnerCredentialByEmail`, verificado
--      con `verifyPassword` en la capa TS -- ver owner-portal.ts).
--   2. `rentas.create_owner_portal_invite(owner_id, token_hash, expires_at)` -- exige
--      que quien la invoca (`auth.uid()`, un staff YA autenticado, ver
--      `requirePropertyMembership`/`assertVerticalRole` en owner-portal-invite.ts) sea
--      staff con acceso real (`core.has_property_access`) a AL MENOS UNA property
--      donde el propietario tenga una `rentas.unidad` -- mismo invariante que
--      `RentasRepository.findOwnerConUnidadesEnProperty` ya verifica en TS antes de
--      llamar este método, reforzado aquí como autoridad real (nunca confía solo en
--      que la ruta HTTP ya lo hizo). `created_by` se toma de `auth.uid()` DENTRO de la
--      función (nunca un parámetro que el caller pudiera falsear).
--   3. `rentas.consume_owner_portal_invite(token_hash, password_hash, now)` -- sin
--      sesión (el propietario activa su cuenta ANTES de tener una), valida
--      pending+no-expirado por el TOKEN MISMO (hasheado, de un solo uso) -- exactamente
--      el mismo criterio de autorización que ya usaba el SQL directo que reemplaza
--      (`password_reset_token_hash`/`password_reset_expires_at`), solo que ahora corre
--      con el privilegio necesario para tocar la tabla.
--
-- Con esto, `ProductionRentasOwnerPortalRepository` deja de necesitar
-- `notProductionReady` para estos 3 métodos (ver ese archivo, actualizado en la misma
-- rama) -- el portal de propietario de Fase 3 queda con los 8 métodos de su puerto
-- completos contra Postgres real, sin requerir aprovisionar `service_role`.
--
-- Requiere: 006_owner_portal_schema.sql (rentas.owner_credential, rentas.owner),
-- 001_rentas_schema.sql (rentas.unidad), 0001_core_schema.sql (core.has_property_access).

create or replace function rentas.find_owner_credential_by_email(p_email text)
returns table (owner_id uuid, email text, password_hash text)
language sql
stable
security definer
set search_path = rentas, pg_temp
as $$
  -- NOTA: rentas.owner.email no tiene índice único -- si dos owners comparten correo
  -- (dato mal capturado por staff), la primera fila con password_hash no nulo gana;
  -- esto es un caso de higiene de datos, no de este diseño (mismo comentario que ya
  -- traía el SQL que esta función reemplaza).
  select oc.owner_id, o.email, oc.password_hash
  from rentas.owner_credential oc
  join rentas.owner o on o.id = oc.owner_id
  where lower(o.email) = lower(p_email) and oc.password_hash is not null
  limit 1;
$$;

revoke all on function rentas.find_owner_credential_by_email(text) from public;
-- El login del propietario corre bajo el mismo rol `authenticated` que el resto de
-- sesiones de este monorepo (ver `ManagedPostgresEngine.withAppSession`, siempre
-- `set local role authenticated`, con o sin `auth.uid()` real) -- nunca `anon`.
grant execute on function rentas.find_owner_credential_by_email(text) to authenticated;

create or replace function rentas.create_owner_portal_invite(
  p_owner_id uuid,
  p_token_hash text,
  p_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = rentas, core, pg_temp
as $$
declare
  v_created_by uuid := auth.uid();
begin
  if v_created_by is null then
    raise exception 'se requiere una sesión de staff autenticada' using errcode = '28000';
  end if;

  -- Mismo invariante que `RentasRepository.findOwnerConUnidadesEnProperty` ya exige en
  -- la capa TS (owner-portal-invite.ts) antes de llamar este método: quien invita debe
  -- tener acceso real (`core.has_property_access`) a AL MENOS UNA property donde el
  -- propietario tenga una unidad -- reforzado aquí como autoridad real, nunca solo
  -- confiado desde la ruta HTTP.
  if not exists (
    select 1
    from rentas.unidad u
    where u.owner_id = p_owner_id
      and core.has_property_access(v_created_by, u.property_id)
  ) then
    raise exception 'propietario no encontrado, o sin ninguna unidad en una property con acceso del staff invitante' using errcode = 'P0001';
  end if;

  insert into rentas.owner_credential (owner_id, created_via, created_by, password_reset_token_hash, password_reset_expires_at)
  values (p_owner_id, 'invite', v_created_by, p_token_hash, p_expires_at)
  on conflict (owner_id) do update set
    created_by = excluded.created_by,
    password_reset_token_hash = excluded.password_reset_token_hash,
    password_reset_expires_at = excluded.password_reset_expires_at;
end;
$$;

revoke all on function rentas.create_owner_portal_invite(uuid, text, timestamptz) from public;
grant execute on function rentas.create_owner_portal_invite(uuid, text, timestamptz) to authenticated;

create or replace function rentas.consume_owner_portal_invite(
  p_token_hash text,
  p_password_hash text,
  p_now timestamptz
)
returns table (owner_id uuid)
language plpgsql
security definer
set search_path = rentas, pg_temp
as $$
begin
  return query
  update rentas.owner_credential
  set password_hash = p_password_hash, password_reset_token_hash = null, password_reset_expires_at = null
  where password_reset_token_hash = p_token_hash
    and password_reset_expires_at is not null
    and password_reset_expires_at > p_now
  returning rentas.owner_credential.owner_id;
end;
$$;

revoke all on function rentas.consume_owner_portal_invite(text, text, timestamptz) from public;
-- El propietario activa su cuenta ANTES de tener sesión (mismo momento que
-- `core.accept_staff_invite` para un invitado de staff) -- corre bajo `authenticated`
-- sin `auth.uid()` real (`engine.withAppSession({userId: null})`).
grant execute on function rentas.consume_owner_portal_invite(text, text, timestamptz) to authenticated;
