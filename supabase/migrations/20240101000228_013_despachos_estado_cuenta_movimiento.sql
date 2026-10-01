-- Decimotercera migración del esquema `despachos.*` (D-03) — libro de movimientos
-- importados de estados de cuenta bancarios, con idempotencia por huella (hash).
--
-- Contexto: el parseo de CSV/OFX (`domain-despachos/src/conciliacion/estado-de-cuenta/`)
-- calcula un SHA-256 determinista por movimiento (cuenta + banco + fecha + importe +
-- concepto + ocurrencia). Esta tabla es lo que hace REAL la idempotencia: volver a subir
-- el mismo archivo, o dos archivos de periodos traslapados, NO duplica movimientos
-- porque `unique (property_id, hash)` + `insert ... on conflict do nothing` los descarta.
--
-- Nota de numeración: el siguiente número interno libre de este directorio es 013;
-- la migración de EFOS (PR #233) ocupa 014 y no tiene relación con esta tabla.
--
-- Diseño de seguridad (cada punto con su justificación):
--  * RLS habilitada; autoridad SIEMPRE `core.has_property_access` (mismo patrón que el
--    resto de `despachos.*`), nunca aislamiento a mano.
--  * Lectura: cualquier staff con acceso a la property (la conciliación consulta qué ya
--    se importó).
--  * Inserción: solo `admin` o `contador` de la organización (los roles de
--    `CONCILIACION_ROLES`), y la fila debe pertenecer a la MISMA organización que su
--    property -- sin esa comparación, un staff con membership en dos organizaciones
--    podría etiquetar una fila de la property A con el organization_id de la B
--    (defensa en profundidad contra mezcla de tenants). La capa TS repite el chequeo
--    de rol (mejor mensaje de error); RLS es la autoridad.
--  * Libro de solo-anexar: `authenticated` NO tiene UPDATE ni DELETE (un movimiento
--    bancario importado no se edita ni se borra desde la app: se corrige re-importando).
--    `service_role` conserva select/insert/delete para mantenimiento y atención de
--    solicitudes de borrado; no tiene UPDATE (nadie reescribe un movimiento).
--  * GRANT de INSERT a nivel COLUMNA: la ruta real solo escribe las 15 columnas listadas;
--    `id`, `created_at` e `importado_por` quedan fuera del grant y los llena el DEFAULT
--    (`importado_por` = `auth.uid()`), así que un cliente no puede falsear quién importó
--    ni cuándo.
--  * Sin ningún GRANT a `anon`.
--  * Sin `using (true)`: ninguna policy es permisiva en blanco.
create table despachos.estado_cuenta_movimiento (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  cuenta text check (cuenta is null or (cuenta <> '' and char_length(cuenta) <= 34)),
  banco text not null check (banco in ('bbva', 'banorte', 'santander', 'hsbc', 'scotiabank', 'banamex', 'inbursa', 'generico')),
  formato text not null check (formato in ('csv', 'ofx')),
  fecha date not null,
  descripcion text not null default '' check (char_length(descripcion) <= 500),
  referencia text check (referencia is null or char_length(referencia) <= 200),
  cargo numeric(14, 2) check (cargo is null or cargo > 0),
  abono numeric(14, 2) check (abono is null or abono > 0),
  monto numeric(14, 2) not null check (monto <> 0),
  saldo numeric(14, 2),
  lote_id uuid not null,
  renglon integer not null check (renglon > 0),
  importado_por uuid default auth.uid(),
  created_at timestamptz not null default now(),
  -- Exactamente uno de cargo/abono, y `monto` con el signo coherente (cargo = salida).
  constraint estado_cuenta_movimiento_signo check (
    (cargo is not null and abono is null and monto = -cargo) or (abono is not null and cargo is null and monto = abono)
  ),
  -- La huella es única POR property: el mismo movimiento en dos clientes del despacho
  -- (dos properties) es legítimamente distinto.
  unique (property_id, hash)
);
create index estado_cuenta_movimiento_property_fecha_idx on despachos.estado_cuenta_movimiento (property_id, fecha);
create index estado_cuenta_movimiento_lote_idx on despachos.estado_cuenta_movimiento (property_id, lote_id);

alter table despachos.estado_cuenta_movimiento enable row level security;

create policy "staff ve movimientos importados de su property" on despachos.estado_cuenta_movimiento for select
  using (core.has_property_access(auth.uid(), property_id));

create policy "admin y contador importan movimientos de su property" on despachos.estado_cuenta_movimiento for insert
  with check (
    core.has_property_access(auth.uid(), property_id)
    and exists (select 1 from core.property p where p.id = estado_cuenta_movimiento.property_id and p.organization_id = estado_cuenta_movimiento.organization_id)
    and exists (
      select 1 from core.membership m
      where m.organization_id = estado_cuenta_movimiento.organization_id
        and m.user_id = auth.uid()
        and m.vertical_role in ('admin', 'contador')
    )
  );

revoke all on despachos.estado_cuenta_movimiento from public, anon, authenticated;
grant select on despachos.estado_cuenta_movimiento to authenticated;
grant insert (organization_id, property_id, hash, cuenta, banco, formato, fecha, descripcion, referencia, cargo, abono, monto, saldo, lote_id, renglon)
  on despachos.estado_cuenta_movimiento to authenticated;
grant select, insert, delete on despachos.estado_cuenta_movimiento to service_role;
