require('./loadEnv')
const path = require('path')

const migrationsDirectory = path.join(__dirname, 'migrations')
const seedsDirectory = path.join(__dirname, 'seeds')

module.exports = {
  development: {
    client: 'pg',
    connection: process.env.DATABASE_URL,
    migrations: {
      directory: migrationsDirectory,
      extension: 'js',
      loadExtensions: ['.js']
    },
    seeds: {
      directory: seedsDirectory,
      extension: 'js'
    }
  },

  production: {
    client: 'pg',
    connection: process.env.DATABASE_URL,
    migrations: {
      directory: migrationsDirectory,
      extension: 'js',
      loadExtensions: ['.js']
    },
    seeds: {
      directory: seedsDirectory,
      extension: 'js'
    }
  }
}
