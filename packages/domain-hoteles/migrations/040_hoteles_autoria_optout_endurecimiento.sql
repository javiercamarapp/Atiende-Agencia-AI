-- Endurecimiento de 039 (seguimiento del PR #327; 039 ya esta aplicada y NO se edita).
--
-- Defensa en profundidad sobre tres puntos de las tablas que 039 creo:
--
--  (1) AUTORIA fijada por el servidor. 039 dio GRANT de columna sobre las columnas de autoria
--      (updated_by / counted_by / taken_by / created_by / reverted_by) y de sello de tiempo
--      (updated_at / reverted_at), asi que un cliente autenticado con rol suficiente podia escribir por
--      PostgREST el nombre de OTRO miembro del staff como autor (el FK solo exige que exista en
--      core.staff_user). Aqui el valor lo fija un trigger BEFORE a partir de auth.uid() (la sesion
--      autenticada, nunca un parametro del cliente) y se ignora lo que mande el cliente. Se conserva el
--      GRANT porque las rutas reales ya mandan esas columnas (compatibilidad con el codigo desplegado);
--      el trigger las vuelve inertes. Cuando auth.uid() es nulo (sesion de sistema / service_role) el
--      valor recibido se respeta: esas sesiones no son un cliente y no tienen "usuario" que sellar.
--
--  (2) OPT-OUT revertido es TERMINAL. 039 permitia UPDATE de status por PostgREST: un opt-out revertido
--      podia volver a 'activo' (revivir una exclusion de limpieza ya descartada sin dejar historial) y
--      reverted_by/reverted_at podian re-sellarse. Ahora: revertido -> activo se rechaza (23514, para
--      cualquier rol; para excluir de nuevo se registra un opt-out NUEVO, que el indice unico parcial
--      ya admite) y revertir sella reverted_by/reverted_at con el servidor.
--
--  (3) voice_agent_config. Se revisaron los dos puntos pendientes:
--        * policy `for all` heredada de 004: 039 ya la sustituye (drop por nombre exacto). Aqui se repite
--          el drop de forma idempotente y verify-hoteles-hk-canal asserta contra pg_policies que no queda
--          ninguna policy `for all` ni de `anon`/`public` sobre la tabla.
--        * GRANT insert (organization_id): se CONSERVA a proposito. El trigger voice_agent_config_derive_org
--          (039) sobreescribe organization_id con el de core.property ANTES de cualquier constraint, de modo
--          que el valor que mande el cliente es inerte (verify escenario 26 y los nuevos lo prueban con una
--          organizacion ajena). Quitar el GRANT romperia el INSERT que ya emite
--          PostgresMensajeriaConfigRepository.rotateVoiceSecret contra la base actual sin aportar
--          seguridad adicional.
--
-- Justificacion de seguridad de cada objeto nuevo:
--   * 4 funciones trigger (SECURITY INVOKER, search_path fijo, EXECUTE revocado a public/anon): solo leen
--     auth.uid() y OLD/NEW; no tocan tablas; no exponen datos. Las triggers corren con los privilegios del
--     rol que escribe, que ya paso RLS y GRANT de columna.
--   * Ningun GRANT, policy ni RLS nuevo/modificado: la superficie de acceso no crece, solo se acota el
--     valor de columnas ya escribibles.

-- ---------------------------------------------------------------------------
-- (1a) updated_by / updated_at: housekeeping_config y whatsapp_channel_config.
-- ---------------------------------------------------------------------------
create or replace function hoteles.stamp_updated_by()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if auth.uid() is not null then
    new.updated_by := auth.uid();
    new.updated_at := now();
  end if;
  return new;
end;
$$;
revoke all on function hoteles.stamp_updated_by() from public, anon;

create trigger housekeeping_config_stamp_updated_by before insert or update on hoteles.housekeeping_config
  for each row execute function hoteles.stamp_updated_by();
create trigger whatsapp_channel_config_stamp_updated_by before insert or update on hoteles.whatsapp_channel_config
  for each row execute function hoteles.stamp_updated_by();

-- ---------------------------------------------------------------------------
-- (1b) counted_by / updated_at: linen_count.
-- ---------------------------------------------------------------------------
create or replace function hoteles.stamp_counted_by()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if auth.uid() is not null then
    new.counted_by := auth.uid();
    new.updated_at := now();
  end if;
  return new;
end;
$$;
revoke all on function hoteles.stamp_counted_by() from public, anon;

create trigger linen_count_stamp_counted_by before insert or update on hoteles.linen_count
  for each row execute function hoteles.stamp_counted_by();

-- ---------------------------------------------------------------------------
-- (1c) taken_by: housekeeping_task_photo (solo INSERT: una foto no se edita).
-- ---------------------------------------------------------------------------
create or replace function hoteles.stamp_taken_by()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if auth.uid() is not null then
    new.taken_by := auth.uid();
  end if;
  return new;
end;
$$;
revoke all on function hoteles.stamp_taken_by() from public, anon;

create trigger housekeeping_task_photo_stamp_taken_by before insert on hoteles.housekeeping_task_photo
  for each row execute function hoteles.stamp_taken_by();

-- ---------------------------------------------------------------------------
-- (1d) + (2) cleaning_opt_out: created_by al insertar; revertir sella reverted_by/reverted_at;
--      revertido es terminal.
-- ---------------------------------------------------------------------------
create or replace function hoteles.cleaning_opt_out_guard()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.created_by := auth.uid();
    end if;
    return new;
  end if;

  -- UPDATE
  if old.status = 'revertido' then
    if new.status is distinct from old.status then
      raise exception 'un opt-out revertido es definitivo: registra uno nuevo' using errcode = '23514';
    end if;
    -- Ya revertido: el sello original no se re-escribe.
    new.reverted_by := old.reverted_by;
    new.reverted_at := old.reverted_at;
    return new;
  end if;

  if new.status = 'revertido' then
    if auth.uid() is not null then
      new.reverted_by := auth.uid();
      new.reverted_at := now();
    else
      new.reverted_at := coalesce(new.reverted_at, now());
    end if;
  else
    -- Sigue activo: no hay reversion que sellar (el CHECK de 039 exige reverted_at nulo).
    new.reverted_by := old.reverted_by;
  end if;
  return new;
end;
$$;
revoke all on function hoteles.cleaning_opt_out_guard() from public, anon;

create trigger cleaning_opt_out_guard before insert or update on hoteles.cleaning_opt_out
  for each row execute function hoteles.cleaning_opt_out_guard();

-- ---------------------------------------------------------------------------
-- (3) voice_agent_config: la policy `for all` de 004 no debe existir (idempotente; 039 ya la retiro).
-- ---------------------------------------------------------------------------
drop policy if exists "staff admin ve/gestiona el secreto de voz de su property" on hoteles.voice_agent_config;
