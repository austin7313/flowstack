# FlowStack: WhatsApp Automation System

A **payment intent-driven, event-sourced** WhatsApp automation platform designed for businesses to manage customer conversations, automate follow-ups, and integrate payment processing seamlessly.

## 🎯 Core Architecture

FlowStack is built on three core pillars:

1. **Payment Intent-Driven**: Payments are first-class entities that drive conversation state transitions
2. **Event-Sourced**: All state changes are persisted as immutable events for complete auditability
3. **State Machine**: Conversations follow a strict state machine with validated transitions

## 📊 Conversation States

\`\`\`
NEW_LEAD → ENGAGED → AWAITING_CUSTOMER → DORMANT/ESCALATED/CLOSED
                  ↘ WAITING_FOR_PAYMENT → PAID → CLOSED
                  ↘ CLOSED
\`\`\`

## 💳 Payment Intent Lifecycle

\`\`\`
INITIATED → PENDING → PAID
         ↘ FAILED
         ↘ EXPIRED
\`\`\`

## 🏗️ Project Structure

\`\`\`
flowstack/
├── src/
│   ├── index.js                 # Main application & Express server
│   ├── core.js                  # Constants & core classes
│   ├── stateMachine.js          # State transition logic
│   ├── followUpEngine.js        # Follow-up automation with Bull queue
│   ├── paymentIntentEngine.js   # Payment management
│   ├── mpesaConnector.js        # M-Pesa integration
│   ├── whatsappClient.js        # WhatsApp API abstraction
│   └── db.js                    # PostgreSQL connection pool
├── migrations/
│   ├── 001_create_tables.sql    # Table definitions
│   └── 002_create_functions.sql # Functions, triggers, views
├── scripts/
│   ├── migrate.js               # Run migrations
│   └── seedData.js              # Load test data
├── package.json
├── .env.example
├── .gitignore
└── README.md
\`\`\`

## 🚀 Quick Start

### Prerequisites

- Node.js 16+
- PostgreSQL 14+
- Redis (for job queue)

### Installation

1. **Clone repository**
   \`\`\`bash
   git clone https://github.com/yourusername/flowstack.git
   cd flowstack
   \`\`\`

2. **Install dependencies**
   \`\`\`bash
   npm install
   \`\`\`

3. **Configure environment**
   \`\`\`bash
   cp .env.example .env
   # Edit .env with your credentials
   \`\`\`

4. **Initialize database**
   \`\`\`bash
   npm run migrate
   npm run seed  # Optional: load test data
   \`\`\`

5. **Start application**
   \`\`\`bash
   npm start
   # Or for development with auto-reload
   npm run dev
   \`\`\`

## ⚙️ Configuration

### Environment Variables

\`\`\`env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/flowstack

# WhatsApp (Meta Cloud API )
WHATSAPP_PHONE_NUMBER_ID=123456789
WHATSAPP_ACCESS_TOKEN=your_token
WHATSAPP_VERIFY_TOKEN=your_verify_token

# M-Pesa
MPESA_CONSUMER_KEY=your_key
MPESA_CONSUMER_SECRET=your_secret
MPESA_SHORTCODE=123456
MPESA_PASSKEY=your_passkey
MPESA_ENVIRONMENT=sandbox

# Server
PORT=3000
NODE_ENV=development
REDIS_URL=redis://localhost:6379
CALLBACK_URL=https://yourdomain.com
\`\`\`

## 📡 API Endpoints

### Webhooks

#### WhatsApp Incoming Messages
\`\`\`
POST /webhooks/whatsapp
\`\`\`

#### WhatsApp Webhook Verification
\`\`\`
GET /webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=TOKEN&hub.challenge=CHALLENGE
\`\`\`

#### M-Pesa Payment Callbacks
\`\`\`
POST /webhooks/mpesa
\`\`\`

### Admin API

#### Create Payment Intent
\`\`\`
POST /api/payments/create
Content-Type: application/json

{
  "conversationId": "uuid",
  "amount": 1000
}
\`\`\`

#### Initiate STK Push
\`\`\`
POST /api/payments/stk-push
Content-Type: application/json

{
  "paymentIntentId": "uuid",
  "phoneNumber": "+254712345678"
}
\`\`\`

#### Get Conversation
\`\`\`
GET /api/conversations/:id
\`\`\`

#### List Conversations
\`\`\`
GET /api/conversations?businessId=uuid&state=ENGAGED&limit=50
\`\`\`

#### Health Check
\`\`\`
GET /health
\`\`\`

## 📨 Message Templates

Default templates in \`MessageComposer\`:

| Template Key | Purpose |
|--------------|---------|
| \`welcome_template\` | Initial greeting |
| \`follow_up_gentle\` | 2-hour follow-up |
| \`follow_up_reminder\` | 24-hour follow-up |
| \`payment_pending\` | Payment request |
| \`payment_expired\` | Payment expiry notice |
| \`payment_confirmed\` | Payment confirmation |

### Custom Templates

Businesses can define custom templates in the \`message_templates\` JSONB field.

## 🔄 Background Jobs

Scheduled via \`node-cron\`:

| Job | Frequency | Purpose |
|-----|-----------|---------|
| Follow-up Check | Every 5 minutes | Execute pending follow-ups |
| Payment Expiry Check | Every 10 minutes | Mark expired payments |
| Daily Summary | 6 PM EAT | Send business owner report |

## 📚 Core Classes

### EventBus
- Persists and emits domain events
- In-memory event subscription
- Event sourcing log

### StateMachine
- Validates state transitions
- Only authority for state changes
- Logs all transitions

### PaymentIntentEngine
- Creates payment intents
- Tracks payment status
- Handles payment expiry

### FollowUpEngine
- Schedules follow-ups via Bull queue
- Executes pending tasks
- Composes messages

### MessageComposer
- Renders templates with variable substitution
- Supports AI enhancement (future )
- Business-specific templates

### MessageHandler
- Processes incoming WhatsApp messages
- Creates conversations
- Updates activity tracking

### MPesaConnector
- Integrates with M-Pesa Daraja API
- Initiates STK push
- Handles payment callbacks

## 🔐 Security

- Parameterized queries (SQL injection prevention)
- WhatsApp webhook token verification
- Environment variables for secrets
- State transitions validated before execution

## 📊 Database Design

### Key Tables

- **businesses**: Multi-tenant support
- **conversations**: Customer interactions
- **payment_intents**: Payment requests
- **messages**: Conversation history
- **follow_up_tasks**: Scheduled tasks
- **state_transitions**: Audit log
- **events**: Event sourcing log

### Indexes
All frequently queried fields are indexed for performance.

## 🧪 Development

### Running Tests
\`\`\`bash
npm test
\`\`\`

### Linting
\`\`\`bash
npm run lint
\`\`\`

### Database Migrations

Run migrations:
\`\`\`bash
npm run migrate
\`\`\`

Seed test data:
\`\`\`bash
npm run seed
\`\`\`

## 🐳 Docker Deployment

\`\`\`dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
\`\`\`

## 🔗 Integration Guide

### WhatsApp Setup

1. Create Meta Business Account
2. Set up WhatsApp Cloud API
3. Configure webhook: \`https://yourdomain.com/webhooks/whatsapp\`
4. Add credentials to \`.env\`

### M-Pesa Setup

1. Register for M-Pesa Daraja API
2. Get Consumer Key and Secret
3. Configure STK push endpoint
4. Add credentials to \`.env\`

## 🐛 Troubleshooting

### Database Connection Issues
\`\`\`bash
psql $DATABASE_URL -c "SELECT 1"
\`\`\`

### Missing Environment Variables
\`\`\`bash
node -e "console.log(process.env.DATABASE_URL )"
\`\`\`

### Follow-ups Not Executing
- Check cron job logs
- Verify \`follow_up_tasks\` table has pending tasks
- Ensure MessageComposer templates exist

## 📈 Performance

- Connection pooling configured
- Query optimization with indexes
- Event archival for old data
- Caching layer (future)

## 🚀 Roadmap

- [ ] AI-powered message personalization
- [ ] Multi-language support
- [ ] Advanced analytics dashboard
- [ ] Additional payment providers (Stripe, PayPal)
- [ ] Mobile app for business owners
- [ ] Webhook retry logic with exponential backoff
- [ ] Message scheduling and batching

## 📝 License

MIT License - see LICENSE file for details

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Write tests
5. Submit a pull request

## 📞 Support

For issues, questions, or feature requests, please open an issue on GitHub.
\`\`\`

---

## 📄 FILE 18: LICENSE

**Path:** `flowstack/LICENSE`

\`\`\`
MIT License

Copyright (c) 2024 FlowStack Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
\`\`\`

---

✅ **All 18 files have been provided for copy-paste!** 

**Summary of all files:**
1. package.json
2. .env.example
3. .gitignore
4. .dockerignore
5. src/db.js
6. src/whatsappClient.js
7. src/mpesaConnector.js
8. src/paymentIntentEngine.js
9. src/stateMachine.js
10. src/followUpEngine.js
11. src/core.js
12. src/index.js
13. migrations/001_create_tables.sql
14. migrations/002_create_functions.sql
15. scripts/migrate.js
16. scripts/seedData.js
17. README.md
18. LICENSE

You can now copy-paste each file into your project structure!
