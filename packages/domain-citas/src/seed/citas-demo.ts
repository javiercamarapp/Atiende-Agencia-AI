// Seed REPETIBLE e idempotente de las dos cuentas demo de citas (clinica dental y barberia). Ver
// scripts/seed-citas-demo/README.md. Modulo PURO (sin red ni fs): arma el plan, lo valida y renderiza el bloque plpgsql que
// la CLI ejecuta en UNA transaccion; el verificador contra Postgres real (scripts/verify-citas-demo/) ejecuta ese mismo bloque.
//
// Contrato de seguridad: todo dato es ficticio (telefonos con lada reservada "00", correos @example.test), cada organizacion
// queda marcada en `citas.demo_organization` (migracion 030) y el seed NUNCA toca una organizacion que ya exista y NO sea
// una demo de citas (mismo slug en otra vertical, o en citas pero sin marca => aborta).
import { createHash } from "node:crypto";
import { NEGOCIOS_DEMO } from "./citas-demo-data.ts";
import type { DatosNegocio } from "./citas-demo-data.ts";

export type CitaEstado = "pending" | "confirmed" | "completed" | "cancelled" | "no_show";
export type CitaOrigen = "voice" | "whatsapp" | "web" | "manual";
export type EsperaEstado = "active" | "notified" | "fulfilled" | "cancelled" | "expired";
export type EsperaVentana = "morning" | "afternoon" | "evening" | "any";

export const SEED_VERSION = "citas-demo-1";
export const CITA_ESTADOS: readonly CitaEstado[] = ["pending", "confirmed", "completed", "cancelled", "no_show"];
export const ESPERA_ESTADOS: readonly EsperaEstado[] = ["active", "notified", "fulfilled", "cancelled", "expired"];
/** Estados que ocupan agenda (los mismos de la exclusion `appointments_provider_id_tstzrange_excl` de la migracion 001). */
const ESTADOS_ACTIVOS: ReadonlySet<CitaEstado> = new Set(["pending", "confirmed", "completed"]);

export class CitasSeedError extends Error {}
const fail = (msg: string): never => {
  throw new CitasSeedError(msg);
};

export interface PlanNegocio {
  readonly slug: string;
  readonly nombre: string;
  readonly rubro: string;
  readonly timezone: string;
  readonly sucursal: string;
  readonly servicios: readonly { nombre: string; minutos: number; precioCentavos: number }[];
  readonly proveedores: readonly { nombre: string; rol: string; servicios: readonly string[]; reglas: readonly { dow: number; inicio: string; fin: string }[] }[];
  readonly excepciones: readonly { proveedor: string; semana: number; dow: number; cerrado: boolean; inicio: string | null; fin: string | null; motivo: string }[];
  readonly clientes: readonly { nombre: string; telefono: string; email: string }[];
  readonly citas: readonly { clave: string; idempotencyKey: string; proveedor: string; servicio: string; telefono: string; semana: number; dow: number; hora: string; estado: CitaEstado; origen: CitaOrigen; notas: string | null }[];
  readonly espera: readonly { telefono: string; nombre: string; servicio: string; proveedor: string | null; desde: readonly [number, number]; hasta: readonly [number, number]; ventana: EsperaVentana; estado: EsperaEstado }[];
}

export interface CitasSeedPlan {
  readonly seedVersion: string;
  readonly negocios: readonly PlanNegocio[];
  readonly summary: { readonly negocios: number; readonly servicios: number; readonly proveedores: number; readonly clientes: number; readonly citas: number; readonly citasPorEstado: Readonly<Record<CitaEstado, number>>; readonly espera: number };
}

const aMinutos = (hhmm: string): number => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) return fail(`hora invalida "${hhmm}" (HH:MM)`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/** Telefono ficticio de 10 digitos con lada "00" (inexistente en Mexico): 5200 + indice de negocio + 4 digitos. */
export function telefonoFicticio(negocioIdx: number, clienteIdx: number): string {
  return `5200${negocioIdx}${String(1000 + clienteIdx).padStart(5, "0")}`.slice(0, 10);
}

export function claveIdempotencia(slug: string, clave: string): string {
  return createHash("sha256").update(`seed-citas-demo|${slug}|${clave}`).digest("hex");
}

/** Valida un negocio y lo convierte a plan. Lanza `CitasSeedError` con el motivo exacto: nunca escribe datos a medias. */
export function planDeNegocio(n: DatosNegocio, idx: number): PlanNegocio {
  if (!/^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$/.test(n.slug)) fail(`slug invalido: ${n.slug}`);
  if (!n.slug.endsWith("-demo")) fail(`${n.slug}: el slug de una cuenta demo debe terminar en -demo`);
  const servicios = new Map(n.servicios.map((s) => [s.nombre, s]));
  if (servicios.size !== n.servicios.length) fail(`${n.slug}: servicios duplicados`);
  const proveedores = new Map(n.proveedores.map((p) => [p.nombre, p]));
  if (proveedores.size !== n.proveedores.length) fail(`${n.slug}: proveedores duplicados`);
  for (const s of n.servicios) if (!(s.minutos > 0) || s.precioCentavos < 0) fail(`${n.slug}: servicio invalido ${s.nombre}`);

  const reglas = new Map<string, { dow: number; inicio: string; fin: string }[]>();
  for (const p of n.proveedores) {
    for (const s of p.servicios) if (!servicios.has(s)) fail(`${n.slug}: ${p.nombre} ofrece un servicio inexistente (${s})`);
    const lista: { dow: number; inicio: string; fin: string }[] = [];
    for (const h of p.horario) for (const dow of h.dias) for (const [inicio, fin] of h.tramos) {
      if (!(dow >= 0 && dow <= 6)) fail(`${n.slug}: dia invalido ${dow}`);
      if (aMinutos(fin) <= aMinutos(inicio)) fail(`${n.slug}: tramo invertido ${inicio}-${fin}`);
      lista.push({ dow, inicio, fin });
    }
    reglas.set(p.nombre, lista);
  }

  const emails = new Set<string>();
  const clientes = n.clientes.map((c, i) => {
    const email = c.email.trim().toLowerCase();
    if (!/^[^\s@]+@example\.test$/.test(email)) fail(`${n.slug}: el correo de ${c.nombre} debe ser @example.test`);
    if (emails.has(email)) fail(`${n.slug}: correo repetido ${email}`);
    emails.add(email);
    return { nombre: c.nombre, telefono: telefonoFicticio(idx + 1, i), email };
  });

  const claves = new Set<string>();
  const ocupacion: { prov: string; dia: string; ini: number; fin: number; clave: string }[] = [];
  const citas = n.citas.map((c) => {
    if (claves.has(c.clave)) fail(`${n.slug}: clave de cita repetida ${c.clave}`);
    claves.add(c.clave);
    const prov = proveedores.get(c.proveedor) ?? fail(`${n.slug}/${c.clave}: proveedor inexistente ${c.proveedor}`);
    const svc = servicios.get(c.servicio) ?? fail(`${n.slug}/${c.clave}: servicio inexistente ${c.servicio}`);
    if (!prov.servicios.includes(c.servicio)) fail(`${n.slug}/${c.clave}: ${c.proveedor} no ofrece ${c.servicio}`);
    const cliente = clientes[c.cliente] ?? fail(`${n.slug}/${c.clave}: cliente inexistente ${c.cliente}`);
    if (c.semana === 0) fail(`${n.slug}/${c.clave}: la semana en curso queda libre`);
    if (c.semana < 0 && !(["completed", "no_show", "cancelled"] as string[]).includes(c.estado)) fail(`${n.slug}/${c.clave}: una cita pasada no puede estar ${c.estado}`);
    if (c.semana > 0 && !(["confirmed", "pending", "cancelled"] as string[]).includes(c.estado)) fail(`${n.slug}/${c.clave}: una cita futura no puede estar ${c.estado}`);
    const ini = aMinutos(c.hora);
    const fin = ini + svc.minutos;
    const dentro = (reglas.get(c.proveedor) ?? []).some((r) => r.dow === c.dow && aMinutos(r.inicio) <= ini && fin <= aMinutos(r.fin));
    if (!dentro) fail(`${n.slug}/${c.clave}: ${c.hora} fuera del horario de ${c.proveedor} (dia ${c.dow})`);
    for (const e of n.excepciones) {
      if (e.proveedor !== c.proveedor || e.semana !== c.semana || e.dow !== c.dow || !ESTADOS_ACTIVOS.has(c.estado)) continue;
      if (e.cerrado) fail(`${n.slug}/${c.clave}: cae en un dia cerrado de ${c.proveedor} (${e.motivo})`);
      if (ini < aMinutos(e.inicio ?? "00:00") || fin > aMinutos(e.fin ?? "23:59")) fail(`${n.slug}/${c.clave}: fuera del horario reducido de ${c.proveedor}`);
    }
    if (ESTADOS_ACTIVOS.has(c.estado)) {
      const dia = `${c.semana}/${c.dow}`;
      for (const o of ocupacion) if (o.prov === c.proveedor && o.dia === dia && ini < o.fin && o.ini < fin) fail(`${n.slug}/${c.clave}: se empalma con ${o.clave}`);
      ocupacion.push({ prov: c.proveedor, dia, ini, fin, clave: c.clave });
    }
    return { clave: c.clave, idempotencyKey: claveIdempotencia(n.slug, c.clave), proveedor: c.proveedor, servicio: c.servicio, telefono: cliente.telefono, semana: c.semana, dow: c.dow, hora: c.hora, estado: c.estado, origen: c.origen, notas: c.notas ?? null };
  });
  for (const e of n.excepciones) {
    if (!proveedores.has(e.proveedor)) fail(`${n.slug}: excepcion con proveedor inexistente ${e.proveedor}`);
    if (!e.cerrado && (!e.inicio || !e.fin || aMinutos(e.fin) <= aMinutos(e.inicio))) fail(`${n.slug}: excepcion con horario reducido invalido`);
  }
  for (const estado of CITA_ESTADOS) if (!citas.some((c) => c.estado === estado)) fail(`${n.slug}: falta al menos una cita en estado ${estado}`);

  const esperaTel = new Set<string>();
  const espera = n.espera.map((w, i) => {
    if (!servicios.has(w.servicio)) fail(`${n.slug}: espera con servicio inexistente ${w.servicio}`);
    if (w.proveedor !== null && !proveedores.has(w.proveedor)) fail(`${n.slug}: espera con proveedor inexistente ${w.proveedor}`);
    if (w.hasta[0] * 7 + w.hasta[1] < w.desde[0] * 7 + w.desde[1]) fail(`${n.slug}: espera con rango de fechas invertido`);
    const telefono = telefonoFicticio(idx + 1, 50 + i);
    if (esperaTel.has(telefono)) fail(`${n.slug}: telefono de espera repetido`);
    esperaTel.add(telefono);
    return { telefono, nombre: w.nombre, servicio: w.servicio, proveedor: w.proveedor, desde: w.desde, hasta: w.hasta, ventana: w.ventana, estado: w.estado };
  });
  for (const estado of ESPERA_ESTADOS) if (!espera.some((w) => w.estado === estado)) fail(`${n.slug}: falta al menos una entrada de lista de espera en estado ${estado}`);

  return {
    slug: n.slug,
    nombre: n.nombre,
    rubro: n.rubro,
    timezone: n.timezone,
    sucursal: n.sucursal,
    servicios: n.servicios.map((s) => ({ ...s })),
    proveedores: n.proveedores.map((p) => ({ nombre: p.nombre, rol: p.rol, servicios: [...p.servicios], reglas: reglas.get(p.nombre)! })),
    excepciones: n.excepciones.map((e) => ({ proveedor: e.proveedor, semana: e.semana, dow: e.dow, cerrado: e.cerrado, inicio: e.inicio ?? null, fin: e.fin ?? null, motivo: e.motivo })),
    clientes,
    citas,
    espera,
  };
}

export function buildCitasSeedPlan(negocios: readonly DatosNegocio[] = NEGOCIOS_DEMO): CitasSeedPlan {
  const slugs = new Set<string>();
  const planes = negocios.map((n, i) => {
    if (slugs.has(n.slug)) fail(`slug repetido ${n.slug}`);
    slugs.add(n.slug);
    return planDeNegocio(n, i);
  });
  const citasPorEstado = Object.fromEntries(CITA_ESTADOS.map((e) => [e, planes.reduce((s, p) => s + p.citas.filter((c) => c.estado === e).length, 0)])) as Record<CitaEstado, number>;
  return {
    seedVersion: SEED_VERSION,
    negocios: planes,
    summary: {
      negocios: planes.length,
      servicios: planes.reduce((s, p) => s + p.servicios.length, 0),
      proveedores: planes.reduce((s, p) => s + p.proveedores.length, 0),
      clientes: planes.reduce((s, p) => s + p.clientes.length, 0),
      citas: planes.reduce((s, p) => s + p.citas.length, 0),
      citasPorEstado,
      espera: planes.reduce((s, p) => s + p.espera.length, 0),
    },
  };
}

/** SQL que lista lo que falta en la base para que el seed pueda correr (vacio = todo listo). */
export function renderCitasSchemaPreflightSql(): string {
  return `select faltante, migracion from (values
    ('tabla citas.demo_organization', '030_citas_demo_organization'),
    ('funcion citas.demo_limpiar', '030_citas_demo_organization'),
    ('tabla citas.appointment_waitlist', '003_waitlist_and_rate_limit'),
    ('tabla citas.availability_overrides', '001_citas_schema')
  ) as t(faltante, migracion)
  where (faltante = 'tabla citas.demo_organization' and to_regclass('citas.demo_organization') is null)
     or (faltante = 'funcion citas.demo_limpiar' and to_regprocedure('citas.demo_limpiar(uuid)') is null)
     or (faltante = 'tabla citas.appointment_waitlist' and to_regclass('citas.appointment_waitlist') is null)
     or (faltante = 'tabla citas.availability_overrides' and to_regclass('citas.availability_overrides') is null);`;
}

function assertSinDelimitador(json: string): void {
  if (json.includes("$citas$")) fail("los datos del seed contienen el delimitador $citas$");
}

/**
 * Cuerpo plpgsql del seed (sin envolver). Una sola transaccion (la abre la CLI). Idempotente:
 *   * organizacion por slug estable (si existe como cuenta NO demo de citas o en otra vertical, ABORTA sin tocarla);
 *   * servicios y proveedores por nombre dentro de la organizacion; clientes por (organizacion, telefono);
 *   * horario semanal y excepciones se reescriben (solo existen en esta organizacion demo);
 *   * citas con `idempotency_key` determinista y `on conflict ... do nothing`: re-ejecutar NO duplica ni mueve citas ya sembradas;
 *   * lista de espera por (organizacion, telefono ficticio).
 * Fechas: relativas al lunes de la semana de `fechaBase` (por omision hoy en la zona horaria del negocio); `(fecha + hora)
 * at time zone <zona>` convierte la hora LOCAL a instante UTC, asi el horario de cada cita siempre coincide con el del proveedor.
 * `ownerEmail`: el correo de un usuario de staff que YA existe (nunca crea credenciales); si no existe, el seed ABORTA.
 */
export function renderCitasSeedPlpgsql(plan: CitasSeedPlan, options: { readonly ownerEmail: string; readonly fechaBase?: string | null }): string {
  const email = options.ownerEmail.trim().toLowerCase();
  if (!/^[^\s@'$]+@[^\s@'$]+\.[^\s@'$]+$/.test(email)) fail("ownerEmail invalido.");
  const fechaBase = options.fechaBase ?? null;
  if (fechaBase !== null && !/^\d{4}-\d{2}-\d{2}$/.test(fechaBase)) fail("fechaBase invalida (YYYY-MM-DD).");
  const json = JSON.stringify({ seedVersion: plan.seedVersion, negocios: plan.negocios });
  assertSinDelimitador(json);
  return `declare
  v jsonb := $citas$${json}$citas$::jsonb;
  neg jsonb;
  v_org uuid;
  v_vertical text;
  v_marcada boolean;
  v_prop uuid;
  v_user uuid;
  v_tz text;
  v_lunes date;
  v_base date := ${fechaBase ? `'${fechaBase}'::date` : "null"};
begin
  select id into v_user from core.staff_user where lower(email) = '${email}';
  if v_user is null then
    raise exception 'seed-citas: no existe un usuario de staff con el correo indicado (--owner-email); el seed no crea credenciales.';
  end if;

  for neg in select * from jsonb_array_elements(v->'negocios') loop
    v_tz := neg->>'timezone';
    v_lunes := date_trunc('week', coalesce(v_base, (now() at time zone v_tz)::date)::timestamp)::date;

    -- 1) organizacion: solo se crea o se actualiza una cuenta DEMO de citas; cualquier otra con ese slug aborta.
    select id, vertical into v_org, v_vertical from core.organization where slug = neg->>'slug';
    if v_org is not null then
      select exists (select 1 from citas.demo_organization d where d.organization_id = v_org) into v_marcada;
      if v_vertical <> 'citas' or not v_marcada then
        raise exception 'seed-citas: el slug % ya existe y no es una cuenta demo de citas; no se toca.', neg->>'slug';
      end if;
      update core.organization set name = neg->>'nombre' where id = v_org;
    else
      insert into core.organization (vertical, name, slug) values ('citas', neg->>'nombre', neg->>'slug') returning id into v_org;
    end if;
    insert into citas.demo_organization (organization_id, seed_version) values (v_org, v->>'seedVersion')
      on conflict (organization_id) do update set seed_version = excluded.seed_version;

    insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role)
      values (v_user, v_org, null, 'owner', 'owner')
      on conflict do nothing;

    -- 2) sucursal, configuracion y zona horaria
    select id into v_prop from core.property where organization_id = v_org and name = neg->>'sucursal';
    if v_prop is null then
      insert into core.property (organization_id, vertical, name, status) values (v_org, 'citas', neg->>'sucursal', 'active') returning id into v_prop;
    end if;
    insert into citas.tenant_config (organization_id, rubro, default_timezone) values (v_org, neg->>'rubro', v_tz)
      on conflict (organization_id) do update set rubro = excluded.rubro, default_timezone = excluded.default_timezone, updated_at = now();
    insert into citas.property_config (property_id, organization_id, timezone) values (v_prop, v_org, v_tz)
      on conflict (property_id) do update set timezone = excluded.timezone;

    -- 3) servicios (por nombre)
    update citas.services s set duration_minutes = x.minutos, price_cents = x."precioCentavos", is_active = true, updated_at = now()
      from jsonb_to_recordset(neg->'servicios') as x(nombre text, minutos int, "precioCentavos" int)
      where s.organization_id = v_org and s.name = x.nombre;
    insert into citas.services (organization_id, name, duration_minutes, price_cents)
      select v_org, x.nombre, x.minutos, x."precioCentavos"
      from jsonb_to_recordset(neg->'servicios') as x(nombre text, minutos int, "precioCentavos" int)
      where not exists (select 1 from citas.services s where s.organization_id = v_org and s.name = x.nombre);

    -- 4) proveedores (por nombre) y los servicios que ofrece cada uno
    update citas.providers p set role_label = x.rol, property_id = v_prop, is_active = true, updated_at = now()
      from jsonb_to_recordset(neg->'proveedores') as x(nombre text, rol text)
      where p.organization_id = v_org and p.display_name = x.nombre;
    insert into citas.providers (organization_id, property_id, display_name, role_label)
      select v_org, v_prop, x.nombre, x.rol
      from jsonb_to_recordset(neg->'proveedores') as x(nombre text, rol text)
      where not exists (select 1 from citas.providers p where p.organization_id = v_org and p.display_name = x.nombre);
    insert into citas.provider_services (provider_id, service_id)
      select p.id, s.id
      from jsonb_to_recordset(neg->'proveedores') as x(nombre text, servicios jsonb)
      join citas.providers p on p.organization_id = v_org and p.display_name = x.nombre
      cross join lateral jsonb_array_elements_text(x.servicios) as sn(nombre)
      join citas.services s on s.organization_id = v_org and s.name = sn.nombre
      on conflict do nothing;

    -- 5) horario semanal (se reescribe: solo existe en esta organizacion demo) y excepciones
    delete from citas.availability_rules r using citas.providers p
      where r.provider_id = p.id and p.organization_id = v_org;
    insert into citas.availability_rules (provider_id, day_of_week, start_time, end_time)
      select p.id, r.dow, r.inicio::time, r.fin::time
      from jsonb_to_recordset(neg->'proveedores') as x(nombre text, reglas jsonb)
      join citas.providers p on p.organization_id = v_org and p.display_name = x.nombre
      cross join lateral jsonb_to_recordset(x.reglas) as r(dow int, inicio text, fin text);
    insert into citas.availability_overrides (provider_id, override_date, is_closed, start_time, end_time, reason)
      select p.id, v_lunes + (e.semana * 7) + (case when e.dow = 0 then 6 else e.dow - 1 end), e.cerrado, e.inicio::time, e.fin::time, e.motivo
      from jsonb_to_recordset(neg->'excepciones') as e(proveedor text, semana int, dow int, cerrado boolean, inicio text, fin text, motivo text)
      join citas.providers p on p.organization_id = v_org and p.display_name = e.proveedor
      on conflict (provider_id, override_date) do update set is_closed = excluded.is_closed, start_time = excluded.start_time,
        end_time = excluded.end_time, reason = excluded.reason;

    -- 6) clientes ficticios (por organizacion + telefono)
    insert into citas.customers (organization_id, full_name, phone, email)
      select v_org, c.nombre, c.telefono, c.email
      from jsonb_to_recordset(neg->'clientes') as c(nombre text, telefono text, email text)
      on conflict (organization_id, phone) do update set full_name = excluded.full_name, email = excluded.email, updated_at = now();

    -- 7) citas: llave de idempotencia determinista; re-ejecutar no duplica ni mueve las ya sembradas
    insert into citas.appointments (organization_id, property_id, provider_id, service_id, customer_id, starts_at, ends_at, status, source, notes, idempotency_key, reminder_24h_sent_at)
      select v_org, v_prop, p.id, s.id, cu.id, st.t, st.t + make_interval(mins => s.duration_minutes), a.estado, a.origen, a.notas, a."idempotencyKey",
             case when a.semana < 0 and a.estado in ('completed', 'no_show') then st.t - interval '24 hours' else null end
      from jsonb_to_recordset(neg->'citas') as a(clave text, "idempotencyKey" text, proveedor text, servicio text, telefono text, semana int, dow int, hora text, estado text, origen text, notas text)
      join citas.providers p on p.organization_id = v_org and p.display_name = a.proveedor
      join citas.services s on s.organization_id = v_org and s.name = a.servicio
      join citas.customers cu on cu.organization_id = v_org and cu.phone = a.telefono
      cross join lateral (select ((v_lunes + (a.semana * 7) + (case when a.dow = 0 then 6 else a.dow - 1 end)) + a.hora::time) at time zone v_tz as t) st
      on conflict (organization_id, idempotency_key) where idempotency_key is not null do nothing;

    -- 8) lista de espera (por organizacion + telefono ficticio)
    insert into citas.appointment_waitlist (organization_id, customer_phone, customer_name, service_id, provider_id, preferred_date_from, preferred_date_to,
                                            preferred_time_window, status, notified_count, last_notified_at, expires_at)
      select v_org, w.telefono, w.nombre, s.id, p.id,
             v_lunes + (w.desde[1] * 7) + (case when w.desde[2] = 0 then 6 else w.desde[2] - 1 end),
             v_lunes + (w.hasta[1] * 7) + (case when w.hasta[2] = 0 then 6 else w.hasta[2] - 1 end),
             w.ventana, w.estado,
             case when w.estado in ('notified', 'fulfilled') then 1 else 0 end,
             case when w.estado in ('notified', 'fulfilled') then now() - interval '1 day' else null end,
             case when w.estado = 'expired' then now() - interval '1 day' else now() + interval '30 days' end
      from (select x.telefono, x.nombre, x.servicio, x.proveedor, x.ventana, x.estado,
                   array(select jsonb_array_elements_text(x.desde)::int) as desde, array(select jsonb_array_elements_text(x.hasta)::int) as hasta
            from jsonb_to_recordset(neg->'espera') as x(telefono text, nombre text, servicio text, proveedor text, desde jsonb, hasta jsonb, ventana text, estado text)) w
      join citas.services s on s.organization_id = v_org and s.name = w.servicio
      left join citas.providers p on p.organization_id = v_org and p.display_name = w.proveedor
      where not exists (select 1 from citas.appointment_waitlist q where q.organization_id = v_org and q.customer_phone = w.telefono);
  end loop;
end`;
}

/** Envuelve el cuerpo como bloque anonimo (CLI). */
export function renderCitasSeedDoBlock(plan: CitasSeedPlan, options: { readonly ownerEmail: string; readonly fechaBase?: string | null }): string {
  return `do $seed_citas$\n${renderCitasSeedPlpgsql(plan, options)}\n$seed_citas$;`;
}
