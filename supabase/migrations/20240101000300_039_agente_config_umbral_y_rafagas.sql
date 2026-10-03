-- PM-C5 (decisiones de Javier, 2-oct-2026): dos ajustes del agente de WhatsApp que el dueño debe poder cambiar sin tocar el
-- codigo: el UMBRAL de pedido grande (a partir de cuando el agente pasa el pedido a la sucursal en vez de tomarlo normal) y la
-- ESPERA de rafagas (segundos que el agente aguarda tras el ultimo mensaje del cliente antes de responder).
-- Prefijo de supabase/migrations asignado para esta tanda: 20240101000300 (interno 039).
--
-- Decision de diseno: SOLO dos columnas opcionales (NULL = el valor por omision del perfil: umbral de $4,000 / 5 kg / $2,500 sin
-- historial en efectivo y espera apagada). Nada se borra ni se renombra. El codigo TypeScript que lee/escribe estas columnas
-- degrada con SAVEPOINT al comportamiento anterior (033/029) cuando la base todavia no tiene esta migracion (SQLSTATE
-- 42703/42P01/42883/42501): nada de esto se aplica al mergear.
--
-- Justificacion de seguridad de cada cambio (uno por uno):
--  * `large_order_text`: texto libre CORTO (1 a 200 caracteres, CHECK) que el dueño escribe y que termina dentro del prompt del
--    agente, igual que `salsas_text` o `promos_text` de 033. El codigo lo pasa por `sanitizeInlineText` antes de usarlo. No
--    concede ninguna regla: el agente solo escala (nunca rechaza ni cobra distinto) y las reglas duras viven en el codigo.
--  * `reply_debounce_seconds`: entero de 0 a 10 (CHECK). Acota el tiempo que una peticion del webhook puede esperar: el limite de
--    la funcion es de 30 s y, despues de esperar, todavia tiene que correr el turno del agente; un valor fuera de rango no entra ni por SQL directo.
--  * GRANT: se amplian los GRANT por COLUMNA de INSERT y UPDATE de `authenticated` a SOLO estas dos columnas. Las policies de 029
--    (solo owner/admin de la organizacion) siguen siendo las que protegen la escritura y el cross-tenant; `anon` no recibe nada
--    (ni lectura ni escritura) y no se otorga DELETE. `service_role` conserva lo que ya tenia.
alter table restaurantes.whatsapp_agent_config
  add column large_order_text text check (large_order_text is null or char_length(large_order_text) between 1 and 200),
  add column reply_debounce_seconds smallint check (reply_debounce_seconds is null or reply_debounce_seconds between 0 and 10);

grant insert (large_order_text, reply_debounce_seconds) on restaurantes.whatsapp_agent_config to authenticated;
grant update (large_order_text, reply_debounce_seconds) on restaurantes.whatsapp_agent_config to authenticated;
