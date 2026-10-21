# Geocercas de reparto del perfil PM (`RESTAURANTES_GEOCERCAS`)

Apagada por omisión. Con `RESTAURANTES_GEOCERCAS=1` y SOLO en el perfil `taqueria_pm`:
la cobertura la decide el polígono de cada sucursal (`packages/domain-restaurantes/src/seed/geocercas-pm.ts`) con el pin del cliente; una colonia sin pin pide el pin una vez y, si no hay, la sucursal confirma y se escala;
`crear_pedido` con pin pide solo la referencia; y el prompt agrega las reglas B1-B7. Activarla es decisión del dueño. Sin SQL ni migraciones.

## Qué deja de aplicar al encenderla (evidencia)

Corrida local de toda la suite de `packages/domain-restaurantes` con `RESTAURANTES_GEOCERCAS=1`: 47 pruebas fallan en 8 suites existentes
(más las pruebas propias del paquete que suponen la bandera apagada). Todas fallan por diseño, porque el polígono reemplaza al radio y a la cobertura por colonia:

| Suite | Pruebas | Por qué deja de aplicar |
|---|---|---|
| `sucursal-mas-cercana-cuenta-real.spec.ts` | 21 | Cobertura explícita del dueño por colonia, pines propuestos y corte de 8 km: con pin manda el polígono |
| `sucursal-mas-cercana-8km.spec.ts` | 10 | Radio de 8 km y "sucursal más cercana en km" |
| `pm-r8-guardas-l3.spec.ts` | 6 | Derivación y fuera de zona por km con pin |
| `contadores-agente-whatsapp.spec.ts` | 2 | La colonia sin pin ahora pide el pin y escala, no cuenta como "no reconocida" |
| `demo-pm-guion.spec.ts` | 1 | Los pines del guion se asignan por polígono |
| `pm-r2-no-bloqueantes-revision.spec.ts` | 1 | Tope duro de 8 km |
| `pm-r11-romper/5-negocio-y-privacidad.spec.ts` | 1 | Pin a 12 km: ahora "ninguna zona" |
| `pm-r5-kilos.spec.ts` | 1 | Colonia escrita contra pin compartido |

## Riesgos al encender
1. Un pin fuera de los polígonos (aunque esté a menos de 8 km o en override del dueño) da "ninguna zona", recoger y persona.
2. Colonias cubiertas hoy por radio que queden a más de 60 m fuera pierden el envío.
3. Con pin se ignoran los overrides por colonia; sin pin ninguna colonia afirma cobertura.
4. La sucursal de entrada del chat prevalece sobre el pin donde las zonas se traslapan (T1/T7 y T7/T8).
5. Sin geocerca para T4 y T5, ni coordenadas de colonias como Country Towers.
6. El horario y si la sucursal derivada tiene agente no se verifican: el mensaje manda confirmarlo con la sucursal.
