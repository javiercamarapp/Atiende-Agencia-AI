-- QA R1 (citas, seguridad): cuatro cierres de defensa en profundidad en Postgres que acompanan los arreglos de TypeScript
-- del mismo PR. Todo es aditivo o REEMPLAZA una policy existente por otra mas estricta; ningun GRANT nuevo a anon.
--
-- Contexto de roles: `withAppSession` SIEMPRE conecta como `set local role authenticated` (tanto una sesion de staff, con
-- auth.uid() = el usuario, como una sesion de sistema, con auth.uid() NULL). Por eso un GRANT no distingue staff de sistema:
-- esa distincion solo la dan las policies (`auth.uid() is null`) y los guards de funcion/trigger.

-- ============================================================================
-- 1. citas.tenant_config: solo owner/admin escriben (QA-citas-R1-seguridad-01)
-- ============================================================================
-- Hallazgo: la policy "for all" de 001 dejaba escribir a cualquier miembro de la organizacion (rol 'staff' incluido, aunque tuviera
-- una sola sucursal). El rubro enciende o apaga la guardia de crisis de TODA la organizacion y `owner_notification_phone` recibe las
-- escalaciones de crisis (con el telefono del paciente) y los callbacks de voz. La ruta HTTP ya exige owner/admin
-- (`assertVerticalRole(STAFF_INVITE_ROLES)`); esta migracion lo hace real tambien en SQL (mismo criterio `vertical_role in
-- ('owner','admin')` que 023/024/029).
--   - SELECT: cualquier miembro de la organizacion (el panel muestra la configuracion a todo el staff) Y la sesion de sistema
--     (auth.uid() null). Justificacion de la lectura de sistema: el agente de WhatsApp y de voz corren en sesion de sistema y leen
--     `rubro` y `owner_notification_phone` (crisis-guardrail.ts::runCrisisGuardrail); con la policy anterior esa lectura devolvia 0 filas
--     y el aviso al dueno de una escalacion de crisis nunca encontraba el telefono. Es solo lectura y la sesion de sistema ya es de confianza
--     (mismo escape que 016 dio a provider_calendar_accounts).
--   - INSERT/UPDATE: solo owner/admin de ESA organizacion. Sin DELETE (no hay GRANT de borrado, igual que antes).
drop policy if exists "staff gestiona tenant_config de su organización" on citas.tenant_config;

create policy "tenant_config lectura staff y sistema" on citas.tenant_config for select
  using (
    auth.uid() is null
    or exists (select 1 from core.membership m where m.organization_id = tenant_config.organization_id and m.user_id = auth.uid())
  );
create policy "tenant_config alta owner admin" on citas.tenant_config for insert
  with check (
    exists (
      select 1 from core.membership m
      where m.organization_id = tenant_config.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );
create policy "tenant_config edicion owner admin" on citas.tenant_config for update
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = tenant_config.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  )
  with check (
    exists (
      select 1 from core.membership m
      where m.organization_id = tenant_config.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

-- ============================================================================
-- 2. Cuentas de calendario externo: acotadas a la sucursal del proveedor (QA-citas-R1-seguridad-02)
-- ============================================================================
-- Hallazgo: las policies de provider_calendar_accounts / provider_caldav_accounts / provider_calcom_accounts solo comparaban la
-- organizacion, asi que el staff de una sucursal podia conectar un calendario propio al proveedor de OTRA sucursal; cada cita sincronizada
-- lleva servicio, nombre, telefono y notas del paciente (calendar-sync.ts). Ahora la fila solo es visible/escribible si el proveedor es de la
-- misma organizacion que la fila y la membership cubre la sucursal del proveedor (`citas.membership_covers_property`, de 015: un proveedor sin
-- sucursal o una membership sin restriccion cubren toda la organizacion).
--   - La sesion de sistema (auth.uid() null) conserva el acceso: es la que conecta (el secreto solo lo puede escribir el sistema, ver 3) y la que
--     sincroniza por cron. provider_calendar_accounts ya lo tenia desde 016; calcom/caldav NO lo tenian, asi que el cron de sincronizacion de
--     Cal.com/CalDAV no veia ninguna cuenta; este cambio lo habilita (alcance: solo la sesion de sistema, que ya es de confianza).
drop policy if exists "staff gestiona provider_calendar_accounts de su organización" on citas.provider_calendar_accounts;
create policy "cuentas google acotadas a la sucursal del proveedor" on citas.provider_calendar_accounts for all
  using (
    auth.uid() is null
    or exists (
      select 1 from citas.providers p
      where p.id = provider_calendar_accounts.provider_id and p.organization_id = provider_calendar_accounts.organization_id
        and citas.membership_covers_property(p.organization_id, p.property_id)
    )
  )
  with check (
    auth.uid() is null
    or exists (
      select 1 from citas.providers p
      where p.id = provider_calendar_accounts.provider_id and p.organization_id = provider_calendar_accounts.organization_id
        and citas.membership_covers_property(p.organization_id, p.property_id)
    )
  );

drop policy if exists "staff gestiona provider_caldav_accounts de su organización" on citas.provider_caldav_accounts;
create policy "cuentas caldav acotadas a la sucursal del proveedor" on citas.provider_caldav_accounts for all
  using (
    auth.uid() is null
    or exists (
      select 1 from citas.providers p
      where p.id = provider_caldav_accounts.provider_id and p.organization_id = provider_caldav_accounts.organization_id
        and citas.membership_covers_property(p.organization_id, p.property_id)
    )
  )
  with check (
    auth.uid() is null
    or exists (
      select 1 from citas.providers p
      where p.id = provider_caldav_accounts.provider_id and p.organization_id = provider_caldav_accounts.organization_id
        and citas.membership_covers_property(p.organization_id, p.property_id)
    )
  );

drop policy if exists "staff gestiona provider_calcom_accounts de su organización" on citas.provider_calcom_accounts;
create policy "cuentas calcom acotadas a la sucursal del proveedor" on citas.provider_calcom_accounts for all
  using (
    auth.uid() is null
    or exists (
      select 1 from citas.providers p
      where p.id = provider_calcom_accounts.provider_id and p.organization_id = provider_calcom_accounts.organization_id
        and citas.membership_covers_property(p.organization_id, p.property_id)
    )
  )
  with check (
    auth.uid() is null
    or exists (
      select 1 from citas.providers p
      where p.id = provider_calcom_accounts.provider_id and p.organization_id = provider_calcom_accounts.organization_id
        and citas.membership_covers_property(p.organization_id, p.property_id)
    )
  );

-- ============================================================================
-- 3. El id del secreto de Vault solo lo asigna la sesion de sistema (QA-citas-R1-seguridad-03)
-- ============================================================================
-- Hallazgo: el GRANT de columna completo (016) dejaba que un staff escribiera directo `*_secret_id` con cualquier uuid. Como el rol de la sesion
-- es el mismo para staff y sistema, un GRANT por columna no puede separarlos; el guard es un trigger: una fila escrita con auth.uid() no nulo no
-- puede traer ni cambiar el id del secreto. Quien lo asigna es `citas.set_provider_calendar_refresh_token` (solo sistema) desde una sesion de sistema.
-- Funcion de seguridad invoker (no necesita privilegios extra), search_path fijo; los triggers no requieren EXECUTE para dispararse.
create or replace function citas.guard_calendar_secret_id() returns trigger
language plpgsql
set search_path = pg_catalog, citas
as $$
declare
  v_col text := tg_argv[0];
  v_new text := to_jsonb(new) ->> v_col;
  v_old text := case when tg_op = 'UPDATE' then to_jsonb(old) ->> v_col else null end;
begin
  if auth.uid() is not null and v_new is distinct from v_old then
    raise exception 'el id del secreto (%) solo lo asigna la sesion de sistema', v_col using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function citas.guard_calendar_secret_id() from public, anon;

create trigger provider_calendar_accounts_guard_secret before insert or update on citas.provider_calendar_accounts
  for each row execute function citas.guard_calendar_secret_id('google_refresh_token_secret_id');
create trigger provider_caldav_accounts_guard_secret before insert or update on citas.provider_caldav_accounts
  for each row execute function citas.guard_calendar_secret_id('caldav_password_secret_id');
create trigger provider_calcom_accounts_guard_secret before insert or update on citas.provider_calcom_accounts
  for each row execute function citas.guard_calendar_secret_id('calcom_api_key_secret_id');

-- ============================================================================
-- 4. Una cita solo referencia proveedor, servicio y cliente de su organizacion y sucursal (QA-citas-R1-seguridad-05)
-- ============================================================================
-- Hallazgo (defensa en profundidad: hoy el TypeScript valida antes y el schema citas no esta expuesto en PostgREST): las RPC de alta
-- (create_appointment_from_panel, create_appointment_idempotent) y la de reasignacion aceptan ids que no validan, asi que una cita de la
-- organizacion A podia ocupar la agenda de un proveedor de B o de otra sucursal. En vez de reescribir cada funcion, el invariante se fija
-- en la tabla con un trigger (cubre tambien cualquier funcion futura). `security definer` con search_path fijo: lee proveedores/servicios/
-- clientes sin depender de la RLS del invocador. Reglas:
--   - proveedor, servicio y cliente deben ser de la misma organizacion que la cita (AT403: el id pertenece a otro negocio);
--   - al insertar (o al cambiar la sucursal), si el proveedor tiene sucursal, la cita debe llevar esa misma sucursal (AT400).
create or replace function citas.guard_appointment_references() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, citas
as $$
declare
  v_provider_org uuid;
  v_provider_property uuid;
  v_service_org uuid;
  v_customer_org uuid;
begin
  select organization_id, property_id into v_provider_org, v_provider_property from citas.providers where id = new.provider_id;
  if v_provider_org is distinct from new.organization_id then
    raise exception 'el proveedor no pertenece a la organizacion de la cita' using errcode = 'AT403';
  end if;

  select organization_id into v_service_org from citas.services where id = new.service_id;
  if v_service_org is distinct from new.organization_id then
    raise exception 'el servicio no pertenece a la organizacion de la cita' using errcode = 'AT403';
  end if;

  select organization_id into v_customer_org from citas.customers where id = new.customer_id;
  if v_customer_org is distinct from new.organization_id then
    raise exception 'el cliente no pertenece a la organizacion de la cita' using errcode = 'AT403';
  end if;

  if (tg_op = 'INSERT' or new.property_id is distinct from old.property_id)
     and v_provider_property is not null and new.property_id is distinct from v_provider_property then
    raise exception 'el proveedor es de otra sucursal' using errcode = 'AT400';
  end if;

  return new;
end;
$$;
revoke all on function citas.guard_appointment_references() from public, anon;

create trigger appointments_guard_references before insert or update of organization_id, property_id, provider_id, service_id, customer_id on citas.appointments
  for each row execute function citas.guard_appointment_references();
