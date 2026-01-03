/**
 * FollowUpEngine
 * SAFE MODE — Redis/Bull disabled
 * Uses DB + cron only
 */

const db = require('./db');

class FollowUpEngine {
  constructor(whatsappClient, messageComposer, eventBus) {
    this.whatsapp = whatsappClient;
    this.messageComposer = messageComposer;
    this.eventBus = eventBus;

    console.log('⚠️ FollowUpEngine running WITHOUT Redis (safe mode)');
  }

  /**
   * Check pending follow-ups directly from DB
   */
  async checkPendingFollowUps() {
    try {
      const result = await db.query(
        `
        SELECT f.follow_up_id,
               f.conversation_id,
               f.message_template,
               c.customer_phone
        FROM follow_ups f
        JOIN conversations c ON c.conversation_id = f.conversation_id
        WHERE f.status = 'PENDING'
          AND f.scheduled_at <= NOW()
        LIMIT 20
        `
      );

      for (const row of result.rows) {
        await this.sendFollowUp(row);
      }
    } catch (error) {
      console.error('Check pending follow-ups error:', error.message);
    }
  }

  /**
   * Send follow-up message
   */
  async sendFollowUp(followUp) {
    try {
      const message = this.messageComposer.compose(
        followUp.message_template,
        {}
      );

      await this.whatsapp.sendMessage(
        followUp.customer_phone,
        message
      );

      await db.query(
        `
        UPDATE follow_ups
        SET status = 'SENT',
            sent_at = NOW()
        WHERE follow_up_id = $1
        `,
        [followUp.follow_up_id]
      );

      console.log(
        `✓ Follow-up sent for conversation ${followUp.conversation_id}`
      );
    } catch (error) {
      console.error(
        `Follow-up send failed (${followUp.follow_up_id}):`,
        error.message
      );
    }
  }

  /**
   * Graceful shutdown hook
   */
  async close() {
    console.log('✓ FollowUpEngine stopped');
  }
}

module.exports = FollowUpEngine;
