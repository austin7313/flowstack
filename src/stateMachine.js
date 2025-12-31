/**
 * State Machine
 * Manages conversation state transitions
 */

const db = require('./db');
const { CONVERSATION_STATES, STATE_TRANSITIONS, EVENT_TYPES } = require('./core');

class StateMachine {
  constructor(eventBus) {
    this.eventBus = eventBus;
  }

  /**
   * Check if transition is valid
   */
  isValidTransition(fromState, toState) {
    return STATE_TRANSITIONS[fromState]?.includes(toState) || false;
  }

  /**
   * Transition conversation to new state
   * ONLY method to change conversation state
   */
  async transitionTo(conversationId, newState, trigger, triggeredBy = 'system', metadata = null) {
    const client = await db.connect();

    try {
      await client.query('BEGIN');

      // Get current state
      const result = await client.query(
        'SELECT current_state, business_id FROM conversations WHERE conversation_id = $1 FOR UPDATE',
        [conversationId]
      );

      if (result.rows.length === 0) {
        throw new Error('Conversation not found');
      }

      const currentState = result.rows[0].current_state;
      const businessId = result.rows[0].business_id;

      // Validate transition
      if (!this.isValidTransition(currentState, newState)) {
        throw new Error(
          `Invalid transition from ${currentState} to ${newState}`
        );
      }

      // Update conversation state
      await client.query(
        `UPDATE conversations 
         SET current_state = $1,
             previous_state = $2,
             state_changed_at = NOW(),
             updated_at = NOW()
         WHERE conversation_id = $3`,
        [newState, currentState, conversationId]
      );

      // Log transition
      await client.query(
        `INSERT INTO state_transitions (conversation_id, business_id, from_state, to_state, trigger, triggered_by, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [conversationId, businessId, currentState, newState, trigger, triggeredBy, metadata ? JSON.stringify(metadata) : null]
      );

      await client.query('COMMIT');

      console.log(`✓ State transition: ${currentState} → ${newState} (${trigger})`);

      // Emit event
      await this.eventBus.emit(
        EVENT_TYPES.STATE_CHANGED,
        businessId,
        conversationId,
        null,
        { from_state: currentState, to_state: newState, trigger }
      );

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('State transition error:', error.message);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get current state of conversation
   */
  async getCurrentState(conversationId) {
    try {
      const result = await db.query(
        'SELECT current_state FROM conversations WHERE conversation_id = $1',
        [conversationId]
      );

      return result.rows[0]?.current_state || null;
    } catch (error) {
      console.error('Get state error:', error);
      throw error;
    }
  }

  /**
   * Get state transition history
   */
  async getTransitionHistory(conversationId, limit = 10) {
    try {
      const result = await db.query(
        `SELECT * FROM state_transitions 
         WHERE conversation_id = $1 
         ORDER BY created_at DESC 
         LIMIT $2`,
        [conversationId, limit]
      );

      return result.rows;
    } catch (error) {
      console.error('Get history error:', error);
      throw error;
    }
  }
}

module.exports = StateMachine;
