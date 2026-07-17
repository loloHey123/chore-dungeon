// Chore Dungeon — site config. No sign-in: the board loads straight away using
// these values.
//
//  apiBase       Where the backend lives. Leave blank to use the same origin
//                (works when the page is served directly by your Mac mini).
//                When you host the page on GitHub Pages, set this to your Mac
//                mini's public URL (e.g. its Cloudflare tunnel URL).
//  housePassword Sent automatically with every request so roommates never see a
//                login. Must match HOUSE_PASSWORD in the server's .env.
window.CHORE_CONFIG = {
  apiBase: '',
  housePassword: 'dungeonmaster',
};
