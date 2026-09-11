-- Núcleo de "movimiento financiero por reserva" (diseño Fase 1 §2.4, flujo 3,
-- RV12 §2.1/H-062/H-063/H-065). `rentas.reserva_financiero` es 1:1 con una fila de
-- `rentas.ocupacion` de capa='reserva' — la fuente de verdad de fechas/unidad/canal
-- sigue siendo `rentas.ocupacion` ("calculado desde reserva, nunca al revés").
-- Requiere: 001_rentas_schema.sql ya aplicada.
--
-- Todos los montos se guardan en CENTAVOS (bigint), nunca en `numeric` decimal ni en
-- tipos de punto flotante — el motor puro de @atiende/domain-rentas::finanzas ya
-- trabaja exclusivamente en centavos (redondeo determinista, sin float); esta
-- migración solo persiste el mismo tipo de dato.
--
-- Fuera de fase (diseño §6): owner statement / conciliación de payout por lote — solo
-- se porta el cálculo por-reserva (movimiento.ts), no la agregación periódica.

-- Configuración de comisión de canal por tenant/canal, opcionalmente acotada a una
-- property (`property_id IS NULL` = regla global del tenant) — NUNCA hardcodeada en
-- código. `ya_neto_de_comision=true` es el caso Airbnb confirmado (Finanzas-1);
-- Booking.com/Vrbo quedan en false con porcentaje editable hasta tener fuente
-- oficial.
create table rentas.regla_comision_canal (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid references core.property(id) on delete cascade,
  canal_id uuid not null references rentas.canal(id),
  ya_neto_de_comision boolean not null default false,
  comision_basis_points integer not null default 0 check (comision_basis_points between 0 and 10000),
  fuente text not null,
  vigente_desde date not null default current_date,
  creado_en timestamptz not null default now(),
  unique (organization_id, canal_id, property_id, vigente_desde)
);
create index regla_comision_canal_org_idx on rentas.regla_comision_canal (organization_id, canal_id);

create table rentas.reserva_financiero (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  ocupacion_id uuid not null unique references rentas.ocupacion(id) on delete cascade,
  moneda char(3) not null check (moneda ~ '^[A-Z]{3}$'),
  monto_bruto_centavos bigint not null check (monto_bruto_centavos >= 0),
  ya_neto_de_comision boolean not null default false,
  comision_canal_basis_points integer not null default 0,
  comision_canal_fuente text not null default '',
  comision_canal_centavos bigint not null default 0 check (comision_canal_centavos >= 0),
  comision_gestor_basis_points integer not null default 0,
  comision_gestor_base text not null default 'neto_de_canal' check (comision_gestor_base in ('bruto', 'neto_de_canal')),
  comision_gestor_centavos bigint not null default 0 check (comision_gestor_centavos >= 0),
  monto_recibido_centavos bigint not null default 0,
  gastos_centavos bigint not null default 0 check (gastos_centavos >= 0),
  impuestos_centavos bigint not null default 0 check (impuestos_centavos >= 0),
  neto_centavos bigint not null default 0,
  created_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index reserva_financiero_property_idx on rentas.reserva_financiero (property_id);

create table rentas.linea_gasto (
  id uuid primary key default gen_random_uuid(),
  reserva_financiero_id uuid not null references rentas.reserva_financiero(id) on delete cascade,
  tipo text not null,
  descripcion text,
  monto_centavos bigint not null check (monto_centavos >= 0),
  creado_por uuid references core.staff_user(id) on delete set null,
  creado_en timestamptz not null default now()
);
create index linea_gasto_reserva_financiero_idx on rentas.linea_gasto (reserva_financiero_id);

-- SIEMPRE marcada para revisión legal/fiscal — el CHECK hace explícito en el propio
-- esquema que esta tabla nunca presenta una cifra fiscal como definitiva.
create table rentas.linea_impuesto (
  id uuid primary key default gen_random_uuid(),
  reserva_financiero_id uuid not null references rentas.reserva_financiero(id) on delete cascade,
  tipo text not null,
  monto_centavos bigint not null check (monto_centavos >= 0),
  revision_fiscal boolean not null default true check (revision_fiscal = true),
  nota text not null default 'Revisión legal/fiscal pendiente — cifra no verificada con fuente oficial del SAT',
  creado_por uuid references core.staff_user(id) on delete set null,
  creado_en timestamptz not null default now()
);
create index linea_impuesto_reserva_financiero_idx on rentas.linea_impuesto (reserva_financiero_id);

-- RLS: escritura solo `admin_gestora`, lectura `admin_gestora`+`contador` — mismo
-- criterio que `hoteles.can_access_money()`, acotado a estos dos vertical_role finos
-- (ver diseño §2.2, FINANZAS_ESCRITURA_ROLES/FINANZAS_LECTURA_ROLES).
create or replace function rentas.can_read_finanzas(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, rentas as $$
  select exists (
    select 1 from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = auth.uid() and p.id = _property_id
      and (m.property_ids is null or _property_id = any(m.property_ids))
      and m.vertical_role in ('admin_gestora', 'contador')
  )
$$;

create or replace function rentas.can_write_finanzas(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, rentas as $$
  select exists (
    select 1 from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = auth.uid() and p.id = _property_id
      and (m.property_ids is null or _property_id = any(m.property_ids))
      and m.vertical_role = 'admin_gestora'
  )
$$;

alter table rentas.regla_comision_canal enable row level security;
alter table rentas.reserva_financiero enable row level security;
alter table rentas.linea_gasto enable row level security;
alter table rentas.linea_impuesto enable row level security;

create policy "finanzas: lectura de regla_comision_canal" on rentas.regla_comision_canal for select
  using (exists (select 1 from core.membership m where m.organization_id = regla_comision_canal.organization_id and m.user_id = auth.uid() and m.vertical_role in ('admin_gestora','contador')));

create policy "finanzas: lectura de reserva_financiero" on rentas.reserva_financiero for select using (rentas.can_read_finanzas(property_id));
create policy "finanzas: escritura de reserva_financiero" on rentas.reserva_financiero for insert with check (rentas.can_write_finanzas(property_id));
create policy "finanzas: actualización de reserva_financiero" on rentas.reserva_financiero for update
  using (rentas.can_write_finanzas(property_id)) with check (rentas.can_write_finanzas(property_id));

create policy "finanzas: lectura de linea_gasto" on rentas.linea_gasto for select
  using (exists (select 1 from rentas.reserva_financiero rf where rf.id = linea_gasto.reserva_financiero_id and rentas.can_read_finanzas(rf.property_id)));
create policy "finanzas: escritura de linea_gasto" on rentas.linea_gasto for insert
  with check (exists (select 1 from rentas.reserva_financiero rf where rf.id = linea_gasto.reserva_financiero_id and rentas.can_write_finanzas(rf.property_id)));

create policy "finanzas: lectura de linea_impuesto" on rentas.linea_impuesto for select
  using (exists (select 1 from rentas.reserva_financiero rf where rf.id = linea_impuesto.reserva_financiero_id and rentas.can_read_finanzas(rf.property_id)));
create policy "finanzas: escritura de linea_impuesto" on rentas.linea_impuesto for insert
  with check (exists (select 1 from rentas.reserva_financiero rf where rf.id = linea_impuesto.reserva_financiero_id and rentas.can_write_finanzas(rf.property_id)));

revoke all on rentas.regla_comision_canal, rentas.reserva_financiero, rentas.linea_gasto, rentas.linea_impuesto from public, anon;
grant select on rentas.regla_comision_canal to authenticated;
grant select, insert, update on rentas.reserva_financiero to authenticated;
grant select, insert on rentas.linea_gasto, rentas.linea_impuesto to authenticated;
grant select, insert, update, delete on rentas.regla_comision_canal, rentas.reserva_financiero, rentas.linea_gasto, rentas.linea_impuesto to service_role;
