# CAP-121: Importación múltiple desde una IA externa (zip de chapas recortadas → "Por revisar")

| Jira                                                     | Epic  | Rama                   | Agente    | Estado      |
| -------------------------------------------------------- | ----- | ---------------------- | --------- | ----------- |
| [CAP-121](https://naevatec.atlassian.net/browse/CAP-121) | CAP-7 | `CAP-121-multi-import` | `dev-app` | En revisión |

## Contexto

- Spec: ADR-012; `exchange.md § Multi-import`; `SCREENS.md` #9 Import y § Multi-import; features.md § Defaults when
  unsure y § Place from GPS. Contratos v0.6.0 (CAP-119): `multiImportInstructions`, `MULTI_IMPORT_TEMPLATE`,
  `MULTI_IMPORT_LIMITS`, `parseExchangeUpload`, `normaliseResponseFields`.
- Ya existe: la pantalla Import (`screens/exchange-screen.ts`, renombrada en CAP-120), la lectura de subidas
  (`exchange/answer.ts` `readUpload`, que abre zips con `fflate`), la subida prefirmada (`images/upload.ts`), el códec
  WebP con su respaldo wasm (`images/resize.ts`, CAP-88), el dHash (`images/dhash.ts`), el guard de lote de ADR-009
  (`capture/batch.ts` `BATCH_DHASH_GUARD` = 12) y el lugar por defecto (`capture/place.ts` `defaultPlace`).
- Sin cambios de API, contrato ni infra.

## Pasos

| #   | Paso                                                                                                              | Estado | Commit  |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------ | ------- |
| 1   | `exchange/multi-import.ts`: límites, emparejado por nombre base, preparación de imagen (aplanado, WebP, dHash)    | Hecho  | este PR |
| 2   | Ejecución por pares: guard dentro del zip, `POST /scans/analyse` (`useAi: false`), marca + variante, `POST /caps` | Hecho  | este PR |
| 3   | `screens/multi-import-section.ts`: pedir (prompt, plantilla, formato de foto), subir, progreso, resumen           | Hecho  | este PR |
| 4   | Import con dos secciones «Una chapa · Varias chapas»; i18n es/en; tests y fixture sintético                       | Hecho  | este PR |

## Preguntas abiertas y decisiones

| #   | Paso | Pregunta                                                                     | Recomendación                                                                                                                                                                                                                                                                       | Decisión (fecha) |
| --- | ---- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Q1  | 1    | ¿Qué es el «fondo neutro que usa `cropCircle`» para aplanar antes del dHash? | No hay una constante: lo único que `cropCircle` deja fuera de la chapa es el negro transparente de `maskCircle`, y el dHash ignora el alfa. Aplanar = componer sobre negro (RGB × α) y hacer el dHash del cuadrado inscrito, igual que un escaneo. `SPEC-GAP CAP-121` en el código. | Así (2026-11-28) |
| Q2  | 2    | «Hasta 2 a la vez» frente a «repetida respecto a un par anterior».           | La preparación de imagen (decodificar, WebP, dHash) del par siguiente corre mientras se procesa el actual (2 en vuelo); las comprobaciones de duplicado y el guardado van en orden del zip, de uno en uno. Así el resultado no depende del azar.                                    | Así (2026-11-28) |
| Q3  | 2    | Un JSON sin marca: `brand` es obligatorio en `CapInput`.                     | Guardar con marca «Unknown», el mismo nombre que exige el prompt para el archivo, y saltar la comprobación de marca. `SPEC-GAP CAP-121`.                                                                                                                                            | Así (2026-11-28) |
| Q4  | 5    | ¿Qué pasa con los pares no procesados al cancelar?                           | Filas «con errores» con motivo «cancelada»: el resumen las cuenta y «Reintentar fallidas» las retoma.                                                                                                                                                                               | Así (2026-11-28) |
| Q5  | 5    | ¿Cuenta «Importadas» los posibles duplicados (que también se guardan)?       | Recuentos exclusivos: cada fila cae en una sola categoría y la suma da el número de filas.                                                                                                                                                                                          | Así (2026-11-28) |
| Q6  | 4    | IDs de test: la historia dice `T-app-237…`, pero 237–239 son de CAP-120.     | Empezar en `T-app-240`.                                                                                                                                                                                                                                                             | Así (2026-11-28) |

## Cambios de decisión

## Notas

- El proveedor del JSON (`provider`) se pasa a minúsculas con guiones (`Anthropic` → `external:anthropic`); sin
  proveedor, `external:unknown`.
- `acquiredWhere` se pide una sola vez por importación (`defaultPlace`); sin lugar, se omite.
