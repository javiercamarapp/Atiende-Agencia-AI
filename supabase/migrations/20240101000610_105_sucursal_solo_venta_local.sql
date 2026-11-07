-- Sucursal "solo venta local" (Galerias de Los Taquitos de PM, decision del dueno 6-nov-2026).
--
-- Problema: una sucursal que vende SOLO en mostrador (su venta entra por SoftRestaurant, importada al CFO) tenia dos estados
-- posibles y ninguno servia: `core.property.status = 'inactive'` la saca de los tableros por sucursal (KPIs y filtro de
-- sucursal), y `active` la pone en el directorio del agente de WhatsApp y de voz (recoger, horarios, menu, ruteo). Se agrega
-- UNA columna a `restaurantes.branch_policy`:
--
--   * solo_venta_local boolean not null default false -- true = la sucursal cuenta para reportes (tableros, CFO, importacion
--     de SoftRestaurant) pero los agentes (WhatsApp y voz) y el pedido en linea NUNCA la ofrecen: no aparece en su lista de
--     sucursales ni en el conocimiento generado, no se cotiza ni se crea un pedido en ella (domicilio ni recoger), no entra al
--     ruteo de domicilio ni a la sucursal mas cercana por pin.
--
-- Decision de diseno: columna NUEVA con default que conserva el comportamiento actual (ninguna sucursal cambia al aplicar).
-- El codigo que la lee degrada con SAVEPOINT cuando la base todavia no la tiene (SQLSTATE 42703): sin la columna ninguna
-- sucursal es "solo venta local". Nada se aplica al mergear.
--
-- Justificacion de seguridad:
--  * RLS: sin cambios. Las policies de 023 (SELECT staff de la organizacion o sesion de SISTEMA; INSERT/UPDATE solo
--    owner/admin con `with check` de organizacion) cubren la columna por ser de la misma fila. `anon` sigue sin acceso.
--  * GRANT por COLUMNA: igual que 057, se agrega al INSERT/UPDATE por columna de `authenticated` (owner/admin desde el panel).
--  * Sin CHECK contra `acepta_domicilio`: el codigo ya excluye una sucursal solo venta local del despacho aunque
--    `acepta_domicilio` siga en true, y un CHECK haria fallar el guardado de la politica desde el panel.

alter table restaurantes.branch_policy
  add column if not exists solo_venta_local boolean not null default false;

comment on column restaurantes.branch_policy.solo_venta_local is
  'true = sucursal solo de reporte (venta en mostrador via SoftRestaurant): los agentes de WhatsApp/voz y el pedido en linea nunca la ofrecen.';

grant insert (solo_venta_local) on restaurantes.branch_policy to authenticated;
grant update (solo_venta_local) on restaurantes.branch_policy to authenticated;
