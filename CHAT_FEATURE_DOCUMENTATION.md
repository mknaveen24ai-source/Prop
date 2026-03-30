# 💬 Live Chat Support Feature

## Overview
Real-time live chat support system integrated into the prop firm platform, allowing traders to communicate with support staff instantly.

## Features Implemented

### User Features
- **Start new conversations** - Users can create chat conversations with support
- **View conversation history** - All past chats are accessible
- **Real-time messaging** - Messages appear instantly via WebSocket
- **Typing indicators** - See when support is typing
- **Status tracking** - Open, Pending, Resolved, Closed states
- **Unread message badges** - Know when you have new messages
- **Close conversations** - Users can close chats when done

### Admin Features
- **Conversation dashboard** - View all user conversations
- **Filter by status** - Filter conversations by Open, Pending, Resolved, Closed
- **Real-time notifications** - Get notified when users send messages
- **Assign conversations** - Assign chats to specific admins
- **Status management** - Update conversation status
- **Pagination** - Handle large volumes of conversations
- **Stats dashboard** - See open count, unread count, 24h message volume
- **Message history** - Full conversation thread with timestamps

## Files Created/Modified

### Backend
1. **`backend/routes/chat.js`** (NEW)
   - User conversation endpoints
   - Admin conversation management
   - Message sending/receiving
   - Rate limiting (30 messages/minute)

2. **`backend/server.js`** (MODIFIED)
   - Added chat routes import
   - WebSocket chat room support
   - Typing indicator events
   - Real-time message broadcasting

### Frontend
1. **`frontend/src/pages/Chat.js`** (NEW)
   - User chat interface
   - Conversation list sidebar
   - Real-time message display
   - Typing indicators

2. **`frontend/src/pages/Dashboard.js`** (MODIFIED)
   - Added Chat page import
   - Chat page rendering in dashboard

3. **`frontend/src/pages/Admin.js`** (MODIFIED)
   - Added ChatTab component
   - Admin chat management interface
   - Real-time conversation handling

4. **`frontend/src/components/Sidebar.js`** (MODIFIED)
   - Added "Live Chat" navigation item

5. **`frontend/src/App.js`** (MODIFIED)
   - Added Chat route

## API Endpoints

### User Endpoints
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/chat/conversations` | Create new conversation |
| GET | `/api/chat/conversations` | Get user's conversations |
| GET | `/api/chat/conversations/:id` | Get conversation with messages |
| POST | `/api/chat/conversations/:id/messages` | Send message |
| PATCH | `/api/chat/conversations/:id/close` | Close conversation |

### Admin Endpoints
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/chat/admin/conversations` | Get all conversations (paginated) |
| GET | `/api/chat/admin/conversations/:id` | Get specific conversation |
| POST | `/api/chat/admin/conversations/:id/messages` | Send admin message |
| PATCH | `/api/chat/admin/conversations/:id` | Update conversation (status, assign) |
| GET | `/api/chat/admin/chat-stats` | Get chat statistics |

## Database Schema

### `chat_conversations` Table
```sql
CREATE TABLE chat_conversations (
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
```

### `chat_messages` Table
```sql
CREATE TABLE chat_messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id),
  user_id         INTEGER NOT NULL REFERENCES users(id),
  message         TEXT NOT NULL,
  is_admin        BOOLEAN NOT NULL DEFAULT false,
  sender_name     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at         TIMESTAMPTZ,
  attachments     JSONB DEFAULT '[]'::jsonb
)
```

## WebSocket Events

### Client → Server
- `join_chat` - Join a chat room
- `leave_chat` - Leave a chat room
- `typing_start` - Indicate user is typing

### Server → Client
- `chat_new_message` - New message notification
- `chat_message_received` - Message received in active chat
- `user_typing` - Other party is typing

## Security Features

1. **Authentication Required** - All endpoints require valid JWT
2. **Rate Limiting** - 30 messages per minute per user
3. **Authorization Checks** - Users can only access their own conversations
4. **Admin-only Endpoints** - Admin routes require admin JWT
5. **Input Validation** - Message content validated and sanitized
6. **SQL Injection Protection** - Parameterized queries throughout

## Usage

### For Users
1. Navigate to **Dashboard** → **Live Chat** (💬 icon in sidebar)
2. Click **"+ New Chat"** to start a conversation
3. Enter a subject describing your issue
4. Type your message and press Send
5. Wait for real-time response from support
6. Close the conversation when your issue is resolved

### For Admins
1. Navigate to **Admin Panel** → **💬 Live Chat** tab
2. View all conversations with filter options
3. Click **"Chat"** to open a conversation
4. Reply to user messages in real-time
5. Update status (Resolve/Close) as needed
6. Monitor stats for chat volume

## Conversation Statuses

| Status | Description |
|--------|-------------|
| **Open** | New conversation, needs attention |
| **Pending** | Waiting for user response |
| **Resolved** | Issue resolved, can be reopened |
| **Closed** | Conversation permanently closed |

## Future Enhancements (Optional)
- File attachments in chat
- Canned responses for common questions
- Chat transcripts via email
- Multi-language support
- Chat bots for FAQ
- Voice/video call integration
- Customer satisfaction ratings

## Testing Checklist

- [ ] User can create new conversation
- [ ] User can send messages
- [ ] User receives real-time replies
- [ ] Admin can view all conversations
- [ ] Admin can send messages
- [ ] Messages appear in real-time for both parties
- [ ] Conversation status updates work
- [ ] Unread message badges display correctly
- [ ] Rate limiting prevents spam
- [ ] Authorization prevents unauthorized access
- [ ] Mobile responsive design works

## Notes

- Users can only have **one open conversation at a time** (prevents spam)
- Messages are stored indefinitely for audit purposes
- Closed conversations cannot receive new messages
- WebSocket connection auto-reconnects on disconnect
- Typing indicators timeout after 1 second of inactivity
