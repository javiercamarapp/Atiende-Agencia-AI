// DEMO-PM -- verificacion SOLO LECTURA de la cuenta demo ya cargada (`npm run demo:pm -- --verificar`, o al final de la carga).
// Una consulta devuelve los HECHOS de la base (un json) y `evaluarVerificacionDemo` los convierte en un checklist con veredicto
// por punto: nada de "parece que cargo". Puro (sin red ni fs) para probarse. Las cifras esperadas son las del perfil T7.
import { DEMO_PERFIL_T7 } from "./demo-volume.ts";

export interface DemoFacts {
  readonly org: { readonly id: string; readonly demo: boolean; readonly activo: boolean } | null;
  readonly sucursales: ReadonlyArray<{ readonly slug: string; readonly status: string }>;
  readonly agente: { readonly perfil: string; readonly enabled: boolean } | null;
  readonly vozT7Habilitada: boolean | null;
  readonly volumen: {
    readonly pedidos: number;
    readonly clientes: number;
    readonly sucursales: number;
    readonly porSlug: Readonly<Record<string, number>>;
    readonly whatsapp: number;
    readonly domicilio: number;
    readonly tarjeta: number;
    readonly clientesRecurrentes: number;
    readonly pedidosDeRecurrentes: number;
    readonly ticketMediano: number | null;
    readonly minutosDomicilioMediana: number | null;
  };
  readonly sesionesWidget: { readonly pedidos: number; readonly conversaciones: number };
}

export interface DemoCheck {
  readonly id: string;
  readonly ok: boolean;
  /** `aviso` = informa un estado honesto que no impide la demo (p. ej. la voz esta apagada a proposito). */
  readonly nivel: "requisito" | "aviso";
  readonly detalle: string;
}

/** Consulta de solo lectura. `$1` = slug de la organizacion demo. Devuelve UNA fila con la columna `hechos` (jsonb). */
export function renderDemoVerificationSql(): string {
  return `
with o as (
  select org.id, (d.organization_id is not null) as demo, coalesce(d.activo, false) as activo
    from core.organization org left join restaurantes.demo_organization d on d.organization_id = org.id
   where org.slug = $1
), ped as (
  select ord.*, right(regexp_replace(ord.customer_phone, '\\D', '', 'g'), 10) as tel
    from restaurantes.orders ord join o on o.id = ord.organization_id
), vol as (select * from ped where tel like '0001%'),
porcliente as (select tel, count(*) filter (where status <> 'cancelado') as n from vol group by tel)
select jsonb_build_object(
  'org', (select to_jsonb(o) from o),
  'sucursales', coalesce((select jsonb_agg(jsonb_build_object('slug', bd.slug, 'status', p.status) order by bd.slug)
                            from restaurantes.branch_detail bd join core.property p on p.id = bd.property_id join o on o.id = bd.organization_id), '[]'::jsonb),
  'agente', (select jsonb_build_object('perfil', c.perfil, 'enabled', c.enabled)
               from restaurantes.whatsapp_agent_config c join o on o.id = c.organization_id where c.property_id is null),
  'vozT7Habilitada', (select v.habilitado from restaurantes.branch_voice_config v join restaurantes.branch_detail bd on bd.property_id = v.property_id
                        join o on o.id = bd.organization_id where bd.slug = '${DEMO_PERFIL_T7.sucursal}'),
  'volumen', jsonb_build_object(
    'pedidos', (select count(*) from vol),
    'clientes', (select count(*) from porcliente),
    'sucursales', (select count(distinct branch) from vol),
    'porSlug', coalesce((select jsonb_object_agg(bd.slug, c.n) from (select property_id, count(*) n from vol group by property_id) c
                           join restaurantes.branch_detail bd on bd.property_id = c.property_id), '{}'::jsonb),
    'whatsapp', (select count(*) from vol where source = 'whatsapp'),
    'domicilio', (select count(*) from vol where canal = 'domicilio'),
    'tarjeta', (select count(*) from vol where payment_method = 'tarjeta'),
    'clientesRecurrentes', (select count(*) from porcliente where n >= 2),
    'pedidosDeRecurrentes', (select coalesce(sum(n), 0) from porcliente where n >= 2),
    'ticketMediano', (select (percentile_cont(0.5) within group (order by total))::numeric(12,2) from vol),
    'minutosDomicilioMediana', (select (percentile_cont(0.5) within group (order by extract(epoch from (delivered_at - created_at)) / 60))::numeric(8,1)
                                  from vol where canal = 'domicilio' and status = 'completado' and delivered_at is not null)),
  'sesionesWidget', jsonb_build_object(
    'pedidos', (select count(*) from ped where tel like '0009%'),
    'conversaciones', (select count(*) from restaurantes.whatsapp_conversations w join o on o.id = w.organization_id
                         where right(regexp_replace(w.phone, '\\D', '', 'g'), 10) like '0009%'))
) as hechos;`;
}

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 100));

/** Checklist con veredicto. `requisito` en falso = la demo NO esta lista; `aviso` = estado honesto a decir tal cual. */
export function evaluarVerificacionDemo(f: DemoFacts): DemoCheck[] {
  const checks: DemoCheck[] = [];
  const req = (id: string, ok: boolean, detalle: string) => checks.push({ id, ok, nivel: "requisito", detalle });
  const aviso = (id: string, ok: boolean, detalle: string) => checks.push({ id, ok, nivel: "aviso", detalle });
  const v = f.volumen;

  req("org-demo", f.org?.demo === true, f.org ? (f.org.demo ? "organizacion marcada como demo" : "la organizacion existe pero NO esta marcada como demo (cargue con --demo)") : "la organizacion no existe: falta el seed");
  req("widget-activo", f.org?.activo === true, f.org?.activo ? "widget publico encendido" : "widget publico apagado (restaurantes.demo_organization.activo = false)");
  const t7 = f.sucursales.find((s) => s.slug === DEMO_PERFIL_T7.sucursal);
  req("t7-activa", t7?.status === "active", t7 ? `T7 Garcia Lavin: ${t7.status}` : "no existe la sucursal T7 (garcia-lavin)");
  req("agente-pm", f.agente?.perfil === "taqueria_pm" && f.agente.enabled, f.agente ? `agente de WhatsApp: perfil ${f.agente.perfil}${f.agente.enabled ? "" : " (apagado)"}` : "sin configuracion del agente de WhatsApp");
  req("volumen-cargado", v.pedidos > 0, `${v.pedidos} pedidos ficticios (0001) de ${v.clientes} clientes`);
  const soloT7 = v.sucursales === 1 && (v.porSlug[DEMO_PERFIL_T7.sucursal] ?? 0) === v.pedidos;
  req("volumen-solo-t7", v.pedidos > 0 && soloT7, soloT7 ? "todo el volumen es de T7" : `volumen repartido en ${v.sucursales} sucursales (perfil t7: limpie con demo:limpiar --modo=volumen y recargue)`);
  req("volumen-ritmo", v.pedidos >= 100 && v.pedidos <= 400, `${v.pedidos} pedidos (el perfil t7 trae ${DEMO_PERFIL_T7.pedidos} en ${DEMO_PERFIL_T7.dias} dias)`);
  const recPct = pct(v.pedidosDeRecurrentes, v.pedidos);
  req("recurrentes", v.pedidos > 0 && recPct >= 65 && recPct <= 80, `${v.clientesRecurrentes} clientes recurrentes con ${v.pedidosDeRecurrentes} pedidos = ${recPct} % de los pedidos no cancelados (el 73 % real se mide sobre todos; rango aceptado 65 a 80 %)`);
  req("whatsapp", v.pedidos > 0 && v.whatsapp === v.pedidos, `${v.whatsapp} de ${v.pedidos} pedidos por WhatsApp`);
  const dom = pct(v.domicilio, v.pedidos);
  req("domicilio", v.pedidos > 0 && dom >= 70 && dom <= 88, `${dom} % a domicilio (real: 79 %)`);
  req("ticket", v.ticketMediano !== null && v.ticketMediano >= 500 && v.ticketMediano <= 800, `ticket mediano $${v.ticketMediano ?? "?"} (real: $643)`);
  req("tiempos", v.minutosDomicilioMediana !== null && v.minutosDomicilioMediana >= 58 && v.minutosDomicilioMediana <= 72, `mediana de entrega a domicilio ${v.minutosDomicilioMediana ?? "?"} min (real: 65)`);
  aviso("voz", true, f.vozT7Habilitada === false ? "voz DESHABILITADA a proposito (sin gasto de proveedores): los KPIs de voz salen en cero" : f.vozT7Habilitada === true ? "voz habilitada: revise que las credenciales de voz existan antes de mostrarla" : "sin configuracion de voz de T7");
  aviso("sesiones-widget", f.sesionesWidget.pedidos === 0 && f.sesionesWidget.conversaciones === 0, f.sesionesWidget.pedidos + f.sesionesWidget.conversaciones === 0 ? "sin sesiones previas del widget" : `quedan ${f.sesionesWidget.pedidos} pedidos y ${f.sesionesWidget.conversaciones} conversaciones de ensayos del widget (demo:limpiar --modo=sesiones_widget)`);
  return checks;
}

/** `true` si todos los requisitos pasan (los avisos no cuentan). */
export function demoLista(checks: readonly DemoCheck[]): boolean {
  return checks.filter((c) => c.nivel === "requisito").every((c) => c.ok);
}
