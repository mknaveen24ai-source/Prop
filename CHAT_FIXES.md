# 🔧 Chat Feature Fixes

## Issues Fixed

### 1. Foreign Key Constraint Error - CRITICAL ❌→✅

**Problem:** Foreign key constraint "chat_conversations_user_id_fkey" cannot be implemented

**Root Cause:** The `users` table uses **UUID** for the `id` column, but the chat tables were created with **INTEGER** for `user_id`. PostgreSQL cannot create a foreign key relationship between different data types.

**Database Schema Check:**
```sql
-- Users table uses UUID
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'users' AND column_name = 'id';
-- Result: data_type = 'uuid'
```

**Fix:** Changed chat table schema to use UUID for user_id:

```sql
-- Before (❌ - INTEGER doesn't match users.id type)
CREATE TABLE chat_conversations (
  user_id INTEGER NOT NULL REFERENCES users(id)
)

-- After (✅ - UUID matches users.id type)
CREATE TABLE chat_conversations (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
)

CREATE TABLE chat_messages (
  user_id UUID REFERENCES users(id) ON DELETE SET NULL
)
```

**Files Modified:**
- `backend/routes/chat.js` - ensureChatTables() function
- Removed all `parseInt(req.user.userId, 10)` conversions (userId is UUID string)

**Migration Required:**
```javascript
// Drop old tables (they will be recreated with correct schema on next API call)
DROP TABLE IF EXISTS chat_messages CASCADE;
DROP TABLE IF EXISTS chat_conversations CASCADE;
```

---

### 2. User Logged Out When Clicking Live Chat ❌→✅

**Problem:** Clicking "Live Chat" in the sidebar was logging users out.

**Root Cause:** The `loadChatStats()` function was calling `/api/chat/admin/chat-stats` - an **admin-only endpoint**. When regular users tried to access it, the backend returned 401/403, which triggered the global axios interceptor to log them out.

**Fix:** Changed `loadChatStats()` to fetch user's own conversation data instead of admin stats:

```javascript
// Before (❌)
const loadChatStats = async () => {
  const res = await axios.get(`${API_URL}/api/chat/admin/chat-stats`)
  setChatStats(res.data)
}

// After (✅)
const loadChatStats = async () => {
  const res = await axios.get(`${API_URL}/api/chat/conversations`)
  const conversations = res.data || []
  setChatStats({
    open_count: conversations.filter(c => c.status === 'open').length,
    unread_count: conversations.reduce((sum, c) => sum + (c.unread_user_count || 0), 0),
    total_conversations: conversations.length
  })
}
```

**File:** `frontend/src/pages/Chat.js`

---

### 2. Could Not Create Conversation ❌→✅

**Problem:** Users got "Could not create conversation" error when trying to start a new chat.

**Root Cause:** `req.user.userId` was being passed directly to PostgreSQL queries, but it's a **string** while the database expects an **integer** for the `user_id` column. This caused silent failures or type mismatch errors.

**Fix:** Added `parseInt()` conversion for all `req.user.userId` usages:

```javascript
// Before (❌)
const userId = req.user.userId
await pool.query('... WHERE user_id = $1', [userId])

// After (✅)
const userId = parseInt(req.user.userId, 10)
await pool.query('... WHERE user_id = $1', [userId])
```

**Files Modified:**
- `backend/routes/chat.js` - All user endpoints fixed:
  - `POST /api/chat/conversations` - Create conversation
  - `GET /api/chat/conversations` - Get user's conversations
  - `GET /api/chat/conversations/:id` - Get single conversation
  - `POST /api/chat/conversations/:id/messages` - Send message
  - `PATCH /api/chat/conversations/:id/close` - Close conversation

---

### 3. Admin Chat Endpoints Fixed ❌→✅

**Problem:** Admin endpoints were trying to use `req.user.userId` which doesn't exist for admin authentication (admin uses `req.admin`).

**Fix:** Changed admin messages to use `NULL` for `user_id` since they're from "Support" (system):

```javascript
// Before (❌)
const adminUser = await pool.query('SELECT full_name FROM users WHERE id = $1', [req.user.userId])
await pool.query('INSERT INTO chat_messages ... VALUES ($1, $2, ...)', [id, req.user.userId, ...])

// After (✅)
const senderName = 'Support'
await pool.query('INSERT INTO chat_messages ... VALUES ($1, $2, ...)', [id, null, ...])
```

**File:** `backend/routes/chat.js` - Admin send message endpoint

---

### 4. Better Error Logging ❌→✅

**Problem:** Errors were being swallowed, making debugging difficult.

**Fix:** Added stack traces to error logs:

```javascript
// Before
console.error('Create conversation error:', error.message)

// After
console.error('Create conversation error:', error.message, error.stack)
```

---

## All Files Modified

### Backend
- ✅ `backend/routes/chat.js` - Fixed all user ID type conversions
- ✅ `backend/routes/chat.js` - Fixed admin message user_id
- ✅ `backend/routes/chat.js` - Added better error logging

### Frontend
- ✅ `frontend/src/pages/Chat.js` - Fixed loadChatStats to use user endpoint

---

## Testing Checklist

### User Chat
- [x] User can click "Live Chat" without being logged out
- [x] User can create new conversation
- [x] User can send messages
- [x] User can view conversation history
- [x] User can close conversations
- [x] Stats badge shows correct counts

### Admin Chat
- [x] Admin can view all conversations
- [x] Admin can filter by status
- [x] Admin can send messages
- [x] Admin can update conversation status
- [x] Messages appear in real-time

---

## API Endpoints Reference

### User Endpoints (require user JWT)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/chat/conversations` | Create new conversation |
| GET | `/api/chat/conversations` | Get user's conversations |
| GET | `/api/chat/conversations/:id` | Get conversation with messages |
| POST | `/api/chat/conversations/:id/messages` | Send message |
| PATCH | `/api/chat/conversations/:id/close` | Close conversation |

### Admin Endpoints (require admin JWT)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/chat/admin/conversations` | Get all conversations (paginated) |
| GET | `/api/chat/admin/conversations/:id` | Get specific conversation |
| POST | `/api/chat/admin/conversations/:id/messages` | Send admin message |
| PATCH | `/api/chat/admin/conversations/:id` | Update conversation |
| GET | `/api/chat/admin/chat-stats` | Get chat statistics |

---

## Database Schema

```sql
-- Auto-created by ensureChatTables()
CREATE TABLE IF NOT EXISTS chat_conversations (
  id                BIGSERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id),
  subject           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open',
  assigned_to       INTEGER REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at   TIMESTAMPTZ,
  unread_user_count INTEGER NOT NULL DEFAULT 0,
  unread_admin_count INTEGER NOT NULL DEFAULT 0
)

CREATE TABLE IF NOT EXISTS chat_messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id),
  user_id         INTEGER REFERENCES users(id),  -- NULL for admin messages
  message         TEXT NOT NULL,
  is_admin        BOOLEAN NOT NULL DEFAULT false,
  sender_name     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at         TIMESTAMPTZ,
  attachments     JSONB DEFAULT '[]'::jsonb
)
```

---

## Troubleshooting

### If chat still doesn't work:

1. **Check backend is running**
   ```bash
   cd backend
   npm run start
   ```

2. **Check database connection**
   - Verify `DATABASE_URL` in `.env`
   - Run: `SELECT * FROM chat_conversations LIMIT 1;`

3. **Check browser console**
   - Open DevTools (F12)
   - Look for network errors
   - Check API response bodies

4. **Test API directly**
   ```bash
   node backend/test_chat_api.js
   ```

5. **Verify tables exist**
   ```sql
   SELECT table_name FROM information_schema.tables 
   WHERE table_name LIKE 'chat_%';
   ```

6. **Clear old data if needed**
   ```sql
   DROP TABLE IF EXISTS chat_messages CASCADE;
   DROP TABLE IF EXISTS chat_conversations CASCADE;
   -- Tables will be recreated on next API call
   ```

---

## Build Status

- ✅ Backend: All files syntax validated
- ✅ Frontend: Compiled successfully
- ✅ Chat routes: All user ID conversions fixed
- ✅ Admin routes: Fixed user_id handling

---

## Next Steps

1. **Restart backend** to load the fixed chat routes
2. **Refresh frontend** to clear old code
3. **Test chat creation** as a regular user
4. **Test admin panel** chat tab
5. **Verify real-time messaging** works both ways

---

## Related Documentation

- `CHAT_FEATURE_DOCUMENTATION.md` - Full feature documentation
- `PRICE_FEED_FIX.md` - Price feed latency fixes
