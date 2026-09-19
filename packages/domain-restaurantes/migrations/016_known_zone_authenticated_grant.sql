-- Hallazgo real (verify-restaurantes-sql, ejercitado contra Postgres real por
-- primera vez): `restaurantes.known_zone` (migrations/005_known_zones_and_nearest_
-- branch.sql) se creó con `alter table ... enable row level security;` pero SIN
-- ninguna policy y SIN NINGÚN `grant` a `authenticated`/`anon` -- a diferencia de
-- TODAS las demás tablas de este paquete, que siempre traen su `grant` (y su policy,
-- si aplica) junto con su `enable row level security` en la misma migración (ver
-- 001_restaurantes_schema.sql, 007_admin_backoffice_grants_and_policies.sql,
-- 009_order_notifications.sql, 010_promotions.sql). `restaurantes.
-- nearest_branch_by_colonia()` (mismo archivo, migrations/005) NO es
-- `security definer` (corre como el rol que la invoca, a propósito -- ver su
-- comentario "language plpgsql stable" sin `security definer`, igual que
-- `calc_customer_tier`), así que necesita el GRANT SELECT + una policy real sobre
-- `known_zone` para poder leer la tabla que hace el matching de colonia.
--
-- Impacto real verificado contra Postgres real (nunca lo hubiera detectado el
-- repositorio en memoria, que no aplica GRANT ni RLS): CUALQUIER llamada a
-- `nearest_branch_by_colonia()` bajo el rol `authenticated` -- que es SIEMPRE el rol
-- de conexión real de este monorepo, con o sin `auth.uid()` (ver
-- packages/db/src/managed-postgres-engine.ts::withAppSession) -- fallaba con
-- "permission denied for table known_zone" antes de siquiera evaluar RLS (sin el
-- GRANT). Eso rompía, para TODO cliente real, tanto el tool de voz
-- "buscar_sucursal_cercana" (apps/api/src/routes/verticals/restaurantes/
-- voice-tools.ts, siempre `withAppSession({ userId: null })`) como el mismo flujo
-- vía WhatsApp (packages/domain-restaurantes/src/whatsapp/llm-turn-handler.ts,
-- mismo patrón de sesión) -- el LLM SIEMPRE recibía un error en vez de la sucursal
-- más cercana real, sin que ningún test de este repo pudiera verlo (los 443 tests
-- de domain-restaurantes corren contra el repositorio en memoria).
--
-- El GRANT por sí solo NO habría bastado (verificado antes de escribir este fix):
-- con RLS habilitada y CERO policies, Postgres deniega todo acceso por default para
-- cualquier rol sin BYPASSRLS, incluso con GRANT SELECT ya otorgado -- el resultado
-- habría sido cero filas SIEMPRE, en silencio (indistinguible de "colonia sin match
-- real", el contrato de silencio documentado en el propio migrations/005), en vez de
-- fallar ruidoso o funcionar -- un bug todavía peor porque nunca se manifiesta como
-- error.
--
-- Fix (dos partes):
--   1. GRANT SELECT a `authenticated` -- `known_zone` nunca se lee desde un checkout
--      público anónimo (a diferencia del catálogo), así que no se otorga a `anon`
--      (verificado con `grep -rn "nearest_branch_by_colonia\|known_zone"
--      apps/web/src`: ningún código de `apps/web` la usa).
--   2. Policy de SELECT con el MISMO criterio ya establecido por
--      014_catalogo_publico_scoped.sql para una tabla de catálogo sin PII por-huésped:
--      sesión de sistema (auth.uid() is null, el caso real de voice-tools.ts/
--      llm-turn-handler.ts) O staff con membership real de la organización dueña de
--      la zona -- nunca "using (true)" a secas, que reabriría el mismo hallazgo de
--      fuga cross-tenant que esa migración ya cerró para categories/products/
--      branch_products/branch_detail (un staff autenticado de OTRA organización
--      podría, si no fuera por esta policy, leer directo por SQL las zonas/
--      coordenadas configuradas por cualquier restaurante ajeno).
grant select on restaurantes.known_zone to authenticated;

create policy "sistema o su organización ve zonas conocidas" on restaurantes.known_zone for select
  using (
    auth.uid() is null
    or exists (select 1 from core.membership m where m.organization_id = known_zone.organization_id and m.user_id = auth.uid())
  );
