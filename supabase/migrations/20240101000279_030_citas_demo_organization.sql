-- C-27: marca de organizacion DEMO de citas (`citas.demo_organization`). Prefijo de supabase/migrations asignado para esta
-- tarea: 20240101000279 (interno 030). Equivalente de `restaurantes.demo_organization` (migracion 037).
--
-- Una organizacion demo es una cuenta de demostracion (clinica dental y barberia ficticias cargadas por
-- scripts/seed-citas-demo) que se puede presentar a un cliente SIN datos reales. La marca cumple dos funciones y ninguna mas:
--   1. El script de limpieza (`scripts/seed-citas-demo/limpiar-demo.ts`) y la funcion `citas.demo_limpiar` solo borran
--      organizaciones marcadas aqui: se niegan a tocar cualquier otra.
--   2. El seed la escribe (con la conexion del propietario de la base) para dejar constancia de que la organizacion es demo.
--
-- Compatibilidad con la base sin migrar: NINGUN codigo TypeScript de la aplicacion lee ni escribe esta tabla; solo la usan los
-- scripts de operador (que comprueban su existencia antes de escribir y lo avisan). Nada de esto afecta a un deploy.
--
-- Justificacion de seguridad de cada GRANT / policy / funcion (una por una):
--  * RLS habilitado y `revoke all ... from public, anon, authenticated, service_role`: `anon` no tiene NINGUN acceso.
--  * SELECT para `authenticated` y `service_role`: la policy deja leer la marca solo al staff de ESA organizacion
--    (`core.membership`). La tabla no guarda PII ni secretos (solo la version del seed y una fecha). Sin rama de sesion de
--    sistema: ningun codigo de la aplicacion la necesita.
--  * SIN INSERT/UPDATE/DELETE para ningun rol de la aplicacion: la marca la escribe unicamente quien carga el seed con la
--    cadena de conexion del propietario de la base (un operador, nunca un request). Un owner de cualquier organizacion no puede
--    marcarse como demo ni quitar la marca, ni siquiera la suya.
--  * `citas.demo_limpiar` es SECURITY DEFINER con `set search_path = pg_catalog, public` y nombres calificados (sin secuestro
--    por search_path); exige `auth.uid() is null` (solo sesion de sistema u operador: un usuario autenticado, aunque llegara a
--    tener EXECUTE, recibe 42501); se niega a operar sobre una organizacion que no este marcada como demo; y tiene
--    `revoke all ... from public, anon, authenticated, service_role`, asi que solo el propietario de la base la ejecuta.
create table citas.demo_organization (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  -- Version de los datos del seed que la creo (trazabilidad; no se usa para decidir nada).
  seed_version text not null check (char_length(seed_version) between 1 and 60),
  created_at timestamptz not null default now()
);

alter table citas.demo_organization enable row level security;

create policy "staff lee la marca demo de su organizacion" on citas.demo_organization for select
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = demo_organization.organization_id and m.user_id = auth.uid()
    )
  );

revoke all on citas.demo_organization from public, anon, authenticated, service_role;
grant select on citas.demo_organization to authenticated, service_role;

-- Limpieza de una organizacion demo. Funcion de OPERADOR: se invoca con la conexion del propietario desde
-- `scripts/seed-citas-demo/limpiar-demo.ts` (nunca desde un request). Borra primero las citas (citas.appointments referencia
-- proveedor, servicio y cliente con ON DELETE RESTRICT, que no admite el borrado en cascada de la organizacion en un solo paso)
-- y despues la organizacion completa, cuyo borrado en cascada se lleva el resto (clientes, proveedores, servicios, reglas,
-- excepciones, lista de espera, configuracion y la propia marca).
create or replace function citas.demo_limpiar(p_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_citas integer := 0;
  v_clientes integer := 0;
  v_espera integer := 0;
begin
  if auth.uid() is not null then
    raise exception 'demo_limpiar: solo la sesion de sistema u operador puede ejecutarla' using errcode = '42501';
  end if;
  if not exists (select 1 from citas.demo_organization d where d.organization_id = p_organization_id) then
    raise exception 'demo_limpiar: la organizacion no esta marcada como demo; no se toca' using errcode = '42501';
  end if;

  select count(*)::integer into v_clientes from citas.customers where organization_id = p_organization_id;
  select count(*)::integer into v_espera from citas.appointment_waitlist where organization_id = p_organization_id;
  delete from citas.appointments where organization_id = p_organization_id;
  get diagnostics v_citas = row_count;
  delete from core.organization where id = p_organization_id;

  return jsonb_build_object('organizacion_borrada', true, 'citas', v_citas, 'clientes', v_clientes, 'lista_espera', v_espera);
end;
$$;

revoke all on function citas.demo_limpiar(uuid) from public, anon, authenticated, service_role;
