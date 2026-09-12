-- Fase 5 hoteles (H16-014, REQ-REC-014, P1/SEG) — tabla de alertas de fraude
-- interno. Port de hoteles/packages/db/migrations/0095_fraude_alerta.sql, adaptado
-- al esquema real de atiende-fusion (`organization_id`/`property_id`, no
-- `tenant_id`/`hotel_id`) y ACOTADO a los 2 patrones que domain-hoteles Fase 5
-- porta (`descuento_fuera_de_politica`, `folio_reabierto_post_auditoria`) — ver
-- domain-hoteles/src/fraude/deteccion.ts para por qué los otros 2 patrones del
-- original (`cargo_fnb_no_posteado`, `reembolso_tarjeta_distinta`) quedan fuera de
-- esta fase (requieren un conector PMS/POS real).
--
-- A diferencia de domain-despachos (invoice/invoice_review en dos tablas porque ahí
-- SÍ hay un registro primario propio del CFDI ingerido), aquí la alerta ES el
-- sujeto de la cola de revisión humana: una sola tabla con `status`/
-- `resolved_by`/`resolved_at`, mismo campo que
-- `@atiende/core-authz::requiresHumanReview` gatea en otras verticales.
--
-- Requiere: 001_hoteles_schema.sql ya aplicada (hoteles.folio, hoteles.charge,
-- hoteles.payment, hoteles.can_access_money()).

create type hoteles.fraud_pattern as enum (
  'descuento_fuera_de_politica',
  'folio_reabierto_post_auditoria'
);

create type hoteles.fraud_alert_status as enum ('pendiente', 'confirmado', 'descartado');

create table hoteles.fraud_alert (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  pattern hoteles.fraud_pattern not null,
  folio_id uuid references hoteles.folio(id) on delete set null,
  charge_id uuid references hoteles.charge(id) on delete set null,
  payment_id uuid references hoteles.payment(id) on delete set null,
  reason text not null,
  evidence jsonb not null default '{}'::jsonb,
  -- Lista de hoteles.hotel_role destinatarios (REQ-REC-014: "alerta al destinatario
  -- correspondiente"). jsonb (no `hoteles.hotel_role[]`), mismo criterio ya
  -- documentado por el original: ninguna otra columna de este esquema es un
  -- arreglo tipado, y `evidence` ya usa jsonb vía `JSON.stringify` sin introducir
  -- una superficie nueva.
  recipient_roles jsonb not null default '[]'::jsonb,
  -- Clave determinista de idempotencia de escaneo (deteccion.ts, `dedupeKey`):
  -- re-escanear los mismos datos NUNCA duplica la alerta ya generada.
  dedupe_key text not null,
  status hoteles.fraud_alert_status not null default 'pendiente',
  decision_note text,
  resolved_by uuid references core.staff_user(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint fraud_alert_resolution_consistency check (
    (status = 'pendiente' and resolved_by is null and resolved_at is null)
    or (status <> 'pendiente' and resolved_at is not null)
  )
);
create unique index fraud_alert_dedupe_idx on hoteles.fraud_alert (property_id, dedupe_key);
create index fraud_alert_property_created_idx on hoteles.fraud_alert (organization_id, property_id, created_at desc);

alter table hoteles.fraud_alert enable row level security;

-- Solo owner/gm/accountant (hoteles.can_access_money) ven/gestionan alertas de
-- fraude en esta fase — ambos patrones portados son de dinero/administración
-- (ver FRAUD_VIEW_ROLES/FRAUD_RESOLVER_ROLES en domain-hoteles/src/roles.ts); a
-- diferencia del original, esta fase no suma `fnb` porque el patrón que lo
-- justificaba (`cargo_fnb_no_posteado`) está fuera de alcance.
create policy "dinero: staff con acceso ve alertas de fraude" on hoteles.fraud_alert for select
  using (hoteles.can_access_money(property_id));
create policy "dinero: staff con acceso inserta alertas de fraude" on hoteles.fraud_alert for insert
  with check (hoteles.can_access_money(property_id));
create policy "dinero: staff con acceso resuelve alertas de fraude" on hoteles.fraud_alert for update
  using (hoteles.can_access_money(property_id)) with check (hoteles.can_access_money(property_id));

revoke all on hoteles.fraud_alert from public, anon;
grant select, insert, update on hoteles.fraud_alert to authenticated;
grant select, insert, update, delete on hoteles.fraud_alert to service_role;
