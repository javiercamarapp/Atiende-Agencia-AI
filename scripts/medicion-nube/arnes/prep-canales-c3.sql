-- SOLO en la copia efimera, SOLO para la suite C3 (corre DESPUES de prep-canales.sql).
-- El banco C3 espera que el agente elija la sucursal por la DIRECCION del cliente. El numero de la ORGANIZACION
-- (restaurantes.whatsapp_channel_config, una fila por organizacion) pasa a un numero de prueba que NO esta en
-- whatsapp_branch_channel: resolveWhatsAppChannel devuelve { organizationId, propertyId: null } y el agente no tiene
-- "sucursal de este chat" (usa buscar_sucursal_cercana). Los numeros por sucursal de prep-canales.sql se conservan.
update restaurantes.whatsapp_channel_config set phone_number_id = '5550009999'
 where organization_id = 'f838fd2c-967e-46fd-af8d-e0229b15748d';
delete from restaurantes.whatsapp_branch_channel where phone_number_id = '5550009999';
-- Numeros POR SUCURSAL (decision del dueno de PM, 2026-11-06): cada sucursal tiene su numero de WhatsApp. prep-canales.sql ya mapea
-- garcia-lavin (5550007777), prol-montejo (5550001111) y pensiones (5550003333); aqui el resto. El numero de la organizacion (5550009999)
-- sigue sin sucursal solo para QA_C3_NUMERO=org.
insert into restaurantes.whatsapp_branch_channel(phone_number_id, organization_id, property_id) values
 ('5550000202','f838fd2c-967e-46fd-af8d-e0229b15748d','c558908d-d48a-431a-bfc4-0dd422b6ad45'),
 ('5550000205','f838fd2c-967e-46fd-af8d-e0229b15748d','82f4cdfe-cd15-4f82-8547-121eb6750e77'),
 ('5550000206','f838fd2c-967e-46fd-af8d-e0229b15748d','75c67a13-101c-47eb-9ae4-76757c1098bd'),
 ('5550000207','f838fd2c-967e-46fd-af8d-e0229b15748d','9b68a3c2-0cb2-4ac2-84fb-cd4d6d8f6d83') on conflict do nothing;
-- Reloj de la BD (SOLO copia efimera): el arnes corre cada conversacion con su reloj desplazado; created_at de un pedido nuevo recibe el desfase de
-- su telefono (lo inserta suites-c3 al arrancar la conversacion) para que las ventanas «pedido reciente» del agente lo encuentren.
create table if not exists public.qa_desfase_telefono (tel10 text primary key, desfase interval not null);
grant select on public.qa_desfase_telefono to public;
create or replace function public.qa_desfase_created_at() returns trigger language plpgsql security definer set search_path = public as $$
declare d interval;
begin
  select q.desfase into d from public.qa_desfase_telefono q where q.tel10 = right(regexp_replace(coalesce(new.customer_phone, ''), '[^0-9]', '', 'g'), 10);
  if d is not null then new.created_at := coalesce(new.created_at, now()) + d; end if;
  return new;
end $$;
drop trigger if exists qa_desfase_created_at on restaurantes.orders;
create trigger qa_desfase_created_at before insert on restaurantes.orders for each row execute function public.qa_desfase_created_at();
