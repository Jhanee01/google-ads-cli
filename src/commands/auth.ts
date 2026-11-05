import type { Command } from 'commander'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config, CliError } from '../config.js'

const SCOPE = 'https://www.googleapis.com/auth/adwords'

/** Sets KEY=value in an .env file, keeping every other line. */
export function upsertEnv(text: string, key: string, value: string): string {
  const line = `${key}=${value}`
  const re = new RegExp(`^${key}=.*$`, 'm')
  if (re.test(text)) return text.replace(re, line)
  return `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`
}

export function registerAuth(program: Command): void {
  program.command('auth').description(`Get a new refresh token in the browser and save it into .env.

Needs GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET of a "Desktop app" OAuth client.
Opens a one-time local callback on 127.0.0.1, then writes GOOGLE_ADS_REFRESH_TOKEN into the .env
file. The token itself is never printed.`)
    .option('--env-file <path>', '.env file to update', '.env')
    .action(async (o: { envFile: string }) => {
      if (!config.clientId || !config.clientSecret) {
        throw new CliError('Set GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET in .env first.')
      }
      const state = randomBytes(16).toString('hex')
      const code = await new Promise<{ code: string; redirectUri: string }>((done, fail) => {
        const server = createServer((req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          if (url.pathname !== '/callback') { res.writeHead(404).end(); return }
          const ok = url.searchParams.get('state') === state && url.searchParams.get('code')
          res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(ok ? 'Done. You can close this tab and return to the terminal.' : 'Authorization failed.')
          server.close()
          if (ok) done({ code: url.searchParams.get('code')!, redirectUri })
          else fail(new CliError(`Authorization failed: ${url.searchParams.get('error') ?? 'state mismatch'}`))
        })
        let redirectUri = ''
        server.listen(0, '127.0.0.1', () => {
          const port = (server.address() as { port: number }).port
          redirectUri = `http://127.0.0.1:${port}/callback`
          const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
          auth.search = new URLSearchParams({
            client_id: config.clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
            access_type: 'offline', prompt: 'consent', state,
          }).toString()
          console.error(`Open this URL, sign in with the user that can access the Google Ads account:\n\n${auth}\n`)
        })
        setTimeout(() => { server.close(); fail(new CliError('Timed out after 5 minutes.')) }, 300_000).unref()
      })

      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: code.code, client_id: config.clientId, client_secret: config.clientSecret,
          redirect_uri: code.redirectUri, grant_type: 'authorization_code',
        }),
      })
      if (!res.ok) throw new CliError(`Token exchange failed (${res.status}): ${await res.text()}`)
      const data = (await res.json()) as { refresh_token?: string }
      if (!data.refresh_token) throw new CliError('Google returned no refresh token. Remove the app at myaccount.google.com/permissions and retry.')
      const file = resolve(o.envFile)
      writeFileSync(file, upsertEnv(existsSync(file) ? readFileSync(file, 'utf8') : '', 'GOOGLE_ADS_REFRESH_TOKEN', data.refresh_token))
      console.log(JSON.stringify({ status: 'ok', saved: `GOOGLE_ADS_REFRESH_TOKEN in ${file}`, next: 'google-ads ping' }))
    })
}
