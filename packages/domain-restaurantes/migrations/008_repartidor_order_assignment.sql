-- Fase 8 restaurantes — superficie real del rol "repartidor" (ver
-- domain-restaurantes/src/roles.ts: "repartidor tiene acceso acotado a SU propio
-- pedido/perfil, nunca gestión"). Hasta esta migración el enum de rol existía
-- (RESTAURANTES_ROLES) pero ninguna columna real soportaba "asignar un pedido a un
-- repartidor" ni "el repartidor reportó una incidencia" — puerto de
-- `orders.assigned_repartidor_id`/`estimated_delivery_at` (origen:
-- supabase/migrations/20260903095843_pedidos_seguimiento_entrega.sql) y
-- `orders.incident_note` (origen:
-- supabase/migrations/20260904057000_close_membership_and_courier_escalation.sql),
-- generalizados a `core.staff_user` (fusion NO usa `auth.users` de Supabase — ver
-- packages/db/migrations/0001_core_schema.sql, `core.staff_user` es el equivalente
-- real de este monorepo).
--
-- Deliberadamente SIN nuevas policies de RLS: la policy de SELECT ("staff ve
-- pedidos de su organización") y la de UPDATE ("staff actualiza pedidos de su
-- organización"), ambas de migrations/001 y 007, ya autorizan a CUALQUIER
-- membership de la organización (repartidor incluido) a leer/tocar la fila —
-- exactamente el mismo criterio de defensa-en-profundidad que ya documenta
-- core-auth/src/middleware.ts ("403 explícito ADEMÁS de RLS"): la autorización FINA
-- por rol (repartidor solo ve/toca SUS pedidos asignados, MANAGER_ROLES ve/toca
-- todos los de su alcance de sucursal) vive en la capa TS — assertVerticalRole() +
-- el WHERE explícito de cada método nuevo de RestaurantesRepository (ver
-- postgres-repository.ts::listOrdersForRepartidor/findAssignedOrderById/
-- updateAssignedOrderStatus) — nunca en una policy nueva de Postgres. Añadir una
-- policy RLS redundante con esa misma regla solo duplicaría la fuente de verdad sin
-- ganar nada (el GRANT de UPDATE ya es de tabla completa desde migrations/007).

alter table restaurantes.orders
  add column if not exists assigned_repartidor_id uuid references core.staff_user(id),
  add column if not exists estimated_delivery_at timestamptz,
  add column if not exists incident_note text check (incident_note is null or length(incident_note) between 1 and 2000);

create index if not exists orders_assigned_repartidor_id_idx
  on restaurantes.orders(assigned_repartidor_id)
  where assigned_repartidor_id is not null;
