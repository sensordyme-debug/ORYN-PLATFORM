import { getAuth } from "@/server/auth/auth";
import { handleAuthRequest } from "@/server/auth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Better Auth endpoints: sign-in (username or email), sign-out, session, and
// email password reset. Only an allowlist is served (src/server/auth/http.ts).
// Rate limiting, CSRF/origin checks, and password hashing are handled there.
export const GET = (req: Request) => handleAuthRequest(getAuth, req);
export const POST = (req: Request) => handleAuthRequest(getAuth, req);
