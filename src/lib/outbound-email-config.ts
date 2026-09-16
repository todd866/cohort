export interface OutboundEmailEnvironment {
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
}

export interface OutboundEmailConfig {
  apiKey: string;
  from: string;
}

/**
 * Outbound email is an operator-owned capability. Requiring both values keeps
 * a copied example environment from enabling a half-configured provider or
 * silently sending under an MD3-owned identity.
 */
export function getOutboundEmailConfig(
  env: OutboundEmailEnvironment = process.env as OutboundEmailEnvironment,
): OutboundEmailConfig | null {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();

  if (!apiKey || !from) return null;

  return { apiKey, from };
}
