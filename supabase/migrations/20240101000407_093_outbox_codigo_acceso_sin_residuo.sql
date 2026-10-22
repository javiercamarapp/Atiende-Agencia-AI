-- Login del repartidor por WhatsApp (docs/LOGIN-CHOFER-WHATSAPP.md): el mensaje con el codigo de acceso pasa por restaurantes.messaging_outbox
-- y su payload necesita llevar el codigo en claro (variable de la plantilla) y el telefono hasta el instante del envio.
--
-- Esta migracion evita que ese residuo quede guardado: cuando una fila de evento `auth.codigo_acceso` llega a un estado terminal
-- (`sent` o `dead`) el payload se reemplaza por un marcador sin codigo ni telefono. Mientras esta pendiente/procesando conserva lo
-- necesario para enviar (el codigo vive 5 minutos y es de un solo uso). Sin esta migracion el flujo sigue funcionando; solo queda el
-- residuo hasta que la fila se purgue por retencion.
--
-- Justificacion de seguridad: es un trigger BEFORE UPDATE sin SECURITY DEFINER (no amplia privilegios; corre con los del que actualiza), con
-- search_path fijo. No hay GRANT nuevo (ni a anon). Solo toca filas con event_type = 'auth.codigo_acceso'.
--
-- Reversa: drop trigger if exists messaging_outbox_codigo_acceso_sin_residuo on restaurantes.messaging_outbox;
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
