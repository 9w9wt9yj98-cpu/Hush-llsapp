/* Anslutning till Supabase. Se README.md, steg 2.
   Nyckeln här är den publika (publishable/anon) nyckeln. Den får ligga i ett publikt repo,
   eftersom tabellen skyddas av Row Level Security och kräver hushållets inloggning.
   Lägg ALDRIG service_role-nyckeln eller hushållets lösenord här. */
window.HUSH_CONFIG = {
  supabaseUrl: "https://lkvzhiafarrczbikkkno.supabase.co",
  supabaseKey: "",      // Project Settings → API Keys → publishable (anon) key
  householdEmail: "hem@example.com",
};
