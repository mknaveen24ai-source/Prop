require('./loadEnv')

module.exports = {
  development: {
    client: 'pg',
    connection: process.env.DATABASE_URL,
    migrations: {
      directory: './migrations',
      extension: 'js',
      loadExtensions: ['.js']
    },
    seeds: {
      directory: './seeds',
      extension: 'js'
    }
  },

  production: {
    client: 'pg',
    connection: process.env.DATABASE_URL,
    migrations: {
      directory: './migrations',
      extension: 'js',
      loadExtensions: ['.js']
    },
    seeds: {
      directory: './seeds',
      extension: 'js'
    }
  }
}
