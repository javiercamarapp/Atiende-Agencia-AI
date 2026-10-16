-- D-32 -- Facturacion de honorarios del despacho a sus clientes: igualas (contrato recurrente) y prefacturas mensuales
-- con maquina de estados y reserva anti doble timbrado.
--
-- Modelo (todo en CENTAVOS ENTEROS, bigint; esta migracion NO llama a ningun PAC ni al SAT: el timbrado lo hace la capa
-- TypeScript con un PacClient inyectado, y solo si hay credencial configurada, ver D-20):
--   * `despachos.iguala`    -- contrato de honorarios por cliente (property): concepto, clave SAT de producto/servicio y unidad
--                              (nacen 'por_verificar': la clave concreta es lista del fiscalista, D-34), monto base, tasa de IVA, retencion
--                              de ISR y retencion de IVA (dos terceras partes), periodicidad mensual, dia de emision, uso de CFDI y activa.
--                              El receptor (RFC, regimen, CP) NO se guarda aqui: sale de la ficha del cliente (migracion 018) al generar.
--   * `despachos.prefactura`-- una por (iguala, periodo AAAA-MM), con foto del concepto y del receptor al generarla, desglose
--                              base / IVA / retenciones / total, y el ciclo borrador -> aprobada -> timbrando -> timbrada | fallida,
--                              cancelada desde borrador, aprobada, fallida o timbrada. UNIQUE (iguala_id, periodo): generar dos veces no duplica.
--
-- Seguridad (cada punto lo ejerce scripts/verify-despachos-facturacion-honorarios/assertions.sql):
--   1. Las 2 tablas: RLS habilitado, REVOKE de todo a public/anon/authenticated y SOLO `select` a `authenticated` con la policy
--      `core.has_property_access(auth.uid(), property_id)` -- justificacion: el staff lee igualas y prefacturas de SUS clientes y nada mas.
--      NO hay INSERT/UPDATE/DELETE directos (por eso no hay GRANT por columna: no se concede ninguna escritura): toda escritura pasa por las
--      funciones de abajo. Sin `using (true)` y sin GRANT a anon. `service_role` conserva acceso total (soporte).
--      La llave foranea COMPUESTA (iguala_id, organization_id, property_id) impide ligar una prefactura a la iguala de OTRO cliente u
--      otra organizacion aunque se mienta en las columnas de tenant (cross-tenant).
--   2. Las funciones de escritura son `security definer` con `set search_path = despachos, pg_temp`, `revoke all ... from public, anon` y
--      EXECUTE solo a `authenticated`. TODAS exigen `auth.uid()` no nulo y `despachos.honorarios_puede_escribir(property)`: acceso a la
--      property y rol `admin` en la organizacion de despachos de ESA property (42501 si no). Facturar a clientes y timbrar es de alto
--      impacto (un CFDI timbrado solo se deshace cancelandolo ante el SAT): el contador y los roles de lectura solo ven.
--   3. El desglose lo recalcula la base con aritmetica entera (misma regla que el dominio TypeScript: IVA = base * tasa, retencion de ISR =
--      base * tasa, retencion de IVA = 2/3 del IVA; todo redondeado a centavo, mitad hacia arriba) y rechaza (22023) una prefactura cuyo
--      importe no coincida: ni un cliente malicioso del RPC ni un bug de TypeScript pueden guardar un desglose que no cuadre. La base
--      del importe es el monto de la iguala, no un dato libre.
--   4. Anti doble timbrado: `prefactura_reservar_timbrado` es un compare-and-set (UPDATE condicional bajo el bloqueo de fila) que pasa
--      de aprobada/fallida a 'timbrando' ANTES de que el TypeScript llame al PAC; dos llamadas concurrentes: solo una gana (la otra recibe
--      false). Una reserva vieja (> p_expira_segundos, minimo 300) puede reclamarse: el llamador manda la prefactura como `referencia` al PAC.
--   5. Cancelacion con guardas: motivo SAT 01-04 obligatorio; el 01 exige el folio fiscal de sustitucion (distinto del propio) y los demas
--      motivos no lo admiten; una prefactura 'timbrando' o ya cancelada no se cancela (55000); una timbrada solo se cancela con acuse
--      del PAC (p_acuse_pac = true) para que la base nunca diga "cancelada" mientras el CFDI sigue vivo ante el SAT sin que alguien lo
--      haya confirmado. UUID fiscal unico por organizacion (indice parcial): el mismo CFDI no se liga a dos prefacturas.
--   6. Ninguna funcion llama a la red ni guarda secretos. Los textos de error que guardan las funciones son cortos (<= 200) y los
--      escribe el TypeScript a partir de un catalogo de motivos, no del mensaje crudo del PAC.
--
-- Hueco declarado: la cuenta por cobrar de cobranza (`despachos.receivable`) exige una factura CFDI ya ingerida (`invoice_id`); una prefactura
-- aprobada todavia no la tiene, asi que no se crea cuenta por cobrar al aprobar. Se liga cuando el CFDI timbrado se ingiere (trabajo aparte).
--
-- Compatibilidad con la base sin migrar: el TypeScript que consume esto captura 42883/42P01/42703 dentro de SAVEPOINT
-- (runWithSavepointFallback) y responde "no disponible aun" (lista vacia + estado); nunca un 500. Se puede aplicar antes o despues del codigo.

create table despachos.iguala (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  concepto text not null check (char_length(btrim(concepto)) between 3 and 200),
  clave_prod_serv text not null default '84111500' check (clave_prod_serv ~ '^[0-9]{8}$'),
  clave_unidad text not null default 'E48' check (clave_unidad ~ '^[A-Z0-9]{2,3}$'),
  clave_sat_estado text not null default 'por_verificar' check (clave_sat_estado in ('por_verificar', 'verificada')),
  monto_base_centavos bigint not null check (monto_base_centavos > 0 and monto_base_centavos <= 100000000000),
  tasa_iva_bp integer not null default 1600 check (tasa_iva_bp in (0, 800, 1600)),
  retencion_isr_bp integer not null default 0 check (retencion_isr_bp between 0 and 3500),
  retiene_iva_dos_tercios boolean not null default false,
  periodicidad text not null default 'mensual' check (periodicidad = 'mensual'),
  dia_emision integer not null default 1 check (dia_emision between 1 and 28),
  uso_cfdi text not null default 'G03' check (uso_cfdi ~ '^[A-Z][0-9]{2}$'),
  activa boolean not null default true,
  creado_por uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id, property_id)
);
create index iguala_property_idx on despachos.iguala (property_id, activa);
create index iguala_org_idx on despachos.iguala (organization_id);

create table despachos.prefactura (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  iguala_id uuid not null,
  periodo text not null check (periodo ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  estado text not null default 'borrador' check (estado in ('borrador', 'aprobada', 'timbrando', 'timbrada', 'cancelada', 'fallida')),
  concepto text not null,
  clave_prod_serv text not null check (clave_prod_serv ~ '^[0-9]{8}$'),
  clave_unidad text not null check (clave_unidad ~ '^[A-Z0-9]{2,3}$'),
  receptor_rfc text not null,
  receptor_razon_social text not null,
  receptor_regimen text not null check (receptor_regimen ~ '^[0-9]{3}$'),
  receptor_cp text not null check (receptor_cp ~ '^[0-9]{5}$'),
  uso_cfdi text not null check (uso_cfdi ~ '^[A-Z][0-9]{2}$'),
  fecha_emision date not null,
  base_centavos bigint not null check (base_centavos > 0),
  iva_centavos bigint not null check (iva_centavos >= 0),
  retencion_isr_centavos bigint not null default 0 check (retencion_isr_centavos >= 0),
  retencion_iva_centavos bigint not null default 0 check (retencion_iva_centavos >= 0),
  total_centavos bigint not null check (total_centavos > 0),
  check (total_centavos = base_centavos + iva_centavos - retencion_isr_centavos - retencion_iva_centavos),
  aprobada_en timestamptz,
  aprobada_por uuid references core.staff_user(id) on delete set null,
  timbrando_en timestamptz,
  timbrada_en timestamptz,
  uuid_cfdi text check (uuid_cfdi is null or uuid_cfdi ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  pac_id text check (pac_id is null or char_length(pac_id) between 1 and 120),
  url_pdf text check (url_pdf is null or char_length(url_pdf) <= 600),
  url_xml text check (url_xml is null or char_length(url_xml) <= 600),
  error_timbrado text check (error_timbrado is null or char_length(error_timbrado) <= 200),
  cancelada_en timestamptz,
  motivo_cancelacion text check (motivo_cancelacion is null or motivo_cancelacion in ('01', '02', '03', '04')),
  folio_sustitucion text check (folio_sustitucion is null or folio_sustitucion ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  creado_por uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (iguala_id, periodo),
  foreign key (iguala_id, organization_id, property_id) references despachos.iguala (id, organization_id, property_id) on delete cascade,
  check ((estado = 'timbrando') = (timbrando_en is not null)),
  check (estado <> 'timbrada' or (uuid_cfdi is not null and timbrada_en is not null)),
  check ((estado = 'cancelada') = (motivo_cancelacion is not null and cancelada_en is not null)),
  check (folio_sustitucion is null or motivo_cancelacion = '01')
);
create unique index prefactura_uuid_cfdi_uniq on despachos.prefactura (organization_id, lower(uuid_cfdi)) where uuid_cfdi is not null;
create index prefactura_property_periodo_idx on despachos.prefactura (property_id, periodo);
create index prefactura_org_estado_idx on despachos.prefactura (organization_id, estado);

alter table despachos.iguala enable row level security;
alter table despachos.prefactura enable row level security;
revoke all on despachos.iguala, despachos.prefactura from public, anon, authenticated;
create policy "staff ve las igualas de sus clientes" on despachos.iguala for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff ve las prefacturas de sus clientes" on despachos.prefactura for select
  using (core.has_property_access(auth.uid(), property_id));
grant select on despachos.iguala, despachos.prefactura to authenticated;
grant select, insert, update, delete on despachos.iguala, despachos.prefactura to service_role;

-- Solo `admin` de la organizacion de despachos de la property, con acceso a ella. No se expone al cliente (revoke de public).
create or replace function despachos.honorarios_puede_escribir(p_property_id uuid)
returns boolean
language sql
stable
security definer
set search_path = despachos, pg_temp
as $$
  select auth.uid() is not null
    and core.has_property_access(auth.uid(), p_property_id)
    and exists (
      select 1
      from core.property p
      join core.organization o on o.id = p.organization_id
      join core.membership m on m.organization_id = p.organization_id and m.user_id = auth.uid()
      where p.id = p_property_id
        and o.vertical = 'despachos'
        and m.vertical_role = 'admin'
    );
$$;
revoke all on function despachos.honorarios_puede_escribir(uuid) from public;

-- Aritmetica entera compartida (mitad hacia arriba): importe = round(base * bp / 10000).
create or replace function despachos.honorarios_porcentaje(p_base bigint, p_bp integer)
returns bigint
language sql
immutable
set search_path = pg_temp
as $$ select ((p_base * p_bp::bigint) + 5000) / 10000 $$;
revoke all on function despachos.honorarios_porcentaje(bigint, integer) from public;

-- ---------------------------------------------------------------------------
-- Igualas.
-- ---------------------------------------------------------------------------
create or replace function despachos.iguala_guardar(
  p_property_id uuid,
  p_id uuid,
  p_concepto text,
  p_clave_prod_serv text,
  p_clave_unidad text,
  p_monto_base_centavos bigint,
  p_tasa_iva_bp integer,
  p_retencion_isr_bp integer,
  p_retiene_iva_dos_tercios boolean,
  p_dia_emision integer,
  p_uso_cfdi text,
  p_activa boolean
)
returns uuid
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_id uuid;
begin
  if auth.uid() is null or not despachos.honorarios_puede_escribir(p_property_id) then
    raise exception 'iguala_guardar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id and p.vertical = 'despachos';
  if v_org is null then
    raise exception 'iguala_guardar: la property no es de despachos' using errcode = '42501';
  end if;
  if p_concepto is null or char_length(btrim(p_concepto)) not between 3 and 200
     or p_clave_prod_serv is null or p_clave_prod_serv !~ '^[0-9]{8}$'
     or p_clave_unidad is null or p_clave_unidad !~ '^[A-Z0-9]{2,3}$'
     or p_monto_base_centavos is null or p_monto_base_centavos <= 0 or p_monto_base_centavos > 100000000000
     or p_tasa_iva_bp is null or p_tasa_iva_bp not in (0, 800, 1600)
     or p_retencion_isr_bp is null or p_retencion_isr_bp not between 0 and 3500
     or p_retiene_iva_dos_tercios is null
     or p_dia_emision is null or p_dia_emision not between 1 and 28
     or p_uso_cfdi is null or p_uso_cfdi !~ '^[A-Z][0-9]{2}$'
     or p_activa is null then
    raise exception 'iguala_guardar: datos de la iguala invalidos' using errcode = '22023';
  end if;
  if p_id is null then
    if (select count(*) from despachos.iguala i where i.property_id = p_property_id) >= 50 then
      raise exception 'iguala_guardar: tope de 50 igualas por cliente' using errcode = '23514';
    end if;
    insert into despachos.iguala (organization_id, property_id, concepto, clave_prod_serv, clave_unidad, monto_base_centavos, tasa_iva_bp,
                                  retencion_isr_bp, retiene_iva_dos_tercios, dia_emision, uso_cfdi, activa, creado_por)
    values (v_org, p_property_id, btrim(p_concepto), p_clave_prod_serv, p_clave_unidad, p_monto_base_centavos, p_tasa_iva_bp,
            p_retencion_isr_bp, p_retiene_iva_dos_tercios, p_dia_emision, p_uso_cfdi, p_activa, auth.uid())
    returning id into v_id;
    return v_id;
  end if;
  update despachos.iguala
    set concepto = btrim(p_concepto), clave_prod_serv = p_clave_prod_serv, clave_unidad = p_clave_unidad, monto_base_centavos = p_monto_base_centavos,
        tasa_iva_bp = p_tasa_iva_bp, retencion_isr_bp = p_retencion_isr_bp, retiene_iva_dos_tercios = p_retiene_iva_dos_tercios,
        dia_emision = p_dia_emision, uso_cfdi = p_uso_cfdi, activa = p_activa, updated_at = now()
    where id = p_id and property_id = p_property_id
    returning id into v_id;
  if v_id is null then
    raise exception 'iguala_guardar: la iguala no existe en ese cliente' using errcode = 'P0002';
  end if;
  return v_id;
end;
$$;
revoke all on function despachos.iguala_guardar(uuid, uuid, text, text, text, bigint, integer, integer, boolean, integer, text, boolean) from public, anon;
grant execute on function despachos.iguala_guardar(uuid, uuid, text, text, text, bigint, integer, integer, boolean, integer, text, boolean) to authenticated;

create or replace function despachos.iguala_eliminar(p_property_id uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
begin
  if auth.uid() is null or not despachos.honorarios_puede_escribir(p_property_id) then
    raise exception 'iguala_eliminar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  perform 1 from despachos.iguala where id = p_id and property_id = p_property_id for update;
  if not found then
    raise exception 'iguala_eliminar: la iguala no existe en ese cliente' using errcode = 'P0002';
  end if;
  if exists (select 1 from despachos.prefactura pf where pf.iguala_id = p_id) then
    raise exception 'iguala_eliminar: la iguala ya tiene prefacturas; desactivala en vez de borrarla' using errcode = '55000';
  end if;
  delete from despachos.iguala where id = p_id and property_id = p_property_id;
end;
$$;
revoke all on function despachos.iguala_eliminar(uuid, uuid) from public, anon;
grant execute on function despachos.iguala_eliminar(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Prefacturas.
-- ---------------------------------------------------------------------------
-- Genera la prefactura (borrador) de UN periodo de una iguala activa. Idempotente: si ya existe (iguala, periodo) devuelve null y no toca nada.
create or replace function despachos.prefactura_generar(
  p_property_id uuid,
  p_iguala_id uuid,
  p_periodo text,
  p_base_centavos bigint,
  p_iva_centavos bigint,
  p_retencion_isr_centavos bigint,
  p_retencion_iva_centavos bigint,
  p_total_centavos bigint
)
returns uuid
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_ig despachos.iguala%rowtype;
  v_ficha despachos.cliente_ficha%rowtype;
  v_iva bigint;
  v_isr bigint;
  v_riva bigint;
  v_id uuid;
begin
  if auth.uid() is null or not despachos.honorarios_puede_escribir(p_property_id) then
    raise exception 'prefactura_generar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  if p_periodo is null or p_periodo !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'prefactura_generar: periodo invalido (AAAA-MM)' using errcode = '22023';
  end if;
  select * into v_ig from despachos.iguala where id = p_iguala_id and property_id = p_property_id for share;
  if not found then
    raise exception 'prefactura_generar: la iguala no existe en ese cliente' using errcode = 'P0002';
  end if;
  if not v_ig.activa then
    raise exception 'prefactura_generar: la iguala esta inactiva' using errcode = '55000';
  end if;
  select * into v_ficha from despachos.cliente_ficha where property_id = p_property_id;
  if not found then
    raise exception 'prefactura_generar: el cliente no tiene ficha fiscal (RFC, regimen, CP)' using errcode = '22023';
  end if;
  v_iva := despachos.honorarios_porcentaje(v_ig.monto_base_centavos, v_ig.tasa_iva_bp);
  v_isr := despachos.honorarios_porcentaje(v_ig.monto_base_centavos, v_ig.retencion_isr_bp);
  v_riva := case when v_ig.retiene_iva_dos_tercios then ((v_iva * 4) + 3) / 6 else 0 end;
  if p_base_centavos is distinct from v_ig.monto_base_centavos or p_iva_centavos is distinct from v_iva
     or p_retencion_isr_centavos is distinct from v_isr or p_retencion_iva_centavos is distinct from v_riva
     or p_total_centavos is distinct from (v_ig.monto_base_centavos + v_iva - v_isr - v_riva) then
    raise exception 'prefactura_generar: el desglose no coincide con la iguala' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('despachos.prefactura:' || p_iguala_id::text || ':' || p_periodo, 0));
  insert into despachos.prefactura (organization_id, property_id, iguala_id, periodo, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social,
                                    receptor_regimen, receptor_cp, uso_cfdi, fecha_emision, base_centavos, iva_centavos, retencion_isr_centavos,
                                    retencion_iva_centavos, total_centavos, creado_por)
  values (v_ig.organization_id, p_property_id, p_iguala_id, p_periodo, v_ig.concepto, v_ig.clave_prod_serv, v_ig.clave_unidad, v_ficha.rfc, v_ficha.razon_social,
          v_ficha.regimenes_fiscales[1], v_ficha.cp_fiscal, v_ig.uso_cfdi,
          make_date(substr(p_periodo, 1, 4)::int, substr(p_periodo, 6, 2)::int, v_ig.dia_emision),
          v_ig.monto_base_centavos, v_iva, v_isr, v_riva, v_ig.monto_base_centavos + v_iva - v_isr - v_riva, auth.uid())
  on conflict (iguala_id, periodo) do nothing
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function despachos.prefactura_generar(uuid, uuid, text, bigint, bigint, bigint, bigint, bigint) from public, anon;
grant execute on function despachos.prefactura_generar(uuid, uuid, text, bigint, bigint, bigint, bigint, bigint) to authenticated;

create or replace function despachos.prefactura_aprobar(p_property_id uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_estado text;
begin
  if auth.uid() is null or not despachos.honorarios_puede_escribir(p_property_id) then
    raise exception 'prefactura_aprobar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  select estado into v_estado from despachos.prefactura where id = p_id and property_id = p_property_id for update;
  if v_estado is null then
    raise exception 'prefactura_aprobar: la prefactura no existe en ese cliente' using errcode = 'P0002';
  end if;
  if v_estado <> 'borrador' then
    raise exception 'prefactura_aprobar: solo se aprueba una prefactura en borrador (estado actual: %)', v_estado using errcode = '55000';
  end if;
  update despachos.prefactura set estado = 'aprobada', aprobada_en = now(), aprobada_por = auth.uid(), updated_at = now() where id = p_id;
end;
$$;
revoke all on function despachos.prefactura_aprobar(uuid, uuid) from public, anon;
grant execute on function despachos.prefactura_aprobar(uuid, uuid) to authenticated;

-- Compare-and-set ANTES de llamar al PAC. true = esta llamada gano la reserva; false = otra la tiene o el estado no lo permite.
create or replace function despachos.prefactura_reservar_timbrado(p_property_id uuid, p_id uuid, p_expira_segundos integer)
returns boolean
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
begin
  if auth.uid() is null or not despachos.honorarios_puede_escribir(p_property_id) then
    raise exception 'prefactura_reservar_timbrado: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  if p_expira_segundos is null or p_expira_segundos < 300 then
    raise exception 'prefactura_reservar_timbrado: la reserva expira en 300 segundos o mas' using errcode = '22023';
  end if;
  update despachos.prefactura
    set estado = 'timbrando', timbrando_en = now(), error_timbrado = null, updated_at = now()
    where id = p_id and property_id = p_property_id
      and (estado in ('aprobada', 'fallida') or (estado = 'timbrando' and timbrando_en < now() - make_interval(secs => p_expira_segundos)));
  return found;
end;
$$;
revoke all on function despachos.prefactura_reservar_timbrado(uuid, uuid, integer) from public, anon;
grant execute on function despachos.prefactura_reservar_timbrado(uuid, uuid, integer) to authenticated;

create or replace function despachos.prefactura_registrar_timbre(p_property_id uuid, p_id uuid, p_uuid text, p_pac_id text, p_url_pdf text, p_url_xml text)
returns void
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_estado text;
begin
  if auth.uid() is null or not despachos.honorarios_puede_escribir(p_property_id) then
    raise exception 'prefactura_registrar_timbre: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  if p_uuid is null or p_uuid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or p_pac_id is null or char_length(p_pac_id) not between 1 and 120 then
    raise exception 'prefactura_registrar_timbre: UUID fiscal o id del PAC invalidos' using errcode = '22023';
  end if;
  select estado into v_estado from despachos.prefactura where id = p_id and property_id = p_property_id for update;
  if v_estado is null then
    raise exception 'prefactura_registrar_timbre: la prefactura no existe en ese cliente' using errcode = 'P0002';
  end if;
  if v_estado <> 'timbrando' then
    raise exception 'prefactura_registrar_timbre: la prefactura no tiene una reserva de timbrado vigente (estado: %)', v_estado using errcode = '55000';
  end if;
  update despachos.prefactura
    set estado = 'timbrada', timbrando_en = null, timbrada_en = now(), uuid_cfdi = lower(p_uuid), pac_id = p_pac_id,
        url_pdf = left(p_url_pdf, 600), url_xml = left(p_url_xml, 600), error_timbrado = null, updated_at = now()
    where id = p_id;
end;
$$;
revoke all on function despachos.prefactura_registrar_timbre(uuid, uuid, text, text, text, text) from public, anon;
grant execute on function despachos.prefactura_registrar_timbre(uuid, uuid, text, text, text, text) to authenticated;

create or replace function despachos.prefactura_registrar_fallo(p_property_id uuid, p_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_estado text;
begin
  if auth.uid() is null or not despachos.honorarios_puede_escribir(p_property_id) then
    raise exception 'prefactura_registrar_fallo: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  select estado into v_estado from despachos.prefactura where id = p_id and property_id = p_property_id for update;
  if v_estado is null then
    raise exception 'prefactura_registrar_fallo: la prefactura no existe en ese cliente' using errcode = 'P0002';
  end if;
  if v_estado <> 'timbrando' then
    raise exception 'prefactura_registrar_fallo: la prefactura no tiene una reserva de timbrado vigente (estado: %)', v_estado using errcode = '55000';
  end if;
  update despachos.prefactura
    set estado = 'fallida', timbrando_en = null, error_timbrado = left(coalesce(nullif(btrim(p_error), ''), 'fallo_desconocido'), 200), updated_at = now()
    where id = p_id;
end;
$$;
revoke all on function despachos.prefactura_registrar_fallo(uuid, uuid, text) from public, anon;
grant execute on function despachos.prefactura_registrar_fallo(uuid, uuid, text) to authenticated;

create or replace function despachos.prefactura_cancelar(p_property_id uuid, p_id uuid, p_motivo text, p_folio_sustitucion text, p_acuse_pac boolean)
returns void
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_estado text;
  v_uuid text;
begin
  if auth.uid() is null or not despachos.honorarios_puede_escribir(p_property_id) then
    raise exception 'prefactura_cancelar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  if p_motivo is null or p_motivo not in ('01', '02', '03', '04') then
    raise exception 'prefactura_cancelar: motivo de cancelacion invalido (01 a 04)' using errcode = '22023';
  end if;
  if p_motivo = '01' and (p_folio_sustitucion is null or p_folio_sustitucion !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception 'prefactura_cancelar: el motivo 01 exige el folio fiscal (UUID) del CFDI que lo sustituye' using errcode = '22023';
  end if;
  if p_motivo <> '01' and p_folio_sustitucion is not null then
    raise exception 'prefactura_cancelar: solo el motivo 01 lleva folio de sustitucion' using errcode = '22023';
  end if;
  select estado, uuid_cfdi into v_estado, v_uuid from despachos.prefactura where id = p_id and property_id = p_property_id for update;
  if v_estado is null then
    raise exception 'prefactura_cancelar: la prefactura no existe en ese cliente' using errcode = 'P0002';
  end if;
  if v_estado = 'cancelada' then
    raise exception 'prefactura_cancelar: la prefactura ya esta cancelada' using errcode = '55000';
  end if;
  if v_estado = 'timbrando' then
    raise exception 'prefactura_cancelar: hay un timbrado en curso; espera a que termine' using errcode = '55000';
  end if;
  if v_estado = 'timbrada' and coalesce(p_acuse_pac, false) is not true then
    raise exception 'prefactura_cancelar: una prefactura timbrada solo se cancela con acuse del PAC' using errcode = '55000';
  end if;
  if p_motivo = '01' and lower(p_folio_sustitucion) = lower(coalesce(v_uuid, '')) then
    raise exception 'prefactura_cancelar: el folio de sustitucion no puede ser el del propio CFDI' using errcode = '22023';
  end if;
  update despachos.prefactura
    set estado = 'cancelada', cancelada_en = now(), motivo_cancelacion = p_motivo, folio_sustitucion = lower(p_folio_sustitucion), updated_at = now()
    where id = p_id;
end;
$$;
revoke all on function despachos.prefactura_cancelar(uuid, uuid, text, text, boolean) from public, anon;
grant execute on function despachos.prefactura_cancelar(uuid, uuid, text, text, boolean) to authenticated;
