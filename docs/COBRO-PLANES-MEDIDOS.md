# Cobro por plan medido (restaurantes primero)

Migraciones: `packages/db/migrations/0080_cobro_planes_medidos.sql` (tarifa del plan) y
`packages/domain-restaurantes/migrations/200_uso_facturable.sql` (uso del mes). Espejos en `supabase/migrations/20240101000700_*` y `..._701_*`.
Verificación contra Postgres real: `scripts/verify-cobro-planes-medidos/` (la corre el gate de CI).

## Por qué

El plan sembrado en 0028 para restaurantes cobra por agente de voz y no cubre el costo medido: la voz es ~85 % del costo
y depende de los **minutos**, no del número de agentes. El precio tiene que vivir en datos, poder ser a la medida de un
cliente y medirse contra lo que de verdad se usó. **Esta migración no siembra ningún precio**: el superadmin lo captura.

## Modelo de la tarifa (`core.plan`, `modelo_cobro = 'medido'`)

| Columna | Significado |
|---|---|
| `precio_base_mxn_centavos` (de 0028) | Cuota fija mensual (sin IVA). |
| `precio_sucursal_mxn_centavos` | Precio por sucursal ACTIVA arriba de `sucursales_incluidas`. NULL = no se cobra por sucursal. |
| `minutos_voz_incluidos` + `minutos_voz_incluidos_por_sucursal` | Minutos incluidos al mes (fijos + por sucursal cubierta). |
| `precio_minuto_voz_excedente_mxn_centavos` | Precio del minuto adicional. NULL = el excedente solo se avisa. |
| `conversaciones_wa_incluidas` + `..._por_sucursal` / `precio_conversacion_wa_excedente_mxn_centavos` | Igual para WhatsApp. |
| `uso_justo_pct` | Tope de uso justo en % de lo incluido (p. ej. 150). Lo que pasa del tope **no se cobra solo**: se marca para renegociar. |
| `cuota_alta_mxn_centavos` | Cuota de alta (una vez, primera factura). |
| `tasa_iva_bp` | IVA en puntos base (1600 = 16 %). El IVA se traslada encima del subtotal. |
| `organizacion_exclusiva_id` | Plan **a la medida**: solo asignable a esa organización (trigger en `core.organization_plan`). |

Los planes existentes quedan como `por_asiento` y siguen igual.

## Unidades medidas

- **Minuto de voz**: suma de `duration_s` de `restaurantes.voice_conversation` con `canal = 'llamada'` (los previews no cuentan) que empezaron en el mes, redondeada hacia arriba sobre el total del mes.
- **Conversación de WhatsApp**: cliente distinto (`phone_hash`) con al menos un mensaje entrante procesado (`restaurantes.whatsapp_inbound_events`) por día del negocio; equivale a la ventana de 24 h de Meta.
- **Mes**: calendario en la zona horaria del negocio, igual que el medidor de mensajes de 0046.

## Cálculo

`@atiende/billing::calcularFacturaPlanMedido(tarifa, uso, { incluirCuotaAlta })` devuelve renglones (cuota fija, sucursales,
excedente de minutos, excedente de conversaciones, cuota de alta), subtotal, IVA, total y avisos (excedente sin precio, uso
justo superado). Todo en centavos enteros. Una tarifa incompleta lanza `TarifaInvalida`: nunca se factura una cifra inventada.

## API

- `GET /superadmin/planes/tarifas`: tarifa de todo el catálogo (superadmin; el rol `finanzas` también la lee).
- `PUT /superadmin/planes/:id/tarifa` (superadmin + step-up MFA): fija la tarifa; los montos van en pesos y la base guarda centavos.
  Primero se crea el plan con `PUT /superadmin/planes/:id` (nombre, vertical, cuota fija); después se le pone la tarifa.
- `GET /billing/plan-medido[?organizationId=&mes=YYYY-MM]` (miembro de la organización o superadmin): tarifa, uso del mes y
  factura **estimada**.

Base sin migrar: las lecturas responden `disponible: false` y la escritura 503; nunca 500.

## Dar de alta un plan a la medida (ejemplo de pasos, sin cifras)

1. `PUT /superadmin/planes/<id>` con `nombre`, `vertical: "restaurantes"` y `precioBaseMxn` (la cuota fija acordada).
2. `PUT /superadmin/planes/<id>/tarifa` con `modeloCobro: "medido"`, `sucursalesIncluidas`, `minutosVozIncluidos`,
   `conversacionesWaIncluidas`, los precios de excedente, `usoJustoPct`, `tasaIvaPct` y `organizacionExclusivaId`.
3. Asignarlo con el flujo de dos pasos de siempre (`POST /superadmin/planes/asignaciones` → confirmar).

## Orden de despliegue

1. Desplegar el código: contra la base vieja todo responde «no disponible» y nada cambia.
2. Aplicar `20240101000700_0080_cobro_planes_medidos.sql` y después `20240101000701_200_uso_facturable.sql` (solo aditivas).
3. Capturar los planes y tarifas desde el superadmin.

## Rollback

Las instrucciones exactas están en la cabecera de cada migración (drop de funciones, triggers y columnas). Se pierde la tarifa capturada.

## Tabulador, bandas de volumen, planes de lista y cotizador (0081, 0082, restaurantes 201)

- **Tabulador por sucursal** (`core.plan_tramo_sucursal`): el precio por sucursal lo fija el TOTAL de sucursales activas (escalón por volumen). Cada tramo puede traer su propia bolsa por sucursal. Tramo con precio NULL = «a cotizar».
- **Bandas de volumen** (`core.plan_banda_uso`): precio GRADUADO por minuto o conversación según el volumen mensual de la cuenta, con el **costo unitario de cada banda** (el costo también baja con el volumen). Si un plan tiene bandas para una métrica, su excedente se cobra por bandas. Banda con precio NULL = volumen a cotizar.
- **Costos unitarios** (`core.cobro_costo_unitario`): minuto de voz, conversación de WhatsApp, fijo por sucursal, número de voz por sucursal (solo planes con voz), fijo por organización y comisión de tarjeta. Los captura el superadmin con su fuente; sin ellos el margen no se calcula (409), nunca se inventa.
- **Margen mínimo por plan** (`core.plan.margen_minimo_pct`); sin él, el cotizador usa el piso de negociación de 55 %.
- **Semillas** (editables; `on conflict do nothing`): planes de lista de autoservicio `restaurantes-basico`, `restaurantes-plus`, `restaurantes-pro` (1 a 2 sucursales; 3 o más = cotizar), `restaurantes-por-uso` (cuota de plataforma por sucursal y bandas) y los planes de **referencia interna** `restaurantes-referencia-*` (inactivos: piso del cotizador, no se muestran ni se asignan). El plan de 0028 `restaurantes-estandar` no se toca: desactivarlo es decisión del dueño.
- **Cotizador** (`POST /superadmin/cotizador/calcular` y `/crear-plan`): calcula factura, costo y margen con los supuestos del cliente (llamadas × minutos por llamada, conversaciones, sucursales) y en el **peor punto** (bolsa llena). Debajo del mínimo bloquea, salvo motivo de ≥ 20 caracteres; queda en `core.cotizacion` (append-only; la regla también es un CHECK) y en la bitácora de planes. `GET /superadmin/cotizaciones/:id/documento` devuelve la cotización imprimible para el cliente, sin costos ni márgenes.
- **Consumo** (`GET /billing/consumo`): llamadas, minutos, duración promedio, conversaciones, pedidos de los agentes, % de la bolsa, factura al corte, **proyección de cierre de mes** con rango (ritmo diario: central lineal, bajo y alto con los percentiles 25 y 75 de los días cerrados), desglose por sucursal (las conversaciones de WhatsApp no se desglosan: el evento entrante no guarda la sucursal) e historial de 6 meses.
- **Margen por organización** (`GET /superadmin/cobro/organizaciones`): ingreso proyectado, costo con los costos unitarios y margen, marcado si queda debajo del mínimo del plan.
- **Avisos de bolsa** (`apps/api/src/plan-topes/aviso-bolsa.ts`): al 80 %, al 100 % y al pasar el uso justo, in-app y por correo al dueño (y a superadmin al pasar el uso justo). Corre en el cron diario existente `/internal/plataforma/prueba-avisos` (no agrega cron; siguen 40 de 40). Reclamo idempotente en `core.cobro_aviso_bolsa`. **Nada se corta.**

Orden de despliegue: código → `20240101000702_0081_*` → `20240101000703_201_*` → `20240101000704_0082_*`. Rollback: cabecera de cada migración.

## Stripe, cobranza y CFDI (0083)

- **Lista permitida de precios** (`core.plan_stripe_precio`): por plan y componente (`cuota_fija`, `sucursal`, `alta`, `minuto_voz_excedente`, `conversacion_wa_excedente`). `PUT /superadmin/planes/:id/stripe-precios/:componente` (step-up) valida el precio contra Stripe: activo, en MXN, recurrente y mayor que $0. El alta es de pago único y los excedentes son precios **medidos** ligados a un meter. `POST /billing/checkout` (el de antes) ya solo acepta precios de esta lista.
- **Autoservicio con tarjeta**: `POST /billing/checkout-plan`. La sucursal se cobra por cantidad, los medidos van sin cantidad y el alta entra solo en la primera factura. El IVA usa `STRIPE_IVA_TAX_RATE_ID`; sin esa variable, responde 503. El periodo se ancla al día 1 en la zona del negocio, así que el periodo de Stripe coincide con el mes que se mide.
- **Enterprise por SPEI**: `POST /superadmin/cobro/organizaciones/:id/suscripcion-spei` (step-up) crea la suscripción por factura (`collection_method=send_invoice`, `customer_balance` + `mx_bank_transfer`, CLABE virtual de Stripe). **OXXO no se ofrece**: Stripe no lo admite en suscripciones ni en facturas, y su tope es de 10,000 MXN por pago.
- **Uso medido**: se reporta a Stripe (`/v1/billing/meter_events`) una vez al día, dentro del cron existente, y una última vez al llegar `invoice.created` del ciclo. Solo se manda la diferencia contra `core.cobro_uso_reportado`, con un identificador idempotente.
- **Cobranza**:
  - `invoice.payment_failed` sube la cobranza a «aviso», luego a «gracia» y luego a «pausa sugerida» (con 3 fallos o a los 7 días). Avisa al dueño y a superadmin. **Nada se pausa solo.**
  - `invoice.paid` regresa la cobranza a «al corriente».
- **CFDI**: cada factura pagada se encola en `core.cfdi_suscripcion_solicitud`. El emisor (`EmisorCfdiSuscripcion`) se conecta al PAC cuando haya CSD y credenciales; por omisión, `EmisorCfdiSinPac` no timbra nada y la solicitud queda «pendiente_pac». Se consultan en `GET /superadmin/cobro/cfdi-pendientes`.

Configuración en Stripe (la hace una persona; no la toca ninguna migración):

1. Crear la tasa de IVA de 16 % exclusiva y ponerla en `STRIPE_IVA_TAX_RATE_ID`.
2. Crear los meters `atiende_minutos_voz` y `atiende_conversaciones_wa`, con agregación por suma.
3. Crear los precios: sucursal o cuota fija, alta (pago único) y excedentes (medidos, graduados si el plan trae bandas).
4. Ligarlos al plan en el superadmin.
5. Habilitar la transferencia bancaria (SPEI) en la cuenta.
6. Suscribir el webhook a `invoice.paid`, `invoice.payment_failed` e `invoice.created`.

Orden de despliegue: código, después `20240101000705_0083_*` y después la configuración de Stripe de arriba.
