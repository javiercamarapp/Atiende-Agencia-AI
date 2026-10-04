-- QA-restaurantes-R1-automatizacion-08: barrido de llamadas de voz HUERFANAS (sin cierre).
-- Prefijo de supabase/migrations: 20240101000319 (interno restaurantes 060).
-- Requiere: 025 (voice_conversation / voice_turn / voz_cerrar_conversacion), 035 (KPI de voz).
--
-- Problema: una llamada cuyo worker murio (o perdio la red) antes de llamar a `voz_cerrar_conversacion` queda con ended_at y resultado
-- nulos PARA SIEMPRE: el KPI (035) la cuenta en "llamadas" pero no en "cerradas" ni en "abandonadas", asi que el abandono se subestima y
-- las alertas por tasa no la ven.
--
-- Que agrega (todo NUEVO; ninguna tabla ni funcion existente se modifica):
--   * restaurantes.voz_cerrar_huerfanas(p_inactivas_minutos, p_limite) -- cierra como 'abandonado' las conversaciones abiertas (ended_at nulo,
--     resultado nulo) iniciadas hace mas de p_inactivas_minutos y devuelve cuantas cerro. Calcula igual que voz_cerrar_conversacion:
--     duracion = (ultimo turno o inicio) - inicio, costo = suma de los turnos, p95 de latencia. No toca llamadas cerradas ni recientes,
--     ni cambia 'resultado' de una llamada que ya lo tenga. Idempotente: una segunda corrida no encuentra nada.
--
-- Justificacion de seguridad (una por una):
--  * restaurantes.voz_cerrar_huerfanas -- SECURITY DEFINER con search_path fijo (restaurantes, core, pg_temp); `revoke all ... from public, anon`;
--    `grant execute` a authenticated y service_role igual que voz_cerrar_conversacion (025): la sesion de sistema del backend corre con el rol
--    authenticated SIN usuario, y el guard `auth.uid() is null` (42501 si hay usuario) es lo que la limita a sistema. NO hay GRANT a anon.
--    Barre todas las organizaciones (es un barrido de plataforma, como cierre_sucursales_sistema de 041) pero SOLO puede escribir
--    ended_at/resultado/duration_s/costo/p95 de filas YA abiertas, nunca crea ni borra filas ni lee datos para devolverlos (devuelve un entero).
--    Los parametros estan acotados (30 min a 7 dias; lote de 1 a 1000) para que un parametro mal armado no cierre llamadas en curso.
--    `for update skip locked`: dos barridos simultaneos no se pisan.

create or replace function restaurantes.voz_cerrar_huerfanas(
  p_inactivas_minutos integer default 120,
  p_limite integer default 200
) returns integer
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_rows integer;
begin
  if auth.uid() is not null then
    raise exception 'voz_cerrar_huerfanas es solo de sistema' using errcode = '42501';
  end if;
  if p_inactivas_minutos is null or p_inactivas_minutos < 30 or p_inactivas_minutos > 10080 then
    raise exception 'p_inactivas_minutos debe estar entre 30 y 10080' using errcode = '22023';
  end if;
  if p_limite is null or p_limite < 1 or p_limite > 1000 then
    raise exception 'p_limite debe estar entre 1 y 1000' using errcode = '22023';
  end if;

  with huerfanas as (
    select c.id
    from restaurantes.voice_conversation c
    where c.ended_at is null
      and c.resultado is null
      and c.started_at < now() - make_interval(mins => p_inactivas_minutos)
    order by c.started_at
    limit p_limite
    for update skip locked
  ),
  calculo as (
    select h.id,
           greatest(c.started_at, coalesce((select max(t.created_at) from restaurantes.voice_turn t where t.conversation_id = c.id), c.started_at)) as fin
    from huerfanas h
    join restaurantes.voice_conversation c on c.id = h.id
  )
  update restaurantes.voice_conversation c set
    ended_at = k.fin,
    resultado = 'abandonado',
    duration_s = greatest(0, extract(epoch from (k.fin - c.started_at))::integer),
    costo_estimado_micro_usd = coalesce((select sum(t.costo_estimado_micro_usd) from restaurantes.voice_turn t where t.conversation_id = c.id), 0),
    latencia_p95_ms = (select percentile_disc(0.95) within group (order by t.latencia_ms) from restaurantes.voice_turn t where t.conversation_id = c.id and t.latencia_ms is not null)
  from calculo k
  where c.id = k.id and c.ended_at is null and c.resultado is null;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function restaurantes.voz_cerrar_huerfanas(integer, integer) from public, anon;
grant execute on function restaurantes.voz_cerrar_huerfanas(integer, integer) to authenticated, service_role;
