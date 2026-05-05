const express = require('express')
const swaggerUi = require('swagger-ui-express')

const router = express.Router()

function buildOpenApiSpec() {
  const serverUrl = process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 5000}`

  return {
    openapi: '3.0.3',
    info: {
      title: 'PropFirm API',
      version: '1.0.0',
      description: 'Operational API docs for the PropFirm platform, including live chat, health, and admin chat workflows.'
    },
    servers: [
      { url: serverUrl, description: 'Configured API server' }
    ],
    tags: [
      { name: 'System', description: 'Health and platform diagnostics' },
      { name: 'Chat', description: 'Trader live chat conversations' },
      { name: 'Admin Chat', description: 'Admin support chat operations' }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        },
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'token'
        },
        adminCookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'admin_token'
        }
      },
      schemas: {
        HealthStatus: {
          type: 'object',
          additionalProperties: true
        },
        ChatConversation: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            user_id: { type: 'string' },
            user_email: { type: 'string' },
            user_name: { type: 'string' },
            subject: { type: 'string' },
            status: { type: 'string', enum: ['open', 'pending', 'resolved', 'closed'] },
            assigned_to: { type: 'string', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
            last_message_at: { type: 'string', format: 'date-time', nullable: true },
            last_message: { type: 'string', nullable: true },
            unread_user_count: { type: 'integer' },
            unread_admin_count: { type: 'integer' },
            message_count: { type: 'integer' }
          }
        },
        ChatMessage: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            conversation_id: { type: 'integer' },
            user_id: { type: 'string', nullable: true },
            message: { type: 'string' },
            is_admin: { type: 'boolean' },
            sender_name: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
            read_at: { type: 'string', format: 'date-time', nullable: true }
          }
        },
        ChatConversationResponse: {
          type: 'object',
          properties: {
            conversation: { $ref: '#/components/schemas/ChatConversation' },
            messages: {
              type: 'array',
              items: { $ref: '#/components/schemas/ChatMessage' }
            }
          }
        },
        ConversationListResponse: {
          type: 'object',
          properties: {
            conversations: {
              type: 'array',
              items: { $ref: '#/components/schemas/ChatConversation' }
            },
            total: { type: 'integer' },
            page: { type: 'integer' },
            limit: { type: 'integer' }
          }
        }
      }
    },
    paths: {
      '/api/health': {
        get: {
          tags: ['System'],
          summary: 'Get platform health',
          responses: {
            200: {
              description: 'Current health summary',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/HealthStatus' }
                }
              }
            }
          }
        }
      },
      '/api/chat/conversations': {
        get: {
          tags: ['Chat'],
          summary: 'List trader conversations',
          security: [{ bearerAuth: [] }, { cookieAuth: [] }],
          responses: {
            200: {
              description: 'Current user conversations',
              content: {
                'application/json': {
                  schema: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/ChatConversation' }
                  }
                }
              }
            }
          }
        },
        post: {
          tags: ['Chat'],
          summary: 'Create a trader conversation',
          security: [{ bearerAuth: [] }, { cookieAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['subject'],
                  properties: {
                    subject: { type: 'string', minLength: 3 }
                  }
                }
              }
            }
          },
          responses: {
            201: {
              description: 'Conversation created'
            }
          }
        }
      },
      '/api/chat/conversations/{id}': {
        get: {
          tags: ['Chat'],
          summary: 'Get one trader conversation',
          security: [{ bearerAuth: [] }, { cookieAuth: [] }],
          parameters: [{
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'integer' }
          }],
          responses: {
            200: {
              description: 'Conversation with messages',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ChatConversationResponse' }
                }
              }
            }
          }
        }
      },
      '/api/chat/conversations/{id}/messages': {
        post: {
          tags: ['Chat'],
          summary: 'Send trader chat message',
          security: [{ bearerAuth: [] }, { cookieAuth: [] }],
          parameters: [{
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'integer' }
          }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['message'],
                  properties: {
                    message: { type: 'string', minLength: 1 }
                  }
                }
              }
            }
          },
          responses: {
            201: {
              description: 'Message sent'
            }
          }
        }
      },
      '/api/chat/admin/conversations': {
        get: {
          tags: ['Admin Chat'],
          summary: 'List admin chat conversations',
          security: [{ bearerAuth: [] }, { adminCookieAuth: [] }],
          parameters: [
            {
              name: 'status',
              in: 'query',
              required: false,
              schema: { type: 'string' }
            },
            {
              name: 'page',
              in: 'query',
              required: false,
              schema: { type: 'integer', default: 1 }
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', default: 20 }
            }
          ],
          responses: {
            200: {
              description: 'Paginated admin chat conversations',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ConversationListResponse' }
                }
              }
            }
          }
        }
      },
      '/api/chat/admin/conversations/{id}': {
        get: {
          tags: ['Admin Chat'],
          summary: 'Get one admin conversation',
          security: [{ bearerAuth: [] }, { adminCookieAuth: [] }],
          parameters: [{
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'integer' }
          }],
          responses: {
            200: {
              description: 'Conversation with messages',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ChatConversationResponse' }
                }
              }
            }
          }
        },
        patch: {
          tags: ['Admin Chat'],
          summary: 'Update admin conversation status',
          security: [{ bearerAuth: [] }, { adminCookieAuth: [] }],
          parameters: [{
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'integer' }
          }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['open', 'pending', 'resolved', 'closed'] },
                    assigned_to: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'Conversation updated'
            }
          }
        }
      },
      '/api/chat/admin/conversations/{id}/messages': {
        post: {
          tags: ['Admin Chat'],
          summary: 'Send admin support reply',
          security: [{ bearerAuth: [] }, { adminCookieAuth: [] }],
          parameters: [{
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'integer' }
          }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['message'],
                  properties: {
                    message: { type: 'string', minLength: 1 }
                  }
                }
              }
            }
          },
          responses: {
            201: {
              description: 'Admin message sent'
            }
          }
        }
      }
    }
  }
}

const openApiSpec = buildOpenApiSpec()

router.get('/openapi.json', function(req, res) {
  res.json(openApiSpec)
})

router.use('/', swaggerUi.serve)
router.get('/', swaggerUi.setup(openApiSpec, {
  explorer: true,
  customSiteTitle: 'PropFirm Swagger Docs'
}))

module.exports = router
