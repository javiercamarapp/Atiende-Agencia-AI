-- D-11 -- Cola de cobranza del despacho: gestiones de cobranza por factura/cliente (promesa de pago,
-- recordatorio, llamada, nota, con su estado) y recordatorios por WhatsApp como OUTBOX que NO envia
-- nada (con consentimiento opt-in/opt-out por cliente).
--
-- Reutiliza lo que ya existe (no lo duplica): la cartera es `despachos.receivable` + `despachos.invoice`
-- (migraciones 001/004), el historial automatico de recordatorios sigue en `despachos.collection_event`
-- (004) y el correo en `despachos.messaging_outbox` (005). Esta migracion solo agrega lo que faltaba: el
-- registro humano de la gestion y la cola de WhatsApp.
--
-- Modelo:
--   * `despachos.cobranza_gestion`                    -- una fila por gestion sobre UNA cuenta por cobrar
--                                                         (la factura). El "cliente" es el RFC receptor del
--                                                         CFDI de esa cuenta. Montos en CENTAVOS enteros MXN.
--   * `despachos.cobranza_whatsapp_consentimiento`    -- opt-in/opt-out por (property, RFC receptor) con el
--                                                         telefono E.164 y la evidencia declarada.
--   * `despachos.cobranza_whatsapp_outbox`            -- cola de mensajes WhatsApp en `pendiente`. NADA en el
--                                                         repo la consume todavia: no existe despachador ni
--                                                         credencial de WhatsApp para despachos. Es una cola
--                                                         honesta, nunca un envio.
--
-- Cambio sobre una tabla existente: `despachos.receivable` gana `unique (id, property_id)`. Es redundante
-- con la PK (id) y solo existe para que `cobranza_gestion` pueda tener una llave foranea COMPUESTA
-- (receivable_id, property_id): asi es imposible por construccion que una gestion apunte a una cuenta de otra
-- property (defensa en profundidad cross-tenant/cross-cliente, ademas de los checks de las funciones).
--
-- Seguridad (cada punto lo ejerce scripts/verify-despachos-cola-cobranza/assertions.sql):
--   1. Las 3 tablas: RLS habilitado y REVOKE de todo a public/anon/authenticated; despues SOLO SELECT a
--      `authenticated`, con policy `core.has_property_access(auth.uid(), property_id)` (nunca `using (true)`,
--      nunca GRANT a anon). Justificacion: el staff lista la cola y el historial de SU property. Ninguna
--      escritura directa: INSERT/UPDATE/DELETE no se conceden a nadie (ni a service_role: no hay consumidor
--      todavia); todo cambio pasa por las funciones de abajo, que validan forma y pertenencia. Una gestion
--      jamas se borra (auditoria): se cancela.
--   2. GRANT por COLUMNA en el outbox: el staff NO recibe `telefono` (PII) por esa tabla; el telefono vive en
--      la tabla de consentimiento, donde si es necesario mostrarlo para gestionar opt-in/opt-out.
--   3. Funciones de STAFF (las 4 publicas): security definer, `set search_path = despachos, pg_temp`, revoke
--      de public, EXECUTE solo a `authenticated`. Todas pasan por `despachos._cobranza_contexto`, que exige
--      `auth.uid()` no nulo, property de vertical despachos, `core.has_property_access` y, para escribir, rol
--      de membresia admin o contador (auditor/readonly rechazados con 42501 aunque la API ya los filtra).
--      Una sesion de sistema (`auth.uid() is null`) o anon se rechaza con 42501. Cuenta inexistente o de otra
--      property = P0002 con el MISMO mensaje (sin oraculo de existencia entre tenants).
--   4. `despachos._cobranza_contexto` es un helper interno: revoke de public/anon/authenticated (solo lo
--      invocan las funciones definer de esta migracion, que corren como su dueno).
--   5. Topes de abuso (SQLSTATE 54000): 500 gestiones por cuenta, 200 mensajes WhatsApp pendientes por property.
--   6. WhatsApp: encolar exige consentimiento `opt_in` vigente para el RFC de la factura; fijar `opt_out`
--      cancela en la misma transaccion los mensajes pendientes de ese cliente. Sin consentimiento = CB001.
--   7. Nada se ejecuta ni se envia aqui: el texto del mensaje es dato opaco acotado a 1000 caracteres.
--
-- Compatibilidad con la base sin migrar: el TypeScript que consume estas tablas/funciones captura
-- 42883/42P01/42703 dentro de SAVEPOINT (runWithSavepointFallback) y degrada a "no disponible aun" (lista
-- vacia + estado), nunca a un 500. Orden de despliegue: esta migracion se puede aplicar antes o despues del
-- codigo; sin ella la pantalla "Cola de cobranza" dice que aun no esta disponible y el reporte PDF de cartera
-- (que solo lee tablas ya existentes) sigue funcionando.

alter table despachos.receivable add constraint receivable_id_property_unique unique (id, property_id);

create table despachos.cobranza_gestion (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  receivable_id uuid not null,
  tipo text not null check (tipo in ('promesa_pago', 'recordatorio', 'llamada', 'nota')),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'cumplida', 'incumplida', 'cancelada')),
  monto_promesa_centavos bigint check (monto_promesa_centavos is null or monto_promesa_centavos between 1 and 99999999999999),
  fecha_promesa date,
  fecha_seguimiento date,
  nota text check (nota is null or char_length(nota) between 1 and 1000),
  creado_por uuid references core.staff_user(id) on delete set null,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  foreign key (receivable_id, property_id) references despachos.receivable (id, property_id) on delete cascade,
  constraint cobranza_gestion_promesa_consistente check (
    (tipo = 'promesa_pago' and monto_promesa_centavos is not null and fecha_promesa is not null)
    or (tipo <> 'promesa_pago' and monto_promesa_centavos is null and fecha_promesa is null)
  ),
  constraint cobranza_gestion_nota_requerida check (tipo not in ('llamada', 'nota') or nota is not null)
);
create index cobranza_gestion_cuenta_idx on despachos.cobranza_gestion (receivable_id, creado_en desc);
create index cobranza_gestion_cola_idx on despachos.cobranza_gestion (property_id, estado, fecha_seguimiento);

create table despachos.cobranza_whatsapp_consentimiento (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  rfc_receptor text not null check (rfc_receptor ~ '^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$'),
  telefono text not null check (telefono ~ '^\+[1-9][0-9]{7,14}$'),
  estado text not null check (estado in ('opt_in', 'opt_out')),
  evidencia text check (evidencia is null or char_length(evidencia) between 1 and 300),
  actualizado_por uuid references core.staff_user(id) on delete set null,
  actualizado_en timestamptz not null default now(),
  unique (property_id, rfc_receptor),
  constraint cobranza_consentimiento_evidencia check (estado <> 'opt_in' or evidencia is not null)
);

create table despachos.cobranza_whatsapp_outbox (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  receivable_id uuid not null,
  rfc_receptor text not null,
  telefono text not null check (telefono ~ '^\+[1-9][0-9]{7,14}$'),
  cuerpo text not null check (char_length(cuerpo) between 1 and 1000),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 200),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'cancelado', 'enviado', 'fallido')),
  creado_por uuid references core.staff_user(id) on delete set null,
  creado_en timestamptz not null default now(),
  foreign key (receivable_id, property_id) references despachos.receivable (id, property_id) on delete cascade,
  unique (property_id, dedupe_key)
);
create index cobranza_whatsapp_outbox_cola_idx on despachos.cobranza_whatsapp_outbox (property_id, estado, creado_en);

alter table despachos.cobranza_gestion enable row level security;
alter table despachos.cobranza_whatsapp_consentimiento enable row level security;
alter table despachos.cobranza_whatsapp_outbox enable row level security;
revoke all on despachos.cobranza_gestion from public, anon, authenticated;
revoke all on despachos.cobranza_whatsapp_consentimiento from public, anon, authenticated;
revoke all on despachos.cobranza_whatsapp_outbox from public, anon, authenticated;

grant select on despachos.cobranza_gestion to authenticated;
grant select on despachos.cobranza_whatsapp_consentimiento to authenticated;
-- Sin `telefono`: ver punto 2 de la cabecera.
grant select (id, organization_id, property_id, receivable_id, rfc_receptor, cuerpo, dedupe_key, estado, creado_por, creado_en)
  on despachos.cobranza_whatsapp_outbox to authenticated;

create policy "staff ve gestiones de cobranza de su property" on despachos.cobranza_gestion for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff ve consentimientos de cobranza de su property" on despachos.cobranza_whatsapp_consentimiento for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff ve outbox de cobranza de su property" on despachos.cobranza_whatsapp_outbox for select
  using (core.has_property_access(auth.uid(), property_id));

-- Helper interno: valida acceso y devuelve la organizacion de la property. `p_escritura` exige ademas rol
-- admin o contador en la membresia de esa organizacion.
create or replace function despachos._cobranza_contexto(p_property_id uuid, p_escritura boolean)
returns uuid
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
begin
  if auth.uid() is null or p_property_id is null or not core.has_property_access(auth.uid(), p_property_id) then
    raise exception 'cobranza: sin acceso a la property' using errcode = '42501';
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id and p.vertical = 'despachos';
  if v_org is null then
    raise exception 'cobranza: la property no es de despachos' using errcode = '42501';
  end if;
  if p_escritura and not exists (
    select 1 from core.membership m where m.organization_id = v_org and m.user_id = auth.uid() and m.vertical_role in ('admin', 'contador')
  ) then
    raise exception 'cobranza: el rol no puede gestionar cobranza' using errcode = '42501';
  end if;
  return v_org;
end;
$$;
revoke all on function despachos._cobranza_contexto(uuid, boolean) from public, anon, authenticated;

-- 1) Registrar una gestion sobre una cuenta por cobrar.
create or replace function despachos.cobranza_gestion_crear(
  p_property_id uuid, p_receivable_id uuid, p_tipo text, p_nota text,
  p_monto_promesa_centavos bigint, p_fecha_promesa date, p_fecha_seguimiento date
)
returns uuid
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_pagado timestamptz;
  v_nota text;
  v_estado text;
  v_id uuid;
begin
  v_org := despachos._cobranza_contexto(p_property_id, true);
  select r.pagado_en into v_pagado from despachos.receivable r where r.id = p_receivable_id and r.property_id = p_property_id;
  if not found then
    raise exception 'cobranza_gestion_crear: cuenta no encontrada' using errcode = 'P0002';
  end if;
  if p_tipo is null or p_tipo not in ('promesa_pago', 'recordatorio', 'llamada', 'nota') then
    raise exception 'cobranza_gestion_crear: tipo no valido' using errcode = '22023';
  end if;
  v_nota := nullif(btrim(coalesce(p_nota, '')), '');
  if v_nota is not null and char_length(v_nota) > 1000 then
    raise exception 'cobranza_gestion_crear: la nota admite hasta 1000 caracteres' using errcode = '22023';
  end if;
  if p_tipo in ('llamada', 'nota') and v_nota is null then
    raise exception 'cobranza_gestion_crear: la nota es obligatoria' using errcode = '22023';
  end if;
  if p_tipo = 'promesa_pago' then
    if v_pagado is not null then
      raise exception 'cobranza_gestion_crear: la cuenta ya esta pagada' using errcode = '22023';
    end if;
    if p_monto_promesa_centavos is null or p_monto_promesa_centavos < 1 or p_monto_promesa_centavos > 99999999999999 or p_fecha_promesa is null
       or p_fecha_promesa > current_date + 365 then
      raise exception 'cobranza_gestion_crear: promesa de pago invalida (monto en centavos y fecha obligatorios)' using errcode = '22023';
    end if;
    v_estado := 'pendiente';
  else
    if p_monto_promesa_centavos is not null or p_fecha_promesa is not null then
      raise exception 'cobranza_gestion_crear: monto y fecha de promesa solo aplican a promesa_pago' using errcode = '22023';
    end if;
    v_estado := case when p_fecha_seguimiento is not null then 'pendiente' else 'cumplida' end;
  end if;
  if p_fecha_seguimiento is not null and p_fecha_seguimiento > current_date + 365 then
    raise exception 'cobranza_gestion_crear: fecha de seguimiento demasiado lejana' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('despachos.cobranza_gestion:' || p_receivable_id::text, 0));
  if (select count(*) from despachos.cobranza_gestion g where g.receivable_id = p_receivable_id) >= 500 then
    raise exception 'cobranza_gestion_crear: maximo 500 gestiones por cuenta' using errcode = '54000';
  end if;
  insert into despachos.cobranza_gestion (organization_id, property_id, receivable_id, tipo, estado, monto_promesa_centavos, fecha_promesa, fecha_seguimiento, nota, creado_por)
  values (v_org, p_property_id, p_receivable_id, p_tipo, v_estado, p_monto_promesa_centavos, p_fecha_promesa, p_fecha_seguimiento, v_nota, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function despachos.cobranza_gestion_crear(uuid, uuid, text, text, bigint, date, date) from public;
grant execute on function despachos.cobranza_gestion_crear(uuid, uuid, text, text, bigint, date, date) to authenticated;

-- 2) Resolver una gestion pendiente (cumplida / incumplida / cancelada). No marca la cuenta como pagada:
-- el pago sigue pasando por `POST .../cobranza/cuentas/:id/pagar` (flujo existente).
create or replace function despachos.cobranza_gestion_resolver(p_property_id uuid, p_gestion_id uuid, p_estado text, p_nota text)
returns void
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_actual text;
  v_nota text;
begin
  perform despachos._cobranza_contexto(p_property_id, true);
  if p_estado is null or p_estado not in ('cumplida', 'incumplida', 'cancelada') then
    raise exception 'cobranza_gestion_resolver: estado no valido' using errcode = '22023';
  end if;
  v_nota := nullif(btrim(coalesce(p_nota, '')), '');
  if v_nota is not null and char_length(v_nota) > 1000 then
    raise exception 'cobranza_gestion_resolver: la nota admite hasta 1000 caracteres' using errcode = '22023';
  end if;
  select g.estado into v_actual from despachos.cobranza_gestion g where g.id = p_gestion_id and g.property_id = p_property_id for update;
  if not found then
    raise exception 'cobranza_gestion_resolver: gestion no encontrada' using errcode = 'P0002';
  end if;
  if v_actual <> 'pendiente' then
    raise exception 'cobranza_gestion_resolver: la gestion ya esta resuelta' using errcode = '55000';
  end if;
  update despachos.cobranza_gestion
     set estado = p_estado, nota = coalesce(v_nota, nota), actualizado_en = now()
   where id = p_gestion_id and property_id = p_property_id;
end;
$$;
revoke all on function despachos.cobranza_gestion_resolver(uuid, uuid, text, text) from public;
grant execute on function despachos.cobranza_gestion_resolver(uuid, uuid, text, text) to authenticated;

-- 3) Consentimiento de WhatsApp por cliente (RFC receptor de una factura de ESTA property).
create or replace function despachos.cobranza_whatsapp_consentimiento_fijar(
  p_property_id uuid, p_rfc_receptor text, p_telefono text, p_estado text, p_evidencia text
)
returns void
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_rfc text;
  v_evidencia text;
begin
  v_org := despachos._cobranza_contexto(p_property_id, true);
  v_rfc := upper(btrim(coalesce(p_rfc_receptor, '')));
  if v_rfc !~ '^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$' then
    raise exception 'cobranza_whatsapp_consentimiento_fijar: RFC no valido' using errcode = '22023';
  end if;
  if p_telefono is null or p_telefono !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'cobranza_whatsapp_consentimiento_fijar: telefono no valido (E.164)' using errcode = '22023';
  end if;
  if p_estado is null or p_estado not in ('opt_in', 'opt_out') then
    raise exception 'cobranza_whatsapp_consentimiento_fijar: estado no valido' using errcode = '22023';
  end if;
  v_evidencia := nullif(btrim(coalesce(p_evidencia, '')), '');
  if v_evidencia is not null and char_length(v_evidencia) > 300 then
    raise exception 'cobranza_whatsapp_consentimiento_fijar: evidencia de hasta 300 caracteres' using errcode = '22023';
  end if;
  if p_estado = 'opt_in' and v_evidencia is null then
    raise exception 'cobranza_whatsapp_consentimiento_fijar: el opt-in exige evidencia del consentimiento' using errcode = '22023';
  end if;
  if not exists (select 1 from despachos.invoice i where i.property_id = p_property_id and i.rfc_receptor = v_rfc) then
    raise exception 'cobranza_whatsapp_consentimiento_fijar: cliente no encontrado' using errcode = 'P0002';
  end if;
  insert into despachos.cobranza_whatsapp_consentimiento (organization_id, property_id, rfc_receptor, telefono, estado, evidencia, actualizado_por)
  values (v_org, p_property_id, v_rfc, p_telefono, p_estado, v_evidencia, auth.uid())
  on conflict (property_id, rfc_receptor) do update
    set telefono = excluded.telefono, estado = excluded.estado, evidencia = excluded.evidencia,
        actualizado_por = excluded.actualizado_por, actualizado_en = now();
  if p_estado = 'opt_out' then
    update despachos.cobranza_whatsapp_outbox o set estado = 'cancelado'
     where o.property_id = p_property_id and o.rfc_receptor = v_rfc and o.estado = 'pendiente';
  end if;
end;
$$;
revoke all on function despachos.cobranza_whatsapp_consentimiento_fijar(uuid, text, text, text, text) from public;
grant execute on function despachos.cobranza_whatsapp_consentimiento_fijar(uuid, text, text, text, text) to authenticated;

-- 4) Encolar (NO enviar) un recordatorio de WhatsApp para una cuenta. Idempotente por (property, dedupe_key).
create or replace function despachos.cobranza_whatsapp_encolar(p_property_id uuid, p_receivable_id uuid, p_cuerpo text, p_dedupe_key text)
returns table (out_id uuid, out_duplicado boolean)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_pagado timestamptz;
  v_rfc text;
  v_telefono text;
  v_cuerpo text;
  v_id uuid;
begin
  v_org := despachos._cobranza_contexto(p_property_id, true);
  select r.pagado_en, i.rfc_receptor into v_pagado, v_rfc
    from despachos.receivable r join despachos.invoice i on i.id = r.invoice_id and i.property_id = r.property_id
   where r.id = p_receivable_id and r.property_id = p_property_id;
  if not found then
    raise exception 'cobranza_whatsapp_encolar: cuenta no encontrada' using errcode = 'P0002';
  end if;
  if v_pagado is not null then
    raise exception 'cobranza_whatsapp_encolar: la cuenta ya esta pagada' using errcode = '22023';
  end if;
  v_cuerpo := btrim(coalesce(p_cuerpo, ''));
  if char_length(v_cuerpo) < 1 or char_length(v_cuerpo) > 1000 then
    raise exception 'cobranza_whatsapp_encolar: el mensaje debe tener entre 1 y 1000 caracteres' using errcode = '22023';
  end if;
  if p_dedupe_key is null or char_length(p_dedupe_key) < 1 or char_length(p_dedupe_key) > 200 then
    raise exception 'cobranza_whatsapp_encolar: dedupe_key invalida' using errcode = '22023';
  end if;
  select c.telefono into v_telefono from despachos.cobranza_whatsapp_consentimiento c
   where c.property_id = p_property_id and c.rfc_receptor = v_rfc and c.estado = 'opt_in';
  if v_telefono is null then
    raise exception 'cobranza_whatsapp_encolar: el cliente no tiene consentimiento opt-in' using errcode = 'CB001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('despachos.cobranza_whatsapp_outbox:' || p_property_id::text, 0));
  select o.id into v_id from despachos.cobranza_whatsapp_outbox o where o.property_id = p_property_id and o.dedupe_key = p_dedupe_key;
  if v_id is not null then
    return query select v_id, true;
    return;
  end if;
  if (select count(*) from despachos.cobranza_whatsapp_outbox o where o.property_id = p_property_id and o.estado = 'pendiente') >= 200 then
    raise exception 'cobranza_whatsapp_encolar: maximo 200 mensajes pendientes' using errcode = '54000';
  end if;
  insert into despachos.cobranza_whatsapp_outbox (organization_id, property_id, receivable_id, rfc_receptor, telefono, cuerpo, dedupe_key, creado_por)
  values (v_org, p_property_id, p_receivable_id, v_rfc, v_telefono, v_cuerpo, p_dedupe_key, auth.uid())
  returning id into v_id;
  return query select v_id, false;
end;
$$;
revoke all on function despachos.cobranza_whatsapp_encolar(uuid, uuid, text, text) from public;
grant execute on function despachos.cobranza_whatsapp_encolar(uuid, uuid, text, text) to authenticated;
