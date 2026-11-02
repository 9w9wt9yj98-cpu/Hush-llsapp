# Kylskåpsdörren

Hushållsapp för två: inköpslista, matsedel, recept, städschema, budget och kalender.
Den körs som en webbapp på GitHub Pages, sparar allt i Supabase och kan läggas på hemskärmen på iPhone.
Den skickar inga pushnotiser.

Vill du bara prova? Öppna appen med `?demo` på slutet av adressen. Då sparas allt bara i webbläsaren.

## Kom igång (en gång)

### 1. Skapa databasen i Supabase

1. Skapa ett gratiskonto på [supabase.com](https://supabase.com) och ett nytt projekt (välj region i EU, t.ex. Stockholm eller Frankfurt).
2. Öppna **SQL Editor**, klistra in hela innehållet i [`supabase/schema.sql`](supabase/schema.sql) och tryck **Run**.
3. Gå till **Authentication → Sign In / Providers** och stäng av **Allow new users to sign up**. Då kan ingen annan skapa ett konto.
4. Gå till **Authentication → Users → Add user → Create new user**. Ange en riktig e-postadress (Supabase avvisar ofta påhittade), ett starkt lösenord och kryssa i **Auto Confirm User**. Det här är hushållets gemensamma inloggning, som ni båda använder.

### 2. Koppla appen till databasen

Öppna **Project Settings → API Keys** (eller **Data API**) i Supabase och fyll i [`config.js`](config.js). E-posten kan lämnas tom; då skriver ni in den i appen vid inloggning och den hamnar aldrig i repot:

```js
window.HUSH_CONFIG = {
  supabaseUrl: "https://<ditt-projekt>.supabase.co",
  supabaseKey: "<publishable / anon key>",
  householdEmail: "",
};
```

Den publika nyckeln får ligga i repot. Lösenordet ska **inte** in i repot, och inte heller `service_role`-nyckeln.

### 3. Publicera på GitHub Pages

I repot på GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, välj `main` och `/ (root)`, och spara.
Efter någon minut finns appen på `https://<ditt-användarnamn>.github.io/<repo-namn>/`.

På ett gratiskonto måste repot vara publikt för att Pages ska fungera. Det är okej: koden innehåller ingen hemlig data, och allt ni skriver i appen ligger i Supabase bakom inloggningen.

### 4. Lägg appen på hemskärmen

På varje iPhone: öppna adressen i **Safari**, tryck på dela-knappen och välj **Lägg till på hemskärmen**.
Öppna appen från hemskärmen och logga in med hushållets e-post och lösenord. Det behövs bara en gång per telefon.

Logga in från hemskärmsikonen, inte i Safari: på iPhone har hemskärmsappen en egen inloggning skild från Safari.

## Vanliga frågor

**En ändring syns inte på den andra telefonen.** Ändringar syns direkt när båda har appen öppen. Annars hämtas det senaste när appen öppnas igen.

**Vi vill byta lösenord.** Ändra det i Supabase under **Authentication → Users**. Telefonerna loggas ut när deras inloggning går ut och får logga in med det nya.

**Gratisprojekt i Supabase pausas** efter en längre tid utan användning. Används appen varje vecka händer det inte. Om det händer, öppna projektet på supabase.com och tryck **Restore**.

**Säkerhetskopia:** i Supabase, **Table Editor → items → Export to CSV**.
