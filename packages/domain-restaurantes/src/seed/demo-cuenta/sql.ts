// SQL del seed de la cuenta demo ficticia: convierte el PLAN validado (`plan.ts`) en el cuerpo de UN bloque plpgsql idempotente. Puro: no abre ninguna
// conexion. Lo ejecuta la CLI `scripts/seed-demo-cuenta/seed-demo-cuenta.ts` (dry-run por omision; escribir exige --apply + SEED_DATABASE_URL).
//
// Reglas (mismo criterio que el seed de PM, `../pm-demo.ts`):
//   * Todo esta acotado a la organizacion del plan (slug `demo-cadena`). Si ese slug ya existe en OTRA vertical, aborta; jamas toca otra organizacion
//     (ni la demo vieja `demo-restaurantes`, que el plan rechaza como slug).
//   * Re-ejecutar REPARA lo que el seed controla (nombres, precios, horarios, cobertura) y NO pisa decisiones del dueno: no vuelve a prender un producto
//     agotado, no reactiva la voz, no reinicia contadores de promociones ni borra productos que el dueno agrego.
//   * Sin secretos ni usuarios: nunca crea credenciales ni membresias. La voz se carga DESHABILITADA (sin gasto de proveedores).
import { renderSchemaPreflightSql } from "../pm-demo.ts";
import { DemoCuentaError, type DemoCuentaPlan } from "./plan.ts";

const DELIMITADOR = "$dc$";
/** Delimitadores que envuelven el JSON en algun contexto (CLI `do`, funcion del gate, archivo emitido): ningun dato puede contenerlos. */
const DELIMITADORES_RESERVADOS = [DELIMITADOR, "$seed_dc$", "$seed_fn$", "$preflight$"] as const;

/** Normaliza y valida el correo del dueno que se embebe como literal SQL (sin comillas, espacios ni `$`). */
export function normalizarOwnerEmail(ownerEmail: string | null | undefined): string | null {
  if (!ownerEmail) return null;
  const email = ownerEmail.trim().toLowerCase();
  if (!/^[^\s@'"$\\]+@[^\s@'"$\\]+\.[^\s@'"$\\]+$/.test(email)) throw new DemoCuentaError("owner-email invalido.");
  return email;
}

/** SQL de solo lectura que devuelve una fila por columna FALTANTE del esquema (vacio = la base ya tiene lo que el seed escribe). Incluye `demo_organization`. */
export function renderEsquemaRequeridoDemoCuenta(): string {
  return renderSchemaPreflightSql({ demo: true });
}

/** Cuerpo (`declare ... begin ... end`) del bloque plpgsql idempotente. */
export function renderDemoCuentaPlpgsql(plan: DemoCuentaPlan, options: { readonly ownerEmail?: string | null } = {}): string {
  const doc = {
    organization: plan.organization,
    branches: plan.branches.map((b) => ({
      id: b.id,
      name: b.name,
      slug: b.slug,
      status: b.status,
      phone: b.phone,
      address: b.address,
      lat: b.lat,
      lng: b.lng,
      displayOrder: b.displayOrder,
      zonaHoraria: b.zonaHoraria,
      horario: b.horario,
      pedidoMinimoDomicilio: b.pedidoMinimoDomicilio,
      pedidoMinimoRecoger: b.pedidoMinimoRecoger,
      propinaPolitica: b.propinaPolitica,
      aceptaDomicilio: b.aceptaDomicilio,
      diasDomicilio: b.diasDomicilio,
    })),
    categories: plan.categories,
    products: plan.products,
    zones: plan.zones,
    colonias: plan.colonias,
    conocimiento: plan.conocimiento,
    promotions: plan.promotions,
    whatsappAgent: plan.whatsappAgent,
    demo: plan.demo,
  };
  const json = JSON.stringify(doc);
  for (const d of DELIMITADORES_RESERVADOS) if (json.includes(d)) throw new DemoCuentaError(`Los datos contienen el delimitador ${d} reservado del seed.`);
  const email = normalizarOwnerEmail(options.ownerEmail);
  const owner = email
    ? `
  -- 12) dueno (opcional): membresia owner de un usuario de staff que YA existe con ese correo. Nunca crea usuarios ni credenciales.
  select id into v_user from core.staff_user where lower(email) = '${email}';
  if v_user is null then
    raise notice 'seed-demo-cuenta: no existe un usuario de staff con ese correo; la cuenta queda sin duenos (re-ejecutar con el correo correcto lo agrega).';
  else
    insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role)
      values (v_user, v_org, null, 'owner', 'owner')
      on conflict do nothing;
  end if;`
    : "";
  return `declare
  v jsonb := ${DELIMITADOR}${json}${DELIMITADOR}::jsonb;
  v_org uuid;
  v_vertical text;${email ? "\n  v_user uuid;" : ""}
begin
  -- 1) organizacion (por slug). Nunca pisa una organizacion de otra vertical.
  select id, vertical into v_org, v_vertical from core.organization where slug = v->'organization'->>'slug';
  if v_org is not null and v_vertical <> 'restaurantes' then
    raise exception 'seed-demo-cuenta: el slug % ya existe en otra vertical (%); no se toca.', v->'organization'->>'slug', v_vertical;
  end if;
  if v_org is null then
    insert into core.organization (vertical, name, slug) values ('restaurantes', v->'organization'->>'name', v->'organization'->>'slug') returning id into v_org;
  else
    update core.organization set name = v->'organization'->>'name' where id = v_org;
  end if;

  -- 2) sucursales: core.property (por nombre dentro de la organizacion) + branch_detail con SU zona horaria.
  insert into core.property (organization_id, vertical, name, status)
    select v_org, 'restaurantes', b.name, b.status
    from jsonb_to_recordset(v->'branches') as b(name text, slug text, status text)
    where not exists (select 1 from core.property p where p.organization_id = v_org and p.name = b.name)
      and not exists (select 1 from restaurantes.branch_detail d where d.organization_id = v_org and d.slug = b.slug);
  insert into restaurantes.branch_detail (property_id, organization_id, slug, phone, address, lat, lng, display_order, zona_horaria)
    select p.id, v_org, b.slug, b.phone, b.address, b.lat, b.lng, b."displayOrder", b."zonaHoraria"
    from jsonb_to_recordset(v->'branches') as b(name text, slug text, phone text, address text, lat numeric, lng numeric, "displayOrder" int, "zonaHoraria" text)
    join core.property p on p.organization_id = v_org and p.name = b.name
    on conflict (property_id) do update set slug = excluded.slug, phone = excluded.phone, address = excluded.address,
      lat = excluded.lat, lng = excluded.lng, display_order = excluded.display_order, zona_horaria = excluded.zona_horaria;

  -- 3) categorias
  insert into restaurantes.categories (organization_id, name, slug, display_order)
    select v_org, c.name, c.slug, c."displayOrder"
    from jsonb_to_recordset(v->'categories') as c(name text, slug text, "displayOrder" int)
    on conflict (organization_id, slug) do update set name = excluded.name, display_order = excluded.display_order;

  -- 4) productos (identidad: organizacion + nombre; alcohol = no_domicilio; price = precio de REFERENCIA, el de cada sucursal va en 5)
  update restaurantes.products pr
    set category_id = c.id, description = x.description, price = x.price, is_popular = x."isPopular", display_order = x."displayOrder",
        no_domicilio = x."noDomicilio", updated_at = now(),
        search_keywords = array(select distinct k from unnest(pr.search_keywords || array(select jsonb_array_elements_text(x."searchKeywords"))) as k order by k)
    from jsonb_to_recordset(v->'products') as x(name text, "categorySlug" text, price numeric, description text, "isPopular" boolean, "noDomicilio" boolean, "displayOrder" int, "searchKeywords" jsonb)
    join restaurantes.categories c on c.organization_id = v_org and c.slug = x."categorySlug"
    where pr.organization_id = v_org and pr.name = x.name;
  insert into restaurantes.products (organization_id, category_id, name, description, price, is_popular, display_order, no_domicilio, search_keywords)
    select v_org, c.id, x.name, x.description, x.price, x."isPopular", x."displayOrder", x."noDomicilio", array(select jsonb_array_elements_text(x."searchKeywords"))
    from jsonb_to_recordset(v->'products') as x(name text, "categorySlug" text, price numeric, description text, "isPopular" boolean, "noDomicilio" boolean, "displayOrder" int, "searchKeywords" jsonb)
    join restaurantes.categories c on c.organization_id = v_org and c.slug = x."categorySlug"
    where not exists (select 1 from restaurantes.products pr where pr.organization_id = v_org and pr.name = x.name);

  -- 5) precio y disponibilidad POR SUCURSAL: una fila por cada sucursal con llave en branchPrices (sin llave, el producto no existe ahi).
  -- Insertar deja is_available = false SOLO donde el plan lo marca agotado (unavailableIn); re-ejecutar repara el precio y NUNCA cambia is_available.
  insert into restaurantes.branch_products (property_id, product_id, price, is_available)
    select p.id, pr.id, bpr.value::numeric, not (x."unavailableIn" ? b.id)
    from jsonb_to_recordset(v->'branches') as b(id text, name text)
    join core.property p on p.organization_id = v_org and p.name = b.name
    cross join jsonb_to_recordset(v->'products') as x(name text, "branchPrices" jsonb, "unavailableIn" jsonb)
    cross join lateral jsonb_each_text(x."branchPrices") as bpr(key, value)
    join restaurantes.products pr on pr.organization_id = v_org and pr.name = x.name
    where bpr.key = b.id
    on conflict (property_id, product_id) do update set price = excluded.price, updated_at = now();
  -- 5b) RECONCILIACION: lo que el plan ya no vende en una sucursal DE ESTE seed se borra (acotado a la organizacion, a sucursales del plan y a productos del plan).
  delete from restaurantes.branch_products bp
    using restaurantes.products pr, core.property p, jsonb_to_recordset(v->'branches') as b(id text, name text)
    where bp.product_id = pr.id and pr.organization_id = v_org
      and bp.property_id = p.id and p.organization_id = v_org and p.name = b.name
      and exists (select 1 from jsonb_to_recordset(v->'products') as k(name text) where k.name = pr.name)
      and not exists (select 1 from jsonb_to_recordset(v->'products') as x(name text, "branchPrices" jsonb) where x.name = pr.name and x."branchPrices" -> b.id is not null);

  -- 6) zonas conocidas: el punto de cada sucursal (con coordenadas)
  update restaurantes.known_zone z set lat = x.lat, lng = x.lng
    from jsonb_to_recordset(v->'zones') as x(name text, lat numeric, lng numeric)
    where z.organization_id = v_org and z.name = x.name;
  insert into restaurantes.known_zone (organization_id, name, lat, lng)
    select v_org, x.name, x.lat, x.lng
    from jsonb_to_recordset(v->'zones') as x(name text, lat numeric, lng numeric)
    where not exists (select 1 from restaurantes.known_zone z where z.organization_id = v_org and z.name = x.name);
  -- 6b) colonias de reparto SIN coordenadas (migracion 056); no pisa una zona que el dueno ya edito.
  insert into restaurantes.known_zone (organization_id, name, lat, lng, fuente, asignacion_fuente, ref_sucursal_slug, ref_km, ref2_sucursal_slug, ref2_km)
    select v_org, x.name, null, null, 'demo_cuenta_ficticia', 'demo_cuenta_ficticia', x."refSlug", x."refKm", x."ref2Slug", x."ref2Km"
    from jsonb_to_recordset(v->'colonias') as x(name text, "refSlug" text, "refKm" numeric, "ref2Slug" text, "ref2Km" numeric)
    where not exists (select 1 from restaurantes.known_zone z where z.organization_id = v_org and z.name = x.name);
  -- 6c) cobertura de entrega: solo a zonas que todavia no tienen ninguna (una colonia que el dueno movio a otra sucursal no se repone en la original).
  insert into restaurantes.branch_delivery_zone (property_id, zone_id, organization_id)
    select p.id, z.id, v_org
    from (
      select x.name as zname, x."branchId" as bid from jsonb_to_recordset(v->'zones') as x(name text, "branchId" text)
      union all
      select c.name, cb.id from jsonb_to_recordset(v->'colonias') as c(name text, "branchIds" jsonb), jsonb_array_elements_text(c."branchIds") as cb(id)
    ) cov
    join jsonb_to_recordset(v->'branches') as b(id text, name text) on b.id = cov.bid
    join core.property p on p.organization_id = v_org and p.name = b.name
    join restaurantes.known_zone z on z.organization_id = v_org and z.name = cov.zname
    where not exists (select 1 from restaurantes.branch_delivery_zone bz where bz.zone_id = z.id)
    on conflict do nothing;

  -- 6d) conocimiento publicado: solo AGREGA lo que falta por titulo (no pisa lo que el dueno edito).
  insert into restaurantes.conocimiento_negocio (organization_id, property_id, titulo, texto, tipo, prioridad, estado, origen, activo)
    select v_org, null, x.titulo, x.texto, x.tipo, x.prioridad, 'publicado', 'importado', true
    from jsonb_to_recordset(v->'conocimiento') as x(titulo text, texto text, tipo text, prioridad smallint)
    where not exists (select 1 from restaurantes.conocimiento_negocio c where c.organization_id = v_org and c.property_id is null and c.titulo = x.titulo);

  -- 7) politica por sucursal: horario (cada una el suyo), minimos, propina, domicilio. Todas visibles en el directorio.
  insert into restaurantes.branch_policy (property_id, organization_id, horario, pedido_minimo_domicilio, pedido_minimo_recoger, propina_politica, visible_en_directorio, acepta_domicilio, dias_domicilio, de_temporada)
    select p.id, v_org, b.horario, b."pedidoMinimoDomicilio", b."pedidoMinimoRecoger", b."propinaPolitica", true, b."aceptaDomicilio",
           case when jsonb_typeof(b."diasDomicilio") = 'array' then (select array_agg(d::smallint) from jsonb_array_elements_text(b."diasDomicilio") d) end,
           false
    from jsonb_to_recordset(v->'branches') as b(name text, horario jsonb, "pedidoMinimoDomicilio" numeric, "pedidoMinimoRecoger" numeric, "propinaPolitica" text, "aceptaDomicilio" boolean, "diasDomicilio" jsonb)
    join core.property p on p.organization_id = v_org and p.name = b.name
    on conflict (property_id) do update set horario = excluded.horario, pedido_minimo_domicilio = excluded.pedido_minimo_domicilio,
      pedido_minimo_recoger = excluded.pedido_minimo_recoger, propina_politica = excluded.propina_politica,
      visible_en_directorio = excluded.visible_en_directorio, acepta_domicilio = excluded.acepta_domicilio,
      dias_domicilio = excluded.dias_domicilio, de_temporada = excluded.de_temporada, updated_at = now();

  -- 8) voz DESHABILITADA (sin gasto de proveedores): re-ejecutar no la habilita ni la vuelve a deshabilitar. voice_id es NOT NULL sin default (migracion 025): va la voz por defecto del catalogo; el prompt y el saludo los pone el operador.
  insert into restaurantes.branch_voice_config (property_id, organization_id, habilitado, voice_id)
    select p.id, v_org, false, 'Kore'
    from jsonb_to_recordset(v->'branches') as b(name text)
    join core.property p on p.organization_id = v_org and p.name = b.name
    on conflict (property_id) do nothing;

  -- 9) promociones: se repara lo que controla el seed (alcance, dias, canales, productos); no se reinician contadores ni is_active.
  insert into restaurantes.promotions (organization_id, code, name, description, type, value, min_order_total, days_of_week, channels, product_ids, auto_apply, property_ids, courtesy_product_ids, courtesy_quantity)
    select v_org, x.code, x.name, x.description, x.type, x.value, x."minOrderTotal", (select array_agg(d::smallint) from jsonb_array_elements_text(x."daysOfWeek") d),
           (select array_agg(c) from jsonb_array_elements_text(x.channels) c),
           (select array_agg(pr.id) from jsonb_array_elements_text(x."productNames") n join restaurantes.products pr on pr.organization_id = v_org and pr.name = n),
           x."autoApply",
           case when x."branchIds" is null or x."branchIds" = 'null'::jsonb then null
                else (select array_agg(p.id order by p.id) from jsonb_array_elements_text(x."branchIds") sid
                      join jsonb_to_recordset(v->'branches') as b(id text, name text) on b.id = sid
                      join core.property p on p.organization_id = v_org and p.name = b.name) end,
           case when x."courtesyProductNames" is null or x."courtesyProductNames" = 'null'::jsonb then null
                else (select array_agg(pr.id) from jsonb_array_elements_text(x."courtesyProductNames") n join restaurantes.products pr on pr.organization_id = v_org and pr.name = n) end,
           x."courtesyQuantity"
    from jsonb_to_recordset(v->'promotions') as x(code text, name text, description text, type text, value numeric, "minOrderTotal" numeric, "daysOfWeek" jsonb, channels jsonb, "productNames" jsonb, "branchIds" jsonb, "autoApply" boolean, "courtesyProductNames" jsonb, "courtesyQuantity" smallint)
    on conflict (organization_id, code) do update set name = excluded.name, description = excluded.description, type = excluded.type, value = excluded.value,
      min_order_total = excluded.min_order_total, days_of_week = excluded.days_of_week, channels = excluded.channels, product_ids = excluded.product_ids,
      auto_apply = excluded.auto_apply, property_ids = excluded.property_ids, courtesy_product_ids = excluded.courtesy_product_ids,
      courtesy_quantity = excluded.courtesy_quantity, updated_at = now();

  -- 10) agente de WhatsApp (perfil generico) de la organizacion. Re-ejecutar solo rellena la espera de rafagas si esta vacia: no pisa lo que el dueno edito.
  insert into restaurantes.whatsapp_agent_config (organization_id, property_id, perfil, agent_name, business_name, tone_style, delivery_time_text, greeting_text, salsas_text, promos_text, large_order_text, reply_debounce_seconds, enabled)
    select v_org, null, w.perfil, w."agentName", w."businessName", w."toneStyle", w."deliveryTimeText", w."greetingText", w."salsasText", w."promosText", w."largeOrderText", w."replyDebounceSeconds", true
    from jsonb_to_recordset(jsonb_build_array(v->'whatsappAgent')) as w(perfil text, "agentName" text, "businessName" text, "toneStyle" text,
      "deliveryTimeText" text, "greetingText" text, "salsasText" text, "promosText" text, "largeOrderText" text, "replyDebounceSeconds" smallint)
    on conflict (organization_id) where property_id is null do update set
      reply_debounce_seconds = coalesce(restaurantes.whatsapp_agent_config.reply_debounce_seconds, excluded.reply_debounce_seconds),
      updated_at = now();
  -- 10b) tiempo de entrega PROPIO de cada sucursal (fila con property_id que copia la de la organizacion y cambia solo delivery_time_text). DO NOTHING si existe.
  insert into restaurantes.whatsapp_agent_config (organization_id, property_id, perfil, agent_name, business_name, tone_style, delivery_time_text, greeting_text, salsas_text, promos_text, escalation_reasons_off, large_order_text, reply_debounce_seconds, enabled)
    select o.organization_id, p.id, o.perfil, o.agent_name, o.business_name, o.tone_style, d."deliveryTimeText", o.greeting_text, o.salsas_text, o.promos_text, o.escalation_reasons_off, o.large_order_text, o.reply_debounce_seconds, o.enabled
    from jsonb_to_recordset(v->'whatsappAgent'->'deliveryByBranch') as d("branchId" text, "deliveryTimeText" text)
    join jsonb_to_recordset(v->'branches') as b(id text, name text) on b.id = d."branchId"
    join core.property p on p.organization_id = v_org and p.name = b.name
    join restaurantes.whatsapp_agent_config o on o.organization_id = v_org and o.property_id is null
    on conflict (organization_id, property_id) where property_id is not null do nothing;

  -- 11) marca de organizacion demo (migracion 037); re-ejecutar no reactiva un widget que el operador apago.
  insert into restaurantes.demo_organization (organization_id, seed_version) values (v_org, v->'demo'->>'seedVersion')
    on conflict (organization_id) do update set seed_version = excluded.seed_version;${owner}
end`;
}

/** Envuelve el cuerpo como bloque anonimo (CLI). */
export function renderDemoCuentaDoBlock(plan: DemoCuentaPlan, options: { readonly ownerEmail?: string | null } = {}): string {
  return `do $seed_dc$\n${renderDemoCuentaPlpgsql(plan, options)}\n$seed_dc$;`;
}
