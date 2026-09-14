-- Fase 6 §2 — cuentas de sincronización de calendario ALTERNATIVAS a Google
-- (Fase 3, `citas.provider_calendar_accounts`, ya mergeada y sin tocar): Cal.com
-- (API key + eventTypeId, ver domain-citas/src/calcom-port.ts) y CalDAV (RFC 4791 —
-- Apple/iCloud, Fastmail, Nextcloud; URL de colección + usuario + contraseña de
-- aplicación, ver domain-citas/src/caldav-port.ts). Mismo criterio de alcance que
-- provider_calendar_accounts (005_google_calendar_sync.sql): la conexión es POR
-- PROVEEDOR (`citas.providers.id`), nunca por organización/property completa — un
-- calendario personal (de cualquier plataforma) es personal por naturaleza.
--
-- El secreto (API key de Cal.com / contraseña de aplicación de CalDAV) reutiliza
-- LITERALMENTE las mismas funciones de Vault genéricas que ya introdujo
-- 005_google_calendar_sync.sql (`citas.set_provider_calendar_refresh_token`/
-- `citas.get_provider_calendar_refresh_token`) — a pesar del nombre, esas dos
-- funciones son almacenamiento de secreto genérico (guardan/leen cualquier texto
-- bajo un `secret_id` de Vault), no específico de OAuth de Google; no hay ninguna
-- razón para duplicar la misma plomería de Vault por cada plataforma nueva.

create table citas.provider_calcom_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  provider_id uuid not null unique references citas.providers(id) on delete cascade,
  -- La plantilla de duración/disponibilidad de Cal.com contra la que se reserva
  -- (ver calcom-port.ts: "Cal.com no tiene calendarId, el equivalente es el
  -- eventTypeId").
  calcom_event_type_id text not null check (length(calcom_event_type_id) between 1 and 40),
  calcom_api_key_secret_id uuid,
  sync_status text not null default 'disconnected'
    check (sync_status in ('disconnected', 'connected', 'error')),
  sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index provider_calcom_accounts_organization_idx on citas.provider_calcom_accounts (organization_id);

create table citas.provider_caldav_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  provider_id uuid not null unique references citas.providers(id) on delete cascade,
  -- URL completa y ya resuelta de la colección de calendario, con "/" final (ver
  -- caldav-port.ts CalDavPortConfig.calendarCollectionUrl) -- iCloud/Fastmail/
  -- Nextcloud: el profesional la obtiene desde su propia cuenta, este repo no
  -- implementa descubrimiento PROPFIND (decisión de alcance documentada en
  -- caldav-port.ts).
  caldav_calendar_collection_url text not null check (length(caldav_calendar_collection_url) between 1 and 2000),
  caldav_username text not null check (length(caldav_username) between 1 and 320),
  caldav_password_secret_id uuid,
  sync_status text not null default 'disconnected'
    check (sync_status in ('disconnected', 'connected', 'error')),
  sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index provider_caldav_accounts_organization_idx on citas.provider_caldav_accounts (organization_id);

create trigger provider_calcom_accounts_touch_updated_at
  before update on citas.provider_calcom_accounts
  for each row execute function citas.touch_provider_calendar_accounts_updated_at();
create trigger provider_caldav_accounts_touch_updated_at
  before update on citas.provider_caldav_accounts
  for each row execute function citas.touch_provider_calendar_accounts_updated_at();

alter table citas.provider_calcom_accounts enable row level security;
alter table citas.provider_caldav_accounts enable row level security;

create policy "staff gestiona provider_calcom_accounts de su organización" on citas.provider_calcom_accounts for all
  using (exists (select 1 from core.membership m where m.organization_id = provider_calcom_accounts.organization_id and m.user_id = auth.uid()))
  with check (exists (select 1 from core.membership m where m.organization_id = provider_calcom_accounts.organization_id and m.user_id = auth.uid()));
create policy "staff gestiona provider_caldav_accounts de su organización" on citas.provider_caldav_accounts for all
  using (exists (select 1 from core.membership m where m.organization_id = provider_caldav_accounts.organization_id and m.user_id = auth.uid()))
  with check (exists (select 1 from core.membership m where m.organization_id = provider_caldav_accounts.organization_id and m.user_id = auth.uid()));

grant select, insert, update, delete on citas.provider_calcom_accounts, citas.provider_caldav_accounts to service_role;
grant select on citas.provider_calcom_accounts, citas.provider_caldav_accounts to authenticated;
