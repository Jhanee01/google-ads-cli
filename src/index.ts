#!/usr/bin/env node
import { buildProgram } from './program.js'

buildProgram()
  .parseAsync()
  .catch(err => {
    console.error(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    process.exit(1)
  })
