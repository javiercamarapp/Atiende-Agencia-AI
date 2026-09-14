-- Fase 5 restaurantes — back-office CORE (CRUD real de catálogo/sucursales/pedidos,
-- ver diseño §1). Habilita la escritura de staff que las Fases 1-4 nunca
-- necesitaron: hasta esta migración, TODA la superficie de `restaurantes.*` bajo el
-- rol `authenticated` era de solo lectura a nivel de GRANT — incluidas
-- `categories`/`products`, que ya traían una policy `for all` desde
-- migrations/001_restaurantes_schema.sql que en la práctica era letra muerta (RLS
-- nunca llega a evaluarse si el GRANT ya bloquea la operación primero). Esta
-- migración es puramente aditiva: ningún GRANT/policy existente se toca ni se
-- reduce.
--
-- Deliberadamente NO se toca `core.property` (nombre/status de una sucursal): ese
-- schema es compartido por TODAS las verticales (hoteles/rentas/citas/licitaciones/
-- despachos/restaurantes) y hoy solo `service_role` tiene GRANT de escritura sobre
-- él (ver packages/db/migrations/0001_core_schema.sql) — ninguna otra vertical de
-- este monorepo crea o activa/desactiva una property desde una ruta de staff
-- autenticado todavía. Ampliar esa policy es una decisión de plataforma completa,
-- fuera del alcance de una fase de un solo vertical; por eso
-- `RestaurantesRepository.updateBranchDetail` (Fase 5) solo edita
-- `restaurantes.branch_detail` (teléfono/dirección/coordenadas/slug/orden), nunca
-- `core.property.status`/`name` — "activar/desactivar sucursal" y "crear sucursal"
-- quedan documentados como pendientes de esa decisión de plataforma, no como un
-- CRUD a medias por descuido.

grant insert, update, delete on restaurantes.categories, restaurantes.products to authenticated;
grant insert, update on restaurantes.branch_products to authenticated;
grant update on restaurantes.branch_detail to authenticated;
grant update on restaurantes.orders to authenticated;

-- `branch_detail`/`branch_products` solo tenían policy de SELECT público
-- ("cualquiera puede ver...") desde migrations/001 — ninguna de escritura de staff.
create policy "staff actualiza detalle de sucursal de su organización" on restaurantes.branch_detail for update
  using (exists (select 1 from core.membership m where m.organization_id = branch_detail.organization_id and m.user_id = auth.uid()))
  with check (exists (select 1 from core.membership m where m.organization_id = branch_detail.organization_id and m.user_id = auth.uid()));

create policy "staff gestiona branch_products de su organización" on restaurantes.branch_products for all
  using (exists (
    select 1 from core.property p
    join core.membership m on m.organization_id = p.organization_id
    where p.id = branch_products.property_id and m.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from core.property p
    join core.membership m on m.organization_id = p.organization_id
    where p.id = branch_products.property_id and m.user_id = auth.uid()
  ));

-- `orders` solo tenía policy de SELECT de staff ("staff ve pedidos de su
-- organización") — Fase 5 agrega el primer caso de negocio real que cambia el
-- estado de un pedido desde el panel (ver order-lifecycle.ts: la máquina de
-- estados vive en el dominio, esta policy solo autoriza el UPDATE en sí).
create policy "staff actualiza pedidos de su organización" on restaurantes.orders for update
  using (exists (select 1 from core.membership m where m.organization_id = orders.organization_id and m.user_id = auth.uid()))
  with check (exists (select 1 from core.membership m where m.organization_id = orders.organization_id and m.user_id = auth.uid()));
