-- R12 "romper" ronda 2 -- hallazgos de la capa SQL que siguen ABIERTOS. NO forma parte del gate de CI (run-gate.mjs solo lee assertions.sql): run.sh lo imprime
-- despues del gate para que quede a la vista que defecto sigue reproduciendose y cual ya se corrigio.
--
-- Cada linea dice ABIERTO (el defecto se reproduce) o CORREGIDO. Cuando un hallazgo salga CORREGIDO, se mueve su escenario a assertions.sql y se borra de aqui.
-- Requiere los fixtures de assertions.sql (organizacion R12, propiedad y cliente) ya cargados; run.sh lo corre justo despues.
--
-- R12-15 (P2, disponibilidad): las marcas de tiempo de las funciones de reclamo comparan contra el reloj de la base (`now()`). Si ese reloj RETROCEDE (ajuste de reloj
-- del servidor de la base), una marca escrita "en el futuro" no vence hasta que el reloj la alcance: un mensaje en `processing` o un lease de conversacion quedan atascados
-- por tanto tiempo como retrocedio el reloj. Cambio minimo (requiere migracion; NO se aplica aqui): tratar como vencida toda marca mayor que now() + 1 minuto, p. ej.
-- `or claimed_at > now() + interval '1 minute'` en el WHERE del ON CONFLICT de cada funcion.
\pset pager off
\set VERBOSITY terse
set client_min_messages = notice;

create or replace function public.t_hh(p text) returns text language sql immutable as $$ select md5(p) || md5(p || 'h') $$;

-- Ejecuta p_sql dentro de un sub-bloque y lo DESHACE siempre: true = el estado atascado se reproduce (el defecto sigue), false = ya no.
create or replace function public.t_atascado_mensaje(p_msg text) returns boolean
language plpgsql security definer set search_path = public, restaurantes as $$
declare v boolean;
begin
  begin
    perform restaurantes.claim_whatsapp_message('00000000-0000-0000-0000-0000000f1201', p_msg, public.t_hh(p_msg));
    update restaurantes.whatsapp_inbound_events set claimed_at = now() + interval '3 hours' where message_id = p_msg;
    v := not restaurantes.claim_whatsapp_message('00000000-0000-0000-0000-0000000f1201', p_msg, public.t_hh(p_msg));
    raise exception 'deshacer' using errcode = 'RRR01';
  exception
    when sqlstate 'RRR01' then return coalesce(v, false);
    when others then return false;
  end;
end $$;

create or replace function public.t_atascado_lease(p_msg text) returns boolean
language plpgsql security definer set search_path = public, restaurantes as $$
declare v boolean;
begin
  begin
    perform restaurantes.claim_whatsapp_conversation('00000000-0000-0000-0000-0000000f1201', public.t_hh(p_msg), p_msg || '-a', 120);
    update restaurantes.whatsapp_conversation_leases set locked_until = now() + interval '3 hours' where owner_message_id = p_msg || '-a';
    v := not restaurantes.claim_whatsapp_conversation('00000000-0000-0000-0000-0000000f1201', public.t_hh(p_msg), p_msg || '-b', 120);
    raise exception 'deshacer' using errcode = 'RRR01';
  exception
    when sqlstate 'RRR01' then return coalesce(v, false);
    when others then return false;
  end;
end $$;

create or replace function public.t_informe(p_id text, p_descripcion text, p_abierto boolean) returns void
language plpgsql as $$
begin
  raise notice '% % -- %', case when p_abierto then 'ABIERTO   ' else 'CORREGIDO ' end, p_id, p_descripcion;
end $$;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.t_informe('R12-15a', 'mensaje en processing con la marca 3 h en el futuro NO se retoma (el reloj de la base retrocedio)', public.t_atascado_mensaje('wamid.h15a'));
select public.t_informe('R12-15b', 'lease de conversacion con locked_until 3 h en el futuro NO se libera (el reloj de la base retrocedio)', public.t_atascado_lease('wamid.h15b'));
rollback;
