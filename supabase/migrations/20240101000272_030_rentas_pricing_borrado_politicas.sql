-- Rn-23: que la configuracion de precios de rentas se pueda EDITAR y BORRAR desde el panel.
-- 004_pricing_escritura_rls.sql ya dio INSERT/UPDATE (policy + GRANT) a las 5 tablas de
-- pricing y DELETE solo a rentas.tarifa_regla_canal. Faltaba DELETE en las otras tres tablas
-- de configuracion editable: tarifa_temporada, tarifa_descuento_duracion y tarifa_min_stay.
-- tarifa_base NO gana DELETE: se versiona por `vigente_desde` y su historial no se borra.
--
-- Requiere: 002_pricing_schema.sql y 004_pricing_escritura_rls.sql ya aplicadas.
--
-- JUSTIFICACION DE SEGURIDAD
--   * Tres policies `for delete` nuevas, con la MISMA condicion que las de UPDATE/INSERT de 004:
--     rentas.can_write_pricing(property_id) -- membresia de la property con vertical_role =
--     'admin_gestora' (security definer con search_path fijo, definida en 004). Ninguna
--     `using (true)`: un rol sin escritura, otra organizacion o anon no borran ninguna fila
--     (RLS filtra a 0 filas; ademas anon no tiene GRANT).
--   * GRANT DELETE solo a `authenticated`, solo sobre esas tres tablas. A nivel TABLA y no por
--     columna: DELETE no admite lista de columnas en Postgres. No se otorga nada a anon ni a public.
--   * No se agrega ninguna funcion nueva ni ningun security definer.

create policy "pricing: borrado de tarifa_temporada" on rentas.tarifa_temporada
  for delete using (rentas.can_write_pricing(property_id));
create policy "pricing: borrado de tarifa_descuento_duracion" on rentas.tarifa_descuento_duracion
  for delete using (rentas.can_write_pricing(property_id));
create policy "pricing: borrado de tarifa_min_stay" on rentas.tarifa_min_stay
  for delete using (rentas.can_write_pricing(property_id));

grant delete on rentas.tarifa_temporada, rentas.tarifa_descuento_duracion, rentas.tarifa_min_stay to authenticated;
