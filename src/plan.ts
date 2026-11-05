/**
 * Write commands never change the account. They write a PLAN: what would change, why it is
 * safe, the exact API operations, and a hash of those operations. A human reads the plan and
 * runs `google-ads apply <file> --yes`. Give an agent DENY_COMMANDS=apply and it can only propose.
 */
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { config, CliError } from './config.js'
import type { Change, Mutation } from './builders.js'

export const PLAN_KIND = 'google-ads-cli/plan'

export interface Plan {
  kind: typeof PLAN_KIND
  version: 1
  id: string
  command: string
  customerId: string
  createdAt: string
  expiresAt: string
  summary: string[]
  warnings: string[]
  before: unknown
  validated: 'api-validate-only' | 'skipped'
  mutations: Mutation[]
  hash: string
  appliedAt?: string
  results?: unknown[]
}

export function hashMutations(customerId: string, mutations: Mutation[]): string {
  return createHash('sha256').update(JSON.stringify({ customerId, mutations })).digest('hex')
}

export function createPlan(args: {
  command: string
  customerId: string
  change: Change
  before: unknown
  validated: Plan['validated']
  now?: Date
}): Plan {
  if (!args.change.mutations.length) throw new CliError('Nothing to change.')
  const now = args.now ?? new Date()
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
  return {
    kind: PLAN_KIND,
    version: 1,
    id: `${stamp}-${args.command}-${randomBytes(3).toString('hex')}`,
    command: args.command,
    customerId: args.customerId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + config.planTtlHours * 3600_000).toISOString(),
    summary: args.change.summary,
    warnings: args.change.warnings,
    before: args.before,
    validated: args.validated,
    mutations: args.change.mutations,
    hash: hashMutations(args.customerId, args.change.mutations),
  }
}

export function savePlan(plan: Plan, dir = config.plansDir): string {
  mkdirSync(dir, { recursive: true })
  const file = resolve(join(dir, `${plan.id}.json`))
  writeFileSync(file, JSON.stringify(plan, null, 2) + '\n')
  return file
}

export function loadPlan(file: string): Plan {
  if (!existsSync(file)) throw new CliError(`Plan file not found: ${file}`)
  let plan: Plan
  try {
    plan = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new CliError(`Not a valid plan file: ${file}`)
  }
  if (plan?.kind !== PLAN_KIND || plan.version !== 1) throw new CliError(`Not a google-ads-cli plan: ${file}`)
  return plan
}

/** Everything that must hold before a plan may run. */
export function checkPlan(plan: Plan, opts: { customerId?: string; now?: Date } = {}): void {
  if (plan.appliedAt) throw new CliError(`This plan was already applied at ${plan.appliedAt}. Create a new one.`)
  if (hashMutations(plan.customerId, plan.mutations) !== plan.hash) {
    throw new CliError('The plan was edited after it was created (hash mismatch). Create a new plan instead of editing one.')
  }
  if ((opts.now ?? new Date()) > new Date(plan.expiresAt)) {
    throw new CliError(`The plan expired at ${plan.expiresAt}; the account may have changed since. Create a new one.`)
  }
  if (opts.customerId && opts.customerId !== plan.customerId) {
    throw new CliError(`The plan is for account ${plan.customerId}, not ${opts.customerId}.`)
  }
}

export function markApplied(file: string, plan: Plan, results: unknown[], now = new Date()): void {
  writeFileSync(file, JSON.stringify({ ...plan, appliedAt: now.toISOString(), results }, null, 2) + '\n')
}

export function audit(entry: Record<string, unknown>, file = config.auditLog): void {
  mkdirSync(dirname(resolve(file)), { recursive: true })
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
}
