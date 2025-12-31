/**
 * Core Classes & Constants
 * EventBus, MessageComposer, OwnerNotifier, MessageHandler, EventProcessor
 */

const EventEmitter = require('events');
const db = require('./db');

// ============================================================================
// CONSTANTS
// ============================================================================

const CONVERSATION_STATES = {
  NEW_LEAD: 'NEW_LEAD',
  ENGAGED: 'ENGAGED',
  AWAITING_CUSTOMER: 'AWAITING_CUSTOMER',
  WAITING_FOR_PAYMENT: 'WAITING_FOR_PAYMENT',
  PAID: 'PAID',
  DORMANT: 'DORMANT',
  ESCALATED: 'ESCALATED',
  CLOSED: 'CLOSED'
};

const PAYMENT_INTENT_STATUS = {
  INITIATED: 'initiated',
  PENDING: 'pending',
  PAID: 'paid',
  FAILED: 'failed',
  EXPIRED: 'expired'
};

const EVENT_TYPES = {
  NEW_LEAD: 'NEW_LEAD',
  PAYMENT_INITIATED: 'PAYMENT_INITIATED',
  PAYMENT_CONFIRMED: 'PAYMENT_CONFIRMED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  PAYMENT_EXPIRED: 'PAYMENT_EXPIRED',
  FOLLOW_UP_SENT: 'FOLLOW_UP_SENT',
  ESCALATION_REQUIRED: 'ESCALATION_REQUIRED',
  CONVERSATION_DORMANT: 'CONVERSATION_DORMANT',
  CONVERSATION_CLOSED: 'CONVERSATION_CLOSED',
  STATE_CHANGED: 'STATE_CHANGED'
};

const STATE_TRANSITIONS = {
  NEW_LEAD: ['ENGAGED', 'CLOSED'],
  ENGAGED: ['AWAITING_CUSTOMER', 'WAITING_FOR_PAYMENT', 'CLOSED'],
  AWAITING_CUSTOMER: ['ENGAGED', 'DORMANT', 'ESCALATED', 'CLOSED'],
  WAITING_FOR_PAYMENT: ['PAID', 'CLOSED'],
  PAID: ['CLOSED'],
  DORMANT: ['ENGAGED', 'CLOSED'],
  ESCALATED: ['ENGAGED', 'CLOSED'],
  CLOSED: []
};

// ============================================================================
// EVENT BUS
// ============================================================================

class EventBus extends EventEmitter {
  constructor() {
    super();
  }

  /**
   * Emit and persist event
   */
  async emit(eventType, businessId, conversationId = null, paymentIntentId = null, payload = {}) {
    try {
      // Persist to database
      const result = await db.query(
        `INSERT INTO events (event_type, business_id, conversation_id, payment_intent_id, payload)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING event_id`,
        [eventType, businessId, conversationId, paymentIntentId, JSON.stringify(payload)]
      );

      const eventId = result.rows[0].event_id;

      // Emit in-memory
      super.emit(eventType, {
        eventId,
        eventType,
        businessId,
        conversationId,
        paymentIntentId,
        payload,
        createdAt: new Date()
      });

      console.log(`Event emitted: ${eventType} [${eventId}]`);
      return eventId;
    } catch (error) {
      console.error('Event emission error:', error);
      throw error;
    }
  }
}

// ============================================================================
// MESSAGE COMPOSER
// ============================================================================

class MessageComposer {
  constructor() {
    this.templates = {
      welcome_template: "Hi! Thanks for reaching out to {business_name}. How can we help you today?",
      follow_up_gentle: "Hi again! Just checking in - do you still need help with this?",
      follow_up_reminder: "Hello! We noticed you haven't replied yet. Are you still interested in {service}?",
      payment_pending: "Hi! Your payment of KES {amount} is pending. It will expire in {hours_left} hours. Pay now to secure your booking.",
      payment_expired: "Hi! Your payment request has expired. Please let us know if you'd still like to proceed.",
      payment_confirmed: "Payment received! Thank you. We'll be in touch shortly."
    };
  }

  /**
   * Compose message from template
   */
  async compose(templateKey, context = {}) {
    try {
      // Get business-specific template if exists
      if (context.businessId) {
        const result = await db.query(
          `SELECT message_templates FROM businesses WHERE business_id = $1`,
          [context.businessId]
        );

        if (result.rows.length > 0) {
          const businessTemplates = result.rows[0].message_templates;
          const businessTemplateKey = businessTemplates[templateKey];

          if (businessTemplateKey && this.templates[businessTemplateKey]) {
            templateKey = businessTemplateKey;
          }
        }
      }

      let template = this.templates[templateKey];

      if (!template) {
        throw new Error(`Template not found: ${templateKey}`);
      }

      // Variable substitution
      Object.keys(context).forEach(key => {
        const placeholder = `{${key}}`;
        template = template.replace(new RegExp(placeholder, 'g'), context[key]);
      });

      return template;
    } catch (error) {
      console.error('Message composition error:', error);
      throw error;
    }
  }

  /**
   * Compose with AI enhancement (future)
   */
  async composeWithAI(templateKey, context) {
    // TODO: If AI enabled, enhance/personalize the message
    return this.compose(templateKey, context);
  }
}

// ============================================================================
// OWNER NOTIFIER
// ============================================================================

class OwnerNotifier {
  constructor(whatsappClient, eventBus, messageComposer) {
    this.whatsappClient = whatsappClient;
    this.eventBus = eventBus;
    this.messageComposer = messageComposer;
  }

  /**
   * Notify owner of important events
   */
  async notifyOwner(businessId, event, details) {
    try {
      const result = await db.query(
        `SELECT owner_phone, business_name, whatsapp_number FROM businesses WHERE business_id = $1`,
        [businessId]
      );

      if (result.rows.length === 0) return;

      const business = result.rows[0];
      const message = this.formatNotification(event, details, business.business_name);

      await this.whatsappClient.sendMessage({
        from: business.whatsapp_number,
        to: business.owner_phone,
        body: message
      });

      console.log(`✓ Owner notified: ${event}`);
    } catch (error) {
      console.error('Owner notification error:', error);
    }
  }

  formatNotification(event, details, businessName) {
    const templates = {
      ESCALATION_REQUIRED: `🚨 ${businessName}: Escalation needed. Customer: ${details.customerName}`,
      PAYMENT_FAILED: `⚠️ ${businessName}: Payment failed for ${details.customerName}. Amount: KES ${details.amount}`,
      DORMANT_CONVERSATION: `📊 ${businessName}: Conversation with ${details.customerName} is dormant.`
    };

    return templates[event] || `Event: ${event}`;
  }
}

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

class MessageHandler {
  constructor(stateMachine, eventBus) {
    this.stateMachine = stateMachine;
    this.eventBus = eventBus;
  }

  /**
   * Handle incoming WhatsApp message
   */
  async handleIncomingMessage(incomingMessage) {
    try {
      const { from, to, body, messageId, timestamp } = incomingMessage;

      // Find or create conversation
      let conversation = await db.query(
        `SELECT * FROM conversations 
         WHERE customer_phone = $1 
         AND whatsapp_number = $2`,
        [from, to]
      );

      let conversationId;
      let businessId;

      if (conversation.rows.length === 0) {
        // Create new conversation
        const newConv = await db.query(
          `INSERT INTO conversations (business_id, customer_phone, current_state)
           SELECT business_id, $1, 'NEW_LEAD'
           FROM businesses WHERE whatsapp_number = $2
           RETURNING *`,
          [from, to]
        );
        conversationId = newConv.rows[0].conversation_id;
        businessId = newConv.rows[0].business_id;

        // Emit new lead event
        await this.eventBus.emit(
          EVENT_TYPES.NEW_LEAD,
          businessId,
          conversationId
        );
      } else {
        conversationId = conversation.rows[0].conversation_id;
        businessId = conversation.rows[0].business_id;
      }

      // Store message
      await db.query(
        `INSERT INTO messages (conversation_id, business_id, direction, sender_phone, message_body, whatsapp_message_id, sent_at)
         VALUES ($1, $2, 'inbound', $3, $4, $5, to_timestamp($6))`,
        [conversationId, businessId, from, body, messageId, timestamp]
      );

      // Update conversation activity
      await db.query(
        `UPDATE conversations 
         SET last_message_at = NOW(),
             last_customer_message_at = NOW(),
             message_count = message_count + 1,
             updated_at = NOW()
         WHERE conversation_id = $1`,
        [conversationId]
      );

      console.log(`✓ Message received from ${from}: ${body.substring(0, 50)}...`);
    } catch (error) {
      console.error('Message handling error:', error);
      throw error;
    }
  }
}

// ============================================================================
// EVENT PROCESSOR
// ============================================================================

class EventProcessor {
  constructor(stateMachine, eventBus) {
    this.stateMachine = stateMachine;
    this.eventBus = eventBus;
  }

  /**
   * Process domain events
   */
  async processEvent(event) {
    try {
      const { event_type, conversation_id, business_id, payload } = event;

      switch (event_type) {
        case EVENT_TYPES.PAYMENT_CONFIRMED:
          await this.handlePaymentConfirmed(conversation_id);
          break;
        case EVENT_TYPES.PAYMENT_EXPIRED:
          await this.handlePaymentExpired(conversation_id);
          break;
        default:
          console.log(`Event processed: ${event_type}`);
      }
    } catch (error) {
      console.error('Event processing error:', error);
    }
  }

  async handlePaymentConfirmed(conversationId) {
    await this.stateMachine.transitionTo(
      conversationId,
      CONVERSATION_STATES.PAID,
      'PAYMENT_CONFIRMED'
    );
  }

  async handlePaymentExpired(conversationId) {
    console.log(`Payment expired for conversation ${conversationId}`);
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Constants
  CONVERSATION_STATES,
  PAYMENT_INTENT_STATUS,
  EVENT_TYPES,
  STATE_TRANSITIONS,

  // Classes
  EventBus,
  MessageComposer,
  OwnerNotifier,
  MessageHandler,
  EventProcessor
};
