-- R11 "romper" -- hallazgos de la capa SQL que siguen ABIERTOS. NO forma parte del gate de CI (run-gate.mjs solo lee assertions.sql): run.sh lo imprime
-- despues del gate para que quede a la vista que defecto sigue reproduciendose y cual ya se corrigio.
--
-- Cada linea dice ABIERTO (la sentencia que deberia rechazarse SE EJECUTA) o CORREGIDO (la base ya la rechaza). Cuando un hallazgo salga CORREGIDO, se
-- mueve su escenario a assertions.sql como `t_esperar_error` y se borra de aqui.
--
-- R11-13 (aviso con mensaje de 1 MB), R11-15 y R11-16 quedaron CORREGIDOS por la migracion 088 y pasaron a assertions.sql (O12-O22). Aqui queda solo R11-13b
-- (orders.notes sin tope de largo; la migracion 088 no lo cubre a proposito: fuera del alcance de este carril).
--
-- Contexto (historico): `restaurantes.create_order_idempotent` es SECURITY DEFINER y SOLO la llama el backend (sesion de sistema), que ya valida todo esto en TypeScript
-- (por eso son P2 de defensa en profundidad, no P0): el dia que un llamador nuevo (otro cron, otra ruta, un script) se salte esa validacion, la base no frena.
--
-- Requiere los fixtures de assertions.sql (organizaciones R11 A/B, sus propiedades y clientes) ya cargados; run.sh lo corre justo despues.
\pset pager off
\set VERBOSITY terse
set client_min_messages = notice;

-- Ejecuta p_sql dentro de un sub-bloque y lo DESHACE siempre: true = la sentencia se ejecuto (el defecto sigue), false = la base la rechazo.
create or replace function public.t_reproduce(p_sql text) returns boolean
language plpgsql as $$
begin
  begin
    execute p_sql;
    raise exception 'deshacer' using errcode = 'RRR01';
  exception
    when sqlstate 'RRR01' then return true;
    when others then return false;
  end;
end $$;

create or replace function public.t_informe(p_id text, p_descripcion text, p_sql text) returns void
language plpgsql as $$
begin
  raise notice '% % -- %', case when public.t_reproduce(p_sql) then 'ABIERTO   ' else 'CORREGIDO ' end, p_id, p_descripcion;
end $$;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);

select public.t_informe('R11-13b', 'pedido con notas de 1 MB (orders.notes sin CHECK de largo)',
  $q$select public.t_orden('00000000-0000-0000-0000-0000000f1101', '00000000-0000-0000-0000-0000000f11a1', '00000000-0000-0000-0000-0000000f11c1', 90, 'h13b', null, jsonb_build_object('notes', repeat('x', 1000000)))$q$);
rollback;
