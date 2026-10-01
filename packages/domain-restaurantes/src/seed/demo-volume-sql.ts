// R-20 -- persistencia IDEMPOTENTE de un lote del seed de volumen (ver demo-volume.ts) como bloque plpgsql. Mismo patron que el seed
// de PM (pm-demo.ts): el CLI lo ejecuta como `do $$ ... $$` por lote y el verify contra Postgres real lo envuelve en una funcion y lo
// corre dos veces.
//
// Reglas del bloque (todas verificadas en scripts/verify-restaurantes-demo-volumen):
//   * SOLO escribe en una organizacion marcada en `restaurantes.demo_organization` (migracion 037); si no, aborta sin tocar nada.
//   * Solo acepta telefonos del rango reservado `0001xxxxxx`: nunca puede crear ni tocar a una persona real.
//   * Idempotente: los pedidos se deduplican por (organizacion, clave de idempotencia); clientes por telefono; conversaciones por
//     telefono; handoffs por conversacion; contactos por telefono y fecha. Re-ejecutar el mismo volumen no cambia nada.
//   * Los totales y renglones llegan ya calculados por el motor real (demo-volume.ts); aqui no se recalcula ni se inventa nada.
import type { DemoVolumeBatch } from "./demo-volume.ts";

export const DEMO_VOLUME_PHONE_RE = "^0001[0-9]{6}$";

/** Tablas y columnas que el seed de volumen necesita (migraciones 028, 031, 033 y 037). */
export const DEMO_VOLUME_REQUIRED_SCHEMA: readonly { readonly table: string; readonly columns: readonly string[]; readonly migration: string }[] = [
  { table: "restaurantes.demo_organization", columns: ["organization_id", "activo"], migration: "037_demo_organization.sql" },
  { table: "restaurantes.orders", columns: ["canal", "propina", "idempotency_key"], migration: "031_recoger_promociones_automaticas_puentes.sql" },
  { table: "restaurantes.conversation_handoff", columns: ["estado", "solicitado_por", "conversation_id"], migration: "028_conversaciones_handoff_turnos.sql" },
  { table: "restaurantes.callback_requests", columns: ["status"], migration: "033_agente_config_historial_y_callbacks_estado.sql" },
];

export class DemoVolumeSqlError extends Error {}

function assertSinDelimitador(json: string): void {
  if (json.includes("$dv$")) throw new DemoVolumeSqlError("Los datos contienen el delimitador $dv$ reservado del seed de volumen.");
}

/** SQL de solo lectura: una fila por columna FALTANTE (vacio = esquema completo). */
export function renderVolumePreflightSql(): string {
  return (
    DEMO_VOLUME_REQUIRED_SCHEMA.flatMap((r) =>
      r.columns.map((c) => {
        const [schema, table] = r.table.split(".");
        return `select '${r.table}.${c}' as faltante, '${r.migration}' as migracion
  where not exists (select 1 from information_schema.columns where table_schema = '${schema}' and table_name = '${table}' and column_name = '${c}')`;
      }),
    ).join("\nunion all\n") + ";"
  );
}

/** Cuerpo (`declare ... begin ... end`) del bloque que persiste UN lote en la organizacion demo de slug `orgSlug`. */
export function renderDemoVolumePlpgsql(orgSlug: string, batch: DemoVolumeBatch): string {
  if (!/^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$/.test(orgSlug)) throw new DemoVolumeSqlError("Slug de organizacion invalido.");
  const json = JSON.stringify(batch);
  assertSinDelimitador(json);
  return `declare
  v jsonb := $dv$${json}$dv$::jsonb;
  v_org uuid;
begin
  -- 0) solo una organizacion MARCADA como demo; solo telefonos del rango ficticio reservado.
  select o.id into v_org
    from core.organization o join restaurantes.demo_organization d on d.organization_id = o.id
   where o.slug = '${orgSlug}';
  if v_org is null then
    raise exception 'demo-volumen: la organizacion "${orgSlug}" no existe o NO esta marcada como demo (cargue scripts/seed-pm-demo con --demo); no se escribe nada.' using errcode = '42501';
  end if;
  if exists (select 1 from jsonb_to_recordset(v->'customers') as c(phone text) where c.phone !~ '${DEMO_VOLUME_PHONE_RE}')
     or exists (select 1 from jsonb_to_recordset(v->'orders') as o("customerPhone" text) where o."customerPhone" !~ '${DEMO_VOLUME_PHONE_RE}')
     or exists (select 1 from jsonb_to_recordset(v->'conversations') as c(phone text) where right(c.phone, 10) !~ '${DEMO_VOLUME_PHONE_RE}')
     or exists (select 1 from jsonb_to_recordset(v->'callbacks') as c(phone text) where c.phone !~ '${DEMO_VOLUME_PHONE_RE}') then
    raise exception 'demo-volumen: hay telefonos fuera del rango ficticio reservado 0001xxxxxx; no se escribe nada.' using errcode = '22023';
  end if;

  -- 1) clientes (y su direccion): por (organizacion, telefono)
  insert into restaurantes.customers (organization_id, phone, name, order_count, created_at, updated_at)
    select v_org, c.phone, c.name, 0, c."firstOrderAt", c."firstOrderAt"
    from jsonb_to_recordset(v->'customers') as c(phone text, name text, "firstOrderAt" timestamptz)
    on conflict (organization_id, phone) do nothing;
  insert into restaurantes.customer_addresses (customer_id, label, address, is_default)
    select cu.id, 'Casa', c.address, true
    from jsonb_to_recordset(v->'customers') as c(phone text, address text)
    join restaurantes.customers cu on cu.organization_id = v_org and cu.phone = c.phone
    on conflict (customer_id, address) do nothing;

  -- 2) pedidos: totales y renglones ya calculados por el motor real; deduplicados por clave de idempotencia
  insert into restaurantes.orders (organization_id, property_id, customer_id, customer_name, customer_phone, customer_address, branch, total, status, items, source, notes,
                                   payment_method, idempotency_key, created_at, delivered_at, canal, propina)
    select v_org, bd.property_id, cu.id, o."customerName", o."customerPhone", o.address, o."branchName", o.total, o.status, o.items, o.source, o.notes,
           o."paymentMethod", o."idempotencyKey", o."createdAt", o."deliveredAt", o.canal, o.propina
    from jsonb_to_recordset(v->'orders') as o("idempotencyKey" text, "branchSlug" text, "branchName" text, "customerPhone" text, "customerName" text, address text, items jsonb,
                                             total numeric, status text, source text, "paymentMethod" text, canal text, propina numeric, notes text,
                                             "createdAt" timestamptz, "deliveredAt" timestamptz)
    join restaurantes.branch_detail bd on bd.organization_id = v_org and bd.slug = o."branchSlug"
    join restaurantes.customers cu on cu.organization_id = v_org and cu.phone = o."customerPhone"
    on conflict (organization_id, idempotency_key) where idempotency_key is not null do nothing;

  -- 3) agregados del cliente a partir de SUS pedidos (coherencia: nunca un contador inventado)
  update restaurantes.customers cu
     set order_count = a.n, last_order_at = a.ultimo, updated_at = greatest(cu.updated_at, a.ultimo)
    from (
      select o.customer_id, (count(*) filter (where o.status <> 'cancelado'))::int as n, max(o.created_at) as ultimo
        from restaurantes.orders o
       where o.organization_id = v_org
         and o.customer_phone in (select x."customerPhone" from jsonb_to_recordset(v->'orders') as x("customerPhone" text))
       group by o.customer_id
    ) a
   where cu.id = a.customer_id;

  -- 4) conversaciones de WhatsApp (una por telefono) ligadas a su pedido
  insert into restaurantes.whatsapp_conversations (organization_id, phone, property_id, messages, status, order_id, created_at, updated_at)
    select v_org, c.phone, bd.property_id, c.messages, c.status, o.id, c."updatedAt", c."updatedAt"
    from jsonb_to_recordset(v->'conversations') as c(phone text, "branchSlug" text, messages jsonb, status text, "orderKey" text, "updatedAt" timestamptz)
    join restaurantes.branch_detail bd on bd.organization_id = v_org and bd.slug = c."branchSlug"
    left join restaurantes.orders o on o.organization_id = v_org and o.idempotency_key = c."orderKey"
    on conflict (organization_id, phone) do nothing;

  -- 5) tomas de handoff a humano (cerradas y las pendientes recientes): una por conversacion
  insert into restaurantes.conversation_handoff (organization_id, property_id, canal, conversation_id, estado, solicitado_por, motivo, solicitada_at, ultimo_cliente_at, cerrada_at, created_at, updated_at)
    select v_org, bd.property_id, 'whatsapp', wc.id, h.estado, 'agente', h.motivo, h."solicitadaAt", h."solicitadaAt", h."cerradaAt", h."solicitadaAt", coalesce(h."cerradaAt", h."solicitadaAt")
    from jsonb_to_recordset(v->'handoffs') as h(phone text, "branchSlug" text, estado text, motivo text, "solicitadaAt" timestamptz, "cerradaAt" timestamptz)
    join restaurantes.branch_detail bd on bd.organization_id = v_org and bd.slug = h."branchSlug"
    join restaurantes.whatsapp_conversations wc on wc.organization_id = v_org and wc.phone = h.phone
    where not exists (select 1 from restaurantes.conversation_handoff x where x.canal = 'whatsapp' and x.conversation_id = wc.id);

  -- 6) contactos (callbacks) registrados por el agente al escalar
  insert into restaurantes.callback_requests (organization_id, property_id, customer_name, customer_phone, reason, message, source, resolved, created_at)
    select v_org, bd.property_id, c.name, c.phone, c.reason, c.message, 'whatsapp', c.resolved, c."createdAt"
    from jsonb_to_recordset(v->'callbacks') as c(phone text, name text, "branchSlug" text, reason text, message text, resolved boolean, "createdAt" timestamptz)
    join restaurantes.branch_detail bd on bd.organization_id = v_org and bd.slug = c."branchSlug"
    where not exists (select 1 from restaurantes.callback_requests x where x.organization_id = v_org and x.customer_phone = c.phone and x.created_at = c."createdAt");
end`;
}

export function renderDemoVolumeDoBlock(orgSlug: string, batch: DemoVolumeBatch): string {
  return `do $seed_volumen$\n${renderDemoVolumePlpgsql(orgSlug, batch)}\n$seed_volumen$;`;
}
