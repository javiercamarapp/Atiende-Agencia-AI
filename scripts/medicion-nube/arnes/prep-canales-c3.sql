-- SOLO en la copia efimera, SOLO para la suite C3 (corre DESPUES de prep-canales.sql).
-- El banco C3 espera que el agente elija la sucursal por la DIRECCION del cliente. El numero de la ORGANIZACION
-- (restaurantes.whatsapp_channel_config, una fila por organizacion) pasa a un numero de prueba que NO esta en
-- whatsapp_branch_channel: resolveWhatsAppChannel devuelve { organizationId, propertyId: null } y el agente no tiene
-- "sucursal de este chat" (usa buscar_sucursal_cercana). Los numeros por sucursal de prep-canales.sql se conservan.
update restaurantes.whatsapp_channel_config set phone_number_id = '5550009999'
 where organization_id = 'f838fd2c-967e-46fd-af8d-e0229b15748d';
delete from restaurantes.whatsapp_branch_channel where phone_number_id = '5550009999';
