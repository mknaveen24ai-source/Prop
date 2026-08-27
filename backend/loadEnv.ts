import path from 'node:path'
import dotenv from 'dotenv'
import { RUNTIME_ROOT } from './config/runtimePaths'

let loaded = false

function loadEnv(): void {
  if (loaded) return

  dotenv.config({
    path: path.join(RUNTIME_ROOT, '.env'),
    quiet: true
  })

  loaded = true
}

loadEnv()

export default loadEnv
