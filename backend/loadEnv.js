const path = require('path')
const dotenv = require('dotenv')

let loaded = false

function loadEnv() {
  if (loaded) return

  dotenv.config({
    path: path.join(__dirname, '.env'),
    quiet: true
  })

  loaded = true
}

loadEnv()

module.exports = loadEnv
