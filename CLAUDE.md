# CLAUDE.md

Guide för Claude och andra som arbetar i det här repot.

## Vad det är

**Kylskåpsdörren** är en hushållsapp för två personer, gjord för iPhone (Safari och "Lägg till på hemskärmen").
Sex flikar: **Inköp** (inköpslista med automatisk kategori), **Mat** (matsedel per vecka/månad), **Recept**
(receptbok, ingredienser kan läggas på inköpslistan), **Städ** (återkommande sysslor med intervall), **Budget**
(inkomster/utgifter per månad) och **Kalender** (händelser per dag).

Medvetna avgränsningar: **inga pushnotiser eller påminnelser**, inga personliga konton (hushållet delar en
inloggning), inget byggsteg.

Appen flyttades från en Claude-artifact (där lagringen var `window.claude.use("db")`) till GitHub Pages + Supabase,
så att den kan användas utan Claude-konton.

## Teknik och filer

Ren HTML/CSS/JS utan ramverk, byggverktyg eller npm-beroenden i drift. Filerna serveras som de är av GitHub Pages
från grenen `main`, roten.

| Fil | Innehåll |
|---|---|
| `index.html` | Skal: meta-taggar för iOS/PWA, typsnitt, laddar skripten i ordning `vendor/supabase.js` → `config.js` → `app.js`. |
| `style.css` | All styling. Färger som CSS-variabler på `:root`, mörkt läge via `prefers-color-scheme`. |
| `app.js` | Hela appen (se struktur nedan). |
| `config.js` | Supabase-URL och publik nyckel (tomma ⇒ instruktionsvy). `householdEmail` lämnas tomt med avsikt: e-posten skrivs i inloggningsrutan och sparas i localStorage (`hush-email`), så att ingen personlig adress hamnar i det publika repot. |
| `sw.js` | Service worker: nätet först för egna filer, cache som reserv; cache först för Google Fonts. |
| `manifest.webmanifest`, `icons/` | PWA-manifest och ikoner (180 px apple-touch-icon, 192/512, maskable). |
| `vendor/supabase.js` | Incheckad UMD-bundle av `@supabase/supabase-js` 2.45.4 (ger `window.supabase`). |
| `supabase/schema.sql` | Tabell, RLS-policyer och realtid. Idempotent, kan köras om. |
| `README.md` | Installationssteg för användarna (svenska). |

### Struktur i `app.js`

1. **Lagring** – `supaStore` (Supabase) och `demoStore` (localStorage, aktiveras med `?demo`). Samma gränssnitt:
   `init, session, signIn, signOut, onSignOut, loadAll, live, set, delete`. Byt aldrig lagring någon annanstans än här.
2. **Data och synk** – `data` (en array per samling), `put`/`del` (optimistiska), `onRow`/`onDel` (realtid),
   `mergeAll` (full hämtning), `pending`-kartan.
3. **Hjälpare** – datum (lokala `YYYY-MM-DD`-strängar, `parse` sätter kl. 12 för att undvika sommartidsfel),
   `kr()`, `guessCat()` med nyckelord för inköpskategorier.
4. **Vyer** – en funktion per flik (`vInkop`, `vMat`, …) som returnerar HTML-strängar, plus `vLogin`, `vSetup`.
   `render()` ritar om hela `#app` och bevarar fokus och inmatade värden i fält med `id`.
5. **Bottenark** – `<dialog id="sheet">` för formulär (`sheetItem`, `sheetMeal`, …).
6. **Händelser** – delegerade: `data-a="namn"` → `A.namn(el)` för klick, `data-f="namn"` → `F.namn(values, form)` för formulär.
7. **Anslutning/start** – `ui.phase`: `loading` → `setup` | `login` | `app`.

## Datamodell

En enda tabell `public.items` med primärnyckel `(collection, id)`; själva posten ligger i `data jsonb`.
Samlingar och fält i `data`:

- `shopping`: `name, category, done, createdAt, weekKey?`
- `meals` (id = datumet `YYYY-MM-DD`): `date, recipeId, text`
- `recipes`: `name, servings, ingredients[], instructions, createdAt`
- `chores`: `name, intervalDays, assignee, startDate, lastDone, createdAt` – nästa gång = `lastDone + intervalDays`
- `budget`: `month (YYYY-MM), type (income|expense), label, category, amount`
- `events`: `title, date, time, note`

Ny samling ⇒ lägg till den i `COLS` och `data` i `app.js` **och** i `check`-villkoret i `supabase/schema.sql`
(skriv en `alter table`-migrering för befintliga databaser).

Kolumnerna `ts` (klientens `Date.now()`) och `device` (slumpat id per telefon i localStorage) finns för synken:
en egen skrivning ligger i `pending` tills ekot med samma `ts` och `device` kommer tillbaka, så att sena ekon eller
en äldre `loadAll` inte skriver över det användaren just gjort. Ändringar från den andra telefonen tillämpas alltid.
Senaste skrivningen till servern vinner.

## Inloggning och säkerhet

- Hushållet har **en** gemensam användare i Supabase Auth (e-post och lösenord skrivs i appen, aldrig i repot).
  Registrering är avstängd i Supabase.
- RLS: bara rollen `authenticated` får läsa/skriva `items`; `anon` har inga rättigheter. Den publika nyckeln i
  `config.js` är därför ofarlig att checka in. **Checka aldrig in `service_role`-nyckeln, lösenordet, hushållets e-post eller exporterad data**
  (repot är publikt för att Pages ska fungera gratis).
- Sessionen sparas i localStorage (`hush-auth`). På iPhone har hemskärmsappen egen lagring, skild från Safari.
- All text som ritas ut går genom `esc()`. Behåll det i nya vyer.

## Arbeta lokalt

```sh
python3 -m http.server 8000
# http://localhost:8000/?demo  – fungerar utan Supabase, data i localStorage
# http://localhost:8000/       – använder config.js
```

Service workern registreras bara över https, så den stör inte lokalt. Testa i en smal viewport (iPhone, ~390 px).
Playwright finns i molnmiljön: `require('playwright')`, `devices['iPhone 13']`.

Inga automatiska tester finns; verifiera i webbläsaren, gärna i `?demo` och med två flikar mot riktig Supabase för realtid.

## Konventioner

- **Allt användargränssnitt på svenska**, med datum/valuta via `sv-SE` (`fmt`, `kr`). Kommentarer i koden på svenska.
- Inga ramverk eller byggsteg. Nya bibliotek: lägg en låst version i `vendor/`, inte från CDN.
- Tryckytor minst 44 px, safe-area-insets respekteras, inga horisontella scrollbars på 320 px bredd.
- Felmeddelanden säger vad som hände och vad man kan göra (se `writeError`). Borttagningar ger "Ångra" i toasten.
- **När du ändrar någon fil i `SHELL` i `sw.js`, höj `CACHE`-versionen** (`hush-v1` → `hush-v2`), annars kan
  telefonerna fastna på gamla filer när de är offline.
- Lägg inte till pushnotiser, påminnelser eller personliga konton utan att användarna ber om det.

## Driftsättning

Pusha till `main`; GitHub Pages publicerar automatiskt (Settings → Pages → Deploy from a branch → `main` / root).
Databasändringar körs för hand i Supabase SQL Editor. Se README.md för första installationen.
