/**
 * TLS for ORYN's two PostgreSQL clients — postgres.js (application queries,
 * migrations, CLIs) and pg (Better Auth) — from the URL's `sslmode` and an
 * optional private CA.
 *
 * `DATABASE_CA_CERT` holds the PEM certificate of the CA that signed the
 * database server's certificate (public, not a secret), for servers whose
 * certificate no system CA vouches for — e.g. Railway's PostgreSQL, which
 * signs its certificate with its own root CA and names its private host in
 * it. With the CA set:
 *
 *   sslmode=verify-full  certificate chain AND host name are verified
 *   sslmode=verify-ca    certificate chain is verified (host name is not)
 *
 * Neither client can load a CA from the URL (postgres.js would send an
 * unknown parameter such as `sslrootcert` to the server), hence the variable.
 * Without it, every mode keeps the client's own behaviour, except that pg
 * gets libpq's meaning of `sslmode=require` (encrypt, do not verify), which
 * postgres.js already has.
 */
import { checkServerIdentity, type ConnectionOptions } from "node:tls";

/** The PEM from DATABASE_CA_CERT; accepts literal "\n" escapes from single-line secret stores. */
export function databaseCaCert(): string | undefined {
  const v = process.env.DATABASE_CA_CERT?.trim();
  if (!v) return undefined;
  const pem = v.includes("\\n") ? v.replace(/\\n/g, "\n") : v;
  if (!/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(pem)) {
    throw new Error("DATABASE_CA_CERT is not a PEM certificate (expected -----BEGIN CERTIFICATE-----).");
  }
  return pem;
}

function sslMode(url: string): string | null {
  try {
    return new URL(url).searchParams.get("sslmode");
  } catch {
    return null;
  }
}

/**
 * Verifying TLS options when the URL asks for verification and a CA is
 * configured. verify-full checks the certificate against the URL's own host
 * explicitly: postgres.js sends no server name for an IP host, and Node would
 * then check the certificate against "localhost" instead.
 */
function verifyingTls(url: string): ConnectionOptions | undefined {
  const mode = sslMode(url);
  if (mode !== "verify-full" && mode !== "verify-ca") return undefined;
  const ca = databaseCaCert();
  if (!ca) return undefined;
  if (mode === "verify-ca") return { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined };
  const host = new URL(url).hostname.replace(/^\[(.*)\]$/, "$1");
  return { ca, rejectUnauthorized: true, checkServerIdentity: (_servername, cert) => checkServerIdentity(host, cert) };
}

/**
 * Options to spread into a postgres.js call. postgres.js prefers an explicit
 * `ssl` option over the URL's sslmode — and treats a present-but-undefined
 * `ssl` key as "no TLS" — so the key is only included when it is set.
 */
export function postgresTlsOptions(url: string): { ssl?: ConnectionOptions } {
  const ssl = verifyingTls(url);
  return ssl ? { ssl } : {};
}

/**
 * Pool options for pg. pg lets the URL's sslmode override an explicit `ssl`
 * option, so sslmode is removed from the URL whenever `ssl` is set here.
 */
export function pgConnectionOptions(url: string): { connectionString: string; ssl?: ConnectionOptions } {
  const verifying = verifyingTls(url);
  const mode = sslMode(url);
  if (!verifying && mode !== "require") return { connectionString: url };
  const u = new URL(url);
  u.searchParams.delete("sslmode");
  return { connectionString: u.toString(), ssl: verifying ?? { rejectUnauthorized: false } };
}
