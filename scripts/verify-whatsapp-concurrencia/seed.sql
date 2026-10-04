-- Organizacion + sucursal + numero de WhatsApp MINIMOS para la prueba de carga del webhook (solo en el Postgres efimero del verify).
insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000e0a01', 'restaurantes', 'Carga WhatsApp', 'carga-whatsapp')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000e0b01', '00000000-0000-0000-0000-0000000e0a01', 'restaurantes', 'Sucursal Carga')
on conflict do nothing;
insert into restaurantes.branch_detail (property_id, organization_id, slug, phone, address, lat, lng, display_order) values
  ('00000000-0000-0000-0000-0000000e0b01', '00000000-0000-0000-0000-0000000e0a01', 'sucursal-carga', '9990001111', 'Calle Falsa 123', 21.0129, -89.6152, 0)
on conflict do nothing;
insert into restaurantes.whatsapp_channel_config (organization_id, phone_number_id) values
  ('00000000-0000-0000-0000-0000000e0a01', '5550009999')
on conflict do nothing;

-- Catalogo minimo para los pedidos por canal (fase 2 de carga.ts).
insert into restaurantes.categories (id, organization_id, name, slug) values
  ('00000000-0000-4000-8000-0000000e0c01', '00000000-0000-0000-0000-0000000e0a01', 'Tacos', 'tacos')
on conflict do nothing;
insert into restaurantes.products (id, organization_id, category_id, name, description, price) values
  ('00000000-0000-4000-8000-0000000e0d01', '00000000-0000-0000-0000-0000000e0a01', '00000000-0000-4000-8000-0000000e0c01', 'Coca-Cola 600 ml', 'Refresco', 42)
on conflict do nothing;
insert into restaurantes.branch_products (property_id, product_id, price, is_available) values
  ('00000000-0000-0000-0000-0000000e0b01', '00000000-0000-4000-8000-0000000e0d01', 42, true)
on conflict do nothing;
