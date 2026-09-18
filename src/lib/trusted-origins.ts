/**
 * Single source of truth for every trusted origin, shared between Better
 * Auth's `trustedOrigins` (auth.ts) and the app-wide `cors()` middleware
 * (index.ts) so the two can't drift apart.
 */

// Comma-separated so both `http://localhost:3001` and a LAN IP (needed for
// testing from a physical mobile device against the same website) can be
// trusted at once, without editing .env every time you switch between them.
const webOrigins = (process.env.WEB_ORIGIN ?? "").split(",").map((o) => o.trim()).filter(Boolean);
const mobileScheme = process.env.MOBILE_SCHEME;

// compose.yml always sets NODE_ENV=production, even for local/LAN dev, so
// it can't signal "is this behind TLS" -- BACKEND_URL's scheme can.
export const isHttpsDeployment = process.env.BACKEND_URL?.startsWith("https://") ?? false;

export const trustedOrigins = [
  ...webOrigins,
  ...(mobileScheme ? [mobileScheme] : []),
  // Expo Go's real origin is exp://<lan-ip>:<port>, dev-only.
  ...(!isHttpsDeployment ? ["exp://", "exp://*", "exp://**"] : []),
];
