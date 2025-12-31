/**
 * Payment Intent Engine
 * Manages payment intents and their lifecycle
 */

const db = require('./db');
const { PAYMENT_INTENT_STATUS, EVENT_TYPES } = require('./core');

class PaymentIntentEngine {
  constructor(eventBus, stateMachine) {
    this.eventBus = eventBus;
    this.stateMachine = stateMachine;
  }

  /**
   * Create a new payment intent
   */
  async createIntent(conversationId, amount, expiryHours = 48) {
    try {
      const result = await db.query(
        `INSERT INTO payment_intents (
          conversation_id,
          business_id,
          expected_amount,
          currency,
          status,
          expires_at
        )
        SELECT 
          $1,
          business_id,
          $2,
          'KES',
          'initiated',
          NOW() + INTERVAL '1 hour' * $3
        FROM conversations
        WHERE conversation_id = $1
        RETURNING *`,
        [conversationId, amount, expiryHours]
      );

      const intent = result.rows[0];

      // Emit event
      await this.eventBus.emit(
        EVENT_TYPES.PAYMENT_INITIATED,
        intent.business_id,
        conversationId,
        intent.payment_intent_id,
        { amount, expiryHours }
      );

      console.log(`✓ Payment intent created: ${intent.payment_intent_id} (KES ${amount})`);
      return intent;
    } catch (error) {
      console.error('Create intent error:', error);
      throw error;
    }
  }

  /**
   * Update payment intent status
   */
  async updateStatus(paymentIntentId, newStatus, metadata = {}) {
    try {
      const updates = {
        status: newStatus,
        updated_at: new Date(),
        ...metadata
      };

      if (newStatus === PAYMENT_INTENT_STATUS.PAID) {
        updates.paid_at = new Date();
      } else if (newStatus === PAYMENT_INTENT_STATUS.FAILED) {
        updates.failed_at = new Date();
      }

      const fields = Object.keys(updates)
        .map((key, idx) => `${key} = $${idx + 2}`)
        .join(', ');
      const values = Object.values(updates);

      const result = await db.query(
        `UPDATE payment_intents 
         SET ${fields}
         WHERE payment_intent_id = $1
         RETURNING *`,
        [paymentIntentId, ...values]
      );

      const intent = result.rows[0];

      console.log(`✓ Payment intent ${paymentIntentId} → ${newStatus}`);

      // Emit event based on status
      if (newStatus === PAYMENT_INTENT_STATUS.PAID) {
        await this.eventBus.emit(
          EVENT_TYPES.PAYMENT_CONFIRMED,
          intent.business_id,
          intent.conversation_id,
          paymentIntentId,
          { amount: intent.expected_amount }
        );
      } else if (newStatus === PAYMENT_INTENT_STATUS.FAILED) {
        await this.eventBus.emit(
          EVENT_TYPES.PAYMENT_FAILED,
          intent.business_id,
          intent.conversation_id,
          paymentIntentId,
          { reason: metadata.failure_reason }
        );
      } else if (newStatus === PAYMENT_INTENT_STATUS.EXPIRED) {
        await this.eventBus.emit(
          EVENT_TYPES.PAYMENT_EXPIRED,
          intent.business_id,
          intent.conversation_id,
          paymentIntentId
        );
      }

      return intent;
    } catch (error) {
      console.error('Update status error:', error);
      throw error;
    }
  }

  /**
   * Check for expired payment intents
   */
  async checkExpiredIntents() {
    try {
      const result = await db.query(`
        SELECT * FROM payment_intents
        WHERE status IN ('initiated', 'pending')
        AND expires_at < NOW()
      `);

      for (const intent of result.rows) {
        await this.updateStatus(intent.payment_intent_id, PAYMENT_INTENT_STATUS.EXPIRED);
      }

      console.log(`✓ Checked ${result.rows.length} expired intents`);
    } catch (error) {
      console.error('Check expired intents error:', error);
    }
  }

  /**
   * Get active payment intent for conversation
   */
  async getActiveIntent(conversationId) {
    try {
      const result = await db.query(
        `SELECT * FROM payment_intents 
         WHERE conversation_id = $1 
         AND status IN ('initiated', 'pending')
         ORDER BY created_at DESC 
         LIMIT 1`,
        [conversationId]
      );

      return result.rows[0] || null;
    } catch (error) {
      console.error('Get active intent error:', error);
      throw error;
    }
  }

  /**
   * Get payment intent by ID
   */
  async getIntent(paymentIntentId) {
    try {
      const result = await db.query(
        `SELECT * FROM payment_intents WHERE payment_intent_id = $1`,
        [paymentIntentId]
      );

      return result.rows[0] || null;
    } catch (error) {
      console.error('Get intent error:', error);
      throw error;
    }
  }
}

module.exports = PaymentIntentEngine;
