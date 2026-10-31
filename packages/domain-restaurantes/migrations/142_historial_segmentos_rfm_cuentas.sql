-- 142: segmentos RFM sobre el historial IMPORTADO (agregados) y cuentas de kilo / candidatas a evento. SOLO LECTURA, owner/admin.
-- Fuente distinta de cfo_clientes_rfm (095, sobre orders reales): estos agregados son de menor confianza y NO se mezclan con aquella.
-- Mismas definiciones que packages/domain-restaurantes/src/historico/segmentos.ts (umbrales por omision identicos):
--   campeon              pedidos >= 6 y compro hace <= 30 dias
--   en_riesgo_alto_valor alto valor (gasto >= percentil 0.75 de la cartera con gasto > 0) y sin comprar >= 45 dias
--   dormido              sin comprar >= 90 dias
--   nuevo                primer pedido hace <= 30 dias
--   regular              el resto
--   reactivable          en_riesgo_alto_valor o dormido, sin revision_humana (queja abierta). El OPT-IN de marketing sigue siendo requisito aparte: importar nunca lo otorga.
--   cuenta_kilo          kilos_totales >= 10;  candidata_evento: ticket promedio > 2000 MXN (SUGERIDA, un humano confirma).
-- Sin PII: devuelve un alias de 8 caracteres (sha-256 del customer_id), nunca nombre ni telefono.
-- REVERSA: drop function if exists restaurantes.historial_segmentos(uuid, date, integer, integer, integer, integer, numeric, integer, numeric, numeric);
--          drop function if exists restaurantes.historial_segmentos_resumen(uuid, date);
create or replace function restaurantes.historial_segmentos(
  p_organization_id uuid,
  p_hoy date default current_date,
  p_dias_dormido integer default 90,
  p_dias_en_riesgo integer default 45,
  p_pedidos_campeon integer default 6,
  p_dias_campeon integer default 30,
  p_percentil numeric default 0.75,
  p_dias_nuevo integer default 30,
  p_ticket_evento numeric default 2000,
  p_kilos_cuenta numeric default 10
)
returns table (alias text, segmento text, dias_sin_comprar integer, alto_valor boolean, reactivable boolean, cuenta_kilo boolean, candidata_evento boolean)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_corte numeric;
begin
  if not restaurantes.cliente_es_admin(p_organization_id) then
    raise exception 'historial_segmentos: solo owner/admin' using errcode = '42501';
  end if;
  if p_percentil is null or p_percentil <= 0 or p_percentil > 1 then
    raise exception 'historial_segmentos: percentil fuera de rango' using errcode = '22023';
  end if;
  select percentile_disc(p_percentil) within group (order by h.gasto_mxn) into v_corte
    from restaurantes.customer_historial_resumen h where h.organization_id = p_organization_id and h.gasto_mxn > 0;

  return query
  select left(encode(sha256(convert_to(x.customer_id::text, 'utf8')), 'hex'), 8),
         case
           when x.pedidos >= p_pedidos_campeon and x.dias_sin is not null and x.dias_sin <= p_dias_campeon then 'campeon'
           when x.alto and x.dias_sin is not null and x.dias_sin >= p_dias_en_riesgo then 'en_riesgo_alto_valor'
           when x.dias_sin is not null and x.dias_sin >= p_dias_dormido then 'dormido'
           when x.desde_primero is not null and x.desde_primero <= p_dias_nuevo and x.pedidos > 0 then 'nuevo'
           else 'regular'
         end,
         x.dias_sin,
         x.alto,
         (not x.revision_humana) and (
           (not (x.pedidos >= p_pedidos_campeon and x.dias_sin is not null and x.dias_sin <= p_dias_campeon))
           and ((x.alto and x.dias_sin is not null and x.dias_sin >= p_dias_en_riesgo) or (x.dias_sin is not null and x.dias_sin >= p_dias_dormido))),
         coalesce(x.kilos_totales, 0) >= p_kilos_cuenta,
         coalesce(x.ticket_mxn, 0) > p_ticket_evento
    from (
      select h.customer_id, h.pedidos, h.ticket_mxn, h.kilos_totales, h.revision_humana,
             (p_hoy - h.ultimo_pedido) as dias_sin,
             (p_hoy - h.primer_pedido) as desde_primero,
             (v_corte is not null and h.gasto_mxn >= v_corte and h.gasto_mxn > 0) as alto
        from restaurantes.customer_historial_resumen h
       where h.organization_id = p_organization_id
    ) x
   order by 1;
end;
$$;
revoke all on function restaurantes.historial_segmentos(uuid, date, integer, integer, integer, integer, numeric, integer, numeric, numeric) from public, anon;
grant execute on function restaurantes.historial_segmentos(uuid, date, integer, integer, integer, integer, numeric, integer, numeric, numeric) to authenticated;

create or replace function restaurantes.historial_segmentos_resumen(p_organization_id uuid, p_hoy date default current_date)
returns jsonb
language sql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
  select jsonb_build_object(
    'total', count(*),
    'campeon', count(*) filter (where s.segmento = 'campeon'),
    'en_riesgo_alto_valor', count(*) filter (where s.segmento = 'en_riesgo_alto_valor'),
    'dormido', count(*) filter (where s.segmento = 'dormido'),
    'nuevo', count(*) filter (where s.segmento = 'nuevo'),
    'regular', count(*) filter (where s.segmento = 'regular'),
    'reactivables', count(*) filter (where s.reactivable),
    'cuentas_kilo', count(*) filter (where s.cuenta_kilo),
    'candidatas_evento', count(*) filter (where s.candidata_evento),
    'fuente', 'historial_importado'
  ) from restaurantes.historial_segmentos(p_organization_id, p_hoy) s;
$$;
revoke all on function restaurantes.historial_segmentos_resumen(uuid, date) from public, anon;
grant execute on function restaurantes.historial_segmentos_resumen(uuid, date) to authenticated;
