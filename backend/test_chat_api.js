// Test Chat API
const axios = require('axios')

const API_URL = 'http://localhost:5000'

async function testChatAPI() {
  console.log('=== Testing Chat API ===\n')

  // Test 1: Public price status (should work without auth)
  try {
    const res = await axios.get(`${API_URL}/api/price-status`)
    console.log('✓ Price status endpoint works')
    console.log('  Healthy:', res.data.healthy)
  } catch (err) {
    console.log('✗ Price status endpoint failed:', err.response?.data?.error || err.message)
  }

  // Test 2: Chat without auth (should fail with 401)
  try {
    await axios.get(`${API_URL}/api/chat/conversations`)
    console.log('✗ Chat endpoint should require auth')
  } catch (err) {
    if (err.response?.status === 401) {
      console.log('✓ Chat endpoint correctly requires authentication')
    } else {
      console.log('✗ Chat endpoint error:', err.response?.status, err.response?.data?.error)
    }
  }

  // Test 3: Admin chat stats without auth (should fail with 401)
  try {
    await axios.get(`${API_URL}/api/chat/admin/chat-stats`)
    console.log('✗ Admin chat stats should require auth')
  } catch (err) {
    if (err.response?.status === 401) {
      console.log('✓ Admin chat stats correctly requires authentication')
    } else {
      console.log('✗ Admin chat stats error:', err.response?.status, err.response?.data?.error)
    }
  }

  console.log('\n=== Tests Complete ===')
  console.log('\nNext steps:')
  console.log('1. Make sure backend is running: npm run start (in backend/)')
  console.log('2. Login as a user in the frontend')
  console.log('3. Try creating a chat conversation')
  console.log('4. Check browser console for detailed error messages')
}

testChatAPI().catch(console.error)
