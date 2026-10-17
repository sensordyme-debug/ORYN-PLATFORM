"use client";

import { usernameClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * Browser client for Better Auth's HTTP endpoints. Sign-in goes through
 * /api/auth so its rate limiting and CSRF/origin checks always apply. There
 * is no sign-up: accounts are provisioned by administrators or invitations.
 */
export const authClient = createAuthClient({ basePath: "/api/auth", plugins: [usernameClient()] });
