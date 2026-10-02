-- Fixtures y ayudantes SOLO de esta verificacion (schema `conc`, jamas viaja en una migracion).
-- Se aplica DESPUES de las migraciones reales y de post-migrations.sql.
--
-- Los ayudantes llaman a las RPC REALES de citas (migraciones 002/015) tal cual las usa la sesion de sistema del
-- agente (auth.uid() null): no reimplementan ninguna logica de reserva. Solo capturan el SQLSTATE para que el
-- orquestador (run.sh) pueda comparar el resultado de cada conexion sin parsear mensajes.
create schema conc;
grant usage on schema conc to authenticated;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000c1701', 'citas', 'Org Citas Concurrencia A', 'org-citas-conc-a'),
  ('00000000-0000-0000-0000-0000000c1702', 'citas', 'Org Citas Concurrencia B', 'org-citas-conc-b');

insert into citas.providers (id, organization_id, display_name) values
  ('00000000-0000-0000-0000-0000000c1711', '00000000-0000-0000-0000-0000000c1701', 'Proveedor A1'),
  ('00000000-0000-0000-0000-0000000c1712', '00000000-0000-0000-0000-0000000c1701', 'Proveedor A2'),
  ('00000000-0000-0000-0000-0000000c1713', '00000000-0000-0000-0000-0000000c1702', 'Proveedor B1');

insert into citas.services (id, organization_id, name, duration_minutes) values
  ('00000000-0000-0000-0000-0000000c1721', '00000000-0000-0000-0000-0000000c1701', 'Consulta A', 30),
  ('00000000-0000-0000-0000-0000000c1722', '00000000-0000-0000-0000-0000000c1702', 'Consulta B', 30);

insert into citas.customers (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-0000000c1731', '00000000-0000-0000-0000-0000000c1701', 'Cliente Uno', '5215500001701'),
  ('00000000-0000-0000-0000-0000000c1732', '00000000-0000-0000-0000-0000000c1701', 'Cliente Dos', '5215500001702'),
  ('00000000-0000-0000-0000-0000000c1733', '00000000-0000-0000-0000-0000000c1702', 'Cliente Tres', '5215500001703');

-- Crea una cita por la RPC real. Devuelve 'ok:<id>' o 'err:<SQLSTATE>'.
-- p_key_seed null = sin llave de idempotencia (solo huella de dedupe). La huella y la llave se derivan de sus semillas
-- con sha256, el mismo formato (64 hex) que exige la RPC.
create function conc.try_create(
  p_org uuid, p_provider uuid, p_service uuid, p_customer uuid,
  p_start timestamptz, p_minutes integer, p_key_seed text, p_fp_seed text
) returns text
language plpgsql
as $$
declare
  v_row jsonb;
begin
  v_row := citas.create_appointment_idempotent(
    jsonb_build_object(
      'organization_id', p_org, 'provider_id', p_provider, 'service_id', p_service, 'customer_id', p_customer,
      'starts_at', p_start, 'ends_at', p_start + make_interval(mins => p_minutes), 'status', 'pending', 'source', 'whatsapp'
    ),
    encode(sha256(convert_to(p_fp_seed, 'utf8')), 'hex'),
    case when p_key_seed is null then null else encode(sha256(convert_to(p_key_seed, 'utf8')), 'hex') end
  );
  return 'ok:' || (v_row->>'id');
exception when others then
  return 'err:' || sqlstate;
end;
$$;
grant execute on function conc.try_create(uuid, uuid, uuid, uuid, timestamptz, integer, text, text) to authenticated;

create function conc.try_cancel(p_org uuid, p_id uuid) returns text
language plpgsql
as $$
declare
  v_row jsonb;
begin
  v_row := citas.cancel_appointment_idempotent(p_org, p_id);
  return 'ok:' || (v_row->>'status');
exception when others then
  return 'err:' || sqlstate;
end;
$$;
grant execute on function conc.try_cancel(uuid, uuid) to authenticated;

create function conc.try_reschedule(p_org uuid, p_id uuid, p_start timestamptz, p_minutes integer) returns text
language plpgsql
as $$
declare
  v_row jsonb;
begin
  v_row := citas.reschedule_appointment_idempotent(p_org, p_id, p_start, p_start + make_interval(mins => p_minutes), 'manual', null);
  return 'ok:' || (v_row->>'id');
exception when others then
  return 'err:' || sqlstate;
end;
$$;
grant execute on function conc.try_reschedule(uuid, uuid, timestamptz, integer) to authenticated;
