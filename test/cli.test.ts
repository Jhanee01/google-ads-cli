/**
 * End-to-end through the real commander program with a fake Google Ads API (fetch is mocked):
 * plan → file → apply, and the safety checks around apply.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram, isDenied } from '../src/program.js'
import { resetTokenCache } from '../src/client.js'
import { dateClause, str, id } from '../src/gaql.js'
import { upsertEnv } from '../src/commands/auth.js'

interface Call { url: string; body: any }
let calls: Call[]
let logs: string[]
let dir: string

const CAMPAIGN_ROW = {
  campaign: {
    resourceName: 'customers/111/campaigns/10', id: '10', name: 'Search – City', status: 'ENABLED',
    advertisingChannelType: 'SEARCH', biddingStrategyType: 'TARGET_SPEND',
    geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE_OR_INTEREST' },
  },
  campaignBudget: { resourceName: 'customers/111/campaignBudgets/5', amountMicros: '2000000000', explicitlyShared: false },
}

function fakeApi(url: string, body: any): unknown {
  if (url.includes('oauth2')) return { access_token: 'test-access', expires_in: 3600 }
  if (url.endsWith(':searchStream')) {
    const q: string = body.query
    if (q.includes('FROM customer ')) return [{ results: [{ customer: { id: '111', descriptiveName: 'Demo', currencyCode: 'HUF', timeZone: 'Europe/Budapest' } }] }]
    if (q.includes('FROM campaign_criterion') && q.includes("'KEYWORD'")) return [{ results: [] }]
    if (q.includes('FROM campaign ')) return [{ results: [CAMPAIGN_ROW] }]
    return [{ results: [] }]
  }
  if (url.endsWith(':mutate')) return { results: body.operations.map((_: unknown, i: number) => ({ resourceName: `customers/111/x/${i}` })) }
  throw new Error(`unexpected ${url}`)
}

async function run(...argv: string[]): Promise<any> {
  logs = []
  await buildProgram().exitOverride().parseAsync(['node', 'google-ads', ...argv])
  return JSON.parse(logs.join('\n'))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gads-'))
  Object.assign(process.env, {
    GOOGLE_ADS_CLIENT_ID: 'id', GOOGLE_ADS_CLIENT_SECRET: 'secret', GOOGLE_ADS_REFRESH_TOKEN: 'refresh',
    GOOGLE_ADS_DEVELOPER_TOKEN: 'dev', GOOGLE_ADS_CUSTOMER_ID: '111-000', GOOGLE_ADS_LOGIN_CUSTOMER_ID: '',
    PLANS_DIR: join(dir, 'plans'), AUDIT_LOG: join(dir, 'audit.log.jsonl'), DENY_COMMANDS: '',
  })
  calls = []
  resetTokenCache()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : Object.fromEntries(init.body)
    calls.push({ url, body })
    return new Response(JSON.stringify(fakeApi(url, body)), { status: 200 })
  }))
  vi.spyOn(console, 'log').mockImplementation((s: string) => { logs.push(s) })
})

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const mutateCalls = () => calls.filter(c => c.url.endsWith(':mutate'))

describe('read commands', () => {
  it('ping returns the account as JSON', async () => {
    expect(await run('ping')).toEqual({ status: 'ok', customerId: '111', descriptiveName: 'Demo', currency: 'HUF', timeZone: 'Europe/Budapest' })
    expect(calls.at(-1)!.url).toContain('/customers/111000/googleAds:searchStream')
  })
  it('campaigns converts micros', async () => {
    const [c] = await run('campaigns')
    expect(c).toMatchObject({ id: '10', dailyBudget: 2000, bidding: 'TARGET_SPEND', locationOption: 'PRESENCE_OR_INTEREST' })
  })
})

describe('suggest', () => {
  it('runs every query and reports findings with playbook pages', async () => {
    const res = await run('suggest', '--days', '7')
    expect(res.rules).toBe('defaults')
    expect(res.findings[0]).toMatchObject({ rule: 'no-auction', playbook: 'knowledge/playbook/diagnosis.md' })
    expect(calls.filter(c => c.url.endsWith(':searchStream')).length).toBe(7)
    expect(mutateCalls()).toHaveLength(0)
  })
})

describe('plan → apply', () => {
  it('a write command only validates and writes a plan', async () => {
    const res = await run('set-budget', '--campaign', '10', '--daily', '2500')
    expect(res.status).toBe('planned')
    expect(res.summary[0]).toContain('2000 → 2500')
    const muts = mutateCalls()
    expect(muts).toHaveLength(1)
    expect(muts[0].body.validateOnly).toBe(true)
    expect(existsSync(res.plan)).toBe(true)
  })

  it('apply runs the plan once, then refuses to run it again', async () => {
    const { plan } = await run('add-negative', '--campaign', '10', '--terms', 'free,jobs')
    calls = []
    const res = await run('apply', plan, '--yes')
    expect(res.status).toBe('applied')
    const [m] = mutateCalls()
    expect(m.body.validateOnly).toBeUndefined()
    expect(m.body.operations).toHaveLength(2)
    expect(readFileSync(process.env.AUDIT_LOG!, 'utf8')).toContain('"event":"applied"')
    await expect(run('apply', plan, '--yes')).rejects.toThrow(/already applied/)
  })

  it('refuses an edited plan', async () => {
    const { plan } = await run('set-budget', '--campaign', '10', '--daily', '2500')
    const p = JSON.parse(readFileSync(plan, 'utf8'))
    p.mutations[0].operations[0].update.amountMicros = '90000000000'
    writeFileSync(plan, JSON.stringify(p))
    await expect(run('apply', plan, '--yes')).rejects.toThrow(/hash mismatch/)
  })

  it('refuses an expired plan and a plan for another account', async () => {
    const { plan } = await run('set-bidding', '--campaign', '10', '--strategy', 'max-clicks', '--max-cpc', '400')
    await expect(run('apply', plan, '--yes', '--customer-id', '222')).rejects.toThrow(/for account 111000/)
    const p = JSON.parse(readFileSync(plan, 'utf8'))
    p.expiresAt = '2000-01-01T00:00:00.000Z'
    writeFileSync(plan, JSON.stringify(p))
    await expect(run('apply', plan, '--yes')).rejects.toThrow(/expired/)
  })

  it('refuses to apply without --yes when there is no terminal', async () => {
    const { plan } = await run('set-budget', '--campaign', '10', '--daily', '2500')
    const tty = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
    try {
      await expect(run('apply', plan)).rejects.toThrow(/without --yes/)
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true })
    }
  })

  it('DENY_COMMANDS=apply blocks the agent from applying', async () => {
    const { plan } = await run('set-budget', '--campaign', '10', '--daily', '2500')
    process.env.DENY_COMMANDS = 'apply'
    await expect(run('apply', plan, '--yes')).rejects.toThrow(/blocked by the deny list/)
    expect(mutateCalls().filter(c => !c.body.validateOnly)).toHaveLength(0)
  })
})

describe('helpers', () => {
  it('deny list matches whole names or a prefix*', () => {
    expect(isDenied('apply', ['apply'])).toBe('apply')
    expect(isDenied('set-budget', ['set-*'])).toBe('set-*')
    expect(isDenied('report', ['rep'])).toBeUndefined()
  })
  it('auth updates only its own .env line', () => {
    expect(upsertEnv('A=1\nGOOGLE_ADS_REFRESH_TOKEN=old\nB=2\n', 'GOOGLE_ADS_REFRESH_TOKEN', 'new')).toBe('A=1\nGOOGLE_ADS_REFRESH_TOKEN=new\nB=2\n')
    expect(upsertEnv('A=1', 'GOOGLE_ADS_REFRESH_TOKEN', 'x')).toBe('A=1\nGOOGLE_ADS_REFRESH_TOKEN=x\n')
  })
  it('GAQL guards', () => {
    expect(dateClause(7)).toBe('segments.date DURING LAST_7_DAYS')
    expect(dateClause(90)).toBe('segments.date DURING LAST_30_DAYS')
    expect(str("o'reilly")).toBe("'o\\'reilly'")
    expect(() => id('10 OR 1=1')).toThrow(/numeric/)
  })
})
