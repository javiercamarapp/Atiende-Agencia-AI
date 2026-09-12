-- Fase 2, Flujo 5 (owner statement) y Flujo 6 (payout + conciliación, alcance
-- recortado -- ver diseño Fase 2 rentas §1.4/§2.2/§5). Port de las tablas del repo
-- origen (`owner_statement`/`owner_statement_linea`/`payout_canal`/`payout_linea`) al
-- modelo de tenancy `core.organization`/`core.property` de esta migración. Requiere:
-- 001/002/003 ya aplicadas.
--
-- Decisión de alcance explícita (§4.1): el statement se genera POR PROPERTY, no
-- consolidado por owner a través de toda la organización -- `requirePropertyMembership`
-- es la única primitiva de autorización disponible hoy, no existe
-- `requireOrganizationMembership`. Ver diseño §8-#1 para la mejora futura anotada.

create table rentas.owner_statement (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  owner_id uuid not null references rentas.owner(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  periodo_inicio date not null,
  periodo_fin date not null,
  version integer not null default 1 check (version >= 1),
  moneda char(3) not null check (moneda ~ '^[A-Z]{3}$'),
  ingresos_brutos_centavos bigint not null,
  comision_canal_centavos bigint not null,
  comision_gestor_centavos bigint not null,
  gastos_centavos bigint not null,
  impuestos_centavos bigint not null,
  neto_centavos bigint not null,
  hash_contenido text not null,
  motivo_version text,
  generado_por uuid references core.staff_user(id) on delete set null,
  generado_en timestamptz not null default now(),
  constraint owner_statement_periodo_valido check (periodo_inicio < periodo_fin),
  -- Única protección DURA contra duplicados -- ver diseño §1.3/§4.2: el advisory lock
  -- (`bloquearOwnerStatementEnTransaccion`) evita que la app dependa de este UNIQUE
  -- para decidir la respuesta HTTP, pero el UNIQUE sigue siendo la última línea de
  -- defensa real a nivel de base de datos.
  unique (owner_id, property_id, periodo_inicio, periodo_fin, version)
);
create index owner_statement_owner_periodo_idx on rentas.owner_statement (owner_id, property_id, periodo_inicio, periodo_fin);

create table rentas.owner_statement_linea (
  id uuid primary key default gen_random_uuid(),
  statement_id uuid not null references rentas.owner_statement(id) on delete cascade,
  ocupacion_id uuid references rentas.ocupacion(id) on delete set null,
  tipo text not null check (tipo in ('ingreso','comision_canal','comision_gestor','gasto','impuesto')),
  descripcion text not null,
  monto_centavos bigint not null,
  moneda char(3) not null check (moneda ~ '^[A-Z]{3}$'),
  creado_en timestamptz not null default now()
);
create index owner_statement_linea_statement_idx on rentas.owner_statement_linea (statement_id);

create table rentas.payout_canal (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  canal_id uuid not null references rentas.canal(id),
  referencia_externa text,
  moneda char(3) not null check (moneda ~ '^[A-Z]{3}$'),
  monto_total_centavos bigint not null,
  fecha_payout date not null,
  -- Fase 2: SOLO manual -- el parseo de CSV/XLS real por canal (Vrbo/Airbnb/Booking)
  -- se recorta de esta fase (ver diseño §1.4/§5); el CHECK lo hace explícito en el
  -- propio esquema en vez de dejarlo como un valor de aplicación que se puede olvidar.
  origen_importacion text not null default 'manual' check (origen_importacion = 'manual'),
  creado_por uuid references core.staff_user(id) on delete set null,
  creado_en timestamptz not null default now()
);
create index payout_canal_property_idx on rentas.payout_canal (property_id);

create table rentas.payout_linea (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null references rentas.payout_canal(id) on delete cascade,
  ocupacion_id uuid references rentas.ocupacion(id) on delete set null,
  referencia_externa_reserva text,
  monto_centavos bigint not null,
  monto_esperado_centavos bigint,
  estado_conciliacion text not null default 'pendiente' check (estado_conciliacion in ('conciliado','pendiente','discrepancia')),
  nota text,
  creado_en timestamptz not null default now()
);
create index payout_linea_payout_idx on rentas.payout_linea (payout_id);

-- RLS: mismo criterio que 003_finanzas_schema.sql -- escritura admin_gestora, lectura
-- admin_gestora+contador, vía `rentas.can_read_finanzas`/`rentas.can_write_finanzas`
-- YA EXISTENTES (property_id-scoped, no requieren funciones nuevas).
alter table rentas.owner_statement enable row level security;
alter table rentas.owner_statement_linea enable row level security;
alter table rentas.payout_canal enable row level security;
alter table rentas.payout_linea enable row level security;

create policy "finanzas: lectura de owner_statement" on rentas.owner_statement for select using (rentas.can_read_finanzas(property_id));
create policy "finanzas: escritura de owner_statement" on rentas.owner_statement for insert with check (rentas.can_write_finanzas(property_id));

create policy "finanzas: lectura de owner_statement_linea" on rentas.owner_statement_linea for select
  using (exists (select 1 from rentas.owner_statement os where os.id = owner_statement_linea.statement_id and rentas.can_read_finanzas(os.property_id)));
create policy "finanzas: escritura de owner_statement_linea" on rentas.owner_statement_linea for insert
  with check (exists (select 1 from rentas.owner_statement os where os.id = owner_statement_linea.statement_id and rentas.can_write_finanzas(os.property_id)));

create policy "finanzas: lectura de payout_canal" on rentas.payout_canal for select using (rentas.can_read_finanzas(property_id));
create policy "finanzas: escritura de payout_canal" on rentas.payout_canal for insert with check (rentas.can_write_finanzas(property_id));

create policy "finanzas: lectura de payout_linea" on rentas.payout_linea for select
  using (exists (select 1 from rentas.payout_canal pc where pc.id = payout_linea.payout_id and rentas.can_read_finanzas(pc.property_id)));
create policy "finanzas: escritura de payout_linea" on rentas.payout_linea for insert
  with check (exists (select 1 from rentas.payout_canal pc where pc.id = payout_linea.payout_id and rentas.can_write_finanzas(pc.property_id)));

revoke all on rentas.owner_statement, rentas.owner_statement_linea, rentas.payout_canal, rentas.payout_linea from public, anon;
grant select, insert on rentas.owner_statement, rentas.owner_statement_linea, rentas.payout_canal, rentas.payout_linea to authenticated;
grant select, insert, update, delete on rentas.owner_statement, rentas.owner_statement_linea, rentas.payout_canal, rentas.payout_linea to service_role;
