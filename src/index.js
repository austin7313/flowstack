/**
 * FlowStack Main Application
 * Orchestrates all modules and sets up Express server
 */

require('dotenv').config();

const express = require('express');
const cron = require('node-cron');

const db = require('./db');
const WhatsAppClient = require('./whatsappClient');
const MPesaConnector = require('./mpesaConnector');
const FollowUpEngine = require('./followUpEngine');
const StateMachine = require('./stateMachine');
const PaymentIntentEngine = require('./paymentIntentEngine');

const {
  EventBus,
  MessageComposer,
  OwnerNotifier,
  MessageHandler,
  EventProcessor,
  CONVERSATION_STATES,
  PAYMENT_INTENT_STATUS
} = require('./core');

// ============================================================================
// APPLICATION CLASS
// ============================================================================

class FlowStackApp {
  constructor(config) {
    this.config = config;

    // Initialize core modules
    this.eventBus = new EventBus();
    this.messageComposer = new MessageComposer();
    this.stateMachine = new StateMachine(this.eventBus);
    this.paymentEngine = new PaymentIntentEngine(this.eventBus, this.stateMachine);

    // Initialize clients
    this.whatsapp = new WhatsAppClient({
      WHATSAPP_PHONE_NUMBER_ID: config.WHATSAPP_PHONE_NUMBER_ID,
      WHATSAPP_ACCESS_TOKEN: config.WHATSAPP_ACCESS_TOKEN,
      WHATSAPP_VERIFY_TOKEN: config.WHATSAPP_VERIFY_TOKEN
    });

    this.mpesa = new MPesaConnector(config, this.paymentEngine);

    // Initialize engines
    this.followUpEngine = new FollowUpEngine(
      this.whatsapp,
      this.messageComposer,
      this.eventBus
    );

    this.ownerNotifier = new OwnerNotifier(
      this.whatsapp,
      this.eventBus,
      this.messageComposer
    );

    this.messageHandler = new MessageHandler(
      this.stateMachine,
      this.eventBus
    );

    this.eventProcessor = new EventProcessor(
      this.stateMachine,
      this.eventBus
    );

    // Setup Express
    this.app = express();
    this.app.use(express.json());

    this.setupRoutes();
    this.setupEventListeners();
    this.setupCronJobs();
  }

  // ==========================================================================
  // ROUTES
  // ==========================================================================

  setupRoutes() {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date() });
    });

    // WhatsApp webhook verification
    this.app.get('/webhooks/whatsapp', (req, res) => {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];

      if (mode === 'subscribe' && this.whatsapp.verifyWebhook(token)) {
        console.log('✓ WhatsApp webhook verified');
        res.status(200).send(challenge);
      } else {
        res.status(403).send('Forbidden');
      }
    });

    // WhatsApp incoming messages
    this.app.post('/webhooks/whatsapp', async (req, res) => {
      try {
        const messages = this.whatsapp.parseIncomingMessage(req.body);

        for (const message of messages) {
          await this.messageHandler.handleIncomingMessage(message);
        }

        res.status(200).json({ success: true });
      } catch (error) {
        console.error('WhatsApp webhook error:', error);
        res.status(500).json({ error: 'Internal error' });
      }
    });

    // M-Pesa payment callback
    this.app.post('/webhooks/mpesa', async (req, res) => {
      try {
        await this.mpesa.handleCallback(req.body);
        res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
      } catch (error) {
        console.error('M-Pesa webhook error:', error);
        res.status(500).json({ error: 'Internal error' });
      }
    });

    // Admin API: Create payment intent
    this.app.post('/api/payments/create', async (req, res) => {
      try {
        const { conversationId, amount } = req.body;

        // Transition to WAITING_FOR_PAYMENT
        await this.stateMachine.transitionTo(
          conversationId,
          CONVERSATION_STATES.WAITING_FOR_PAYMENT,
          'payment_requested',
          'staff'
        );

        // Create intent
        const intent = await this.paymentEngine.createIntent(conversationId, amount);

        res.json({ success: true, intent });
      } catch (error) {
        console.error('Payment creation error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Admin API: Initiate STK push
    this.app.post('/api/payments/stk-push', async (req, res) => {
      try {
        const { paymentIntentId, phoneNumber } = req.body;

        const intent = await this.paymentEngine.getIntent(paymentIntentId);
        if (!intent) {
          return res.status(404).json({ error: 'Payment intent not found' });
        }

        const checkoutRequestID = await this.mpesa.initiatePayment(
          paymentIntentId,
          phoneNumber,
          intent.expected_amount
        );

        res.json({ success: true, checkoutRequestID });
      } catch (error) {
        console.error('STK push error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Admin API: Get conversation
    this.app.get('/api/conversations/:id', async (req, res) => {
      try {
        const { id } = req.params;

        const conversation = await db.query(
          `SELECT c.*, b.business_name
           FROM conversations c
           JOIN businesses b ON c.business_id = b.business_id
           WHERE c.conversation_id = $1`,
          [id]
        );

        if (conversation.rows.length === 0) {
          return res.status(404).json({ error: 'Not found' });
        }

        const messages = await db.query(
          `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY sent_at ASC`,
          [id]
        );

        const payments = await db.query(
          `SELECT * FROM payment_intents WHERE conversation_id = $1 ORDER BY created_at DESC`,
          [id]
        );

        res.json({
          conversation: conversation.rows[0],
          messages: messages.rows,
          payments: payments.rows
        });
      } catch (error) {
        console.error('Get conversation error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Admin API: List conversations
    this.app.get('/api/conversations', async (req, res) => {
      try {
        const { businessId, state, limit = 50 } = req.query;

        let query = `
          SELECT c.*, b.business_name
          FROM conversations c
          JOIN businesses b ON c.business_id = b.business_id
          WHERE 1=1
        `;
        const params = [];
        let paramIndex = 1;

        if (businessId) {
          query += ` AND c.business_id = $${paramIndex}`;
          params.push(businessId);
          paramIndex++;
        }

        if (state) {
          query += ` AND c.current_state = $${paramIndex}`;
          params.push(state);
          paramIndex++;
        }

        query += ` ORDER BY c.last_message_at DESC LIMIT $${paramIndex}`;
        params.push(limit);

        const conversations = await db.query(query, params);

        res.json({ conversations: conversations.rows });
      } catch (error) {
        console.error('List conversations error:', error);
        res.status(500).json({ error: error.message });
      }
    });
  }

  // ==========================================================================
  // EVENT LISTENERS
  // ==========================================================================

  setupEventListeners() {
    // Listen for payment confirmed
    this.eventBus.on('PAYMENT_CONFIRMED', async (event) => {
      try {
        await this.stateMachine.transitionTo(
          event.conversationId,
          CONVERSATION_STATES.PAID,
          'PAYMENT_CONFIRMED'
        );
      } catch (error) {
        console.error('Payment confirmation handler error:', error);
      }
    });

    // Listen for escalation
    this.eventBus.on('ESCALATION_REQUIRED', async (event) => {
      try {
        await this.ownerNotifier.notifyOwner(
          event.businessId,
          'ESCALATION_REQUIRED',
          event.payload
        );
      } catch (error) {
        console.error('Escalation handler error:', error);
      }
    });
  }

  // ==========================================================================
  // CRON JOBS
  // ==========================================================================

  setupCronJobs() {
    // Check follow-ups every 5 minutes
    cron.schedule('*/5 * * * *', async () => {
      try {
        console.log('[CRON] Checking for follow-ups...');
        await this.followUpEngine.checkPendingFollowUps();
      } catch (error) {
        console.error('Follow-up check failed:', error);
      }
    });

    // Check expired payments every 10 minutes
    cron.schedule('*/10 * * * *', async () => {
      try {
        console.log('[CRON] Checking for expired payments...');
        await this.paymentEngine.checkExpiredIntents();
      } catch (error) {
        console.error('Payment expiry check failed:', error);
      }
    });

    // Daily summary at 6 PM EAT
    cron.schedule('0 18 * * *', async () => {
      try {
        console.log('[CRON] Sending daily summary...');
        // TODO: Implement daily summary
      } catch (error) {
        console.error('Daily summary failed:', error);
      }
    });
  }

  // ==========================================================================
  // SERVER LIFECYCLE
  // ==========================================================================

  async start(port = 3000) {
    return new Promise((resolve) => {
      this.server = this.app.listen(port, () => {
        console.log(`✓ FlowStack running on port ${port}`);
        resolve();
      });
    });
  }

  async stop() {
    return new Promise(async (resolve) => {
      await this.followUpEngine.close();
      this.server.close(() => {
        db.end();
        console.log('✓ FlowStack stopped');
        resolve();
      });
    });
  }
}

// ============================================================================
// STARTUP
// ============================================================================

if (require.main === module) {
  const config = {
    DATABASE_URL: process.env.DATABASE_URL,
    WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
    WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN,
    MPESA_CONSUMER_KEY: process.env.MPESA_CONSUMER_KEY,
    MPESA_CONSUMER_SECRET: process.env.MPESA_CONSUMER_SECRET,
    MPESA_SHORTCODE: process.env.MPESA_SHORTCODE,
    MPESA_PASSKEY: process.env.MPESA_PASSKEY,
    MPESA_ENVIRONMENT: process.env.MPESA_ENVIRONMENT
  };

  const app = new FlowStackApp(config);
  app.start(process.env.PORT || 3000).catch(console.error);

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully...');
    await app.stop();
    process.exit(0);
  });
}

module.exports = FlowStackApp;
