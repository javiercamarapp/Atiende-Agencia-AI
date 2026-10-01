-- Endurecimiento de `search_path` para las 3 funciones de trigger append-only
-- que `get_advisors` (tipo `security`, WARN "Function Search Path Mutable")
-- sigue marcando tras 0023 y 0027:
--   citas.whatsapp_message_config_history_block_mutation
--   citas.data_rights_events_block_mutation
--   restaurantes.data_rights_events_block_mutation
--
-- Barrido: se aplicaron TODAS las migraciones de supabase/migrations/ a un
-- Postgres efimero y se listaron las funciones de los schemas core, citas,
-- hoteles, rentas, despachos, licitaciones, restaurantes y public sin
-- `search_path` en `pg_proc.proconfig`: solo estas 3 (ninguna es
-- `security definer`; ninguna otra funcion, `security definer` o de trigger,
-- quedo sin `search_path` en esos schemas).
--
-- Los tres cuerpos son un unico `raise exception` con `tg_op` y un literal: no
-- referencian ningun objeto (tabla, funcion u operador) sin calificar. Por eso
-- el valor es `pg_catalog, pg_temp` (el minimo posible: ni siquiera el schema
-- propio hace falta, y `pg_temp` queda AL FINAL para que un objeto temporal del
-- caller nunca sombree a uno real). Defensa en profundidad: cierra la superficie
-- y calla el advisor; no es un hueco explotado hoy.
--
-- Mismo patron que 0027: `alter function ... set search_path` (no copia el
-- cuerpo, conserva firma, owner, volatilidad, GRANT/REVOKE y los triggers que
-- las usan). A diferencia de 0027, cada `alter` va protegido con
-- `to_regprocedure` para que la migracion sea idempotente y tolerante a una
-- base donde alguna funcion no exista (se omite en silencio, sin error).
--
-- Compatibilidad con la base sin migrar: solo `alter function` sobre funciones
-- existentes; el codigo TypeScript que dispara estos triggers se comporta igual
-- con o sin esta migracion, asi que no hace falta fallback de SQLSTATE
-- 42883/42P01/42703. Sin GRANT, policy ni funcion nueva: no cambia ningun
-- permiso.

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'citas.whatsapp_message_config_history_block_mutation()',
    'citas.data_rights_events_block_mutation()',
    'restaurantes.data_rights_events_block_mutation()'
  ] loop
    if to_regprocedure(v_fn) is not null then
      execute format('alter function %s set search_path = pg_catalog, pg_temp', v_fn);
    end if;
  end loop;
end
$$;
