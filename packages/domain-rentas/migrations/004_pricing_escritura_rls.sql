-- Fase 2, Flujo 4: habilita la ESCRITURA de las 5 tablas de pricing que
-- 002_pricing_schema.sql dejó en solo-lectura ("el endpoint de escritura es Fase 2").
-- Cero tablas nuevas -- solo RLS + grants, mismo patrón que
-- `rentas.can_write_finanzas()` de 003_finanzas_schema.sql, acotado a
-- PRICING_ESCRITURA_ROLES = ["admin_gestora"] (ver diseño Fase 2 rentas §2.1/§2.2).
-- Requiere: 001/002/003 ya aplicadas.

create or replace function rentas.can_write_pricing(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, rentas as $$
  select exists (
    select 1 from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = auth.uid() and p.id = _property_id
      and (m.property_ids is null or _property_id = any(m.property_ids))
      and m.vertical_role = 'admin_gestora'
  )
$$;

create policy "pricing: escritura de tarifa_base" on rentas.tarifa_base
  for insert with check (rentas.can_write_pricing(property_id));
create policy "pricing: actualización de tarifa_base" on rentas.tarifa_base
  for update using (rentas.can_write_pricing(property_id)) with check (rentas.can_write_pricing(property_id));

create policy "pricing: escritura de tarifa_temporada" on rentas.tarifa_temporada
  for insert with check (rentas.can_write_pricing(property_id));
create policy "pricing: actualización de tarifa_temporada" on rentas.tarifa_temporada
  for update using (rentas.can_write_pricing(property_id)) with check (rentas.can_write_pricing(property_id));

create policy "pricing: escritura de tarifa_descuento_duracion" on rentas.tarifa_descuento_duracion
  for insert with check (rentas.can_write_pricing(property_id));
create policy "pricing: actualización de tarifa_descuento_duracion" on rentas.tarifa_descuento_duracion
  for update using (rentas.can_write_pricing(property_id)) with check (rentas.can_write_pricing(property_id));

create policy "pricing: escritura de tarifa_min_stay" on rentas.tarifa_min_stay
  for insert with check (rentas.can_write_pricing(property_id));
create policy "pricing: actualización de tarifa_min_stay" on rentas.tarifa_min_stay
  for update using (rentas.can_write_pricing(property_id)) with check (rentas.can_write_pricing(property_id));

-- tarifa_regla_canal además admite DELETE: desactivar una regla de canal debe poder
-- borrarse (no solo `activo = false`), para no dejar basura de canales descontinuados
-- (ver diseño §2.2).
create policy "pricing: escritura de tarifa_regla_canal" on rentas.tarifa_regla_canal
  for insert with check (rentas.can_write_pricing(property_id));
create policy "pricing: actualización de tarifa_regla_canal" on rentas.tarifa_regla_canal
  for update using (rentas.can_write_pricing(property_id)) with check (rentas.can_write_pricing(property_id));
create policy "pricing: borrado de tarifa_regla_canal" on rentas.tarifa_regla_canal
  for delete using (rentas.can_write_pricing(property_id));

grant insert, update on rentas.tarifa_base, rentas.tarifa_temporada, rentas.tarifa_descuento_duracion, rentas.tarifa_min_stay, rentas.tarifa_regla_canal to authenticated;
grant delete on rentas.tarifa_regla_canal to authenticated;
