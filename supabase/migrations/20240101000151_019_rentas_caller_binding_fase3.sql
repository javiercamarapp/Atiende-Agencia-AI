-- Fase 3 del hallazgo de seguridad "caller binding" (ver `packages/db/migrations/
-- 0016_caller_binding_fase3.sql` para el resumen completo de la clase de hallazgo, y
-- `scripts/verify-caller-binding-fase2/README.md` -- sección "Fuera de alcance" --
-- donde quedaron documentados estos dos hallazgos en la Fase 2).
--
-- 1) `rentas.find_owner_credential_by_email` (`013_owner_portal_security_
--    definer.sql`) es `security definer` con `grant execute ... to authenticated`,
--    y devuelve `password_hash` (columna hasheada, pero el hash en sí) para
--    CUALQUIER correo, a CUALQUIER `authenticated` que la invoque por RPC directo
--    -- sin ninguna atadura a `auth.uid()`.
--
--    Call-site-audit (verificado contra el código real de esta rama): único caller
--    real es `POST /rentas/owner-portal/auth/login`
--    (`routes/verticals/rentas/owner-portal.ts`), que abre SIEMPRE
--    `engine.withAppSession({ userId: null })` -- sesión de SISTEMA, `auth.uid()`
--    NULL, el mismo momento pre-autenticación que `core.find_staff_by_email` para
--    login de staff. Clase A (pre-auth, solo sistema): MISMO guard/patrón que
--    `core.find_staff_by_email` (`packages/db/migrations/
--    0016_caller_binding_fase3.sql`)/`core.create_magic_link_token`
--    (`0012_caller_binding_fase2.sql`). Sin cambio de TypeScript: el único call
--    site ya corre así hoy.
--
-- 2) `rentas.revoke_owner_refresh_token` (`017_owner_portal_refresh_revocation.
--    sql`) es `security definer` con `grant execute ... to authenticated`, y
--    recibe `p_owner_id` explícito sin atarlo a `auth.uid()`.
--
--    Call-site-audit (verificado contra el código real de esta rama): único caller
--    real es `POST /rentas/owner-portal/auth/logout`
--    (`routes/verticals/rentas/owner-portal.ts`), que YA abre la sesión COMO el
--    propietario real (`engine.withAppSession({ userId: ownerId })`, con `ownerId`
--    tomado del `sub` YA verificado -- firma -- del refresh token que se está
--    cerrando) y pasa ESE MISMO `ownerId` como `p_owner_id` -- a diferencia de los
--    dos hallazgos de arriba, este es Clase C (self, la ventaja que ya anticipaba
--    el README de la Fase 2): el fix es puramente SQL, `auth.uid() = p_owner_id`,
--    MISMO patrón exacto que `core.revoke_all_refresh_tokens`
--    (`0012_caller_binding_fase2.sql`). Sin cambio de TypeScript.

create or replace function rentas.find_owner_credential_by_email(p_email text)
returns table (owner_id uuid, email text, password_hash text)
language plpgsql
stable
security definer
set search_path = rentas, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'find_owner_credential_by_email: solo alcanzable desde sesión de sistema' using errcode = '42501';
  end if;

  return query
    -- NOTA: rentas.owner.email no tiene índice único -- si dos owners comparten
    -- correo (dato mal capturado por staff), la primera fila con password_hash no
    -- nulo gana; esto es un caso de higiene de datos, no de este diseño (mismo
    -- comentario que ya traía el SQL original).
    select oc.owner_id, o.email, oc.password_hash
    from rentas.owner_credential oc
    join rentas.owner o on o.id = oc.owner_id
    where lower(o.email) = lower(p_email) and oc.password_hash is not null
    limit 1;
end;
$$;

revoke all on function rentas.find_owner_credential_by_email(text) from public;
grant execute on function rentas.find_owner_credential_by_email(text) to authenticated;

create or replace function rentas.revoke_owner_refresh_token(p_jti uuid, p_owner_id uuid, p_expires_at timestamptz)
returns void
security definer
language plpgsql
set search_path = rentas, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() <> p_owner_id then
    raise exception 'revoke_owner_refresh_token: el caller autenticado debe coincidir con p_owner_id' using errcode = '42501';
  end if;

  insert into rentas.revoked_owner_refresh_token (jti, owner_id, expires_at)
  values (p_jti, p_owner_id, p_expires_at)
  on conflict (jti) do nothing;
end;
$$;

revoke all on function rentas.revoke_owner_refresh_token(uuid, uuid, timestamptz) from public;
grant execute on function rentas.revoke_owner_refresh_token(uuid, uuid, timestamptz) to authenticated;
