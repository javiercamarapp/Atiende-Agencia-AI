-- 091 -- Panel movil del operador (PLAN-PANEL-OPERADOR §3/§4), parte 2: consentimiento de avisos por WhatsApp de pedidos CAPTURADOS POR PERSONAL
-- (llamada/mostrador) y envio diferido en la outbox.
--
-- Por que existe: un cliente que pide por llamada no tiene ventana de 24 h abierta y nunca escribio a WhatsApp; mandarle una plantilla exige
-- consentimiento registrado (quien lo pidio y cuando). Guion que lee el personal: «le mandamos el aviso de su pedido por WhatsApp a este
-- numero, ¿esta bien?». Sin consentimiento NO se encola nada y el panel marca «llamale».
--
-- QUE HACE (re-ejecutable: columnas con `if not exists`, `drop policy if exists`, `create or replace`):
--   1. restaurantes.whatsapp_aviso_consentimiento: una fila por (organizacion, telefono). El telefono NO se guarda: solo su huella SHA-256 del E.164.
--      Guarda ademas el PRIMER consentimiento (`primer_*`, nunca se pisa: es la evidencia) y quien revoco (`revocado_por`: 'sistema' = BAJA/STOP o
--      peticion del cliente; 'staff' = el personal registro un NO).
--   2. registrar_consentimiento_aviso(...) -- unico camino de escritura para el personal. NO reactiva una revocacion hecha por el sistema (BAJA/STOP):
--      devuelve bloqueado_por_baja = true y no toca la fila. Un NO del personal si se puede revertir con un SI posterior del personal.
--   3. consentimiento_aviso_vigente(org, telefono) -- booleano: otorgado y no revocado.
--   4. revocar_consentimiento_aviso(org, telefono) -- solo sistema (flujo de BAJA/STOP); marca revocado_por = 'sistema'.
--   5. orders.aviso_whatsapp (boolean, nullable): el consentimiento que aplico a ESE pedido.
--   6. enqueue_messaging_outbox_diferido(...): como enqueue_messaging_outbox pero con `next_attempt_at` futuro (<= 10 min); el claim de 007/015 ya lo
--      respeta. Sirve al aviso «entregado» aplazado 60 s. Quien puede encolar: sesion de sistema, owner/admin/staff de la organizacion, o el CHOFER
--      solo para el aviso `order-status:<pedido>:entregado` de un pedido que tiene asignado y ya marco entregado (es su propia sesion la que encola al entregar).
--
-- Justificacion de seguridad:
--  * Tabla con RLS activa; `revoke all` de public/anon/authenticated; `grant select` a authenticated POR COLUMNA (todas menos `telefono_hash`) con policy de
--    gestor de la organizacion (owner/admin/staff; nunca using(true); cross-tenant = 0 filas); service_role lee. SIN insert/update/delete directo.
--    La tabla no tiene sucursal (el consentimiento es de la organizacion y el telefono), por eso la policy es organizacional, no por sucursal.
--  * Sobre la huella del telefono: un SHA-256 de un numero telefonico es invertible por fuerza bruta (el espacio es pequeno), y un «pepper» guardado en la
--    misma base no cambiaria eso (quien lee la tabla lee la base). Por eso la proteccion real es de ACCESO: la huella no es legible para authenticated (grant
--    por columna), solo para service_role/dueño de la funcion, y la funcion calcula la huella por dentro (el llamador no inyecta huellas). La huella solo sirve
--    para consultar y desduplicar.
--  * Funciones definer con search_path fijo (con pg_temp al final), revoke de public/anon. revocar_consentimiento_aviso se concede a `authenticated` y NO solo a
--    service_role porque este monorepo siempre conecta como `authenticated` (la «sesion de sistema» es auth.uid() nulo; ver 015_messaging_outbox_dispatch_
--    authenticated_grants.sql): la guarda real es auth.uid() is null, como en claim_messaging_outbox_batch.
--
-- Compatibilidad con la base SIN migrar: 42P01/42883/42703 => el TypeScript NO encola WhatsApp y responde aviso.omitido = consentimiento_no_disponible
-- (nunca se asume consentimiento); sin enqueue diferido el aviso «entregado» sale inmediato y el deshacer queda como «ya avisado».
--
-- REVERSA (ORDEN OBLIGATORIO 092 -> 091 -> 090; las funciones plpgsql no registran dependencias):
--     drop function if exists restaurantes.enqueue_messaging_outbox_diferido(uuid, text, text, text, jsonb, timestamptz);
--     drop function if exists restaurantes.revocar_consentimiento_aviso(uuid, text);
--     drop function if exists restaurantes.consentimiento_aviso_vigente(uuid, text);
--     drop function if exists restaurantes.registrar_consentimiento_aviso(uuid, uuid, text, boolean, text, uuid);
--     drop table if exists restaurantes.whatsapp_aviso_consentimiento;      -- ¡BORRA LOS CONSENTIMIENTOS!
--     alter table restaurantes.orders drop column if exists aviso_whatsapp;
--   ADVERTENCIA: revertir esta migracion destruye los consentimientos registrados, que son EVIDENCIA LEGAL (LFPDPPP / politicas de WhatsApp). Antes de
--   revertir, exportar la tabla; despues de revertir, ningun aviso por llamada puede enviarse (el codigo cae a «sin aviso, llamale»).

alter table restaurantes.orders add column if not exists aviso_whatsapp boolean;

create table if not exists restaurantes.whatsapp_aviso_consentimiento (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  telefono_hash text not null check (telefono_hash ~ '^[0-9a-f]{64}$'),
  otorgado boolean not null,
  via text not null check (via in ('verbal_llamada', 'mostrador', 'mensaje_cliente')),
  capturado_por uuid references core.staff_user(id) on delete set null,
  order_id uuid references restaurantes.orders(id) on delete set null,
  otorgado_en timestamptz not null default now(),
  revocado_en timestamptz,
  unique (organization_id, telefono_hash)
);
alter table restaurantes.whatsapp_aviso_consentimiento
  add column if not exists revocado_por text check (revocado_por is null or revocado_por in ('sistema', 'staff')),
  add column if not exists primer_otorgado_en timestamptz,
  add column if not exists primer_capturado_por uuid references core.staff_user(id) on delete set null,
  add column if not exists primera_via text check (primera_via is null or primera_via in ('verbal_llamada', 'mostrador', 'mensaje_cliente'));

alter table restaurantes.whatsapp_aviso_consentimiento enable row level security;
revoke all on restaurantes.whatsapp_aviso_consentimiento from public, anon, authenticated;
grant select (id, organization_id, otorgado, via, capturado_por, order_id, otorgado_en, revocado_en, revocado_por, primer_otorgado_en, primer_capturado_por, primera_via)
  on restaurantes.whatsapp_aviso_consentimiento to authenticated;
grant select on restaurantes.whatsapp_aviso_consentimiento to service_role;

drop policy if exists "gestores leen el consentimiento de avisos de su organizacion" on restaurantes.whatsapp_aviso_consentimiento;
create policy "gestores leen el consentimiento de avisos de su organizacion" on restaurantes.whatsapp_aviso_consentimiento for select
  using (exists (
    select 1 from core.membership m
    where m.user_id = auth.uid()
      and m.organization_id = whatsapp_aviso_consentimiento.organization_id
      and m.vertical_role in ('owner', 'admin', 'staff')
  ));

create or replace function restaurantes.registrar_consentimiento_aviso(
  p_organization_id uuid,
  p_property_id uuid,
  p_telefono text,
  p_otorgado boolean,
  p_via text,
  p_order_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_hash text;
  v_fila restaurantes.whatsapp_aviso_consentimiento;
begin
  if p_organization_id is null or p_property_id is null or p_otorgado is null then
    raise exception 'registrar_consentimiento_aviso: faltan datos' using errcode = '22023';
  end if;
  if p_telefono is null or p_telefono !~ '^\+[1-9][0-9]{9,14}$' then
    raise exception 'registrar_consentimiento_aviso: telefono invalido' using errcode = '22023';
  end if;
  if p_via is null or p_via not in ('verbal_llamada', 'mostrador', 'mensaje_cliente') then
    raise exception 'registrar_consentimiento_aviso: via invalida' using errcode = '22023';
  end if;
  if not exists (select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id) then
    raise exception 'registrar_consentimiento_aviso: la sucursal no pertenece a la organizacion' using errcode = '42501';
  end if;
  if auth.uid() is not null and not restaurantes.operador_puede(p_organization_id, p_property_id, 'capturar') then
    raise exception 'registrar_consentimiento_aviso: sin permiso para capturar en esta sucursal' using errcode = '42501';
  end if;
  if p_order_id is not null
     and not exists (select 1 from restaurantes.orders o where o.id = p_order_id and o.organization_id = p_organization_id) then
    raise exception 'registrar_consentimiento_aviso: el pedido no pertenece a la organizacion' using errcode = '42501';
  end if;

  v_hash := encode(sha256(convert_to(p_telefono, 'UTF8')), 'hex');
  insert into restaurantes.whatsapp_aviso_consentimiento as c
    (organization_id, telefono_hash, otorgado, via, capturado_por, order_id, otorgado_en, revocado_en, revocado_por,
     primer_otorgado_en, primer_capturado_por, primera_via)
  values (p_organization_id, v_hash, p_otorgado, p_via, auth.uid(), p_order_id, now(),
          case when p_otorgado then null else now() end,
          case when p_otorgado then null else 'staff' end,
          case when p_otorgado then now() end,
          case when p_otorgado then auth.uid() end,
          case when p_otorgado then p_via end)
  on conflict (organization_id, telefono_hash) do update
    set otorgado = excluded.otorgado,
        via = excluded.via,
        capturado_por = excluded.capturado_por,
        order_id = excluded.order_id,
        otorgado_en = excluded.otorgado_en,
        revocado_en = excluded.revocado_en,
        revocado_por = excluded.revocado_por,
        -- La evidencia del PRIMER consentimiento no se pisa nunca.
        primer_otorgado_en = coalesce(c.primer_otorgado_en, excluded.primer_otorgado_en),
        primer_capturado_por = case when c.primer_otorgado_en is null then excluded.primer_capturado_por else c.primer_capturado_por end,
        primera_via = coalesce(c.primera_via, excluded.primera_via)
    -- Una revocacion hecha por el sistema (BAJA/STOP o peticion del cliente) NO la deshace el personal.
    where c.revocado_por is distinct from 'sistema'
  returning * into v_fila;

  if v_fila.id is null then
    return jsonb_build_object('otorgado', false, 'bloqueado_por_baja', true);
  end if;
  return jsonb_build_object('otorgado', v_fila.otorgado, 'otorgado_en', v_fila.otorgado_en, 'bloqueado_por_baja', false);
end;
$$;

create or replace function restaurantes.consentimiento_aviso_vigente(p_organization_id uuid, p_telefono text)
returns boolean
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is not null and not exists (
    select 1 from core.membership m
    where m.user_id = auth.uid() and m.organization_id = p_organization_id and m.vertical_role in ('owner', 'admin', 'staff')
  ) then
    raise exception 'consentimiento_aviso_vigente: sin acceso a esta organizacion' using errcode = '42501';
  end if;
  if p_telefono is null or p_telefono !~ '^\+[1-9][0-9]{9,14}$' then
    return false;
  end if;
  return exists (
    select 1 from restaurantes.whatsapp_aviso_consentimiento c
    where c.organization_id = p_organization_id
      and c.telefono_hash = encode(sha256(convert_to(p_telefono, 'UTF8')), 'hex')
      and c.otorgado
      and c.revocado_en is null
  );
end;
$$;

create or replace function restaurantes.revocar_consentimiento_aviso(p_organization_id uuid, p_telefono text)
returns boolean
language plpgsql
security definer
set search_path = restaurantes, pg_temp
as $$
declare
  v_n integer;
begin
  if auth.uid() is not null then
    raise exception 'revocar_consentimiento_aviso es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if p_telefono is null or p_telefono !~ '^\+[1-9][0-9]{9,14}$' then
    return false;
  end if;
  update restaurantes.whatsapp_aviso_consentimiento
  set revocado_en = coalesce(revocado_en, now()),
      revocado_por = 'sistema'
  where organization_id = p_organization_id
    and telefono_hash = encode(sha256(convert_to(p_telefono, 'UTF8')), 'hex');
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

create or replace function restaurantes.enqueue_messaging_outbox_diferido(
  p_organization_id uuid, p_channel text, p_event_type text,
  p_dedupe_key text, p_payload jsonb, p_enviar_despues timestamptz
) returns uuid
language plpgsql
security definer
set search_path = restaurantes, pg_temp
as $$
declare
  v_id uuid;
  v_order_id uuid;
begin
  if auth.uid() is not null then
    if exists (
      select 1 from core.membership m
      where m.organization_id = p_organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin', 'staff')
    ) then
      null; -- gestor de la organizacion
    else
      -- Chofer: SOLO el aviso «entregado» de un pedido que tiene asignado y ya marco entregado.
      if p_event_type is distinct from 'pedido_entregado'
         or p_dedupe_key is null
         or p_dedupe_key !~ '^order-status:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:entregado$' then
        raise exception 'sin acceso a esta organización' using errcode = '42501';
      end if;
      v_order_id := substring(p_dedupe_key from 14 for 36)::uuid;
      if not exists (
        select 1
        from restaurantes.orders o
        join core.membership m on m.user_id = auth.uid() and m.organization_id = o.organization_id and m.vertical_role = 'repartidor'
        where o.id = v_order_id
          and o.organization_id = p_organization_id
          and o.assigned_repartidor_id = auth.uid()
          and o.status = 'entregado'
      ) then
        raise exception 'sin acceso a esta organización' using errcode = '42501';
      end if;
    end if;
  end if;
  if p_channel not in ('whatsapp', 'email') then raise exception 'invalid outbox channel'; end if;
  if p_enviar_despues is null or p_enviar_despues > now() + interval '10 minutes' then
    raise exception 'enqueue_messaging_outbox_diferido: el aplazamiento maximo es de 10 minutos' using errcode = '22023';
  end if;
  insert into restaurantes.messaging_outbox(organization_id, channel, event_type, dedupe_key, payload, created_at, next_attempt_at)
  values (p_organization_id, p_channel, p_event_type, p_dedupe_key, p_payload, clock_timestamp(), greatest(p_enviar_despues, now()))
  on conflict (organization_id, channel, dedupe_key) do update
    set payload = excluded.payload, event_type = excluded.event_type, next_attempt_at = excluded.next_attempt_at
    where messaging_outbox.status in ('pending', 'failed');
  select id into v_id from restaurantes.messaging_outbox
    where organization_id = p_organization_id and channel = p_channel and dedupe_key = p_dedupe_key;
  return v_id;
end;
$$;

revoke all on function restaurantes.registrar_consentimiento_aviso(uuid, uuid, text, boolean, text, uuid) from public, anon;
revoke all on function restaurantes.consentimiento_aviso_vigente(uuid, text) from public, anon;
revoke all on function restaurantes.revocar_consentimiento_aviso(uuid, text) from public, anon;
revoke all on function restaurantes.enqueue_messaging_outbox_diferido(uuid, text, text, text, jsonb, timestamptz) from public, anon;
grant execute on function restaurantes.registrar_consentimiento_aviso(uuid, uuid, text, boolean, text, uuid) to authenticated, service_role;
grant execute on function restaurantes.consentimiento_aviso_vigente(uuid, text) to authenticated, service_role;
grant execute on function restaurantes.revocar_consentimiento_aviso(uuid, text) to authenticated, service_role;
grant execute on function restaurantes.enqueue_messaging_outbox_diferido(uuid, text, text, text, jsonb, timestamptz) to authenticated, service_role;
