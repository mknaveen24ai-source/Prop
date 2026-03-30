const newsService = require('./backend/services/newsService')

async function test() {
  await newsService.fetchNews()
  console.log('Total upcoming USD High Impact events:', newsService.events.length)
  if (newsService.events.length > 0) {
    console.log('Next event:', newsService.events[0])
    const active = newsService.getActiveNewsEvent(3)
    console.log('Is within 3-minute window right now?', active ? 'Yes' : 'No')
  }
}
test()
