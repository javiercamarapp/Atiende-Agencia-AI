-- PARCHE SOLO EN LA COPIA LOCAL (no existe en la base real ni en el repo). Documenta el defecto P0:
-- el rol `authenticated` (con el que el motor de la API abre TODA sesion) no tiene INSERT en estas tablas, por lo que
-- ningun canal puede crear clientes/pedidos/avisos. Se concede aqui SOLO para poder seguir probando el resto de la cadena.
grant insert, update on restaurantes.customers to authenticated;
grant insert on restaurantes.customer_addresses to authenticated;
grant insert on restaurantes.callback_requests to authenticated;
-- Policies RLS (ver parche-log.txt): tambien hacen falta ademas del GRANT. Idempotente.
do $$ declare t text; begin
  foreach t in array array['customers','customer_addresses','callback_requests'] loop
    execute format('drop policy if exists qa_parche_%1$s on restaurantes.%1$s', t);
    execute format('create policy qa_parche_%1$s on restaurantes.%1$s for all to authenticated using (true) with check (true)', t);
    execute format('grant select, insert, update on restaurantes.%1$s to authenticated', t);
  end loop;
end $$;
