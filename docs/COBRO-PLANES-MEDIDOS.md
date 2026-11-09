# Cobro por plan medido (restaurantes primero)

Migraciones: `packages/db/migrations/0103_cobro_planes_medidos.sql` (tarifa del plan) y
`packages/domain-restaurantes/migrations/203_uso_facturable.sql` (uso del mes). Espejos en `supabase/migrations/20240101000910_*` y `..._911_*`.
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
2. Aplicar `20240101000910_0103_cobro_planes_medidos.sql` y después `20240101000911_203_uso_facturable.sql` (solo aditivas).
3. Capturar los planes y tarifas desde el superadmin.

## Rollback

Las instrucciones exactas están en la cabecera de cada migración (drop de funciones, triggers y columnas). Se pierde la tarifa capturada.

## Tabulador, bandas de volumen, planes de lista y cotizador (0104, 0105, restaurantes 204)

- **Tabulador por sucursal** (`core.plan_tramo_sucursal`): el precio por sucursal lo fija el TOTAL de sucursales activas (escalón por volumen). Cada tramo puede traer su propia bolsa por sucursal. Tramo con precio NULL = «a cotizar».
- **Bandas de volumen** (`core.plan_banda_uso`): precio GRADUADO por minuto o conversación según el volumen mensual de la cuenta, con el **costo unitario de cada banda** (el costo también baja con el volumen). Si un plan tiene bandas para una métrica, su excedente se cobra por bandas. Banda con precio NULL = volumen a cotizar.
- **Costos unitarios** (`core.cobro_costo_unitario`): minuto de voz, conversación de WhatsApp, fijo por sucursal, número de voz por sucursal (solo planes con voz), fijo por organización y comisión de tarjeta. Los captura el superadmin con su fuente; sin ellos el margen no se calcula (409), nunca se inventa.
- **Margen mínimo por plan** (`core.plan.margen_minimo_pct`); sin él, el cotizador usa el piso de negociación de 55 %.
- **Semillas** (editables; `on conflict do nothing`): planes de lista de autoservicio `restaurantes-basico`, `restaurantes-plus`, `restaurantes-pro` (1 a 2 sucursales; 3 o más = cotizar), `restaurantes-por-uso` (cuota de plataforma por sucursal y bandas) y los planes de **referencia interna** `restaurantes-referencia-*` (inactivos: piso del cotizador, no se muestran ni se asignan). El plan de 0028 `restaurantes-estandar` no se toca: desactivarlo es decisión del dueño.
- **Cotizador** (`POST /superadmin/cotizador/calcular` y `/crear-plan`): calcula factura, costo y margen con los supuestos del cliente (llamadas × minutos por llamada, conversaciones, sucursales) y en el **peor punto** (bolsa llena). Debajo del mínimo bloquea, salvo motivo de ≥ 20 caracteres; queda en `core.cotizacion` (append-only; la regla también es un CHECK) y en la bitácora de planes. `GET /superadmin/cotizaciones/:id/documento` devuelve la cotización imprimible para el cliente, sin costos ni márgenes.
- **Consumo** (`GET /billing/consumo`): llamadas, minutos, duración promedio, conversaciones, pedidos de los agentes, % de la bolsa, factura al corte, **proyección de cierre de mes** con rango (ritmo diario: central lineal, bajo y alto con los percentiles 25 y 75 de los días cerrados), desglose por sucursal (las conversaciones de WhatsApp no se desglosan: el evento entrante no guarda la sucursal) e historial de 6 meses.
- **Margen por organización** (`GET /superadmin/cobro/organizaciones`): ingreso proyectado, costo con los costos unitarios y margen, marcado si queda debajo del mínimo del plan.
- **Avisos de bolsa** (`apps/api/src/plan-topes/aviso-bolsa.ts`): al 80 %, al 100 % y al pasar el uso justo, in-app y por correo al dueño (y a superadmin al pasar el uso justo). Corre en el cron diario existente `/internal/plataforma/prueba-avisos` (no agrega cron; siguen 40 de 40). Reclamo idempotente en `core.cobro_aviso_bolsa`. **Nada se corta.**

Orden de despliegue: código → `20240101000912_0104_*` → `20240101000913_204_*` → `20240101000914_0105_*`. Rollback: cabecera de cada migración.
