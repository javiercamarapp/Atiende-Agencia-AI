-- 141: fusion DETERMINISTA de clientes duplicados por telefono normalizado (ultimos 10 digitos), conservando todo el historial.
-- Requiere: 049 (cliente_es_admin, customer_preferences, customer_pedido_cierre), 052 (marketing), 140 (historial).
--  * Dos clientes son el mismo si los ultimos 10 digitos de `phone` coinciden (normalizePhone). Un telefono de menos de 10 digitos NUNCA agrupa.
--  * Sobrevive el de mas pedidos, luego el mas antiguo, luego el menor id. Se mueven pedidos, domicilios (sin duplicar el mismo texto), gustos
--    (suma times_seen), cierres de pedido, consentimiento (el mas restrictivo gana: un «revocado» jamas se pierde), envios de campana, resumen
--    historico y quejas. order_count = suma; last_order_at = el mayor; el nombre del sobreviviente solo se completa si estaba vacio.
--  * Los parecidos solo por nombre/colonia NO se fusionan aqui: se proponen en TypeScript para decision humana.
--  * Vista previa por omision (p_aplicar=false): cuenta grupos y absorbidos sin escribir. Cada fusion queda en `customer_fusion_historial`
--    (solo ids, sin telefono ni nombre). Solo owner/admin.
-- REVERSA: drop function if exists restaurantes.historial_fusionar_duplicados(uuid, boolean); drop table if exists restaurantes.customer_fusion_historial;
create table if not exists restaurantes.customer_fusion_historial (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  sobreviviente uuid not null,
  absorbido uuid not null,
  fusionado_por uuid references core.staff_user(id) on delete set null,
  fusionado_at timestamptz not null default now()
);
alter table restaurantes.customer_fusion_historial enable row level security;
revoke all on restaurantes.customer_fusion_historial from public, anon, authenticated;
grant select, insert, update, delete on restaurantes.customer_fusion_historial to service_role;

create or replace function restaurantes.historial_fusionar_duplicados(p_organization_id uuid, p_aplicar boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  g record;
  v_surv uuid;
  v_lose uuid;
  v_grupos integer := 0;
  v_absorbidos integer := 0;
begin
  if not restaurantes.cliente_es_admin(p_organization_id) then
    raise exception 'historial_fusionar_duplicados: solo owner/admin' using errcode = '42501';
  end if;

  for g in
    select right(regexp_replace(c.phone, '\D', '', 'g'), 10) as clave,
           array_agg(c.id order by c.order_count desc, c.created_at asc, c.id asc) as ids
      from restaurantes.customers c
     where c.organization_id = p_organization_id
       and length(regexp_replace(c.phone, '\D', '', 'g')) >= 10
     group by 1
    having count(*) > 1
     order by 1
  loop
    v_grupos := v_grupos + 1;
    v_surv := g.ids[1];
    for i in 2 .. array_length(g.ids, 1) loop
      v_lose := g.ids[i];
      v_absorbidos := v_absorbidos + 1;
      if not p_aplicar then
        continue;
      end if;

      update restaurantes.orders set customer_id = v_surv where customer_id = v_lose;

      -- Domicilios: el mismo texto se suma al del sobreviviente; el resto se mueve (sin predeterminado, el del sobreviviente manda).
      update restaurantes.customer_addresses s
         set times_used = s.times_used + l.times_used, colonia = coalesce(s.colonia, l.colonia)
        from restaurantes.customer_addresses l
       where s.customer_id = v_surv and l.customer_id = v_lose and lower(btrim(s.address)) = lower(btrim(l.address));
      delete from restaurantes.customer_addresses l
       where l.customer_id = v_lose
         and exists (select 1 from restaurantes.customer_addresses s where s.customer_id = v_surv and lower(btrim(s.address)) = lower(btrim(l.address)));
      update restaurantes.customer_addresses set customer_id = v_surv, is_default = false where customer_id = v_lose;

      -- Gustos: mismo (kind, value) suma veces; el resto se mueve.
      update restaurantes.customer_preferences s
         set times_seen = s.times_seen + l.times_seen, last_seen_at = greatest(s.last_seen_at, l.last_seen_at)
        from restaurantes.customer_preferences l
       where s.customer_id = v_surv and l.customer_id = v_lose and s.kind = l.kind and s.value = l.value;
      delete from restaurantes.customer_preferences l
       where l.customer_id = v_lose
         and exists (select 1 from restaurantes.customer_preferences s where s.customer_id = v_surv and s.kind = l.kind and s.value = l.value);
      update restaurantes.customer_preferences set customer_id = v_surv where customer_id = v_lose;

      update restaurantes.customer_pedido_cierre set customer_id = v_surv where customer_id = v_lose;

      -- Consentimiento: el mas restrictivo gana. Si el absorbido revoco, el sobreviviente queda revocado.
      update restaurantes.marketing_consentimiento s
         set estado = 'revocado', revocado_at = coalesce(l.revocado_at, now()), updated_at = now()
        from restaurantes.marketing_consentimiento l
       where s.customer_id = v_surv and l.customer_id = v_lose and s.canal = l.canal and l.estado = 'revocado' and s.estado <> 'revocado';
      delete from restaurantes.marketing_consentimiento l
       where l.customer_id = v_lose
         and exists (select 1 from restaurantes.marketing_consentimiento s where s.customer_id = v_surv and s.canal = l.canal);
      update restaurantes.marketing_consentimiento set customer_id = v_surv where customer_id = v_lose;
      update restaurantes.marketing_consentimiento_evento set customer_id = v_surv where customer_id = v_lose;
      delete from restaurantes.marketing_campana_envio l
       where l.customer_id = v_lose
         and exists (select 1 from restaurantes.marketing_campana_envio s where s.customer_id = v_surv and s.campana_id = l.campana_id);
      update restaurantes.marketing_campana_envio set customer_id = v_surv where customer_id = v_lose;

      -- Historial importado: si el sobreviviente no tiene resumen, hereda el del absorbido; las quejas se unen.
      update restaurantes.customer_historial_resumen set customer_id = v_surv
       where customer_id = v_lose and not exists (select 1 from restaurantes.customer_historial_resumen s where s.customer_id = v_surv);
      insert into restaurantes.customer_quejas_historicas (customer_id, organization_id, categoria, origen_lote)
      select v_surv, q.organization_id, q.categoria, q.origen_lote from restaurantes.customer_quejas_historicas q where q.customer_id = v_lose
      on conflict do nothing;
      update restaurantes.import_historico_fila set customer_id = v_surv where customer_id = v_lose;

      update restaurantes.customers s
         set order_count = s.order_count + l.order_count,
             last_order_at = case when s.last_order_at is null then l.last_order_at when l.last_order_at is null then s.last_order_at else greatest(s.last_order_at, l.last_order_at) end,
             name = case when s.name is null or btrim(s.name) = '' then l.name else s.name end,
             updated_at = now()
        from restaurantes.customers l
       where s.id = v_surv and l.id = v_lose;

      insert into restaurantes.customer_fusion_historial (organization_id, sobreviviente, absorbido, fusionado_por)
      values (p_organization_id, v_surv, v_lose, auth.uid());
      delete from restaurantes.customers where id = v_lose;
    end loop;

    if p_aplicar then
      -- Telefono canonico de 10 digitos (los absorbidos ya no existen, no hay choque de unicidad).
      update restaurantes.customers set phone = g.clave, updated_at = now() where id = v_surv and phone <> g.clave;
    end if;
  end loop;

  return jsonb_build_object('modo', case when p_aplicar then 'aplicado' else 'vista_previa' end, 'grupos', v_grupos, 'absorbidos', v_absorbidos);
end;
$$;
revoke all on function restaurantes.historial_fusionar_duplicados(uuid, boolean) from public, anon;
grant execute on function restaurantes.historial_fusionar_duplicados(uuid, boolean) to authenticated;
