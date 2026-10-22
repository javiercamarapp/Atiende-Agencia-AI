-- Login del repartidor por WhatsApp (docs/LOGIN-CHOFER-WHATSAPP.md): el mensaje con el codigo de acceso pasa por restaurantes.messaging_outbox
-- y su payload necesita llevar el codigo en claro (variable de la plantilla) y el telefono hasta el instante del envio.
--
-- Esta migracion evita que ese residuo quede guardado: cuando una fila de evento `auth.codigo_acceso` llega a un estado terminal
-- (`sent` o `dead`) el payload se reemplaza por un marcador sin codigo ni telefono. Mientras esta pendiente/procesando conserva lo
-- necesario para enviar (el codigo vive 5 minutos y es de un solo uso). Sin esta migracion el flujo sigue funcionando; solo queda el
-- residuo hasta que la fila se purgue por retencion.
--
-- Ademas, restaurantes.purgar_codigos_acceso_vencidos(): marca `dead` (clase `codigo_vencido`; el trigger redacta el payload) toda fila de
-- `auth.codigo_acceso` con mas de 10 minutos en cualquier estado NO terminal (pending/processing/failed). Un codigo vive 5 minutos: si el
-- despachador estuvo caido, el codigo y el telefono no deben quedar en claro en la cola. Estados de la 007: pending, processing, sent, failed, dead;
-- terminales: sent y dead (`failed` existe en el CHECK pero ningun camino lo escribe). La API la llama tras cada solicitud (mejor esfuerzo).
--
-- Justificacion de seguridad: es un trigger BEFORE UPDATE sin SECURITY DEFINER (no amplia privilegios; corre con los del que actualiza), con
-- search_path fijo. Sin GRANT nuevo en el trigger (ni a anon; el unico GRANT es el de la funcion de purga, mas abajo). Solo toca filas con event_type = 'auth.codigo_acceso'.
--
-- La funcion es SECURITY DEFINER con search_path fijo, solo-sistema (auth.uid() is null, si no 42501), revoke de public/anon y grant solo a
-- `authenticated` (rol de la sesion de sistema), mismo patron que complete_messaging_outbox_sent (066).
--
-- Reversa: drop function if exists restaurantes.purgar_codigos_acceso_vencidos();
--          drop trigger if exists messaging_outbox_codigo_acceso_sin_residuo on restaurantes.messaging_outbox;
--          drop function if exists restaurantes.outbox_codigo_acceso_sin_residuo();
create or replace function restaurantes.outbox_codigo_acceso_sin_residuo()
returns trigger
language plpgsql
set search_path = restaurantes, pg_temp
as $$
begin
  if new.event_type = 'auth.codigo_acceso' and new.status in ('sent', 'dead') and old.status is distinct from new.status then
    new.payload := jsonb_build_object('redactado', true);
  end if;
  return new;
end;
$$;

drop trigger if exists messaging_outbox_codigo_acceso_sin_residuo on restaurantes.messaging_outbox;
create trigger messaging_outbox_codigo_acceso_sin_residuo
  before update on restaurantes.messaging_outbox
  for each row execute function restaurantes.outbox_codigo_acceso_sin_residuo();

create or replace function restaurantes.purgar_codigos_acceso_vencidos()
returns integer
language plpgsql security definer set search_path = restaurantes, pg_temp
as $$
declare
  v_filas integer;
begin
  if auth.uid() is not null then
    raise exception 'purgar_codigos_acceso_vencidos es solo para la sesion de sistema' using errcode = '42501';
  end if;
  update restaurantes.messaging_outbox
     set status = 'dead', last_error_class = 'codigo_vencido', claimed_at = null
   where event_type = 'auth.codigo_acceso'
     and status in ('pending', 'processing', 'failed')
     and created_at < now() - interval '10 minutes';
  get diagnostics v_filas = row_count;
  return v_filas;
end;
$$;
revoke all on function restaurantes.purgar_codigos_acceso_vencidos() from public, anon;
grant execute on function restaurantes.purgar_codigos_acceso_vencidos() to authenticated;
