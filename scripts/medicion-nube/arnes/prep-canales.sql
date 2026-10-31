-- SOLO en la copia efimera: numeros de WhatsApp de PRUEBA por sucursal (la cuenta real no tiene ninguno).
insert into restaurantes.whatsapp_channel_config(organization_id, phone_number_id) values ('f838fd2c-967e-46fd-af8d-e0229b15748d','5550007777') on conflict do nothing;
insert into restaurantes.whatsapp_branch_channel(phone_number_id, organization_id, property_id) values
 ('5550007777','f838fd2c-967e-46fd-af8d-e0229b15748d','42996ff1-4285-4e53-9a11-71c7b1cc0392'),
 ('5550001111','f838fd2c-967e-46fd-af8d-e0229b15748d','998f5840-0e2e-4e22-9285-988637cb4d42'),
 ('5550003333','f838fd2c-967e-46fd-af8d-e0229b15748d','13e6655b-c04b-466d-bcf1-e9b1e1a66754') on conflict do nothing;
