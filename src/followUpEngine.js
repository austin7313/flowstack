/**
 * Follow-Up Engine
 * Manages automated follow-ups using Bull queue
 */

const Bull = require('bull');
const db = require('./db');
const { EVENT_TYPES } = require('./core');

class FollowUpEngine {
  constructor(whatsappClient, messageComposer, eventBus) {
    this.whatsappClient = whatsappClient;
    this.messageComposer = messageComposer;
    this.eventBus = eventBus;

    // Initialize Bull queue
    this.followUpQueue = new Bull('follow-ups', {
      redis: {
        url: process.env.REDIS_URL || 'redis://localhost:6379'
      }
    });

    // Process queue jobs
    this.followUpQueue.process(this.processFollowUp.bind(this));

    // Handle queue events
    this.followUpQueue.on('completed', (job) => {
      console.log(`✓ Follow-up job completed: ${job.id}`);
    });

    this.followUpQueue.on('failed', (job, err) => {
      console.error(`✗ Follow-up job failed: ${job.id}`, err.message);
    });
  }

  /**
   * Schedule a follow-up task
   */
  async scheduleFollowUp(conversationId, templateKey, delayMinutes, context = {}) {
    try {
      const delay = delayMinutes * 60 * 1000; // Convert to milliseconds

      const job = await this.followUpQueue.add(
        {
          conversationId,
          templateKey,
          context
        },
        {
          delay,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000
          },
          removeOnComplete: true
        }
      );

      // Store task in database
      await db.query(
        `INSERT INTO follow_up_tasks (
          conversation_id,
          business_id,
          trigger_reason,
          scheduled_time,
          message_template_key,
          message_context,
          status
        )
        SELECT 
          $1,
          business_id,
          $2,
          NOW() + INTERVAL '1 minute' * $3,
          $4,
          $5,
          'pending'
        FROM conversations
        WHERE conversation_id = $1`,
        [conversationId, templateKey, delayMinutes, templateKey, JSON.stringify(context)]
      );

      console.log(`✓ Follow-up scheduled for conversation ${conversationId} (${delayMinutes}m)`);
      return job;
    } catch (error) {
      console.error('Schedule follow-up error:', error);
      throw error;
    }
  }

  /**
   * Process a follow-up job from queue
   */
  async processFollowUp(job) {
    const { conversationId, templateKey, context } = job.data;

    try {
      // Get conversation details
      const convResult = await db.query(
        `SELECT c.*, b.business_name, b.whatsapp_number
         FROM conversations c
         JOIN businesses b ON c.business_id = b.business_id
         WHERE c.conversation_id = $1`,
        [conversationId]
      );

      if (convResult.rows.length === 0) {
        throw new Error('Conversation not found');
      }

      const conversation = convResult.rows[0];

      // Compose message
      const messageBody = await this.messageComposer.compose(
        templateKey,
        {
          businessId: conversation.business_id,
          business_name: conversation.business_name,
          customer_name: conversation.customer_name,
          ...context
        }
      );

      // Send message
      const whatsappResult = await this.whatsappClient.sendMessage({
        from: conversation.whatsapp_number,
        to: conversation.customer_phone,
        body: messageBody
      });

      // Update follow-up task
      await db.query(
        `UPDATE follow_up_tasks 
         SET status = 'completed',
             executed_at = NOW(),
             message_body = $1,
             message_sent = true,
             whatsapp_message_id = $2
         WHERE conversation_id = $3
         AND message_template_key = $4
         AND status = 'pending'
         LIMIT 1`,
        [messageBody, whatsappResult.messageId, conversationId, templateKey]
      );

      // Emit event
      await this.eventBus.emit(
        EVENT_TYPES.FOLLOW_UP_SENT,
        conversation.business_id,
        conversationId,
        null,
        { template: templateKey, trigger: context.trigger_reason }
      );

      console.log(`✓ Follow-up sent for conversation ${conversationId}`);
      return { success: true };
    } catch (error) {
      console.error(`Follow-up processing error for ${conversationId}:`, error);

      // Update task as failed
      await db.query(
        `UPDATE follow_up_tasks 
         SET status = 'failed'
         WHERE conversation_id = $1
         AND status = 'pending'
         LIMIT 1`,
        [conversationId]
      );

      throw error;
    }
  }

  /**
   * Check for pending follow-ups (for cron job)
   */
  async checkPendingFollowUps() {
    try {
      const result = await db.query(`
        SELECT * FROM follow_up_tasks
        WHERE status = 'pending'
        AND scheduled_time <= NOW()
        ORDER BY scheduled_time ASC
        LIMIT 100
      `);

      console.log(`Checking ${result.rows.length} pending follow-ups`);

      for (const task of result.rows) {
        // Re-queue the job
        await this.followUpQueue.add(
          {
            conversationId: task.conversation_id,
            templateKey: task.message_template_key,
            context: task.message_context || {}
          },
          {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 2000
            }
          }
        );
      }

      return result.rows.length;
    } catch (error) {
      console.error('Check pending follow-ups error:', error);
    }
  }

  /**
   * Close the queue
   */
  async close() {
    await this.followUpQueue.close();
  }
}

module.exports = FollowUpEngine;
