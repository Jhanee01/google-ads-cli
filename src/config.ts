import 'dotenv/config'

const env = (name: string, fallback = ''): string => process.env[name]?.trim() || fallback
export const digits = (s: string): string => s.replace(/[^0-9]/g, '')

/** Read lazily, so tests (and --customer-id) can change the environment at runtime. */
export const config = {
  get clientId() { return env('GOOGLE_ADS_CLIENT_ID') },
  get clientSecret() { return env('GOOGLE_ADS_CLIENT_SECRET') },
  get refreshToken() { return env('GOOGLE_ADS_REFRESH_TOKEN') },
  get developerToken() { return env('GOOGLE_ADS_DEVELOPER_TOKEN') },
  get loginCustomerId() { return digits(env('GOOGLE_ADS_LOGIN_CUSTOMER_ID')) },
  get customerId() { return digits(env('GOOGLE_ADS_CUSTOMER_ID')) },
  get apiVersion() { return env('GOOGLE_ADS_API_VERSION', 'v26') },
  get deny() {
    return env('DENY_COMMANDS').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  },
  get maxBudgetChangePct() { return Number(env('MAX_BUDGET_CHANGE_PCT', '50')) },
  get plansDir() { return env('PLANS_DIR', './plans') },
  get auditLog() { return env('AUDIT_LOG', './audit.log.jsonl') },
  get planTtlHours() { return Number(env('PLAN_TTL_HOURS', '24')) },
}

/** An error whose message is meant for the user / agent (printed as JSON, exit code 1). */
export class CliError extends Error {}

/** Validated only right before an API call, so --help works without credentials. */
export function validateConfig(): void {
  const required: Record<string, string> = {
    GOOGLE_ADS_CLIENT_ID: config.clientId,
    GOOGLE_ADS_CLIENT_SECRET: config.clientSecret,
    GOOGLE_ADS_REFRESH_TOKEN: config.refreshToken,
    GOOGLE_ADS_DEVELOPER_TOKEN: config.developerToken,
  }
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k)
  if (missing.length) {
    throw new CliError(`Missing configuration: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`)
  }
}
